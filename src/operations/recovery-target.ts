import fs from 'node:fs';
import path from 'node:path';
import type { AwsTarget } from '../aws/target.js';
import { resolveAwsTarget } from '../aws/target.js';
import { parseRestoreBootstrap } from '../aws/restore-bootstrap.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { OpenClawConfig } from '../cli/types/index.js';
import { configExistsByName, getConfigPathByName, getConfigRoot } from '../cli/utils/config.js';
import { getStackStatus } from '../cli/utils/aws.js';
import { StackNotFoundError } from '../cli/utils/errors.js';
import { validateProjectName } from '../cli/utils/validation.js';
import { validateAWSRegion, validateInstanceCapabilities } from '../cli/utils/aws-validation.js';
import { validateProvisioningConfig } from '../cli/utils/config-validation.js';
import { assertRestoreSecretNamespace } from './deployment.js';
import { backupOperationId, type BackupReceipt } from './backup.js';

/** Shared read-only destination plan for restoring identity or cloning knowledge. */
export async function prepareInactiveRecoveryTarget(options: {
  kind: 'restore' | 'clone';
  recoveryTarget: AwsTarget;
  point: BackupReceipt;
  name?: string;
  region?: string;
  profile?: string;
  instanceType?: string;
  volumeGiB?: number;
  operationId?: string;
  additionalStagingBytes?: number;
  openclaw?: OpenClawConfig['openclaw'];
}) {
  const point = options.point;
  const operationId = backupOperationId(options.operationId);
  const label = options.kind === 'clone' ? 'Clone' : 'Restore';
  if (options.kind === 'clone' && !options.name)
    throw new Error('Clone requires an explicit new deployment name');
  if (
    options.additionalStagingBytes !== undefined &&
    (!Number.isSafeInteger(options.additionalStagingBytes) || options.additionalStagingBytes < 0)
  )
    throw new Error('Recovery staging size is invalid');
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
      `${label} target has local configuration or deployment metadata; select an unused name or explicitly resolve the retained deployment`,
    );
  const minimum = Math.max(
    30,
    // Native restore retains the downloaded archive while extracting data. The
    // saved source capacity covers its data/runtime; reserve archive space too.
    point.source.instance.minimumDiskGiB +
      Math.ceil(point.capture.capture.location.storedBytes / 1024 ** 3) +
      Math.ceil((options.additionalStagingBytes ?? 0) / 1024 ** 3) +
      1,
  );
  const bootstrap = parseRestoreBootstrap({
    operationId,
    runtime: point.capture.runtime,
    volumeGiB: options.volumeGiB ?? minimum,
  });
  if (bootstrap.volumeGiB < minimum)
    throw new Error(
      `${label} volume must be at least ${minimum} GiB for the saved disk and staged data`,
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
      `${label} requires the recovery vault and target in the same AWS account and partition`,
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
    ...(options.openclaw ? { openclaw: structuredClone(options.openclaw) } : {}),
  };
  if (options.kind === 'clone') validateProvisioningConfig(config, { clonedModelPolicy: true });
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
      `${label} target stack already exists; recovery never replaces a live deployment`,
    );
  } catch (error) {
    if (!(error instanceof StackNotFoundError)) throw error;
  }
  await assertRestoreSecretNamespace(context);
  await validateAWSRegion(target);
  await validateInstanceCapabilities(config.instance.type, target);
  return { operationId, point, context, bootstrap };
}
