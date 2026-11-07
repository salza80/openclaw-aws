import prompts from 'prompts';
import { GetParametersCommand } from '@aws-sdk/client-ssm';
import { configureDeployment, type InitArgs } from '../commands/init.js';
import { providerChoice } from './providers.js';
import { configExistsByName, getConfigPathByName, loadConfigByName } from './config.js';
import { getCurrentName } from './config-store.js';
import {
  getApiKeyEnvVar,
  getApiKeyParamName,
  getGatewayTokenParamName,
  resolveApiKey,
} from './api-keys.js';
import { getStackStatus } from './aws.js';
import { createSsmClient } from './aws-clients.js';
import { validateNodeVersion, validatePreDeploy } from './aws-validation.js';
import { AWSError, StackNotFoundError, ValidationError } from './errors.js';
import { validateProjectName } from './validation.js';
import { logger } from './logger.js';
import { resolveAwsTarget } from '../../aws/target.js';
import type { CommandContext } from './context.js';
import { deployDeployment } from '../../operations/deployment.js';
import { freshProviderCredentials } from '../../openclaw/connections.js';
import { prepareInitialBedrock, initialBedrockSummary } from '../../operations/fresh-bedrock.js';

export interface CreateArgs extends InitArgs {
  name: string;
  provider?: string;
}
export { providerChoice };

export async function createFreshDeployment(
  argv: CreateArgs,
  options: {
    apiKey?: string;
    prepare?: (
      ctx: CommandContext,
    ) => Promise<Pick<Parameters<typeof deployDeployment>[1], 'team' | 'additionalCredentials'>>;
  } = {},
): Promise<CommandContext | undefined> {
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
  let apiKey =
    provider === 'amazon-bedrock' ? undefined : (options.apiKey ?? resolveApiKey(provider));
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
  const extra = await options.prepare?.(ctx);
  const initialBedrock = await prepareInitialBedrock(ctx);
  if (initialBedrock) logger.info(initialBedrockSummary(initialBedrock));
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
    ...extra,
    ...(initialBedrock ? { initialBedrock } : {}),
    progress: (message) => logger.info(message),
  });
  logger.success(`OpenClaw '${ctx.name}' is ready. Run openclaw-aws status --name ${ctx.name}`);
  return ctx;
}
