import { isDeepStrictEqual } from 'node:util';
import { bedrockAccessStackName } from '../aws/recovery-source.js';
import type { BedrockAccessPreview } from '../aws/bedrock-access.js';
import { parseBedrockSelection, type BedrockAccessSelection } from '../aws/bedrock-selection.js';
import { modelObject, modelText, type ModelHostTarget } from '../openclaw/model-contract.js';

export interface BedrockGrantPlan {
  selection: BedrockAccessSelection;
  access: BedrockAccessPreview;
}
/** Nonsecret IAM review shared by provider enablement and model selection.
 * Execution still rechecks AWS ownership, exact template and replacement plan. */
export function parseBedrockGrantPlan(
  input: unknown,
  target: ModelHostTarget,
  profile: { arn: string; id: string },
): BedrockGrantPlan {
  const row = modelObject(input);
  if (Object.keys(row).some((key) => !['selection', 'access'].includes(key)))
    throw new Error('Unsupported Bedrock grant plan');
  const access = structuredClone(modelObject(row.access)) as unknown as BedrockAccessPreview;
  if (
    Object.keys(access).some(
      (key) =>
        ![
          'stackName',
          'stackId',
          'changeSetId',
          'source',
          'templateDigest',
          'previousTemplateDigest',
          'noChanges',
        ].includes(key),
    ) ||
    typeof access.noChanges !== 'boolean' ||
    !/^[a-f0-9]{64}$/.test(modelText(access.templateDigest, 64)) ||
    (access.previousTemplateDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(modelText(access.previousTemplateDigest, 64)))
  )
    throw new Error('Invalid Bedrock IAM preview');
  const source = modelObject(access.source),
    role = modelObject(source.role);
  const partition = target.stackId.split(':')[1];
  const exact = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  if (
    !exact(source, ['stackId', 'instanceId', 'role', 'profile']) ||
    !exact(role, ['id', 'name', 'arn']) ||
    source.stackId !== target.stackId ||
    source.instanceId !== target.instanceId ||
    role.id !== target.roleId ||
    !isDeepStrictEqual(source.profile, profile) ||
    typeof role.name !== 'string' ||
    !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(role.name) ||
    typeof role.arn !== 'string' ||
    !role.arn.startsWith(`arn:${partition}:iam::${target.account}:role/`) ||
    !role.arn.endsWith(`/${role.name}`)
  )
    throw new Error('Bedrock IAM preview belongs to another immutable host');
  const name = bedrockAccessStackName(target.stackId, target.roleId);
  if (
    access.stackName !== name ||
    typeof access.stackId !== 'string' ||
    !access.stackId.startsWith(
      `arn:${partition}:cloudformation:${target.region}:${target.account}:stack/${name}/`,
    ) ||
    (access.noChanges
      ? access.changeSetId !== undefined || access.previousTemplateDigest !== access.templateDigest
      : typeof access.changeSetId !== 'string' ||
        !access.changeSetId.startsWith(
          `arn:${partition}:cloudformation:${target.region}:${target.account}:changeSet/`,
        ))
  )
    throw new Error('Bedrock review stack/change set identity is invalid');
  return {
    selection: parseBedrockSelection(row.selection, { account: target.account, partition }),
    access,
  };
}
