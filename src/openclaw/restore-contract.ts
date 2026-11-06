import {
  object,
  parseBackupJob,
  parseCapturedBackup,
  textField,
  type BackupCaptureJob,
  type CapturedBackup,
} from './backup-contract.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';
import { isDeepStrictEqual } from 'node:util';
import { parseBedrockRecoveryPlan, type BedrockRecoveryPlan } from './bedrock-recovery-plan.js';

export interface RestoreJob {
  schemaVersion: 1;
  bootstrap: RestoreBootstrap;
  target: {
    deploymentName: string;
    stackId: string;
    instanceId: string;
    roleId: string;
    account: string;
    region: string;
  };
  backup: { job: BackupCaptureJob; capture: CapturedBackup };
  pluginDirectory: string;
  bedrock?: BedrockRecoveryPlan;
}
export function parseRestoreJob(value: unknown, options: { kind?: 'clone' } = {}): RestoreJob {
  const row = object(value);
  if (
    (options.kind === 'clone' && row.kind !== 'clone') ||
    (row.kind !== undefined && row.kind !== (options.kind ?? 'restore'))
  )
    throw new Error('Recovery request kind differs from the selected workflow');
  if (row.schemaVersion !== 1) throw new Error('Invalid restore job version');
  const bootstrap = parseRestoreBootstrap(row.bootstrap);
  const target = object(row.target);
  const backup = object(row.backup);
  const job = parseBackupJob(backup.job);
  const capture = parseCapturedBackup(backup.capture, job);
  const deploymentName = textField(target.deploymentName, 50);
  const region = textField(target.region, 64);
  const account = textField(target.account, 12);
  const stackId = textField(target.stackId, 2048);
  const instanceId = textField(target.instanceId, 32);
  const roleId = textField(target.roleId, 128);
  const pluginDirectory = textField(row.pluginDirectory);
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(deploymentName) ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region) ||
    account !== job.source.account ||
    !new RegExp(
      `^arn:${job.source.stackId.split(':')[1]}:cloudformation:${region}:${account}:stack/OpenclawStack-${deploymentName}/[A-Za-z0-9-]+$`,
    ).test(stackId) ||
    !/^i-[a-f0-9]{8,17}$/.test(instanceId) ||
    !/^\/home\/ubuntu\/\.openclaw-aws\/plugins\/[a-f0-9]{64}$/.test(pluginDirectory) ||
    JSON.stringify(bootstrap.runtime) !== JSON.stringify(capture.runtime)
  )
    throw new Error('Restore target does not match the selected account, deployment or runtime');
  const bedrock =
    row.bedrock === undefined
      ? undefined
      : parseBedrockRecoveryPlan(row.bedrock, {
          account,
          partition: job.source.stackId.split(':')[1],
        });
  if (options.kind !== 'clone' && !isDeepStrictEqual(bedrock?.intent, capture.credentials.bedrock))
    throw new Error('Recovery Bedrock setup differs from the saved native connection intent');
  return {
    schemaVersion: 1,
    bootstrap,
    target: { deploymentName, stackId, instanceId, roleId, region, account },
    backup: { job, capture },
    pluginDirectory,
    ...(bedrock ? { bedrock } : {}),
  };
}
