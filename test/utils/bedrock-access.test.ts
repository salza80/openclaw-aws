import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
} from '@aws-sdk/client-cloudformation';
import { GetRoleCommand, GetRolePolicyCommand, ListRolePoliciesCommand } from '@aws-sdk/client-iam';
import type { RecoverySource } from '../../src/aws/recovery-source.js';
import { makeCommandContext, testTarget } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({ cfn: vi.fn(), iam: vi.fn(), inspect: vi.fn() }));
vi.mock('@aws-sdk/client-cloudformation', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-cloudformation')>()),
  CloudFormationClient: class {
    send = mocks.cfn;
    destroy = vi.fn();
  },
}));
vi.mock('@aws-sdk/client-iam', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-iam')>()),
  IAMClient: class {
    send = mocks.iam;
    destroy = vi.fn();
  },
}));
vi.mock('../../src/aws/recovery-source.js', async (original) => ({
  ...(await original<typeof import('../../src/aws/recovery-source.js')>()),
  inspectRecoverySource: mocks.inspect,
}));
import {
  previewBedrockAccess,
  applyBedrockAccess,
  discardBedrockAccessPreview,
  inspectBedrockAccess,
  planBedrockAccessExtension,
} from '../../src/aws/bedrock-access.js';
import { BEDROCK_SELECTION_METADATA } from '../../src/aws/bedrock-selection.js';
const ctx = makeCommandContext({ target: { ...testTarget, region: 'eu-central-1' } });
const source = {
  stackId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-alpha/source-id',
  instanceId: 'i-source',
  role: {
    name: 'hosting-role',
    id: 'AROAHOST',
    arn: 'arn:aws:iam::123456789012:role/hosting-role',
  },
  profile: { arn: 'arn:aws:iam::123456789012:instance-profile/hosting-profile', id: 'AIPAHOST' },
} as RecoverySource;
const selection = {
  discoveryRegion: 'eu-central-1',
  routes: [
    {
      model: 'amazon-bedrock/provider.model',
      region: 'eu-central-1',
      kind: 'foundation-model' as const,
      invocationArn: 'arn:aws:bedrock:eu-central-1::foundation-model/provider.model',
      modelArns: ['arn:aws:bedrock:eu-central-1::foundation-model/provider.model'],
    },
  ],
};
type Template = {
  Metadata?: Record<string, unknown>;
  Resources: Record<
    string,
    {
      Type: string;
      Properties: { RoleName: string; PolicyName: string; PolicyDocument: Record<string, unknown> };
    }
  >;
};
let saved: Template | undefined;
let desired: Template;
let stackName: string;
let stackId: string;
let tags: { Key: string; Value: string }[];
let exists: boolean;
let executed: boolean;
let deleted: boolean;
let extraPolicies: Record<string, Record<string, unknown>>;
let replace: string | undefined;
const changeSetId = 'arn:aws:cloudformation:eu-central-1:123456789012:changeSet/bedrock/test';
const missing = () => Object.assign(new Error('Stack does not exist'), { name: 'ValidationError' });
const policy = (value: Template) => Object.values(value.Resources)[0].Properties.PolicyDocument;
function changes() {
  return {
    ChangeSetId: changeSetId,
    StackId: stackId,
    StackName: stackName,
    Status: 'CREATE_COMPLETE',
    ExecutionStatus: executed ? 'EXECUTE_COMPLETE' : 'AVAILABLE',
    Changes: [
      {
        ResourceChange: {
          ResourceType: 'AWS::IAM::RolePolicy',
          LogicalResourceId: 'BedrockAccess',
          Action: exists ? 'Modify' : 'Add',
          Replacement: replace ?? (exists ? 'False' : undefined),
        },
      },
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  saved = undefined;
  exists = false;
  executed = false;
  deleted = false;
  extraPolicies = {};
  replace = undefined;
  mocks.inspect.mockResolvedValue(structuredClone(source));
  mocks.cfn.mockImplementation(async (command) => {
    if (command instanceof DescribeStacksCommand) {
      if (deleted) throw missing();
      if (!exists && !desired) throw missing();
      return {
        Stacks: [
          {
            StackName: stackName,
            StackId: stackId,
            StackStatus: executed
              ? 'UPDATE_COMPLETE'
              : exists
                ? 'CREATE_COMPLETE'
                : 'REVIEW_IN_PROGRESS',
            Tags: tags,
          },
        ],
      };
    }
    if (command instanceof CreateChangeSetCommand) {
      desired = JSON.parse(command.input.TemplateBody!);
      stackName = command.input.StackName!.includes(':stack/')
        ? command.input.StackName!.split(':stack/')[1].split('/')[0]
        : command.input.StackName!;
      stackId = `arn:aws:cloudformation:eu-central-1:123456789012:stack/${stackName}/policy-id`;
      tags = command.input.Tags as typeof tags;
      return { Id: changeSetId, StackId: stackId };
    }
    if (command instanceof DescribeChangeSetCommand) return changes();
    if (command instanceof GetTemplateCommand)
      return {
        TemplateBody: structuredClone(command.input.ChangeSetName || executed ? desired : saved),
      };
    if (command instanceof ExecuteChangeSetCommand) {
      executed = true;
      return {};
    }
    if (command instanceof DeleteStackCommand) {
      deleted = true;
      return {};
    }
    if (command instanceof DeleteChangeSetCommand) return {};
    throw Error('Unexpected AWS write/read');
  });
  // Ensure no state from a prior fixture hides the initial confirmed missing read.
  desired = undefined as unknown as Template;
  mocks.iam.mockImplementation(async (command) => {
    if (command instanceof GetRoleCommand)
      return { Role: { RoleName: source.role.name, RoleId: source.role.id, Arn: source.role.arn } };
    if (command instanceof ListRolePoliciesCommand)
      return {
        PolicyNames: [...Object.keys(extraPolicies), ...(saved || executed ? [stackName] : [])],
        IsTruncated: false,
      };
    if (command instanceof GetRolePolicyCommand)
      return {
        RoleName: source.role.name,
        PolicyName: command.input.PolicyName,
        PolicyDocument: encodeURIComponent(
          JSON.stringify(
            command.input.PolicyName === stackName
              ? policy(executed ? desired : saved!)
              : extraPolicies[command.input.PolicyName!],
          ),
        ),
      };
    throw Error('Unexpected IAM write/read');
  });
});
async function existingPreview() {
  const created = await previewBedrockAccess(ctx, { ...selection, routes: [] }, { pollMs: 0 });
  saved = structuredClone(desired);
  exists = true;
  return created;
}
describe('Bedrock policy-only preview and execution', () => {
  it('discovers the exact applied host route union after local state loss without AWS writes', async () => {
    expect(await inspectBedrockAccess(ctx)).toBeUndefined();
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    await applyBedrockAccess(ctx, selection, preview, { pollMs: 0 });
    saved = structuredClone(desired);
    exists = true;
    executed = false;
    mocks.cfn.mockClear();
    expect(await inspectBedrockAccess(ctx)).toEqual(selection);
    const model = 'provider.second';
    const arn = `arn:aws:bedrock:eu-central-1::foundation-model/${model}`;
    const additional = {
      discoveryRegion: selection.discoveryRegion,
      routes: [
        {
          ...selection.routes[0],
          model: `amazon-bedrock/${model}`,
          invocationArn: arn,
          modelArns: [arn],
        },
      ],
    };
    const union = await planBedrockAccessExtension(ctx, additional);
    expect(union.routes).toHaveLength(2);
    expect(union.routes).toContainEqual(selection.routes[0]);
    expect(union.routes).toContainEqual(additional.routes[0]);
    expect(
      mocks.cfn.mock.calls.every(
        ([command]) =>
          command instanceof DescribeStacksCommand || command instanceof GetTemplateCommand,
      ),
    ).toBe(true);
    await expect(
      planBedrockAccessExtension(ctx, { ...additional, discoveryRegion: 'us-east-1' }),
    ).rejects.toThrow(/whole-host region change/);
  });
  it('does not treat missing, mismatched or drifted remote route metadata as an empty grant inventory', async () => {
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    await applyBedrockAccess(ctx, selection, preview, { pollMs: 0 });
    saved = structuredClone(desired);
    exists = true;
    executed = false;
    const original = structuredClone(saved);
    delete saved.Metadata;
    await expect(inspectBedrockAccess(ctx)).rejects.toThrow(/no managed route metadata/);
    saved = structuredClone(original);
    saved.Metadata![BEDROCK_SELECTION_METADATA] = {
      schemaVersion: 1,
      discoveryRegion: 'eu-central-1',
      routes: [],
    };
    await expect(inspectBedrockAccess(ctx)).rejects.toThrow(/does not match its route inventory/);
    saved = structuredClone(original);
    const originalIam = mocks.iam.getMockImplementation()!;
    mocks.iam.mockImplementation((command) =>
      command instanceof GetRolePolicyCommand
        ? Promise.resolve({
            RoleName: source.role.name,
            PolicyName: stackName,
            PolicyDocument: '{}',
          })
        : originalIam(command),
    );
    await expect(inspectBedrockAccess(ctx)).rejects.toThrow(/unmanaged drift/);
  });
  it('keeps account/role synthesis pinned even when incoming selection data contains extra stack options', async () => {
    const foreign = {
      ...selection,
      env: { account: '999999999999', region: 'eu-central-1' },
      routes: [
        {
          ...selection.routes[0],
          model: 'amazon-bedrock/global.provider.model',
          kind: 'inference-profile' as const,
          invocationArn:
            'arn:aws:bedrock:eu-central-1:999999999999:inference-profile/global.provider.model',
        },
      ],
    };
    await expect(previewBedrockAccess(ctx, foreign)).rejects.toThrow(/selected account/);
    expect(mocks.cfn).not.toHaveBeenCalled();
  });
  it('cancels only the unexecuted review stack or update change set', async () => {
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    await discardBedrockAccessPreview(ctx, preview, { pollMs: 0 });
    expect(
      mocks.cfn.mock.calls
        .filter(([c]) => c instanceof DeleteStackCommand)
        .map(([c]) => c.input.StackName),
    ).toEqual([preview.stackId]);
    deleted = false;
    saved = structuredClone(desired);
    exists = true;
    const update = await previewBedrockAccess(ctx, { ...selection, routes: [] }, { pollMs: 0 });
    await discardBedrockAccessPreview(ctx, update);
    expect(mocks.cfn.mock.calls.filter(([c]) => c instanceof DeleteChangeSetCommand)).toHaveLength(
      1,
    );
    expect(mocks.cfn.mock.calls.filter(([c]) => c instanceof DeleteStackCommand)).toHaveLength(1);
    expect(executed).toBe(false);
  });
  it('refuses cancellation after execution starts', async () => {
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    executed = true;
    await expect(discardBedrockAccessPreview(ctx, preview)).rejects.toThrow(/may be executing/);
    expect(
      mocks.cfn.mock.calls.some(
        ([c]) => c instanceof DeleteStackCommand || c instanceof DeleteChangeSetCommand,
      ),
    ).toBe(false);
  });
  it('prepares an exact role-policy preview, then applies it without EC2 or root-stack writes', async () => {
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    expect(preview.noChanges).toBe(false);
    expect(Object.values(desired.Resources).map((r) => r.Type)).toEqual(['AWS::IAM::RolePolicy']);
    expect(mocks.cfn.mock.calls.some(([c]) => c instanceof ExecuteChangeSetCommand)).toBe(false);
    await applyBedrockAccess(ctx, selection, preview, { pollMs: 0 });
    const execute = mocks.cfn.mock.calls.filter(([c]) => c instanceof ExecuteChangeSetCommand);
    expect(execute).toHaveLength(1);
    expect(execute[0][0].input).toMatchObject({
      ChangeSetName: preview.changeSetId,
      StackName: preview.stackId,
      DisableRollback: false,
    });
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(
      mocks.iam.mock.calls.every(
        ([c]) =>
          c instanceof GetRoleCommand ||
          c instanceof ListRolePoliciesCommand ||
          c instanceof GetRolePolicyCommand,
      ),
    ).toBe(true);
  });
  it('updates the auxiliary policy and adopts a verified no-op without changing the hosting stack', async () => {
    await existingPreview();
    const update = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    expect(update.previousTemplateDigest).toBeTruthy();
    expect(update.noChanges).toBe(false);
    await applyBedrockAccess(ctx, selection, update, { pollMs: 0 });
    saved = structuredClone(desired);
    executed = false;
    const before = mocks.cfn.mock.calls.filter(([c]) => c instanceof CreateChangeSetCommand).length;
    const noop = await previewBedrockAccess(ctx, selection);
    expect(noop.noChanges).toBe(true);
    await applyBedrockAccess(ctx, selection, noop);
    expect(mocks.cfn.mock.calls.filter(([c]) => c instanceof CreateChangeSetCommand)).toHaveLength(
      before,
    );
  });
  it('waits for the exact previous IAM policy to converge after CloudFormation completes', async () => {
    await existingPreview();
    const update = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    const original = mocks.iam.getMockImplementation()!;
    let stale = true;
    mocks.iam.mockImplementation((command) => {
      if (
        executed &&
        stale &&
        command instanceof GetRolePolicyCommand &&
        command.input.PolicyName === stackName
      ) {
        stale = false;
        return Promise.resolve({
          RoleName: source.role.name,
          PolicyName: stackName,
          PolicyDocument: JSON.stringify(policy(saved!)),
        });
      }
      return original(command);
    });
    await applyBedrockAccess(ctx, selection, update, { pollMs: 0 });
    expect(stale).toBe(false);
    expect(executed).toBe(true);
  });
  it('rejects replacement plans before execution', async () => {
    await existingPreview();
    replace = 'Conditional';
    await expect(previewBedrockAccess(ctx, selection, { pollMs: 0 })).rejects.toThrow(/replace/);
    expect(executed).toBe(false);
  });
  it('rejects selection changes and replacement of the source instance or role after approval', async () => {
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    await expect(applyBedrockAccess(ctx, { ...selection, routes: [] }, preview)).rejects.toThrow(
      /selection changed/,
    );
    mocks.inspect.mockResolvedValue({ ...source, instanceId: 'i-other' });
    await expect(applyBedrockAccess(ctx, selection, preview)).rejects.toThrow(/deployment changed/);
    mocks.inspect.mockResolvedValue(source);
    const original = mocks.iam.getMockImplementation()!;
    mocks.iam.mockImplementation((command) =>
      command instanceof GetRoleCommand
        ? Promise.resolve({
            Role: { RoleName: source.role.name, RoleId: 'REPLACED', Arn: source.role.arn },
          })
        : original(command),
    );
    await expect(applyBedrockAccess(ctx, selection, preview)).rejects.toThrow(/role was replaced/);
    expect(executed).toBe(false);
  });
  it('rejects modified prepared templates and additional hosting resources', async () => {
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    desired.Resources.ForeignHost = { Type: 'AWS::EC2::Instance' } as Template['Resources'][string];
    await expect(applyBedrockAccess(ctx, selection, preview)).rejects.toThrow(/policy changed/);
    expect(executed).toBe(false);
  });
  it('rejects inline-policy drift and accounts for unrelated inline policies in the role quota', async () => {
    await existingPreview();
    const original = mocks.iam.getMockImplementation()!;
    mocks.iam.mockImplementation((command) =>
      command instanceof GetRolePolicyCommand && command.input.PolicyName === stackName
        ? Promise.resolve({
            RoleName: source.role.name,
            PolicyName: stackName,
            PolicyDocument: '{}',
          })
        : original(command),
    );
    await expect(previewBedrockAccess(ctx, selection)).rejects.toThrow(/unmanaged drift/);
    mocks.iam.mockImplementation(original);
    extraPolicies.Large = {
      Statement: [{ Sid: 'x'.repeat(10240), Effect: 'Deny', Action: '*', Resource: '*' }],
    };
    await expect(previewBedrockAccess(ctx, selection)).rejects.toThrow(/quota/);
    expect(executed).toBe(false);
  });
  it('preserves denied reads rather than interpreting them as an absent stack', async () => {
    mocks.cfn.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(previewBedrockAccess(ctx, selection)).rejects.toThrow('denied');
    expect(mocks.cfn).toHaveBeenCalledTimes(1);
  });
  it('refuses incomplete IAM pagination and an unavailable/stale change set', async () => {
    const original = mocks.iam.getMockImplementation()!;
    mocks.iam.mockImplementation((command) =>
      command instanceof ListRolePoliciesCommand
        ? Promise.resolve({ PolicyNames: [], IsTruncated: true })
        : original(command),
    );
    await expect(previewBedrockAccess(ctx, selection)).rejects.toThrow(/pagination/);
    mocks.iam.mockImplementation(original);
    const preview = await previewBedrockAccess(ctx, selection, { pollMs: 0 });
    const originalCfn = mocks.cfn.getMockImplementation()!;
    mocks.cfn.mockImplementation((command) =>
      command instanceof DescribeChangeSetCommand
        ? Promise.resolve({ ...changes(), ExecutionStatus: 'OBSOLETE' })
        : originalCfn(command),
    );
    await expect(applyBedrockAccess(ctx, selection, preview)).rejects.toThrow(/unavailable/);
    expect(executed).toBe(false);
  });
});
