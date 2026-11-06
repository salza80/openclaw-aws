import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../cli/utils/context.js';
import { validateProvisioningConfig } from '../cli/utils/config-validation.js';
import { initialModelConnection } from '../openclaw/connections.js';
import { BEDROCK_PLUGIN } from '../openclaw/bedrock-configuration.js';
import { modelObject } from '../openclaw/model-contract.js';
import { resolveBedrockRoute, type BedrockRoute } from '../aws/bedrock-routes.js';
import { parseBedrockSelection } from '../aws/bedrock-selection.js';

export interface InitialBedrockPlan {
  schemaVersion: 1;
  deploymentName: string;
  account: string;
  deploymentRegion: string;
  inferenceRegion: string;
  route: BedrockRoute;
  plugin: typeof BEDROCK_PLUGIN;
}
/** Resolve the concrete model route before fresh provisioning/approval. This
 * metadata-only plan contains no credentials or uncreated resource identities. */
export async function prepareInitialBedrock(
  ctx: CommandContext,
): Promise<InitialBedrockPlan | undefined> {
  const connection = initialModelConnection(ctx.config);
  if (connection.authMode !== 'instance-role') return undefined;
  validateProvisioningConfig(ctx.config);
  const route = await resolveBedrockRoute(
    ctx.target,
    ctx.config.openclaw!.model!,
    connection.region,
  );
  return parseInitialBedrock(
    {
      schemaVersion: 1,
      deploymentName: ctx.name,
      account: ctx.target.account,
      deploymentRegion: ctx.target.region,
      inferenceRegion: connection.region,
      route,
      plugin: BEDROCK_PLUGIN,
    },
    ctx,
  );
}
export function parseInitialBedrock(input: unknown, ctx: CommandContext): InitialBedrockPlan {
  const row = modelObject(input);
  const connection = initialModelConnection(ctx.config);
  if (
    connection.authMode !== 'instance-role' ||
    Object.keys(row).some(
      (key) =>
        ![
          'schemaVersion',
          'deploymentName',
          'account',
          'deploymentRegion',
          'inferenceRegion',
          'route',
          'plugin',
        ].includes(key),
    ) ||
    row.schemaVersion !== 1 ||
    row.deploymentName !== ctx.name ||
    row.account !== ctx.target.account ||
    row.deploymentRegion !== ctx.target.region ||
    row.inferenceRegion !== connection.region ||
    !isDeepStrictEqual(row.plugin, BEDROCK_PLUGIN)
  )
    throw new Error('Initial Bedrock approval differs from the selected deployment/connection');
  const route = parseBedrockSelection(
    { discoveryRegion: connection.region, routes: [row.route] },
    { account: ctx.target.account, partition: ctx.target.arn.split(':')[1] },
  ).routes[0];
  if (route.model !== ctx.config.openclaw?.model)
    throw new Error('Initial Bedrock approval names another model');
  return {
    schemaVersion: 1,
    deploymentName: ctx.name,
    account: ctx.target.account,
    deploymentRegion: ctx.target.region,
    inferenceRegion: connection.region,
    route,
    plugin: { ...BEDROCK_PLUGIN },
  };
}
export function initialBedrockSummary(plan: InitialBedrockPlan): string {
  return `Amazon Bedrock (${plan.inferenceRegion}), billed through AWS; instance-role auth, no model API key.\nInstall/enable ${plan.plugin.spec} (${plan.plugin.integrity}) with model/embedding capabilities and permit a controlled Gateway restart.\nCreate a separate scoped role-policy stack for ${plan.route.model}:\n  Invoke: ${plan.route.invocationArn}\n  Backing models: ${plan.route.modelArns.join(', ')}\nSelect this initial model through supported native controls before reporting ready. Metadata checks send no model prompts.`;
}
/** Provisioning has released its deployment lock. Finish through the SAME
 * explicitly locked existing-host provider/model operations, never onboarding
 * again. Any failure retains billable infrastructure and a concrete operation
 * receipt instead of falsely reporting a ready claw. */
export async function finishInitialBedrock(
  ctx: CommandContext,
  outputs: Record<string, string>,
  input: InitialBedrockPlan,
  progress?: (message: string) => void,
) {
  const initial = parseInitialBedrock(input, ctx);
  const { prepareBedrockConnection, applyBedrockConnection, cancelBedrockConnection } =
    await import('./bedrock.js');
  const { prepareModelChange, applyModelChange, cancelModelChange } = await import('./models.js');
  progress?.('Enabling the reviewed Bedrock role provider on the fresh instance...');
  const provider = await prepareBedrockConnection(ctx, {
    inferenceRegion: initial.inferenceRegion,
    models: [initial.route.model],
    allowRestart: true,
    acceptPluginCapabilities: true,
  });
  let applyingProvider = false;
  try {
    if (
      provider.job.target.stackId !== outputs.DeploymentId ||
      provider.job.target.instanceId !== outputs.InstanceId ||
      !provider.selection.routes.some((route) => isDeepStrictEqual(route, initial.route))
    )
      throw new Error(
        'Fresh host or Bedrock backing metadata changed after approval; review the retained deployment before continuing',
      );
    applyingProvider = true;
    const result = await applyBedrockConnection(ctx, provider);
    if (result.phase !== 'complete')
      throw new Error(
        `Bedrock provider is ${result.phase}; inspect provider operation ${provider.job.operationId}. The fresh deployment is not ready`,
      );
  } finally {
    if (!applyingProvider) await cancelBedrockConnection(ctx, provider);
  }
  progress?.('Selecting and verifying the initial native Bedrock model...');
  const model = await prepareModelChange(ctx, {
    scope: { kind: 'default' },
    model: initial.route.model,
    allowRestart: true,
  });
  let applyingModel = false;
  try {
    if (
      !isDeepStrictEqual(model.job.target, provider.job.target) ||
      !isDeepStrictEqual(model.profile, provider.profile) ||
      model.bedrock?.selection.discoveryRegion !== initial.inferenceRegion ||
      !model.bedrock.selection.routes.some((route) => isDeepStrictEqual(route, initial.route))
    )
      throw new Error(
        'Fresh model target or approved Bedrock route changed after provisioning; no model write was attempted',
      );
    applyingModel = true;
    const result = await applyModelChange(ctx, model);
    if (result.phase !== 'complete')
      throw new Error(
        `Initial model is ${result.phase}; inspect model operation ${model.job.operationId}. The fresh deployment is not ready`,
      );
  } finally {
    if (!applyingModel) await cancelModelChange(ctx, model);
  }
}
