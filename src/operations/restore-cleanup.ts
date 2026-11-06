import {
  DeleteStackCommand,
  DescribeStacksCommand,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { createCloudFormationClient, createSsmClient } from '../cli/utils/aws-clients.js';
import type { CommandContext } from '../cli/utils/context.js';
import { resolveAwsTarget } from '../aws/target.js';
import { removeSourceRecoveryAccess } from '../aws/recovery-source.js';
import { deleteRestoreParameters } from '../aws/restore-cleanup.js';
import { loadDeploymentState, assertDeploymentTarget, forgetRestoredDeployment } from './state.js';
import { loadRestoreRecord, type RestoreRecord } from './restore-record.js';
import {
  getConfigPathByName,
  getOutputsPathByName,
  loadConfigByName,
  configExistsByName,
} from '../cli/utils/config.js';
import {
  getCurrentName,
  listConfigNames,
  setCurrentName,
  clearCurrentName,
} from '../cli/utils/config-store.js';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { withDeploymentLock } from './lock.js';

/** Standard destroy has already verified/deleted the immutable stack identity. */
export async function cleanupRestoredDeployment(ctx: CommandContext): Promise<boolean> {
  const state = loadDeploymentState(ctx);
  const lineage = state?.restoredFrom ?? state?.clonedFrom;
  if (!state || !lineage) return false;
  assertDeploymentTarget(ctx);
  const client = createSsmClient(ctx.target);
  try {
    await deleteRestoreParameters(client, {
      deploymentName: ctx.name,
      deploymentId: state.identity.stackId,
      operationId: lineage.operationId,
    });
  } finally {
    client.destroy();
  }
  return true;
}

/** Explicit cleanup also works after provisioning failed before local config existed. */
export async function cleanupRestore(operationId: string): Promise<void> {
  const record = loadRestoreRecord(operationId);
  return cleanupInactiveRecovery(record);
}

/** Clone and restore share immutable target/operation cleanup authority. */
export async function cleanupInactiveRecovery(
  record: Pick<RestoreRecord, 'operationId' | 'name' | 'config' | 'target'>,
): Promise<void> {
  const operationId = record.operationId;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))
    throw new Error('Recovery cleanup requires a verified operation UUID');
  const target = await resolveAwsTarget(record.config.aws);
  const ctx: CommandContext = {
    name: record.name,
    config: record.config,
    target,
    configPath: getConfigPathByName(record.name),
    awsEnv: {},
  };
  await withDeploymentLock(ctx, async () => {
    assertDeploymentTarget(ctx);
    if (
      record.target &&
      (record.target.stackId.split(':')[4] !== target.account ||
        record.target.stackId.split(':')[1] !== target.arn.split(':')[1])
    )
      throw new Error('Selected account differs from the restore target');
    const cf = createCloudFormationClient(target);
    let stackId = record.target?.stackId;
    try {
      let stack;
      try {
        stack = (
          await cf.send(new DescribeStacksCommand({ StackName: record.config.stack.name }), {
            abortSignal: AbortSignal.timeout(30000),
          })
        ).Stacks?.[0];
        if (!stack) throw new Error('AWS returned no restore target identity');
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== 'ValidationError' ||
          error.message !== `Stack with id ${record.config.stack.name} does not exist`
        )
          throw error;
      }
      if (stack) {
        if (
          !stack.StackId ||
          !stack.StackId.startsWith(
            `arn:${target.arn.split(':')[1]}:cloudformation:${target.region}:${target.account}:stack/${record.config.stack.name}/`,
          ) ||
          (stackId && stackId !== stack.StackId) ||
          !stack.Tags?.some(
            (tag) => tag.Key === 'openclaw-aws:restore-id' && tag.Value === operationId,
          )
        )
          throw new Error('Existing stack is not owned by this restore; nothing was deleted');
        if (
          stack.StackStatus?.endsWith('_IN_PROGRESS') &&
          stack.StackStatus !== 'DELETE_IN_PROGRESS'
        )
          throw new Error('Restore stack is changing; wait before cleanup');
        stackId = stack.StackId;
        assertDeploymentTarget(ctx, {
          stackId,
          stackName: record.config.stack.name,
          stackStatus: stack.StackStatus ?? 'UNKNOWN',
        });
        await removeSourceRecoveryAccess(target, stackId);
        await cf.send(new DeleteStackCommand({ StackName: stackId }), {
          abortSignal: AbortSignal.timeout(30000),
        });
        const waiter = await waitUntilStackDeleteComplete(
          { client: cf, maxWaitTime: 1500 },
          { StackName: stackId },
        );
        if (waiter.state !== 'SUCCESS')
          throw new Error('Restore stack deletion is incomplete; credentials are retained');
      }
      const ssm = createSsmClient(target);
      try {
        await deleteRestoreParameters(ssm, {
          deploymentName: record.name,
          deploymentId: stackId,
          operationId,
        });
      } finally {
        ssm.destroy();
      }
      const outputsFile = getOutputsPathByName(record.name);
      if (fs.existsSync(outputsFile)) {
        const info = fs.lstatSync(outputsFile);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          !stackId ||
          JSON.parse(fs.readFileSync(outputsFile, 'utf8'))[record.config.stack.name]
            ?.DeploymentId !== stackId
        )
          throw new Error('AWS cleanup completed, but local outputs differ and were retained');
        fs.unlinkSync(outputsFile);
      }
      if (configExistsByName(record.name)) {
        if (!isDeepStrictEqual(loadConfigByName(record.name), record.config))
          throw new Error(
            'AWS cleanup completed, but local configuration changed and was retained',
          );
        fs.unlinkSync(ctx.configPath);
      }
      forgetRestoredDeployment(ctx, operationId);
      if (getCurrentName() === record.name) {
        const next = listConfigNames()[0];
        if (next) setCurrentName(next);
        else clearCurrentName();
      }
    } finally {
      cf.destroy();
    }
  });
}
