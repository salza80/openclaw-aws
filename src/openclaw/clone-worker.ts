import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, ListTagsForResourceCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseCloneJob, cloneRequestDigest, type CloneJob } from './clone-contract.js';
import { object } from './backup-contract.js';
import {
  verifiedRestoreTarget,
  ownedRestoreRecord,
  privateRestoreJson,
} from './restore-control.js';
import { stageRecoveryArchive } from './recovery-staging.js';
import { readCloneSourcePolicy } from './clone-source.js';
import { clonePolicyDigest } from './clone-preview.js';
import { planCloneContent } from './clone-content.js';
import { installCloneWorkspaces } from './clone-workspaces.js';
import { initializeNativeClone } from './clone-native.js';
import { verifyNativeClone } from './clone-validate.js';
import { getApiKeyParamName } from '../cli/utils/api-keys.js';
import type { Provider } from '../cli/types/index.js';

export interface CloneWorkerResult {
  schemaVersion: 1;
  kind: 'clone';
  operationId: string;
  stackId: string;
  instanceId: string;
  phase: 'ready-inactive';
  memberCount: number;
  fileCount: number;
  contentDigest: string;
  policyDigest: string;
  configurationHash: string;
  providerParameters: string[];
}

export function cloneTargetMembers(job: CloneJob) {
  return job.backup.capture.members.map((member) => ({
    ...member,
    workspace: `/home/ubuntu/.openclaw/workspaces/${member.id}`,
    agentDir: `/home/ubuntu/.openclaw/agents/${member.id}/agent`,
  }));
}
export function parseCloneWorkerResult(value: unknown, job: CloneJob): CloneWorkerResult {
  const ready = object(value);
  const names = job.credentials.providers.map((provider) =>
    getApiKeyParamName(job.target.deploymentName, provider),
  );
  if (
    ready.schemaVersion !== 1 ||
    ready.kind !== 'clone' ||
    ready.operationId !== job.bootstrap.operationId ||
    ready.stackId !== job.target.stackId ||
    ready.instanceId !== job.target.instanceId ||
    ready.phase !== 'ready-inactive' ||
    ready.contentDigest !== job.preview.contentDigest ||
    ready.policyDigest !== job.preview.policyDigest ||
    ready.memberCount !== job.backup.capture.members.length ||
    !Number.isSafeInteger(ready.fileCount) ||
    (ready.fileCount as number) < 0 ||
    !Array.isArray(ready.providerParameters) ||
    JSON.stringify(ready.providerParameters) !== JSON.stringify(names) ||
    !/^[a-f0-9]{64}$/.test(String(ready.configurationHash))
  )
    throw new Error('Clone completion receipt differs from this request');
  return {
    schemaVersion: 1,
    kind: 'clone',
    operationId: job.bootstrap.operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    phase: 'ready-inactive',
    memberCount: job.backup.capture.members.length,
    fileCount: ready.fileCount as number,
    contentDigest: job.preview.contentDigest,
    policyDigest: job.preview.policyDigest,
    configurationHash: ready.configurationHash as string,
    providerParameters: names,
  };
}

/** The shared entrypoint holds flock; source extraction is never installed as
 * native identity. Every credential is read from this new target's owned SSM paths.
 */
export async function runCloneWorker(
  input: CloneJob,
  signal?: AbortSignal,
): Promise<CloneWorkerResult> {
  const job = parseCloneJob(input);
  const context = await verifiedRestoreTarget(job, signal);
  const { root, work, operationId, owner, credentials, request, assertInactive, packageJson } =
    context;
  const digest = cloneRequestDigest(job);
  const secrets = new SecretsManagerClient({ region: job.backup.job.source.region, credentials });
  const ssm = new SSMClient({ region: job.target.region, credentials });
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    await ownedRestoreRecord(path.join(root, 'maintenance.json'), {
      schemaVersion: 1,
      kind: 'clone',
      operationId,
      stackId: job.target.stackId,
      roleId: job.target.roleId,
      digest,
    });
    await ownedRestoreRecord(path.join(work, 'clone-owner.json'), {
      schemaVersion: 1,
      owner,
      digest,
    });
    // A lost client reply can adopt only the complete receipt. Partial native
    // initialization is retained, never replayed through fresh onboarding.
    try {
      const ready = parseCloneWorkerResult(
        await privateRestoreJson(path.join(work, 'ready.json')),
        job,
      );
      await verifyNativeClone({
        members: cloneTargetMembers(job),
        nativePackageJson: packageJson,
        configurationHash: ready.configurationHash,
        signal,
      });
      await assertInactive();
      return ready;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const { moves, stagingDirectory } = await stageRecoveryArchive({
      job,
      work,
      digest,
      secrets,
      request,
      signal,
      adoptionJournal: 'workspaces.json',
    });
    const policy = await readCloneSourcePolicy({
      configurationPath: job.backup.capture.credentials.configurationPath,
      members: job.backup.capture.members,
      moves,
      stagingDirectory,
      nativePackageJson: packageJson,
      signal,
    });
    const content = await planCloneContent({
      members: job.backup.capture.members,
      moves,
      stagingDirectory,
      credentialPaths: policy.credentialPaths,
      signal,
    });
    if (
      content.digest !== job.preview.contentDigest ||
      clonePolicyDigest(policy) !== job.preview.policyDigest
    )
      throw new Error(
        'Selected clone content/policy differs from the reviewed preview; no native identity was initialized',
      );
    await assertInactive();
    const copied = await installCloneWorkspaces({
      operationId,
      plan: content,
      journal: path.join(work, 'workspaces.json'),
      signal,
    });
    const selected: Partial<Record<Provider, string>> = {};
    const providerParameters: string[] = [];
    for (const provider of job.credentials.providers) {
      const name = getApiKeyParamName(job.target.deploymentName, provider);
      const tags = await ssm.send(
        new ListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: name }),
        request(),
      );
      if (
        ![
          ['openclaw-aws:deployment-id', job.target.stackId],
          ['openclaw-aws:restore-id', operationId],
        ].every(([Key, Value]) =>
          tags.TagList?.some((tag) => tag.Key === Key && tag.Value === Value),
        )
      )
        throw new Error('Clone provider credential belongs to another operation');
      const parameter = await ssm.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
        request(),
      );
      if (
        parameter.Parameter?.Name !== name ||
        parameter.Parameter.Type !== 'SecureString' ||
        !parameter.Parameter.Value
      )
        throw new Error('Explicit target clone provider credential is unavailable');
      selected[provider] = parameter.Parameter.Value;
      providerParameters.push(name);
    }
    const tokenName = `/openclaw/${job.target.deploymentName}/gateway-token`;
    const token = await ssm.send(
      new GetParameterCommand({ Name: tokenName, WithDecryption: true }),
      request(),
    );
    if (
      token.Parameter?.Name !== tokenName ||
      token.Parameter.Type !== 'SecureString' ||
      !token.Parameter.Value
    )
      throw new Error('Fresh clone Gateway credential is unavailable');
    const native = await initializeNativeClone({
      content,
      policy,
      apiProvider: job.credentials.primary,
      providerCredential: selected[job.credentials.primary]!,
      additionalCredentials: selected,
      cloudflareAccountId: job.credentials.cloudflare?.accountId,
      cloudflareGatewayId: job.credentials.cloudflare?.gatewayId,
      gatewayToken: token.Parameter.Value,
      nativePackageJson: packageJson,
      assertInactive,
      signal,
    });
    // Never leave source credentials/history accessible to the fresh Ubuntu
    // agent after activation. Only the explicitly selected files remain.
    await assertInactive();
    await rm(stagingDirectory, { recursive: true, force: true });
    const result: CloneWorkerResult = {
      schemaVersion: 1,
      kind: 'clone',
      operationId,
      stackId: job.target.stackId,
      instanceId: job.target.instanceId,
      phase: 'ready-inactive',
      memberCount: native.members.length,
      fileCount: copied.files,
      contentDigest: content.digest,
      policyDigest: job.preview.policyDigest,
      configurationHash: native.configurationHash,
      providerParameters,
    };
    await ownedRestoreRecord(path.join(work, 'ready.json'), result);
    return result;
  } finally {
    secrets.destroy();
    ssm.destroy();
  }
}
