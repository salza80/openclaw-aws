import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  type DescribeChangeSetOutput,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListRolePoliciesCommand,
  type GetRolePolicyCommandOutput,
} from '@aws-sdk/client-iam';
import type { CommandContext } from '../cli/utils/context.js';
import { awsClientConfig, type AwsTarget } from './target.js';
import {
  inspectRecoverySource,
  bedrockAccessStackName,
  sourceAccessIdentity,
  type RecoverySource,
} from './recovery-source.js';
import {
  BEDROCK_SELECTION_METADATA,
  extendBedrockSelection,
  selectionFromBedrockMetadata,
  type BedrockAccessSelection,
} from './bedrock-selection.js';
export type { BedrockAccessSelection } from './bedrock-selection.js';
export interface BedrockAccessPreview {
  stackName: string;
  stackId?: string;
  changeSetId?: string;
  source: Pick<RecoverySource, 'stackId' | 'instanceId' | 'role' | 'profile'>;
  templateDigest: string;
  previousTemplateDigest?: string;
  noChanges: boolean;
}
type Template = Record<string, unknown>;
type RolePolicy = {
  Type: 'AWS::IAM::RolePolicy';
  Properties: { RoleName: string; PolicyName: string; PolicyDocument: Record<string, unknown> };
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const identity = (source: BedrockAccessPreview['source']) =>
  sourceAccessIdentity(source.stackId, source.role.id);
const stackNameFor = (source: BedrockAccessPreview['source']) =>
  bedrockAccessStackName(source.stackId, source.role.id);
const ownershipTags = (source: BedrockAccessPreview['source']) => [
  { Key: 'openclaw-aws:kind', Value: 'bedrock-access' },
  { Key: 'openclaw-aws:identity', Value: identity(source) },
];
const absent = (error: unknown) =>
  error instanceof Error &&
  error.name === 'ValidationError' &&
  /(?:does not exist|not exist)/i.test(error.message);
function assertStack(stack: Stack, target: AwsTarget, preview: BedrockAccessPreview) {
  if (
    stack.StackName !== preview.stackName ||
    !stack.StackId?.startsWith(
      `arn:${target.arn.split(':')[1]}:cloudformation:${target.region}:${target.account}:stack/${preview.stackName}/`,
    ) ||
    (preview.stackId && stack.StackId !== preview.stackId) ||
    !ownershipTags(preview.source).every((expected) =>
      stack.Tags?.some((tag) => tag.Key === expected.Key && tag.Value === expected.Value),
    )
  )
    throw new Error(
      'Bedrock access stack ownership or immutable identity differs from the preview',
    );
}
function policyResource(
  template: Template,
  preview: Pick<BedrockAccessPreview, 'stackName' | 'source'>,
): [string, RolePolicy] {
  const resources = template.Resources;
  if (
    !resources ||
    typeof resources !== 'object' ||
    Array.isArray(resources) ||
    Object.keys(resources).length !== 1 ||
    template.Transform ||
    template.Parameters ||
    template.Conditions ||
    template.Outputs
  )
    throw new Error('Bedrock access template must contain only one unconditional role policy');
  const [logicalId, value] = Object.entries(resources)[0];
  const resource = value as RolePolicy & {
    Condition?: unknown;
    DeletionPolicy?: string;
    UpdateReplacePolicy?: string;
  };
  if (
    !resource ||
    resource.Type !== 'AWS::IAM::RolePolicy' ||
    resource.Condition !== undefined ||
    (resource.DeletionPolicy !== undefined && resource.DeletionPolicy !== 'Delete') ||
    (resource.UpdateReplacePolicy !== undefined && resource.UpdateReplacePolicy !== 'Delete') ||
    resource.Properties?.RoleName !== preview.source.role.name ||
    resource.Properties?.PolicyName !== preview.stackName ||
    !resource.Properties.PolicyDocument ||
    typeof resource.Properties.PolicyDocument !== 'object'
  )
    throw new Error('Bedrock access template targets unexpected resources or a different role');
  return [logicalId, resource];
}
async function templateFor(
  target: AwsTarget,
  source: BedrockAccessPreview['source'],
  selection: BedrockAccessSelection,
): Promise<Template> {
  const directory = await mkdtemp(path.join(tmpdir(), 'openclaw-bedrock-template-'));
  try {
    const { App, BootstraplessSynthesizer } = await import('aws-cdk-lib');
    const { BedrockAccessStack } = await import('../cdk/bedrock.js');
    const app = new App({ outdir: directory, analyticsReporting: false });
    const name = stackNameFor(source);
    const stack = new BedrockAccessStack(app, name, {
      env: { account: target.account, region: target.region },
      stackName: name,
      synthesizer: new BootstraplessSynthesizer(),
      analyticsReporting: false,
      roleName: source.role.name,
      discoveryRegion: selection.discoveryRegion,
      routes: selection.routes,
    });
    return app.synth().getStackArtifact(stack.artifactId).template;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function describeStack(client: CloudFormationClient, name: string, signal: AbortSignal) {
  try {
    const result = await client.send(new DescribeStacksCommand({ StackName: name }), {
      abortSignal: signal,
    });
    if (result.Stacks?.length !== 1)
      throw new Error('AWS did not return a complete Bedrock access stack');
    return result.Stacks[0];
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}
async function readTemplate(
  client: CloudFormationClient,
  stackId: string,
  signal: AbortSignal,
  changeSetId?: string,
): Promise<Template> {
  const result = await client.send(
    new GetTemplateCommand({
      StackName: stackId,
      ChangeSetName: changeSetId,
      TemplateStage: 'Original',
    }),
    { abortSignal: signal },
  );
  const template =
    typeof result.TemplateBody === 'string' ? JSON.parse(result.TemplateBody) : result.TemplateBody;
  if (!template || typeof template !== 'object' || Array.isArray(template))
    throw new Error('Bedrock access template is unavailable');
  return template as Template;
}
function policyDocument(value: unknown): Record<string, unknown> {
  const result: unknown =
    typeof value === 'string'
      ? JSON.parse(value.trim().startsWith('{') ? value : decodeURIComponent(value))
      : value;
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('IAM did not return a complete inline policy document');
  return result as Record<string, unknown>;
}
class PolicyReadbackPending extends Error {}
/** Check the aggregate quota, role ID and out-of-band drift before any IAM change. */
async function checkRole(
  target: AwsTarget,
  preview: BedrockAccessPreview,
  desired: RolePolicy,
  previous: RolePolicy | undefined,
  signal: AbortSignal,
  pendingPrevious?: RolePolicy | null,
) {
  const client = new IAMClient(awsClientConfig(target));
  try {
    const { Role: role } = await client.send(
      new GetRoleCommand({ RoleName: preview.source.role.name }),
      { abortSignal: signal },
    );
    if (
      role?.RoleId !== preview.source.role.id ||
      role.Arn !== preview.source.role.arn ||
      role.RoleName !== preview.source.role.name
    )
      throw new Error('Hosting role was replaced after inspection');
    let marker: string | undefined;
    const seen = new Set<string>();
    const names = new Set<string>();
    do {
      const page = await client.send(
        new ListRolePoliciesCommand({ RoleName: role.RoleName, Marker: marker }),
        { abortSignal: signal },
      );
      if (
        !Array.isArray(page.PolicyNames) ||
        page.PolicyNames.some((name) => typeof name !== 'string' || names.has(name))
      )
        throw new Error('IAM inline-policy inventory is incomplete or repeated');
      page.PolicyNames.forEach((name) => names.add(name));
      marker = page.IsTruncated ? page.Marker : undefined;
      if (page.IsTruncated && (!marker || seen.has(marker)))
        throw new Error('IAM inline-policy pagination is incomplete or repeated');
      if (marker) seen.add(marker);
    } while (marker);
    let size = Buffer.byteLength(JSON.stringify(desired.Properties.PolicyDocument));
    let foundPrevious = false;
    for (const name of names) {
      const response: GetRolePolicyCommandOutput = await client.send(
        new GetRolePolicyCommand({ RoleName: role.RoleName, PolicyName: name }),
        { abortSignal: signal },
      );
      if (response.RoleName !== role.RoleName || response.PolicyName !== name)
        throw new Error('IAM returned a different role policy');
      const document = policyDocument(response.PolicyDocument);
      if (name === preview.stackName) {
        if (!previous || canonical(document) !== canonical(previous.Properties.PolicyDocument)) {
          if (
            pendingPrevious &&
            canonical(document) === canonical(pendingPrevious.Properties.PolicyDocument)
          )
            throw new PolicyReadbackPending('IAM still reports the previous Bedrock policy');
          throw new Error('Bedrock inline policy has unmanaged drift; inspect before updating');
        }
        foundPrevious = true;
      } else size += Buffer.byteLength(JSON.stringify(document));
    }
    if (Boolean(previous) !== foundPrevious) {
      if (previous && !foundPrevious && pendingPrevious === null)
        throw new PolicyReadbackPending('IAM has not published the new Bedrock policy');
      throw new Error('Bedrock inline policy differs from its owning stack');
    }
    if (size > 10240)
      throw new Error(
        'Combined role inline policies exceed the 10240-byte IAM quota; inspect the role before changing models',
      );
  } finally {
    client.destroy();
  }
}
function assertChangeSet(
  result: DescribeChangeSetOutput,
  preview: BedrockAccessPreview,
  logicalId: string,
  creating: boolean,
) {
  if (
    result.ChangeSetId !== preview.changeSetId ||
    result.StackId !== preview.stackId ||
    result.StackName !== preview.stackName ||
    result.NextToken ||
    result.Status !== 'CREATE_COMPLETE' ||
    result.ExecutionStatus !== 'AVAILABLE' ||
    result.Changes?.length !== 1
  )
    throw new Error('Bedrock change set is incomplete, changed or unavailable');
  const change = result.Changes[0].ResourceChange;
  if (
    change?.ResourceType !== 'AWS::IAM::RolePolicy' ||
    change.LogicalResourceId !== logicalId ||
    change.Action !== (creating ? 'Add' : 'Modify') ||
    (creating
      ? change.Replacement && change.Replacement !== 'False'
      : change.Replacement !== 'False')
  )
    throw new Error(
      'Bedrock change set would replace or change unexpected resources; execution refused',
    );
}
function bounded(signal?: AbortSignal) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)])
    : AbortSignal.timeout(15 * 60_000);
}

/** Read and verify the applied route inventory from AWS rather than local
 * state. The metadata must reproduce the whole IAM template, and live IAM
 * must match it. Missing/foreign/drifted policies are never an empty union.
 * Caller holds the shared deployment lock through preview and application. */
export async function inspectBedrockAccess(
  ctx: CommandContext,
  options: { signal?: AbortSignal } = {},
): Promise<BedrockAccessSelection | undefined> {
  const inspected = await inspectRecoverySource(ctx);
  const source = {
    stackId: inspected.stackId,
    instanceId: inspected.instanceId,
    role: inspected.role,
    profile: inspected.profile,
  };
  const preview: BedrockAccessPreview = {
    stackName: stackNameFor(source),
    source,
    templateDigest: '',
    noChanges: true,
  };
  const signal = bounded(options.signal);
  const client = new CloudFormationClient(awsClientConfig(ctx.target));
  try {
    const stack = await describeStack(client, preview.stackName, signal);
    if (!stack) return undefined;
    assertStack(stack, ctx.target, preview);
    if (
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(
        stack.StackStatus ?? '',
      )
    )
      throw new Error('Bedrock policy is not settled; inspect it before preparing another change');
    const template = await readTemplate(client, stack.StackId!, signal);
    const metadata = template.Metadata as Record<string, unknown> | undefined;
    const selection = selectionFromBedrockMetadata(metadata?.[BEDROCK_SELECTION_METADATA], {
      account: ctx.target.account,
      partition: ctx.target.arn.split(':')[1],
    });
    const expected = await templateFor(ctx.target, source, selection);
    if (digest(template) !== digest(expected))
      throw new Error('Bedrock policy does not match its route inventory; inspect unmanaged drift');
    const [, policy] = policyResource(template, preview);
    await checkRole(ctx.target, preview, policy, policy, signal);
    return selection;
  } finally {
    client.destroy();
  }
}

/** Preserve existing host routes, including fallback/sibling grants, when a
 * caller adds a connection or model. No policy is changed by this read. */
export async function planBedrockAccessExtension(
  ctx: CommandContext,
  requested: BedrockAccessSelection,
  options: { signal?: AbortSignal } = {},
): Promise<BedrockAccessSelection> {
  return extendBedrockSelection(await inspectBedrockAccess(ctx, options), requested, {
    account: ctx.target.account,
    partition: ctx.target.arn.split(':')[1],
  });
}

/** Create a reviewable policy-only change set. Caller holds the deployment lock;
 * this never synthesizes, updates or replaces the hosting EC2 stack.
 */
export async function previewBedrockAccess(
  ctx: CommandContext,
  selection: BedrockAccessSelection,
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<BedrockAccessPreview> {
  selection = structuredClone(selection);
  const inspected = await inspectRecoverySource(ctx);
  const source = {
    stackId: inspected.stackId,
    instanceId: inspected.instanceId,
    role: inspected.role,
    profile: inspected.profile,
  };
  const template = await templateFor(ctx.target, source, selection);
  const preview: BedrockAccessPreview = {
    stackName: stackNameFor(source),
    source,
    templateDigest: digest(template),
    noChanges: false,
  };
  const [logicalId, desired] = policyResource(template, preview);
  const signal = bounded(options.signal);
  const client = new CloudFormationClient(awsClientConfig(ctx.target));
  try {
    const stack = await describeStack(client, preview.stackName, signal);
    let previous: RolePolicy | undefined;
    if (stack) {
      assertStack(stack, ctx.target, preview);
      if (
        !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(
          stack.StackStatus ?? '',
        )
      )
        throw new Error(
          'Bedrock access stack requires reconciliation before preparing another change',
        );
      preview.stackId = stack.StackId;
      const old = await readTemplate(client, stack.StackId!, signal);
      const [oldId, policy] = policyResource(old, preview);
      if (oldId !== logicalId) throw new Error('Bedrock policy logical identity changed');
      previous = policy;
      preview.previousTemplateDigest = digest(old);
    }
    await checkRole(ctx.target, preview, desired, previous, signal);
    if (preview.previousTemplateDigest === preview.templateDigest)
      return { ...preview, noChanges: true };
    const created = await client.send(
      new CreateChangeSetCommand({
        StackName: preview.stackId ?? preview.stackName,
        ChangeSetName: `bedrock-${randomUUID()}`,
        ChangeSetType: stack ? 'UPDATE' : 'CREATE',
        TemplateBody: JSON.stringify(template),
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        Tags: ownershipTags(source),
        ClientToken: randomUUID(),
        Description: 'Scoped OpenClaw Bedrock access; hosting resources unchanged',
      }),
      { abortSignal: signal },
    );
    if (!created.Id || !created.StackId)
      throw new Error(
        'AWS did not return the Bedrock change-set identity; inspect retained review state',
      );
    if (preview.stackId && preview.stackId !== created.StackId)
      throw new Error('Bedrock change set targets another stack');
    preview.stackId = created.StackId;
    preview.changeSetId = created.Id;
    if (
      !preview.stackId.startsWith(
        `arn:${ctx.target.arn.split(':')[1]}:cloudformation:${ctx.target.region}:${ctx.target.account}:stack/${preview.stackName}/`,
      )
    )
      throw new Error('Bedrock change-set account or region differs');
    while (true) {
      const observed = await client.send(
        new DescribeChangeSetCommand({
          StackName: preview.stackId,
          ChangeSetName: preview.changeSetId,
        }),
        { abortSignal: signal },
      );
      if (observed.Status !== 'CREATE_PENDING' && observed.Status !== 'CREATE_IN_PROGRESS') {
        assertChangeSet(observed, preview, logicalId, !stack);
        break;
      }
      await delay(options.pollMs ?? 1500, undefined, { signal });
    }
    const prepared = await readTemplate(client, preview.stackId, signal, preview.changeSetId);
    if (digest(prepared) !== preview.templateDigest)
      throw new Error('Prepared Bedrock policy differs from the displayed selection');
    return preview;
  } finally {
    client.destroy();
  }
}

/** Reinspect ownership, template and quota immediately before executing the
 * exact preview. An uncertain/failed reply leaves the policy stack inspectable.
 */
export async function applyBedrockAccess(
  ctx: CommandContext,
  selection: BedrockAccessSelection,
  previewInput: BedrockAccessPreview,
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<void> {
  const preview = structuredClone(previewInput);
  const current = await inspectRecoverySource(ctx);
  const actual = {
    stackId: current.stackId,
    instanceId: current.instanceId,
    role: current.role,
    profile: current.profile,
  };
  if (canonical(actual) !== canonical(preview.source) || preview.stackName !== stackNameFor(actual))
    throw new Error('Hosting deployment changed after the Bedrock preview');
  const template = await templateFor(ctx.target, actual, structuredClone(selection));
  if (digest(template) !== preview.templateDigest)
    throw new Error('Bedrock selection changed after the preview');
  const [logicalId, desired] = policyResource(template, preview);
  const signal = bounded(options.signal);
  const client = new CloudFormationClient(awsClientConfig(ctx.target));
  try {
    const stack = await describeStack(client, preview.stackId ?? preview.stackName, signal);
    if (!stack)
      throw new Error('Bedrock access review stack disappeared; no replacement was created');
    assertStack(stack, ctx.target, preview);
    const creating = preview.previousTemplateDigest === undefined;
    if (
      creating
        ? stack.StackStatus !== 'REVIEW_IN_PROGRESS'
        : !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(
            stack.StackStatus ?? '',
          )
    )
      throw new Error('Bedrock access stack changed or is not ready');
    let previous: RolePolicy | undefined;
    if (!creating) {
      const old = await readTemplate(client, stack.StackId!, signal);
      if (digest(old) !== preview.previousTemplateDigest)
        throw new Error('Bedrock policy changed after the preview');
      previous = policyResource(old, preview)[1];
    }
    await checkRole(ctx.target, preview, desired, previous, signal);
    if (preview.noChanges) {
      if (
        creating ||
        preview.previousTemplateDigest !== preview.templateDigest ||
        preview.changeSetId
      )
        throw new Error('Invalid no-change Bedrock preview');
      return;
    }
    if (!preview.changeSetId) throw new Error('Bedrock change-set identity is missing');
    const command = { StackName: preview.stackId, ChangeSetName: preview.changeSetId };
    const observed = await client.send(new DescribeChangeSetCommand(command), {
      abortSignal: signal,
    });
    assertChangeSet(observed, preview, logicalId, creating);
    const prepared = await readTemplate(client, stack.StackId!, signal, preview.changeSetId);
    if (digest(prepared) !== preview.templateDigest)
      throw new Error('Prepared Bedrock policy changed after the preview');
    await client.send(
      new ExecuteChangeSetCommand({
        ...command,
        ClientRequestToken: randomUUID(),
        DisableRollback: false,
      }),
      { abortSignal: signal },
    );
    while (true) {
      const change = await client.send(new DescribeChangeSetCommand(command), {
        abortSignal: signal,
      });
      const live = await describeStack(client, stack.StackId!, signal);
      if (!live)
        throw new Error(
          'Bedrock policy stack disappeared during execution; reconcile before model activation',
        );
      assertStack(live, ctx.target, preview);
      if (
        change.ExecutionStatus === 'EXECUTE_COMPLETE' &&
        ['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(live.StackStatus ?? '')
      )
        break;
      if (
        change.ExecutionStatus === 'EXECUTE_FAILED' ||
        /FAILED|ROLLBACK/.test(live.StackStatus ?? '')
      )
        throw new Error(
          'Bedrock policy update failed; keep the previous model selection and inspect the policy stack',
        );
      await delay(options.pollMs ?? 1500, undefined, { signal });
    }
    const applied = await readTemplate(client, stack.StackId!, signal);
    if (digest(applied) !== preview.templateDigest)
      throw new Error('Applied Bedrock policy differs; model activation requires reconciliation');
    // IAM can briefly return the old document after CloudFormation completes.
    // Retry only the exact known old value (or a not-yet-visible new policy),
    // never a changed role, unrelated drift, denied read or malformed inventory.
    const readbackDeadline = Date.now() + 30_000;
    const readbackSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (true) {
      try {
        await checkRole(ctx.target, preview, desired, desired, readbackSignal, previous ?? null);
        break;
      } catch (error) {
        if (!(error instanceof PolicyReadbackPending) && !readbackSignal.aborted) throw error;
        if (Date.now() >= readbackDeadline)
          throw new Error(
            'IAM has not confirmed the applied Bedrock policy; reconcile before changing models',
            { cause: error },
          );
        await delay(options.pollMs ?? 1500, undefined, { signal });
      }
    }
  } finally {
    client.destroy();
  }
}

/** Cancel only this unexecuted preview. A CREATE review stack has no provisioned
 * role policy; an UPDATE cancellation deletes its change set, not the stack.
 */
export async function discardBedrockAccessPreview(
  ctx: CommandContext,
  previewInput: BedrockAccessPreview,
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<void> {
  const preview = structuredClone(previewInput);
  if (preview.noChanges) return;
  if (
    !preview.stackId ||
    !preview.changeSetId ||
    preview.stackName !== stackNameFor(preview.source)
  )
    throw new Error('Invalid Bedrock preview identity; automatic cancellation refused');
  const client = new CloudFormationClient(awsClientConfig(ctx.target));
  const signal = bounded(options.signal);
  try {
    const stack = await describeStack(client, preview.stackId, signal);
    if (!stack) return;
    assertStack(stack, ctx.target, preview);
    const creating = preview.previousTemplateDigest === undefined;
    if (
      creating
        ? stack.StackStatus !== 'REVIEW_IN_PROGRESS'
        : !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(
            stack.StackStatus ?? '',
          )
    )
      throw new Error('Bedrock policy preview may be executing; automatic cancellation refused');
    const command = { StackName: preview.stackId, ChangeSetName: preview.changeSetId };
    const prepared = await readTemplate(client, preview.stackId, signal, preview.changeSetId);
    if (digest(prepared) !== preview.templateDigest)
      throw new Error('Bedrock preview changed; automatic cancellation refused');
    const [logicalId] = policyResource(prepared, preview);
    const change = await client.send(new DescribeChangeSetCommand(command), {
      abortSignal: signal,
    });
    assertChangeSet(change, preview, logicalId, creating);
    if (!creating) {
      await client.send(new DeleteChangeSetCommand(command), { abortSignal: signal });
      return;
    }
    await client.send(
      new DeleteStackCommand({ StackName: preview.stackId, ClientRequestToken: randomUUID() }),
      { abortSignal: signal },
    );
    while (true) {
      const live = await describeStack(client, preview.stackId, signal);
      if (!live) return;
      assertStack(live, ctx.target, preview);
      if (live.StackStatus === 'DELETE_COMPLETE') return;
      if (live.StackStatus !== 'DELETE_IN_PROGRESS')
        throw new Error('Bedrock review-stack cleanup requires inspection');
      await delay(options.pollMs ?? 1500, undefined, { signal });
    }
  } finally {
    client.destroy();
  }
}
