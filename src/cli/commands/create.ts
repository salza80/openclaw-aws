import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { GetParametersCommand } from '@aws-sdk/client-ssm';
import { configureDeployment, type InitArgs } from './init.js';
import { providerChoice } from '../utils/providers.js';
import { configExistsByName, getConfigPathByName, loadConfigByName } from '../utils/config.js';
import { getCurrentName } from '../utils/config-store.js';
import {
  getApiKeyEnvVar,
  getApiKeyParamName,
  getGatewayTokenParamName,
  resolveApiKey,
} from '../utils/api-keys.js';
import { getStackStatus } from '../utils/aws.js';
import { createSsmClient } from '../utils/aws-clients.js';
import { validateNodeVersion, validatePreDeploy } from '../utils/aws-validation.js';
import { AWSError, handleError, StackNotFoundError, ValidationError } from '../utils/errors.js';
import { validateProjectName } from '../utils/validation.js';
import { logger } from '../utils/logger.js';
import { resolveAwsTarget } from '../../aws/target.js';
import type { CommandContext } from '../utils/context.js';
import { deployDeployment } from '../../operations/deployment.js';
import { freshProviderCredentials, PROVIDER_CONNECTIONS } from '../../openclaw/connections.js';

interface CreateArgs extends InitArgs {
  name: string;
  provider?: string;
}
export { providerChoice };

export async function createDeployment(argv: CreateArgs): Promise<void> {
  validateNodeVersion();
  const valid = validateProjectName(argv.name);
  if (valid !== true) throw new ValidationError(String(valid));
  if (configExistsByName(argv.name))
    throw new ValidationError(`Deployment '${argv.name}' already exists; choose a new name`);
  const current = getCurrentName();
  const defaults = current ? loadConfigByName(current) : undefined;
  const provider = argv.provider
    ? providerChoice(argv.provider)
    : (argv.apiProvider ?? defaults?.openclaw?.apiProvider ?? 'anthropic-api-key');
  if (provider !== 'amazon-bedrock' && argv.bedrockRegion !== undefined)
    throw new ValidationError('--bedrock-region requires Amazon Bedrock as the initial provider');
  let apiKey = provider === 'amazon-bedrock' ? undefined : resolveApiKey(provider);
  const interactive = !argv.yes && Boolean(process.stdin.isTTY);
  if (provider !== 'amazon-bedrock' && !apiKey && interactive) {
    const response = await prompts({
      type: 'password',
      name: 'key',
      message: `${provider} API key:`,
    });
    apiKey = response.key;
    if (!apiKey) {
      logger.warn('Create cancelled');
      return;
    }
  }
  if (provider !== 'amazon-bedrock' && !apiKey)
    throw new AWSError(`Missing API key: ${getApiKeyEnvVar(provider)}`, [
      `Set ${getApiKeyEnvVar(provider)} in your environment or .env; credentials are never saved in the deployment config`,
    ]);
  if (!interactive && !argv.yes)
    throw new ValidationError('Noninteractive create requires --yes to approve provisioning');
  let ctx: CommandContext | undefined;
  const result = await configureDeployment(
    {
      ...argv,
      yes: !interactive,
      apiProvider: provider,
      bedrockRegion:
        provider === 'amazon-bedrock'
          ? (argv.bedrockRegion ?? defaults?.openclaw?.bedrock?.region)
          : argv.bedrockRegion,
      region: argv.region ?? defaults?.aws.region,
      profile: argv.profile ?? defaults?.aws.profile,
      instanceType: argv.instanceType ?? defaults?.instance.type,
      cloudflareAccountId: argv.cloudflareAccountId ?? defaults?.openclaw?.cloudflare?.accountId,
      cloudflareGatewayId: argv.cloudflareGatewayId ?? defaults?.openclaw?.cloudflare?.gatewayId,
      model:
        argv.model ??
        (provider === defaults?.openclaw?.apiProvider ? defaults.openclaw.model : undefined),
    },
    {
      rejectExisting: true,
      deployPrompt: false,
      beforeSave: async (config, name) => {
        const target = await resolveAwsTarget(config.aws);
        try {
          await getStackStatus(config.stack.name, target);
          throw new ValidationError(
            `AWS stack '${config.stack.name}' already exists; choose a new deployment name`,
          );
        } catch (error) {
          if (!(error instanceof StackNotFoundError)) throw error;
        }
        const client = createSsmClient(target);
        const names = [
          ...(provider === 'amazon-bedrock' ? [] : [getApiKeyParamName(name, provider)]),
          getGatewayTokenParamName(name),
          `/openclaw/${name}/api-key`,
        ];
        try {
          const parameters = await client.send(
            new GetParametersCommand({ Names: names, WithDecryption: false }),
          );
          if (parameters.Parameters?.length)
            throw new ValidationError(
              `AWS secrets already exist for '${name}'; choose a new deployment name or inspect the retained deployment`,
            );
          if (
            parameters.InvalidParameters?.length !== names.length ||
            names.some((name) => !parameters.InvalidParameters?.includes(name))
          ) {
            throw new AWSError('AWS did not confirm that deployment secret names are available');
          }
        } finally {
          client.destroy();
        }
        ctx = {
          name,
          config,
          configPath: getConfigPathByName(name),
          target,
          awsEnv: await target.environment(),
        };
      },
    },
  );
  if (!result || !ctx) return;
  if (interactive) {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: `Create ${ctx.name} (${ctx.config.instance.type}) in AWS ${ctx.target.account}/${ctx.target.region}?`,
      initial: true,
    });
    if (!confirm) {
      logger.warn('Create cancelled; configuration saved. Run deploy when ready.');
      return;
    }
  }
  await validatePreDeploy(ctx.config, ctx.target, Boolean(argv.yes));
  await deployDeployment(ctx, {
    ...freshProviderCredentials(provider, apiKey),
    progress: (message) => logger.info(message),
  });
  logger.success(`OpenClaw '${ctx.name}' is ready. Run openclaw-aws status --name ${ctx.name}`);
}

export const createCommand: CommandModule<{}, CreateArgs> = {
  command: 'create <name>',
  describe: 'Configure and deploy a new named OpenClaw installation',
  builder: (yargs) =>
    yargs
      .positional('name', { type: 'string', demandOption: true, describe: 'New deployment name' })
      .option('provider', {
        type: 'string',
        describe: 'Provider, e.g. openrouter, anthropic or bedrock',
        choices: [
          ...new Set([
            ...PROVIDER_CONNECTIONS.flatMap(({ value }) => [value, value.replace(/-api-key$/, '')]),
            'bedrock',
          ]),
        ],
      })
      .option('region', {
        type: 'string',
        describe: 'AWS region (defaults to current configuration)',
      })
      .option('profile', { type: 'string', describe: 'AWS credential profile' })
      .option('instance-type', { type: 'string', describe: 'EC2 instance type' })
      .option('model', { type: 'string', describe: 'Initial native provider/model reference' })
      .option('bedrock-region', {
        type: 'string',
        describe: 'Bedrock inference region (separate from EC2 region)',
      })
      .option('cloudflare-account-id', { type: 'string' })
      .option('cloudflare-gateway-id', { type: 'string' })
      .option('yes', {
        type: 'boolean',
        alias: 'y',
        default: false,
        describe: 'Use defaults and approve creation and required CDK bootstrap',
      }),
  handler: async (argv) => {
    try {
      await createDeployment(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default createCommand;
