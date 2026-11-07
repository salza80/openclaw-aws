import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAwsTarget } from '../aws/target.js';
import {
  configExistsByName,
  getConfigPathByName,
  getConfigRoot,
  saveConfigByName,
} from '../cli/utils/config.js';
import { validateProvisioningConfig } from '../cli/utils/config-validation.js';
import { getStackStatus } from '../cli/utils/aws.js';
import { StackNotFoundError } from '../cli/utils/errors.js';
import { deployDeployment } from '../operations/deployment.js';
import { prepareInitialBedrock, initialBedrockSummary } from '../operations/fresh-bedrock.js';
import { resolveCredentialReferences } from '../operations/credential-references.js';
import { freshProviderCredentials, isApiKeyProvider } from '../openclaw/connections.js';
import { parseTeamDefinition } from '../openclaw/team-definition.js';
import { writeControlRecord } from '../operations/control-fence.js';
import type { OpenClawConfig, Provider } from '../cli/types/index.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { UiActionRequest, UiPlanView, UiPreparedAction } from './contracts.js';
import {
  validateInstanceCapabilities,
  checkCDKBootstrap,
  runCDKBootstrap,
} from '../cli/utils/aws-validation.js';

export async function prepareUiCreate(
  request: UiActionRequest,
  view: UiPlanView,
): Promise<UiPreparedAction> {
  const provider = request.provider as Provider;
  const config: OpenClawConfig = {
    version: '1.0',
    aws: { region: request.region!, profile: request.profile },
    network: { useDefaultVpc: true },
    instance: { type: request.instanceType ?? 't3a.small', name: `openclaw-${request.name}` },
    features: { cloudWatchLogs: true },
    stack: { name: `OpenclawStack-${request.name}` },
    openclaw: {
      apiProvider: provider,
      ...(request.model ? { model: request.model } : {}),
      ...(provider === 'amazon-bedrock'
        ? { authMode: 'instance-role', bedrock: { region: request.bedrockRegion! } }
        : { authMode: 'api-key' }),
    },
  };
  validateProvisioningConfig(config);
  const target = await resolveAwsTarget(config.aws);
  const ctx: CommandContext = {
    name: request.name!,
    config,
    configPath: getConfigPathByName(request.name!),
    target,
    awsEnv: await target.environment(),
  };
  const assertFresh = async () => {
    if (configExistsByName(ctx.name)) throw new Error('Choose a new deployment name');
    try {
      await getStackStatus(config.stack.name, target);
    } catch (error) {
      if (error instanceof StackNotFoundError) return;
      throw error;
    }
    throw new Error('Hosting stack already exists; no fresh instance will be created');
  };
  await assertFresh();
  await validateInstanceCapabilities(config.instance.type, target);
  const bootstrap = await checkCDKBootstrap(target.account, target);
  const initialBedrock = await prepareInitialBedrock(ctx);
  const definition =
    request.action === 'team-create' ? parseTeamDefinition(request.definition) : undefined;
  const unique = new Map<string, NonNullable<UiActionRequest['credentials']>[number]>();
  for (const reference of [...(request.credentials ?? []), ...(definition?.credentials ?? [])]) {
    const previous = unique.get(reference.provider);
    if (
      previous &&
      (previous.kind !== reference.kind || previous.reference !== reference.reference)
    )
      throw new Error('Conflicting credential references for the same provider');
    unique.set(reference.provider, reference);
  }
  const references = [...unique.values()];
  if (isApiKeyProvider(provider) && !unique.has(provider))
    throw new Error(
      'Select an explicit environment or SSM credential reference for the initial provider',
    );
  const teamId = definition ? randomUUID() : undefined;
  view.target = { name: ctx.name, account: target.account, region: target.region };
  view.facts = [
    { label: 'EC2 type', value: config.instance.type },
    { label: 'Encrypted disk', value: '30 GiB' },
    { label: 'Provider', value: provider },
    { label: 'Profile', value: target.profile ?? 'Environment/default' },
    {
      label: 'Credential references',
      value:
        references
          .map((reference) => `${reference.provider}: ${reference.kind}:${reference.reference}`)
          .join(', ') || 'None: instance-role authentication',
    },
    ...(initialBedrock
      ? [{ label: 'Bedrock approval', value: initialBedrockSummary(initialBedrock) }]
      : []),
  ];
  view.effects = [
    'Create one billed EC2 host, encrypted disk, role, SSM parameters and log resources in the selected AWS account/region.',
    'Use the default VPC and pinned native installer. CloudFormation success alone is not application readiness.',
    ...(!bootstrap.meetsMinimum
      ? [
          'Create or upgrade the shared CDK bootstrap stack (artifact bucket and deployment roles), which remains after this claw is archived.',
        ]
      : []),
    ...(definition
      ? [
          'Provision the team’s shared host with the declared provider inventory. Then review native team configuration separately on that concrete host.',
        ]
      : []),
  ];
  return {
    view,
    async apply(progress) {
      await assertFresh();
      await validateInstanceCapabilities(config.instance.type, target);
      const values = await resolveCredentialReferences(references, target);
      const additionalCredentials = { ...values };
      if (isApiKeyProvider(provider)) delete additionalCredentials[provider];
      if (!definition && Object.keys(additionalCredentials).length)
        throw new Error('Additional providers require a declared team host');
      const currentBootstrap = await checkCDKBootstrap(target.account, target);
      if (!currentBootstrap.meetsMinimum) {
        if (bootstrap.meetsMinimum)
          throw new Error('CDK bootstrap changed after review; prepare another approval');
        progress('Preparing the reviewed account/region CDK bootstrap...');
        await runCDKBootstrap(target.account, target);
      }
      saveConfigByName(config, ctx.name, { overwrite: false });
      if (definition)
        await writeControlRecord(
          path.join(getConfigRoot(), 'team-create', view.id, 'request.json'),
          {
            schemaVersion: 1,
            name: ctx.name,
            teamId,
            operationId: view.id,
            account: target.account,
            region: target.region,
            definition,
            config,
          },
        );
      const outputs = await deployDeployment(ctx, {
        ...freshProviderCredentials(
          provider,
          isApiKeyProvider(provider) ? values[provider] : undefined,
        ),
        progress,
        initialBedrock,
        ...(definition
          ? {
              team: {
                teamId: teamId!,
                operationId: view.id,
                providers: Object.keys(
                  additionalCredentials,
                ).sort() as (keyof typeof additionalCredentials)[],
              },
              additionalCredentials,
            }
          : {}),
      });
      return {
        summary: definition
          ? 'Shared team host created and ready. Review its native team configuration next.'
          : 'Deployment created with confirmed application readiness.',
        facts: [
          { label: 'Stack', value: outputs.DeploymentId },
          { label: 'EC2 instance', value: outputs.InstanceId },
        ],
        ...(definition
          ? {
              recovery: [
                {
                  action: 'team-configure' as const,
                  name: ctx.name,
                  definition,
                  teamId,
                  allowRestart: true,
                },
              ],
            }
          : {}),
      };
    },
  };
}
