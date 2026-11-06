import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { CommandContext } from '../cli/utils/context.js';
import type { OpenClawConfig } from '../cli/types/index.js';
import {
  getConfigPathByName,
  getConfigRoot,
  getOutputsPathByName,
  loadConfigByName,
} from '../cli/utils/config.js';
import {
  clearCurrentName,
  getCurrentName,
  listConfigNames,
  setCurrentName,
} from '../cli/utils/config-store.js';
import { validateConfig } from '../cli/utils/config-validation.js';
import { resolveAwsTarget, type AwsTarget } from '../aws/target.js';
import { executeSsm } from '../aws/ssm.js';
import { inspectRecoverySource, sourceHash } from '../aws/recovery-source.js';
import { recoveryArtifactFilenames } from '../aws/recovery-artifact.js';
import {
  installedRecoveryRemoteCommand,
  type ArchiveWorkerMode,
} from '../aws/recovery-delivery.js';
import { recoveryStore, parseVaultUri } from '../aws/recovery-store.js';
import {
  planArchiveDeletion,
  assertArchiveDeletionCurrent,
  deleteArchivedStack,
  auditArchivedCompute,
  deleteArchivedParameters,
  type ArchiveDeletionPlan,
} from '../aws/archive-deletion.js';
import { asUbuntu, shellQuote } from '../openclaw/commands.js';
import {
  archiveMemberIdentity,
  assertArchiveRoster,
  archiveCaptureDigest,
  backupJobDigest,
  object,
  textField,
  parseBackupJob,
  parseMembers,
  type ArchiveMember,
} from '../openclaw/backup-contract.js';
import { parseModelHostTarget } from '../openclaw/model-contract.js';
import {
  createBackup,
  inspectBackup,
  verifyBackup,
  assertIndependentVault,
  backupOperationId,
  type BackupPreparation,
  type BackupReceipt,
} from './backup.js';
import { readRecoveryVault } from './vault.js';
import { withDeploymentLock, type DeploymentLease } from './lock.js';
import { assertDeploymentTarget, loadDeploymentState } from './state.js';

export interface ArchivePlan {
  schemaVersion: 1;
  kind: 'openclaw-aws-archive';
  operationId: string;
  name: string;
  createdAt: string;
  vaultUri: string;
  config: OpenClawConfig;
  deleteConfig: boolean;
  expectedMembers: ArchiveMember[];
  deletion: ArchiveDeletionPlan;
}
export interface ArchiveResult {
  operationId: string;
  recordedPhase: 'archived';
  completedAt: string;
  name: string;
  sourceStackId: string;
  pointId: string;
  vaultUri: string;
  localConfig: 'deleted' | 'absent' | 'kept' | 'retained-changed';
  retained: string[];
  restoreCommand: string;
  cloneCommand: string;
}
const key = (id: string, name: string) => `archives/${backupOperationId(id)}/${name}.json`;
function snapshot(config: OpenClawConfig): OpenClawConfig {
  validateConfig(config);
  const publicConfig: OpenClawConfig = {
    version: config.version,
    aws: {
      region: config.aws.region,
      ...(config.aws.profile ? { profile: config.aws.profile } : {}),
    },
    network: { useDefaultVpc: config.network.useDefaultVpc },
    instance: { type: config.instance.type, name: config.instance.name },
    features: { cloudWatchLogs: config.features.cloudWatchLogs },
    stack: { name: config.stack.name },
    ...(config.security
      ? {
          security: {
            enableSsh: config.security.enableSsh,
            sshSourceIp: config.security.sshSourceIp,
          },
        }
      : {}),
    ...(config.openclaw
      ? {
          openclaw: {
            apiProvider: config.openclaw.apiProvider,
            ...(config.openclaw.authMode ? { authMode: config.openclaw.authMode } : {}),
            ...(config.openclaw.model ? { model: config.openclaw.model } : {}),
            ...(config.openclaw.bedrock
              ? { bedrock: { region: config.openclaw.bedrock.region } }
              : {}),
            ...(config.openclaw.cloudflare
              ? {
                  cloudflare: {
                    accountId: config.openclaw.cloudflare.accountId,
                    gatewayId: config.openclaw.cloudflare.gatewayId,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  return JSON.parse(JSON.stringify(publicConfig)) as OpenClawConfig;
}
function cache(plan: ArchivePlan, name: string, value: object) {
  const directory = path.join(getConfigRoot(), 'archives', plan.operationId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${name}.json`);
  const body = JSON.stringify(value);
  try {
    fs.writeFileSync(filename, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const info = fs.lstatSync(filename);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !isDeepStrictEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), value)
    )
      throw new Error('Local archive cache differs; independent remote receipts were retained', {
        cause: error,
      });
  }
}
/** Read-only concrete approval plan. A team caller supplies its exact whole
 * roster; partial member coverage never authorizes deleting a shared host.
 */
export async function planArchive(
  ctx: CommandContext,
  options: {
    vaultUri: string;
    operationId?: string;
    deleteConfig?: boolean;
    expectedMembers?: ArchiveMember[];
  },
): Promise<ArchivePlan> {
  const operationId = backupOperationId(options.operationId);
  parseVaultUri(options.vaultUri);
  const source = await inspectRecoverySource(ctx);
  assertIndependentVault(source, await readRecoveryVault(ctx.target, options.vaultUri));
  const members = archiveMemberIdentity(
    parseMembers(
      JSON.parse(
        (
          await executeSsm(
            source.instanceId,
            ctx.target,
            [asUbuntu('openclaw agents list --json')],
            { executionSeconds: 120 },
          )
        ).stdout,
      ),
    ),
  );
  if (options.expectedMembers) assertArchiveRoster(options.expectedMembers, members);
  return {
    schemaVersion: 1,
    kind: 'openclaw-aws-archive',
    operationId,
    name: ctx.name,
    createdAt: new Date().toISOString(),
    vaultUri: options.vaultUri,
    config: snapshot(ctx.config),
    deleteConfig: options.deleteConfig ?? true,
    expectedMembers: members,
    deletion: await planArchiveDeletion(ctx.target, ctx.name, source),
  };
}
function parsePlan(value: unknown, target: AwsTarget, uri: string, id: string): ArchivePlan {
  const row = object(value),
    deletion = object(row.deletion),
    source = object(deletion.source),
    role = object(source.role),
    profile = object(source.profile);
  const name = textField(row.name, 50),
    config = snapshot(row.config as OpenClawConfig);
  const host = parseModelHostTarget({
    deploymentName: name,
    stackId: source.stackId,
    instanceId: source.instanceId,
    roleId: role.id,
    account: target.account,
    region: target.region,
  });
  if (
    row.schemaVersion !== 1 ||
    row.kind !== 'openclaw-aws-archive' ||
    row.operationId !== backupOperationId(id) ||
    row.vaultUri !== uri ||
    config.aws.region !== target.region ||
    source.stackName !== config.stack.name ||
    !host.stackId.startsWith(
      `arn:${target.arn.split(':')[1]}:cloudformation:${target.region}:${target.account}:stack/${config.stack.name}/`,
    ) ||
    deletion.deploymentName !== name ||
    typeof row.deleteConfig !== 'boolean' ||
    !/^[a-f0-9]{64}$/.test(String(deletion.templateDigest)) ||
    !/^vol-[a-f0-9]{8,17}$/.test(String(deletion.volumeId)) ||
    !Array.isArray(deletion.parameters) ||
    !Number.isFinite(Date.parse(textField(row.createdAt, 64)))
  )
    throw new Error('Archive receipt has inconsistent source ownership');
  if (
    role.arn !==
      `arn:${target.arn.split(':')[1]}:iam::${target.account}:role/${textField(role.name, 64)}` ||
    !String(profile.arn).startsWith(
      `arn:${target.arn.split(':')[1]}:iam::${target.account}:instance-profile/`,
    ) ||
    typeof profile.id !== 'string'
  )
    throw new Error('Archive role/profile identity is invalid');
  const parameters = deletion.parameters.map((value) => {
    const p = object(value),
      name = textField(p.name),
      arn = textField(p.arn);
    if (
      !name.startsWith(`/openclaw/${host.deploymentName}/`) ||
      arn !==
        `arn:${target.arn.split(':')[1]}:ssm:${target.region}:${target.account}:parameter${name}` ||
      !Number.isSafeInteger(p.version) ||
      (p.version as number) < 1 ||
      !Number.isFinite(Date.parse(textField(p.modifiedAt, 64)))
    )
      throw new Error('Archive credential receipt is invalid');
    return { name, arn, version: p.version as number, modifiedAt: p.modifiedAt as string };
  });
  const result: ArchivePlan = {
    schemaVersion: 1,
    kind: 'openclaw-aws-archive',
    operationId: id,
    name,
    createdAt: row.createdAt as string,
    vaultUri: uri,
    config,
    deleteConfig: row.deleteConfig,
    expectedMembers: archiveMemberIdentity(parseMembers(row.expectedMembers)),
    deletion: {
      deploymentName: name,
      source: source as unknown as ArchiveDeletionPlan['source'],
      templateDigest: deletion.templateDigest as string,
      volumeId: deletion.volumeId as string,
      parameters,
    },
  };
  if (
    new Set(parameters.map((p) => p.name)).size !== parameters.length ||
    !parameters.some((p) => p.name === `/openclaw/${name}/gateway-token`)
  )
    throw new Error('Archive credential namespace reservation is missing');
  return result;
}
function parsePreparation(value: unknown, plan: ArchivePlan): BackupPreparation {
  const row = object(value),
    job = parseBackupJob(row.job),
    artifact = object(row.artifact),
    request = object(row.request);
  const location = parseVaultUri(plan.vaultUri),
    source = plan.deletion.source;
  if (
    job.operationId !== plan.operationId ||
    job.source.stackId !== source.stackId ||
    job.source.instanceId !== source.instanceId ||
    job.source.roleId !== source.role.id ||
    job.settings.bucket !== location.bucket ||
    job.settings.prefix !== `${location.prefix}/native/${sourceHash(source.stackId)}` ||
    job.archive?.deploymentName !== plan.name ||
    !isDeepStrictEqual(job.archive.expectedMembers, plan.expectedMembers) ||
    !Array.isArray(artifact.files) ||
    artifact.files.length !== recoveryArtifactFilenames.length
  )
    throw new Error('Archive delivery belongs to another approved source/roster');
  const files = artifact.files.map((value, index) => {
    const file = object(value),
      name = textField(file.name),
      versionId = textField(file.versionId, 1024),
      sha256 = textField(file.sha256, 64);
    if (
      name !== recoveryArtifactFilenames[index] ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      file.key !== `${job.settings.prefix}/_tools/${artifact.digest}/${name}` ||
      versionId === 'null'
    )
      throw new Error('Archive delivery artifact pins are invalid');
    return { name, key: file.key as string, versionId, sha256 };
  });
  const digest = createHash('sha256')
    .update(JSON.stringify(files.map((f) => [f.name, f.sha256])))
    .digest('hex');
  if (
    digest !== artifact.digest ||
    job.pluginDirectory !== `/home/ubuntu/.openclaw-aws/plugins/${digest}` ||
    request.key !== `${job.settings.prefix}/_operations/${plan.operationId}/request.json` ||
    request.sha256 !== backupJobDigest(job) ||
    request.versionId === 'null'
  )
    throw new Error('Archive delivery checksum or request identity changed');
  return {
    job,
    source,
    artifact: { digest, files },
    request: {
      key: request.key as string,
      versionId: textField(request.versionId, 1024),
      sha256: request.sha256 as string,
    },
  };
}
async function control(
  ctx: CommandContext,
  preparation: BackupPreparation,
  mode: ArchiveWorkerMode,
) {
  const result = await executeSsm(
    preparation.source.instanceId,
    ctx.target,
    [
      installedRecoveryRemoteCommand({
        operationId: preparation.job.operationId,
        pluginDirectory: preparation.job.pluginDirectory,
        artifact: preparation.artifact,
        requestSha256: preparation.request.sha256,
        mode,
      }),
    ],
    { executionSeconds: 300 },
  );
  const row = object(JSON.parse(result.stdout));
  if (row.ok !== true || row.operationId !== preparation.job.operationId)
    throw new Error('Archive host control was not confirmed; inspect the original operation');
  const phases = [
    'not-started',
    'capture-uncertain',
    'verified-held',
    'aborting',
    'aborted',
    'destroy-committed',
  ];
  if (!phases.includes(String(row.recordedPhase)))
    throw new Error('Archive host returned an unsupported lifecycle state');
  if (
    mode === 'archive-commit' &&
    (!/^[a-f0-9]{64}$/.test(String(row.requestDigest)) ||
      !/^[a-f0-9]{64}$/.test(String(row.captureDigest)))
  )
    throw new Error('Archive teardown certificate is incomplete');
  return {
    operationId: preparation.job.operationId,
    recordedPhase: row.recordedPhase as string,
    gatewayHeld: typeof row.gatewayHeld === 'boolean' ? row.gatewayHeld : null,
    ...(typeof row.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(row.requestDigest)
      ? { requestDigest: row.requestDigest }
      : {}),
    ...(typeof row.captureDigest === 'string' && /^[a-f0-9]{64}$/.test(row.captureDigest)
      ? { captureDigest: row.captureDigest }
      : {}),
  };
}
function localCleanup(ctx: CommandContext, plan: ArchivePlan): ArchiveResult['localConfig'] {
  if (!plan.deleteConfig) return 'kept';
  const filename = getConfigPathByName(plan.name);
  if (!fs.existsSync(filename)) return 'absent';
  const state = loadDeploymentState(ctx);
  if (
    !state ||
    state.identity.stackId !== plan.deletion.source.stackId ||
    !isDeepStrictEqual(snapshot(loadConfigByName(plan.name)), plan.config)
  )
    return 'retained-changed';
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) return 'retained-changed';
  fs.unlinkSync(filename);
  const output = getOutputsPathByName(plan.name);
  if (fs.existsSync(output)) {
    const info = fs.lstatSync(output);
    if (
      info.isFile() &&
      !info.isSymbolicLink() &&
      JSON.parse(fs.readFileSync(output, 'utf8'))[plan.config.stack.name]?.DeploymentId ===
        plan.deletion.source.stackId
    )
      fs.unlinkSync(output);
  }
  const stateFile = path.join(getConfigRoot(), 'deployments', `${plan.name}.json`);
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  if (getCurrentName() === plan.name) {
    const next = listConfigNames()[0];
    if (next) setCurrentName(next);
    else clearCurrentName();
  }
  return 'deleted';
}
function result(
  plan: ArchivePlan,
  completedAt: string,
  localConfig: ArchiveResult['localConfig'],
  profile?: string,
): ArchiveResult {
  const region = plan.config.aws.region;
  const recovery = `--from ${plan.operationId} --vault ${shellQuote(plan.vaultUri)} --region ${region}${profile ? ` --profile ${shellQuote(profile)}` : ''}`;
  return {
    operationId: plan.operationId,
    recordedPhase: 'archived',
    completedAt,
    name: plan.name,
    sourceStackId: plan.deletion.source.stackId,
    pointId: plan.operationId,
    vaultUri: plan.vaultUri,
    localConfig,
    retained: [
      `Independent backup vault ${plan.vaultUri}`,
      'Independent recovery key and retained object versions',
      'Shared CDK bootstrap resources',
      ...(plan.config.network.useDefaultVpc ? ['Shared/default VPC'] : []),
    ],
    restoreCommand: `openclaw-aws restore ${recovery} --name ${plan.name}`,
    cloneCommand: `openclaw-aws clone ${recovery} --name ${plan.name.slice(0, 45)}-copy`,
  };
}
async function finish(
  ctx: CommandContext,
  plan: ArchivePlan,
  preparation: BackupPreparation,
  point: BackupReceipt,
  store: ReturnType<typeof recoveryStore>,
): Promise<ArchiveResult> {
  if (
    !isDeepStrictEqual(point.job, preparation.job) ||
    point.capture.gateway.held?.requestDigest !== backupJobDigest(preparation.job)
  )
    throw new Error('Archive requires its own verified held-source recovery point');
  const committed = await store.read(key(plan.operationId, 'destroy-intent'));
  const certificate = {
    operationId: plan.operationId,
    requestDigest: backupJobDigest(point.job),
    captureDigest: archiveCaptureDigest(point.capture, point.job),
  };
  if (committed) {
    if (!isDeepStrictEqual(committed.value, certificate))
      throw new Error('Archive teardown receipt has different ownership');
  } else {
    const commitAttempt = await store.read(key(plan.operationId, 'host-commit-intent'));
    try {
      await verifyBackup(ctx.target, plan.vaultUri, plan.operationId);
      await assertArchiveDeletionCurrent(ctx.target, plan.deletion);
    } catch {
      if (commitAttempt)
        throw new Error(
          'Committed archive preflight changed; teardown was refused and the source hold was retained',
        );
      let restored = false;
      try {
        const abort = await control(ctx, preparation, 'archive-abort');
        restored = abort.recordedPhase === 'aborted';
        if (restored)
          await store.putImmutable(key(plan.operationId, 'aborted'), {
            operationId: plan.operationId,
            recordedPhase: 'aborted',
          });
      } catch {
        /* Preserve uncertainty and the independent point. */
      }
      throw new Error(
        restored
          ? 'Archive verification/preflight failed; original service state was restored, and no teardown occurred'
          : 'Archive verification/preflight failed; source restoration is unconfirmed. Inspect the retained operation and recovery point',
      );
    }
    await store.putImmutable(key(plan.operationId, 'host-commit-intent'), certificate);
    const native = await control(ctx, preparation, 'archive-commit');
    if (
      native.recordedPhase !== 'destroy-committed' ||
      native.requestDigest !== certificate.requestDigest ||
      native.captureDigest !== certificate.captureDigest
    )
      throw new Error('Native teardown commitment does not match the retained recovery point');
    await store.putImmutable(key(plan.operationId, 'destroy-intent'), certificate);
  }
  await deleteArchivedStack(ctx.target, plan.deletion);
  await auditArchivedCompute(ctx.target, plan.deletion);
  await deleteArchivedParameters(ctx.target, plan.deletion);
  const localConfig = localCleanup(ctx, plan);
  const existing = await store.read(key(plan.operationId, 'completed'));
  const completedAt = existing
    ? textField(object(existing.value).completedAt, 64)
    : new Date().toISOString();
  await store.putImmutable(key(plan.operationId, 'completed'), {
    schemaVersion: 1,
    operationId: plan.operationId,
    sourceStackId: plan.deletion.source.stackId,
    completedAt,
  });
  const output = result(plan, completedAt, localConfig, ctx.target.profile);
  cache(plan, 'completed', output);
  return output;
}
async function execute(
  ctx: CommandContext,
  plan: ArchivePlan,
  store: ReturnType<typeof recoveryStore>,
  lock: DeploymentLease,
  preparation?: BackupPreparation,
) {
  const current = await inspectRecoverySource(ctx);
  if (
    current.stackId !== plan.deletion.source.stackId ||
    current.instanceId !== plan.deletion.source.instanceId ||
    current.role.id !== plan.deletion.source.role.id ||
    current.profile.id !== plan.deletion.source.profile.id
  )
    throw new Error('Archive source was replaced; no backup permissions or teardown were applied');
  assertDeploymentTarget(ctx, {
    stackId: plan.deletion.source.stackId,
    stackName: plan.config.stack.name,
    stackStatus: 'CREATE_COMPLETE',
    instanceId: plan.deletion.source.instanceId,
  });
  if (await store.read(key(plan.operationId, 'aborted')))
    throw new Error(
      'Archive was aborted; create a new operation instead of reusing its final backup',
    );
  let prepared = preparation;
  const point = await createBackup(ctx, {
    vaultUri: plan.vaultUri,
    operationId: plan.operationId,
    label: 'archive',
    archive: { deploymentName: plan.name, expectedMembers: plan.expectedMembers },
    lock,
    preparation,
    beforeCapture: async (value) => {
      prepared = parsePreparation(value, plan);
      await store.putImmutable(key(plan.operationId, 'preparation'), prepared);
      cache(plan, 'preparation', prepared);
    },
  });
  if (!prepared) {
    const saved = await store.read(key(plan.operationId, 'preparation'));
    if (saved) prepared = parsePreparation(saved.value, plan);
  }
  if (!prepared)
    throw new Error('Archive has no pinned host delivery receipt; no teardown occurred');
  return finish(ctx, plan, prepared, point, store);
}
export async function createArchive(
  ctx: CommandContext,
  approved: ArchivePlan,
): Promise<ArchiveResult> {
  const plan = parsePlan(approved, ctx.target, approved.vaultUri, approved.operationId);
  if (ctx.name !== plan.name || !isDeepStrictEqual(snapshot(ctx.config), plan.config))
    throw new Error('Archive configuration changed after approval');
  return withDeploymentLock(ctx, async (lock) => {
    const store = recoveryStore(ctx.target, plan.vaultUri);
    try {
      await store.putImmutable(key(plan.operationId, 'intent'), plan);
      cache(plan, 'intent', plan);
      return await execute(ctx, plan, store, lock);
    } finally {
      store.close();
    }
  });
}
async function readArchive(target: AwsTarget, uri: string, id: string) {
  const store = recoveryStore(target, uri);
  try {
    const saved = await store.read(key(id, 'intent'));
    if (!saved) throw new Error('No archive operation exists in this independent vault');
    const plan = parsePlan(saved.value, target, uri, id);
    const prep = await store.read(key(id, 'preparation'));
    const preparation = prep ? parsePreparation(prep.value, plan) : undefined;
    const completed = await store.read(key(id, 'completed'));
    return { plan, preparation, completed: completed?.value };
  } finally {
    store.close();
  }
}
function context(plan: ArchivePlan, target: AwsTarget): CommandContext {
  return {
    name: plan.name,
    config: plan.config,
    target,
    configPath: getConfigPathByName(plan.name),
    awsEnv: {},
  };
}
export async function resumeArchive(options: {
  vaultUri: string;
  operationId: string;
  region: string;
  profile?: string;
}): Promise<ArchiveResult> {
  const target = await resolveAwsTarget({ region: options.region, profile: options.profile });
  const { plan, preparation, completed } = await readArchive(
    target,
    options.vaultUri,
    backupOperationId(options.operationId),
  );
  if (completed) {
    const row = object(completed);
    if (row.operationId !== plan.operationId || row.sourceStackId !== plan.deletion.source.stackId)
      throw new Error('Completed archive receipt has inconsistent identity');
    return result(
      plan,
      textField(row.completedAt, 64),
      plan.deleteConfig
        ? fs.existsSync(getConfigPathByName(plan.name))
          ? 'retained-changed'
          : 'absent'
        : 'kept',
      target.profile,
    );
  }
  const ctx = context(plan, target),
    store = recoveryStore(target, plan.vaultUri);
  try {
    return await withDeploymentLock(ctx, async (lock) => {
      if (await store.read(key(plan.operationId, 'destroy-intent'))) {
        if (!preparation) throw new Error('Archive teardown lacks its pinned delivery receipt');
        return finish(
          ctx,
          plan,
          preparation,
          await inspectBackup(target, plan.vaultUri, plan.operationId),
          store,
        );
      }
      return execute(ctx, plan, store, lock, preparation);
    });
  } finally {
    store.close();
  }
}
export async function inspectArchive(options: {
  vaultUri: string;
  operationId: string;
  region: string;
  profile?: string;
}) {
  const target = await resolveAwsTarget({ region: options.region, profile: options.profile });
  const { plan, preparation, completed } = await readArchive(
    target,
    options.vaultUri,
    backupOperationId(options.operationId),
  );
  if (completed)
    return {
      operationId: plan.operationId,
      name: plan.name,
      recordedPhase: 'archived',
      sourceStackId: plan.deletion.source.stackId,
      pointId: plan.operationId,
      vaultUri: plan.vaultUri,
    };
  if (!preparation)
    return {
      operationId: plan.operationId,
      name: plan.name,
      recordedPhase: 'prepared',
      gatewayHeld: null,
    };
  try {
    return {
      name: plan.name,
      ...(await control(context(plan, target), preparation, 'archive-inspect')),
    };
  } catch {
    return {
      operationId: plan.operationId,
      name: plan.name,
      recordedPhase: 'unconfirmed',
      gatewayHeld: null,
      pointId: plan.operationId,
      vaultUri: plan.vaultUri,
    };
  }
}
export async function abortArchive(options: {
  vaultUri: string;
  operationId: string;
  region: string;
  profile?: string;
}) {
  const target = await resolveAwsTarget({ region: options.region, profile: options.profile });
  const { plan, preparation, completed } = await readArchive(
    target,
    options.vaultUri,
    backupOperationId(options.operationId),
  );
  if (completed) throw new Error('An archived deployment cannot be resumed by abort; use restore');
  const ctx = context(plan, target),
    store = recoveryStore(target, plan.vaultUri);
  try {
    return await withDeploymentLock(ctx, async () => {
      if (await store.read(key(plan.operationId, 'destroy-intent')))
        throw new Error('Archive teardown is committed; use resume to finish cleanup');
      if (!preparation)
        throw new Error('No pinned source operation exists; inspect before aborting');
      const observed = await control(ctx, preparation, 'archive-inspect');
      const response =
        observed.recordedPhase === 'aborted'
          ? observed
          : await control(ctx, preparation, 'archive-abort');
      if (response.recordedPhase !== 'aborted')
        throw new Error('Archive source restoration was not confirmed');
      await store.putImmutable(key(plan.operationId, 'aborted'), {
        operationId: plan.operationId,
        recordedPhase: 'aborted',
      });
      return {
        operationId: plan.operationId,
        recordedPhase: 'aborted',
        pointId: plan.operationId,
        vaultUri: plan.vaultUri,
      };
    });
  } finally {
    store.close();
  }
}
