import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../cli/utils/context.js';
import { resolveBedrockRoute } from '../aws/bedrock-routes.js';
import {
  inspectBedrockAccess,
  previewBedrockAccess,
  applyBedrockAccess,
  type BedrockAccessPreview,
} from '../aws/bedrock-access.js';
import type { RecoverySource } from '../aws/recovery-source.js';
import {
  modelObject,
  parseModelHostTarget,
  modelText,
  type ModelHostTarget,
} from '../openclaw/model-contract.js';
import {
  parseBedrockRecoveryIntent,
  type BedrockRecoveryIntent,
} from '../openclaw/bedrock-recovery-intent.js';
import {
  parseBedrockRecoveryPlan,
  type BedrockRecoveryPlan,
} from '../openclaw/bedrock-recovery-plan.js';
import { parseBedrockGrantPlan } from './bedrock-grants.js';

export interface RecoveryBedrockIam {
  phase: 'reviewed' | 'started' | 'applied';
  access: BedrockAccessPreview;
}
export interface RecoveryBedrockState {
  bedrock?: BedrockRecoveryPlan;
  bedrockIam?: RecoveryBedrockIam;
}
export async function prepareRecoveryBedrock(
  ctx: CommandContext,
  input: BedrockRecoveryIntent | undefined,
): Promise<BedrockRecoveryPlan | undefined> {
  if (input === undefined) return undefined;
  const intent = parseBedrockRecoveryIntent(input);
  const routes = [];
  for (const model of intent.models)
    routes.push(await resolveBedrockRoute(ctx.target, model, intent.inferenceRegion));
  return parseBedrockRecoveryPlan(
    { intent, selection: { discoveryRegion: intent.inferenceRegion, routes } },
    { account: ctx.target.account, partition: ctx.target.arn.split(':')[1] },
  );
}
export function recoveryBedrockSummary(plan: BedrockRecoveryPlan): string {
  return `Recreate instance-role Bedrock in ${plan.intent.inferenceRegion}, billed through AWS; no model API key. Prepare ${plan.intent.plugin.spec} (${plan.intent.plugin.integrity}) with its model/embedding capabilities and fresh managed role files before activation. Separate target role-policy grants:\n${plan.selection.routes.map((route) => `  ${route.model}: ${route.invocationArn}; backing: ${route.modelArns.join(', ')}`).join('\n') || '  Discovery only; no invocation grants.'}\nMetadata checks send no model prompts. Source IAM policies and AWS credentials are not copied.`;
}
export function parseRecoveryBedrockIam(
  input: unknown,
  plan: BedrockRecoveryPlan,
  target: ModelHostTarget,
): RecoveryBedrockIam {
  const row = modelObject(input);
  if (
    Object.keys(row).some((key) => !['phase', 'access'].includes(key)) ||
    !['reviewed', 'started', 'applied'].includes(String(row.phase))
  )
    throw new Error('Invalid recovery Bedrock IAM phase');
  const profile = modelObject(modelObject(modelObject(row.access).source).profile);
  const arn = modelText(profile.arn),
    id = modelText(profile.id);
  if (
    !/^AIPA[A-Z0-9]{12,124}$/.test(id) ||
    !arn.startsWith(`arn:${target.stackId.split(':')[1]}:iam::${target.account}:instance-profile/`)
  )
    throw new Error('Recovery Bedrock IAM profile differs from its target account');
  const grant = parseBedrockGrantPlan(
    { selection: plan.selection, access: row.access },
    parseModelHostTarget(target),
    { arn, id },
  );
  return { phase: row.phase as RecoveryBedrockIam['phase'], access: grant.access };
}
/** Caller holds the shared recovery deployment lock and persists this record.
 * Save started intent before ExecuteChangeSet. A lost reply may only adopt a
 * freshly verified applied policy; it never repeats the IAM write. */
export async function ensureRecoveryBedrockAccess(options: {
  ctx: CommandContext;
  record: RecoveryBedrockState;
  jobTarget: ModelHostTarget;
  source: RecoverySource;
  save(): void | Promise<void>;
}) {
  const { ctx, record, jobTarget, source, save } = options;
  if (!record.bedrock) {
    if (record.bedrockIam)
      throw new Error('Recovery has IAM state without a reviewed Bedrock plan');
    return;
  }
  const plan = parseBedrockRecoveryPlan(record.bedrock, {
    account: ctx.target.account,
    partition: ctx.target.arn.split(':')[1],
  });
  if (
    jobTarget.stackId !== source.stackId ||
    jobTarget.instanceId !== source.instanceId ||
    jobTarget.roleId !== source.role.id ||
    jobTarget.deploymentName !== ctx.name ||
    jobTarget.account !== ctx.target.account ||
    jobTarget.region !== ctx.target.region
  )
    throw new Error('Bedrock recovery target identity changed');
  if (record.bedrockIam) {
    record.bedrockIam = parseRecoveryBedrockIam(record.bedrockIam, plan, jobTarget);
  } else {
    const access = await previewBedrockAccess(ctx, plan.selection);
    record.bedrockIam = parseRecoveryBedrockIam({ phase: 'reviewed', access }, plan, jobTarget);
    await save();
  }
  if (
    !isDeepStrictEqual(record.bedrockIam.access.source, {
      stackId: source.stackId,
      instanceId: source.instanceId,
      role: source.role,
      profile: source.profile,
    })
  )
    throw new Error('Bedrock recovery role/profile changed after its permission review');
  if (record.bedrockIam.phase !== 'reviewed') {
    const actual = await inspectBedrockAccess(ctx);
    if (!isDeepStrictEqual(actual, plan.selection))
      throw new Error(
        'Recovery Bedrock IAM is unconfirmed. Inspect the recorded auxiliary stack/change set; no IAM write or Gateway activation was repeated',
      );
    record.bedrockIam.phase = 'applied';
    await save();
    return;
  }
  record.bedrockIam.phase = 'started';
  await save();
  await applyBedrockAccess(ctx, plan.selection, record.bedrockIam.access);
  record.bedrockIam.phase = 'applied';
  await save();
}
