import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { inspectRestoredSessionHolds } from './restore-session-hold.js';
import {
  verifiedRestoreTarget,
  privateRestoreJson,
  ownedRestoreRecord,
} from './restore-control.js';
import type { RestoreJob } from './restore-contract.js';
import {
  createRecoveryServiceHost,
  assertInactiveRecoveryConfig,
  activateRecoveryService as activateRestoredService,
  type RecoveryActivationHost,
} from './recovery-service.js';
import {
  assertRecoveryMaintenance,
  releaseRecoveryMaintenance,
  adoptRecoveryActivation,
} from './recovery-activation-control.js';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { parse as parseDotenv } from 'dotenv';
import { privateModelText } from './model-journal.js';
import { assertRecoveryBedrockNative } from './recovery-bedrock-native.js';

export interface RestoreActivationResult {
  schemaVersion: 1;
  operationId: string;
  stackId: string;
  instanceId: string;
  phase: 'active-held';
  healthy: true;
  memberCount: number;
  heldSessionCount: number;
}
export type RestoreActivationHost = RecoveryActivationHost;
export { activateRestoredService };

export async function runRestoreActivation(
  input: RestoreJob,
  signal?: AbortSignal,
): Promise<RestoreActivationResult> {
  const context = await verifiedRestoreTarget(input, signal, { allowActive: true });
  const { job, root, work, owner, packageJson, operationId, home, digest } = context;
  const ready = await privateRestoreJson(path.join(work, 'ready.json'));
  if (
    ready.operationId !== operationId ||
    ready.stackId !== job.target.stackId ||
    ready.instanceId !== job.target.instanceId ||
    ready.phase !== 'ready-inactive' ||
    ready.memberCount !== job.backup.capture.members.length ||
    !Number.isSafeInteger(ready.heldSessionCount) ||
    (ready.heldSessionCount as number) < 0
  )
    throw new Error('Restore is not certified ready for deliberate activation');
  const result: RestoreActivationResult = {
    schemaVersion: 1,
    operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    phase: 'active-held',
    healthy: true,
    memberCount: ready.memberCount as number,
    heldSessionCount: ready.heldSessionCount as number,
  };
  const ssm = new SSMClient({ region: job.target.region, credentials: context.credentials });
  let gatewayToken: string;
  try {
    const name = `/openclaw/${job.target.deploymentName}/gateway-token`;
    const token = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
      context.request(),
    );
    if (
      token.Parameter?.Name !== name ||
      token.Parameter.Type !== 'SecureString' ||
      !token.Parameter.Value
    )
      throw new Error('Fresh target Gateway credential is unavailable');
    gatewayToken = token.Parameter.Value;
  } finally {
    ssm.destroy();
  }
  const require = createRequire(packageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/config-mutation')).href
  )) as typeof import('openclaw/plugin-sdk/config-mutation');
  const validate = async () => {
    const snapshot = await sdk.readConfigFileSnapshotForWrite();
    if (!snapshot.snapshot.valid || !snapshot.snapshot.sourceConfig)
      throw new Error('Restored configuration is not valid');
    assertInactiveRecoveryConfig(snapshot.snapshot.sourceConfig, gatewayToken);
    if (job.bedrock)
      await assertRecoveryBedrockNative({
        config: snapshot.snapshot.sourceConfig,
        environment: parseDotenv(await privateModelText(path.join(home, '.openclaw/.env'))),
        home,
        deploymentRegion: job.target.region,
        intent: job.bedrock.intent,
      });
    const held = await inspectRestoredSessionHolds({
      owner,
      members: job.backup.capture.members,
      nativePackageJson: packageJson,
      journal: path.join(work, 'session-hold.json'),
    });
    if (held.held !== ready.heldSessionCount)
      throw new Error('Restored session hold count changed');
  };
  const service = createRecoveryServiceHost({
    home,
    work,
    packageJson,
    gatewayToken,
    signal,
    ...(job.bedrock
      ? {
          bedrock: {
            deploymentRegion: job.target.region,
            inferenceRegion: job.bedrock.intent.inferenceRegion,
          },
        }
      : {}),
    validate,
    assertInactive: context.assertInactive,
    commit: async () => {
      await ownedRestoreRecord(activatedFile, result);
      await releaseMaintenance();
    },
  });
  const activatedFile = path.join(work, 'activated.json');
  const releaseMaintenance = () => releaseRecoveryMaintenance(root, job, 'restore', digest);
  if (
    await adoptRecoveryActivation({
      activatedFile,
      expected: result,
      validate,
      health: service.health,
      release: releaseMaintenance,
      assertInactive: context.assertInactive,
      assertMaintenance: () => assertRecoveryMaintenance(root, job, 'restore', digest),
    })
  )
    return result;
  await context.assertInactive();
  await assertRecoveryMaintenance(root, job, 'restore', digest);
  await activateRestoredService(service);
  return result;
}
