import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  parseCloneJob,
  cloneRequestDigest,
  parseCloneWorkerResult,
  cloneTargetMembers,
  type CloneJob,
  type CloneActivationResult,
} from './clone-contract.js';
import {
  verifiedRestoreTarget,
  privateRestoreJson,
  ownedRestoreRecord,
} from './restore-control.js';
import { verifyNativeClone } from './clone-validate.js';
import {
  createRecoveryServiceHost,
  activateRecoveryService,
  assertInactiveRecoveryConfig,
} from './recovery-service.js';
import {
  assertRecoveryMaintenance,
  releaseRecoveryMaintenance,
  adoptRecoveryActivation,
} from './recovery-activation-control.js';
import { assertCloneSourceAccessRevoked } from './clone-access.js';

/** Source archive/key permissions must already be removed by the client. This
 * path executes installed pinned code and does not reattach recovery access.
 */
export async function runCloneActivation(
  input: CloneJob,
  signal?: AbortSignal,
): Promise<CloneActivationResult> {
  const job = parseCloneJob(input);
  const context = await verifiedRestoreTarget(job, signal, { allowActive: true, kind: 'clone' });
  const { root, work, operationId, packageJson, home } = context;
  const digest = cloneRequestDigest(job);
  const ready = parseCloneWorkerResult(
    await privateRestoreJson(path.join(work, 'ready.json')),
    job,
  );
  const result: CloneActivationResult = {
    schemaVersion: 1,
    kind: 'clone',
    operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    phase: 'active',
    healthy: true,
    memberCount: ready.memberCount,
    contentDigest: ready.contentDigest,
    policyDigest: ready.policyDigest,
    configurationHash: ready.configurationHash,
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
  const validate = async () => {
    try {
      await lstat(path.join(work, 'staging'));
      throw new Error('Decrypted source staging still exists; clone cannot activate');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await verifyNativeClone({
      members: cloneTargetMembers(job),
      nativePackageJson: packageJson,
      configurationHash: ready.configurationHash,
      signal,
      ...(job.bedrock
        ? { bedrock: { plan: job.bedrock, deploymentRegion: job.target.region } }
        : {}),
      validateConfig(config) {
        assertInactiveRecoveryConfig(config, gatewayToken);
        if (
          Object.keys(config.channels ?? {}).length ||
          Object.keys(config.mcp?.servers ?? {}).length ||
          config.memory?.search?.enabled !== false ||
          config.agents?.defaults?.skipBootstrap !== true ||
          config.agents.defaults.heartbeat?.every !== '0m' ||
          Object.values(config.agents.entries ?? {}).some(
            (agent) => agent.heartbeat?.every !== '0m' || agent.memory?.search?.enabled !== false,
          )
        )
          throw new Error('Clone automatic integrations are not safely disconnected');
      },
    });
    await assertCloneSourceAccessRevoked(job, context.credentials, signal);
  };
  const host = createRecoveryServiceHost({
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
      await releaseRecoveryMaintenance(root, job, 'clone', digest);
    },
  });
  const activatedFile = path.join(work, 'activated.json');
  if (
    await adoptRecoveryActivation({
      activatedFile,
      expected: result,
      validate,
      health: host.health,
      release: () => releaseRecoveryMaintenance(root, job, 'clone', digest),
      assertInactive: context.assertInactive,
      assertMaintenance: () => assertRecoveryMaintenance(root, job, 'clone', digest),
    })
  )
    return result;
  await context.assertInactive();
  await assertRecoveryMaintenance(root, job, 'clone', digest);
  await activateRecoveryService(host);
  return result;
}
