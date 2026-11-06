import fs from 'node:fs';
import path from 'node:path';
import type { AwsTarget } from '../aws/target.js';
import { resolveAwsTarget } from '../aws/target.js';
import { inspectRecoveryPresence, type RecoveryPresence } from '../aws/recovery-presence.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { OpenClawConfig } from '../cli/types/index.js';
import { configExistsByName, getConfigPathByName, getConfigRoot } from '../cli/utils/config.js';
import { getStackStatus } from '../cli/utils/aws.js';
import { StackNotFoundError } from '../cli/utils/errors.js';
import { validateProjectName } from '../cli/utils/validation.js';
import { validateAWSRegion, validateInstanceCapabilities } from '../cli/utils/aws-validation.js';
import { assertRestoreSecretNamespace } from './deployment.js';
import { backupOperationId, inspectBackup, verifyBackup, type BackupReceipt } from './backup.js';

export interface RestorePlan {
  schemaVersion: 1;
  operationId: string;
  point: BackupReceipt;
  context: CommandContext;
  bootstrap: RestoreBootstrap;
  sourcePresence: RecoveryPresence;
  prerequisites: string[];
}

/** Read-only intake for CLI and dashboard. No source config, source disk or old SSM key.
 * An inspected plan is not authority to restore while a source is still live.
 */
export async function prepareRestore(options: {
  recoveryTarget: AwsTarget;
  vaultUri: string;
  pointId: string;
  name?: string;
  region?: string;
  profile?: string;
  instanceType?: string;
  volumeGiB?: number;
  operationId?: string;
}): Promise<RestorePlan> {
  const operationId = backupOperationId(options.operationId);
  const point = await inspectBackup(options.recoveryTarget, options.vaultUri, options.pointId);
  const name = options.name ?? point.source.stackName.replace(/^OpenclawStack-/, '');
  const validation = validateProjectName(name);
  if (validation !== true) throw new Error(String(validation));
  if (
    configExistsByName(name) ||
    ['deployments', 'outputs'].some((directory) =>
      fs.existsSync(path.join(getConfigRoot(), directory, `${name}.json`)),
    )
  )
    throw new Error(
      'Restore target has local configuration or deployment metadata; select an unused name or explicitly resolve the retained deployment',
    );
  const minimum = Math.max(
    30,
    point.source.instance.minimumDiskGiB,
    Math.ceil(point.capture.capture.location.plaintextBytes / 1024 ** 3) + 8,
  );
  const bootstrap = parseRestoreBootstrap({
    operationId,
    runtime: point.capture.runtime,
    volumeGiB: options.volumeGiB ?? minimum,
  });
  if (bootstrap.volumeGiB < minimum)
    throw new Error(
      `Restore volume must be at least ${minimum} GiB for the saved disk and staged data`,
    );
  const target = await resolveAwsTarget({
    region: options.region ?? point.job.source.region,
    profile: options.profile ?? options.recoveryTarget.profile,
  });
  if (
    target.account !== options.recoveryTarget.account ||
    target.arn.split(':')[1] !== options.recoveryTarget.arn.split(':')[1]
  )
    throw new Error(
      'Restore requires the recovery vault and target in the same AWS account and partition',
    );
  const config: OpenClawConfig = {
    version: '1.0',
    aws: { region: target.region, ...(target.profile ? { profile: target.profile } : {}) },
    network: { useDefaultVpc: true },
    instance: {
      type: options.instanceType ?? point.source.instance.type,
      name: `openclaw-${name}`,
    },
    features: { cloudWatchLogs: false },
    stack: { name: `OpenclawStack-${name}` },
  };
  const context: CommandContext = {
    name,
    config,
    configPath: getConfigPathByName(name),
    target,
    awsEnv: {},
  };
  try {
    await getStackStatus(config.stack.name, target);
    throw new Error(
      'Restore target stack already exists; restore never replaces a live deployment',
    );
  } catch (error) {
    if (!(error instanceof StackNotFoundError)) throw error;
  }
  await assertRestoreSecretNamespace(context);
  await validateAWSRegion(target);
  await validateInstanceCapabilities(config.instance.type, target);
  const sourcePresence = await inspectRecoveryPresence(options.recoveryTarget, point.job.source);
  // Full native decryption/inventory/database verification precedes any provisioning.
  await verifyBackup(options.recoveryTarget, options.vaultUri, options.pointId);
  return {
    schemaVersion: 1,
    operationId,
    point,
    context,
    bootstrap,
    sourcePresence,
    prerequisites: [
      ...point.capture.credentials.prerequisites,
      ...point.capture.omissions,
      'Gateway credentials are rotated; reconnect clients and review device/channel pairing before enabling integrations.',
      'Restoration starts with messaging, scheduled work and replay paths inactive; reactivation is a separate deliberate step.',
      ...(sourcePresence.kind !== 'gone'
        ? [
            'The source identity is still present. Terminate it or complete a separately verified persistent takeover before activation.',
          ]
        : []),
    ],
  };
}
