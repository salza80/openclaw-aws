import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createCloudFormationClient } from './aws-clients.js';
import { createFreshDeployment, type CreateArgs } from './create-flow.js';
import { providerChoice } from './providers.js';
import { getConfigRoot, loadConfigByName } from './config.js';
import { getCurrentName } from './config-store.js';
import { buildCommandContext, type CommandContext } from './context.js';
import { resolveAwsTarget } from '../../aws/target.js';
import { writeControlRecord } from '../../operations/control-fence.js';
import { prepareTeam, applyTeam, inspectTeamOperation } from '../../operations/teams.js';
import { privateModelJson } from '../../openclaw/model-journal.js';
import { parseTeamDefinition, type TeamDefinition } from '../../openclaw/team-definition.js';
import { teamId } from '../../openclaw/team-contract.js';
import { teamCredentials } from './team-file.js';
import { inspectRecoverySource } from '../../aws/recovery-source.js';
import { OPENCLAW_PROVIDER_SETUP } from '../../openclaw/install.js';
import { loadDeploymentState } from '../../operations/state.js';
import {
  prepareBedrockConnection,
  applyBedrockConnection,
  cancelBedrockConnection,
} from '../../operations/bedrock.js';

const requestPath = (operationId: string) =>
  path.join(getConfigRoot(), 'team-create', teamId(operationId), 'request.json');
export function teamBedrockModels(definition: TeamDefinition) {
  return [
    ...new Set(
      [definition.defaultModel, ...definition.members.map((member) => member.model)]
        .flatMap((model) =>
          typeof model === 'string'
            ? [model]
            : model
              ? [...(model.primary ? [model.primary] : []), ...(model.fallbacks ?? [])]
              : [],
        )
        .filter((model) => model.startsWith('amazon-bedrock/')),
    ),
  ];
}
/** This is the same provider/IAM operation used by providers enable-bedrock.
 * The caller has approved plugin capabilities, restart and concrete routes. */
export async function enableTeamBedrock(
  ctx: CommandContext,
  definition: TeamDefinition,
  options: { inferenceRegion?: string; approve: (details: string) => Promise<boolean> },
) {
  const models = teamBedrockModels(definition);
  if (!models.length) return true;
  const plan = await prepareBedrockConnection(ctx, {
    models,
    inferenceRegion:
      options.inferenceRegion ??
      loadDeploymentState(ctx)?.bedrockConnection?.inferenceRegion ??
      ctx.target.region,
    allowRestart: true,
    acceptPluginCapabilities: true,
  });
  let applying = false;
  try {
    if (
      !(await options.approve(
        `Enable the shared native Bedrock provider and scoped host IAM union. Review model/embedding plugin capabilities, controlled Gateway restart and exact routes:\n${JSON.stringify(plan, null, 2)}`,
      ))
    )
      return false;
    applying = true;
    await applyBedrockConnection(ctx, plan);
    return true;
  } finally {
    if (!applying) await cancelBedrockConnection(ctx, plan);
  }
}
async function finish(
  ctx: CommandContext,
  definition: TeamDefinition,
  id: string,
  operationId: string,
  options: { inferenceRegion?: string; approve: (details: string) => Promise<boolean> },
) {
  if (!(await enableTeamBedrock(ctx, definition, options))) return undefined;
  const plan = await prepareTeam(ctx, { definition, teamId: id, operationId, allowRestart: true });
  if (
    !(await options.approve(
      `Configure ${definition.members.length} native agents on the existing EC2 ${plan.job.target.instanceId}. No new host.\n${JSON.stringify(plan, null, 2)}`,
    ))
  )
    return undefined;
  return applyTeam(ctx, plan);
}
export async function createFreshTeam(
  argv: CreateArgs,
  definitionInput: TeamDefinition,
  options: { inferenceRegion?: string; approve: (details: string) => Promise<boolean> },
) {
  const definition = parseTeamDefinition(definitionInput);
  const current = getCurrentName(),
    defaults = current ? loadConfigByName(current) : undefined;
  const provider = providerChoice(argv.provider ?? 'openrouter');
  const region = argv.region ?? defaults?.aws.region ?? 'us-east-1',
    profile = argv.profile ?? defaults?.aws.profile;
  const target = definition.credentials.some((reference) => reference.kind === 'ssm')
    ? await resolveAwsTarget({ region, profile })
    : region;
  const credentials = await teamCredentials(definition, target);
  const operationId = randomUUID(),
    id = randomUUID();
  const initialModel =
    typeof definition.defaultModel === 'string'
      ? definition.defaultModel
      : definition.defaultModel?.primary;
  const nativeProvider =
    provider === 'amazon-bedrock' ? 'amazon-bedrock' : OPENCLAW_PROVIDER_SETUP[provider].providerId;
  const ctx = await createFreshDeployment(
    {
      ...argv,
      region,
      profile,
      provider,
      model:
        argv.model ?? (initialModel?.startsWith(nativeProvider + '/') ? initialModel : undefined),
      bedrockRegion: provider === 'amazon-bedrock' ? options.inferenceRegion : undefined,
    },
    {
      apiKey: provider === 'amazon-bedrock' ? undefined : credentials[provider],
      prepare: async (ctx) => {
        if (typeof target !== 'string' && target.account !== ctx.target.account)
          throw new Error('Team credential and provisioning accounts differ');
        await writeControlRecord(requestPath(operationId), {
          schemaVersion: 1,
          name: ctx.name,
          teamId: id,
          operationId,
          account: ctx.target.account,
          region: ctx.target.region,
          definition,
          config: ctx.config,
        });
        console.error(
          `Team creation operation: ${operationId}. Resume with team create-resume --operation-id ${operationId}; a retry never launches a second host.`,
        );
        const additionalCredentials = { ...credentials };
        if (provider !== 'amazon-bedrock') delete additionalCredentials[provider];
        return {
          team: {
            teamId: id,
            operationId,
            providers: Object.keys(
              additionalCredentials,
            ).sort() as (keyof typeof additionalCredentials)[],
          },
          additionalCredentials,
        };
      },
    },
  );
  if (!ctx) return undefined;
  const source = await inspectRecoverySource(ctx);
  await writeControlRecord(
    path.join(path.dirname(requestPath(operationId)), 'host.json'),
    { stackId: source.stackId, instanceId: source.instanceId, roleId: source.role.id },
    true,
  );
  return finish(ctx, definition, id, operationId, options);
}
export async function resumeFreshTeam(
  operationId: string,
  options: { inferenceRegion?: string; approve: (details: string) => Promise<boolean> },
) {
  const saved = await privateModelJson(requestPath(operationId));
  if (
    saved.schemaVersion !== 1 ||
    saved.operationId !== teamId(operationId) ||
    typeof saved.name !== 'string'
  )
    throw new Error('Invalid team create request');
  const ctx = await buildCommandContext({ name: saved.name });
  if (
    saved.account !== ctx.target.account ||
    saved.region !== ctx.target.region ||
    JSON.stringify(saved.config) !== JSON.stringify(ctx.config)
  )
    throw new Error('Saved team provisioning target/configuration changed');
  const client = createCloudFormationClient(ctx.target);
  try {
    const response = await client.send(
      new DescribeStacksCommand({ StackName: ctx.config.stack.name }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    const stack = response.Stacks?.[0];
    if (
      response.Stacks?.length !== 1 ||
      stack?.StackStatus !== 'CREATE_COMPLETE' ||
      !stack.Tags?.some(
        (tag) => tag.Key === 'openclaw-aws:team-id' && tag.Value === saved.teamId,
      ) ||
      !stack.Tags?.some(
        (tag) => tag.Key === 'openclaw-aws:team-create-id' && tag.Value === operationId,
      )
    )
      throw new Error(
        'Original ready team host was not confirmed; inspect retained provisioning resources before cleanup. No new host was created.',
      );
    const source = await inspectRecoverySource(ctx);
    if (source.stackId !== stack.StackId)
      throw new Error('Team hosting identity changed during resume');
    await writeControlRecord(
      path.join(path.dirname(requestPath(operationId)), 'host.json'),
      { stackId: source.stackId, instanceId: source.instanceId, roleId: source.role.id },
      true,
    );
  } finally {
    client.destroy();
  }
  try {
    await privateModelJson(path.join(getConfigRoot(), 'team-operations', operationId, 'plan.json'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return finish(
      ctx,
      parseTeamDefinition(saved.definition),
      teamId(saved.teamId),
      operationId,
      options,
    );
  }
  return (await inspectTeamOperation(ctx, operationId, { mode: 'resume' })).result;
}
