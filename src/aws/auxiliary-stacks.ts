import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import type { RecoveryAccessProps } from '../cdk/vault.js';
import { awsClientConfig, type AwsTarget } from './target.js';

export type RecoveryStackPlan =
  | { kind: 'recovery-vault'; stackName: string; identity: string; vaultName: string }
  | {
      kind: 'recovery-access';
      stackName: string;
      identity: string;
      access: Pick<
        RecoveryAccessProps,
        'roleName' | 'bucket' | 'dataPrefix' | 'keyArn' | 's3KmsKeyArn' | 'secretKmsKeyArn'
      >;
    };
const tags = (plan: Pick<RecoveryStackPlan, 'kind' | 'identity'>) => [
  { Key: 'openclaw-aws:kind', Value: plan.kind },
  { Key: 'openclaw-aws:identity', Value: plan.identity },
];
export function assertRecoveryStack(
  stack: Stack,
  target: AwsTarget,
  plan: Pick<RecoveryStackPlan, 'kind' | 'identity' | 'stackName'>,
) {
  if (
    !stack.StackId ||
    stack.StackId.split(':')[3] !== target.region ||
    stack.StackId.split(':')[4] !== target.account ||
    stack.StackName !== plan.stackName ||
    !tags(plan).every((expected) =>
      stack.Tags?.some((tag) => tag.Key === expected.Key && tag.Value === expected.Value),
    )
  )
    throw new Error(
      'Existing recovery stack does not match the selected AWS identity and ownership',
    );
}
const missing = (error: unknown) =>
  error instanceof Error &&
  error.name === 'ValidationError' &&
  /(?:does not exist|not exist)/i.test(error.message);
async function describe(
  client: CloudFormationClient,
  name: string,
  signal: AbortSignal,
): Promise<Stack | undefined> {
  try {
    const result = await client.send(new DescribeStacksCommand({ StackName: name }), {
      abortSignal: signal,
    });
    if (result.Stacks?.length !== 1)
      throw new Error('AWS returned an incomplete recovery stack identity');
    return result.Stacks[0];
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Synthesize only independent recovery resources, without AMI lookups or bootstrap dependencies. */
export async function recoveryTemplate(
  target: AwsTarget,
  plan: RecoveryStackPlan,
): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(plan.stackName))
    throw new Error('Invalid recovery stack name');
  const directory = await mkdtemp(path.join(tmpdir(), 'openclaw-recovery-template-'));
  try {
    const { App, BootstraplessSynthesizer } = await import('aws-cdk-lib');
    const { RecoveryAccessStack, RecoveryVaultStack } = await import('../cdk/vault.js');
    const app = new App({ outdir: directory, analyticsReporting: false });
    const props = {
      env: { account: target.account, region: target.region },
      synthesizer: new BootstraplessSynthesizer(),
      analyticsReporting: false,
      stackName: plan.stackName,
    };
    const stack =
      plan.kind === 'recovery-vault'
        ? new RecoveryVaultStack(app, plan.stackName, { ...props, vaultName: plan.vaultName })
        : new RecoveryAccessStack(app, plan.stackName, { ...plan.access, ...props });
    return app.synth().getStackArtifact(stack.artifactId).template;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function ensureRecoveryStack(
  target: AwsTarget,
  plan: RecoveryStackPlan,
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<Stack> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60 * 1000)])
    : AbortSignal.timeout(15 * 60 * 1000);
  const client = new CloudFormationClient(awsClientConfig(target));
  try {
    let stack = await describe(client, plan.stackName, signal);
    if (stack) assertRecoveryStack(stack, target, plan);
    if (!stack) {
      const result = await client.send(
        new CreateStackCommand({
          StackName: plan.stackName,
          TemplateBody: JSON.stringify(await recoveryTemplate(target, plan)),
          Capabilities: ['CAPABILITY_NAMED_IAM'],
          Tags: tags(plan),
          ClientRequestToken: randomUUID(),
          OnFailure: 'DO_NOTHING',
          TimeoutInMinutes: 15,
        }),
        { abortSignal: signal },
      );
      if (!result.StackId) throw new Error('AWS did not return the new recovery stack identity');
      if (
        !result.StackId.startsWith(
          `arn:${target.arn.split(':')[1]}:cloudformation:${target.region}:${target.account}:stack/${plan.stackName}/`,
        )
      )
        throw new Error('AWS returned a different recovery stack target');
      stack = await describe(client, result.StackId, signal);
      while (!stack) {
        await delay(options.pollMs ?? 2000, undefined, { signal });
        stack = await describe(client, result.StackId, signal);
      }
    }
    while (true) {
      assertRecoveryStack(stack, target, plan);
      if (stack.StackStatus === 'CREATE_COMPLETE' || stack.StackStatus === 'UPDATE_COMPLETE')
        return stack;
      if (stack.StackStatus !== 'CREATE_IN_PROGRESS')
        throw new Error(
          `Recovery stack is ${stack.StackStatus ?? 'unknown'}; retained resources require inspection before retrying`,
        );
      await delay(options.pollMs ?? 2000, undefined, { signal });
      const observed = await describe(client, stack.StackId!, signal);
      if (!observed)
        throw new Error(
          'Recovery stack disappeared during creation; inspect AWS state before retrying',
        );
      if (observed.StackId !== stack.StackId)
        throw new Error('Recovery stack identity changed during creation');
      stack = observed;
    }
  } finally {
    client.destroy();
  }
}

/** Delete only a separately owned IAM-policy stack; never the vault or source resources. */
export async function removeRecoveryAccessStack(
  target: AwsTarget,
  plan: { stackName: string; identity: string; roleName: string },
  options: { signal?: AbortSignal; pollMs?: number } = {},
) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60 * 1000)])
    : AbortSignal.timeout(10 * 60 * 1000);
  const client = new CloudFormationClient(awsClientConfig(target));
  try {
    const stack = await describe(client, plan.stackName, signal);
    if (!stack) return;
    assertRecoveryStack(stack, target, { ...plan, kind: 'recovery-access' });
    const response = await client.send(
      new GetTemplateCommand({ StackName: stack.StackId, TemplateStage: 'Processed' }),
      { abortSignal: signal },
    );
    const template =
      typeof response.TemplateBody === 'string'
        ? JSON.parse(response.TemplateBody)
        : response.TemplateBody;
    const resources =
      template && typeof template === 'object'
        ? (
            template as {
              Resources?: Record<
                string,
                {
                  Type?: string;
                  DeletionPolicy?: string;
                  Condition?: unknown;
                  Properties?: { RoleName?: string; PolicyName?: string };
                }
              >;
            }
          ).Resources
        : undefined;
    const entries = resources ? Object.values(resources) : [];
    if (
      entries.length !== 1 ||
      entries[0].Type !== 'AWS::IAM::RolePolicy' ||
      (entries[0].DeletionPolicy !== undefined && entries[0].DeletionPolicy !== 'Delete') ||
      entries[0].Condition !== undefined ||
      entries[0].Properties?.RoleName !== plan.roleName ||
      entries[0].Properties?.PolicyName !== plan.stackName
    )
      throw new Error(
        'Recovery access stack contains unexpected resources; automatic removal refused',
      );
    if (stack.StackStatus !== 'DELETE_IN_PROGRESS')
      await client.send(
        new DeleteStackCommand({ StackName: stack.StackId, ClientRequestToken: randomUUID() }),
        { abortSignal: signal },
      );
    while (true) {
      const current = await describe(client, stack.StackId!, signal);
      if (!current) return;
      assertRecoveryStack(current, target, { ...plan, kind: 'recovery-access' });
      if (current.StackId !== stack.StackId)
        throw new Error('Recovery access stack identity changed during removal');
      if (current.StackStatus === 'DELETE_COMPLETE') return;
      if (current.StackId !== stack.StackId || current.StackStatus !== 'DELETE_IN_PROGRESS')
        throw new Error('Recovery access policy deletion failed; source resources were preserved');
      await delay(options.pollMs ?? 2000, undefined, { signal });
    }
  } finally {
    client.destroy();
  }
}
