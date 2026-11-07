import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseModelHostTarget } from './model-contract.js';
import {
  parseBedrockRecoveryIntent,
  type BedrockRecoveryIntent,
} from './bedrock-recovery-intent.js';
import { parseSettings } from './aws-s3-plugin/settings.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { parseTeamRecovery, type TeamRecovery } from './team-recovery.js';

export interface BackupCaptureJob {
  schemaVersion: 1;
  operationId: string;
  source: { stackId: string; instanceId: string; roleId: string; account: string; region: string };
  settings: {
    bucket: string;
    region: string;
    prefix: string;
    expectedBucketOwner: string;
    credentialSource: 'instance-role';
  };
  key: { arn: string; versionId: string; versionStage: string };
  pluginDirectory: string;
  namespace: string;
  /** Explicit whole-host archive approval, bound to the preflight roster. */
  archive?: { deploymentName: string; expectedMembers: ArchiveMember[] };
}
export type ArchiveMember = Pick<BackupMember, 'id' | 'workspace' | 'agentDir'>;
export interface BackupAsset {
  kind: string;
  sourcePath: string;
}
export interface BackupMember {
  id: string;
  workspace: string;
  agentDir: string;
  model?: string;
  name?: string;
}
export interface NativeCaptureSummary {
  createdAt: string;
  assets: BackupAsset[];
  agentRoots: { agentId: string; sourcePath: string }[];
  skipped: { kind: string; sourcePath: string; reason: string; coveredBy?: string }[];
  skippedVolatileCount: number;
  warnings: string[];
  location: {
    key: string;
    namespace: string;
    locationId: string;
    plaintextBytes: number;
    storedBytes: number;
  };
}
export interface NativeVerification {
  ok: true;
  runtimeVersion: string;
  createdAt: string;
  archiveRoot: string;
  assetCount: number;
  entryCount: number;
  symlinkCount: number;
  sqliteInventoryVerified: true;
}
export interface CapturedBackup {
  schemaVersion: 1;
  operationId: string;
  runtime: { openclaw: string; node: string };
  capture: NativeCaptureSummary;
  members: BackupMember[];
  verification: NativeVerification;
  objects: Record<string, { versionId: string; storedBytes: number }>;
  credentials: {
    mode: 'full-native';
    configurationPath: string;
    sourceEnvironmentIncluded: boolean;
    prerequisites: string[];
    bedrock?: BedrockRecoveryIntent;
    team?: TeamRecovery;
  };
  omissions: string[];
  gateway: {
    initial: 'active' | 'inactive' | 'failed';
    restored: boolean;
    held?: { kind: 'archive'; operationId: string; requestDigest: string };
  };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native backup result');
  return value as Record<string, unknown>;
}
export function textField(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0'))
    throw new Error('Invalid native backup text field');
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid native backup size or count');
  return value as number;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 4096)
    throw new Error('Native backup inventory is missing or exceeds its limit');
  return value;
}
export function parseBackupJob(value: unknown): BackupCaptureJob {
  const job = object(value);
  const source = object(job.source);
  const settings = parseSettings(object(job.settings));
  const key = object(job.key);
  const operationId = textField(job.operationId, 36);
  if (
    job.schemaVersion !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId) ||
    !/^i-[a-f0-9]{8,17}$/.test(textField(source.instanceId)) ||
    !/^\d{12}$/.test(textField(source.account)) ||
    source.account !== settings.expectedBucketOwner ||
    source.region !== settings.region ||
    settings.credentialSource !== 'instance-role' ||
    !/^arn:[a-z0-9-]+:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z0-9-]+\/[a-zA-Z0-9-]+$/.test(
      textField(source.stackId),
    ) ||
    (source.stackId as string).split(':')[3] !== source.region ||
    (source.stackId as string).split(':')[4] !== source.account
  )
    throw new Error('Backup job does not match a supported source target');
  const roleId = textField(source.roleId, 128);
  const namespace = textField(job.namespace, 128);
  if (!/^[A-Za-z0-9._-]+$/.test(namespace) || ['.', '..'].includes(namespace))
    throw new Error('Invalid backup namespace');
  const arn = textField(key.arn, 2048);
  if (
    !arn.startsWith(
      `arn:${(source.stackId as string).split(':')[1]}:secretsmanager:${source.region}:${source.account}:secret:`,
    ) ||
    !/^[A-Za-z0-9-]{32,64}$/.test(textField(key.versionId, 64)) ||
    !/^openclaw-aws-vault-[a-f0-9]{32}$/.test(textField(key.versionStage, 128))
  )
    throw new Error('Backup job requires an independent retained key version');
  const pluginDirectory = textField(job.pluginDirectory);
  if (!path.isAbsolute(pluginDirectory)) throw new Error('Backup plugin path must be absolute');
  let archive: BackupCaptureJob['archive'];
  if (job.archive !== undefined) {
    const plan = object(job.archive);
    const target = parseModelHostTarget({ ...source, deploymentName: plan.deploymentName });
    archive = {
      deploymentName: target.deploymentName,
      expectedMembers: archiveMemberIdentity(parseMembers(plan.expectedMembers)),
    };
  }
  return {
    schemaVersion: 1,
    operationId,
    source: {
      stackId: source.stackId as string,
      instanceId: source.instanceId as string,
      roleId,
      account: source.account as string,
      region: source.region as string,
    },
    settings: {
      bucket: settings.bucket,
      prefix: settings.prefix,
      region: settings.region,
      expectedBucketOwner: settings.expectedBucketOwner,
      credentialSource: 'instance-role',
    },
    key: { arn, versionId: key.versionId as string, versionStage: key.versionStage as string },
    pluginDirectory,
    namespace,
    ...(archive ? { archive } : {}),
  };
}
export function archiveMemberIdentity(members: BackupMember[]): ArchiveMember[] {
  return members
    .map(({ id, workspace, agentDir }) => ({ id, workspace, agentDir }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function assertArchiveRoster(expected: ArchiveMember[], observed: BackupMember[]) {
  if (!isDeepStrictEqual(archiveMemberIdentity(expected), archiveMemberIdentity(observed)))
    throw new Error('The whole-host archive roster changed; no deletion is authorized');
}
export function backupJobDigest(job: BackupCaptureJob) {
  return createHash('sha256')
    .update(JSON.stringify(parseBackupJob(job)))
    .digest('hex');
}
export function archiveCaptureDigest(capture: CapturedBackup, job: BackupCaptureJob) {
  if (!job.archive) throw new Error('Archive verification requires a whole-host request');
  return createHash('sha256')
    .update(JSON.stringify(parseCapturedBackup(capture, job)))
    .digest('hex');
}
export function parseMembers(value: unknown): BackupMember[] {
  const members = list(value).map((entry) => {
    const row = object(entry);
    return {
      id: textField(row.id, 128),
      workspace: textField(row.workspace),
      agentDir: textField(row.agentDir),
      ...(typeof row.model === 'string' && row.model ? { model: textField(row.model, 512) } : {}),
      ...(typeof row.name === 'string' && row.name ? { name: textField(row.name, 256) } : {}),
    };
  });
  if (!members.length || new Set(members.map((member) => member.id)).size !== members.length)
    throw new Error('Native agent roster is empty or ambiguous');
  return members;
}
export function parseCapture(value: unknown): NativeCaptureSummary {
  const row = object(value);
  const location = object(row.location);
  if (
    row.dryRun !== false ||
    row.includeWorkspace !== true ||
    row.onlyConfig !== false ||
    row.verified !== true
  )
    throw new Error('Native capture is not a verified full installation backup');
  const key = textField(location.key, 128);
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/.test(key))
    throw new Error('Native capture returned an invalid archive key');
  if (row.warnings !== undefined && list(row.warnings).length)
    throw new Error(
      'Native capture reported warnings requiring private inspection before full recovery certification',
    );
  return {
    createdAt: textField(row.createdAt, 64),
    assets: list(row.assets).map((entry) => {
      const asset = object(entry);
      return { kind: textField(asset.kind, 64), sourcePath: textField(asset.sourcePath) };
    }),
    agentRoots: list(row.agentRoots).map((entry) => {
      const root = object(entry);
      return { agentId: textField(root.agentId, 128), sourcePath: textField(root.sourcePath) };
    }),
    skipped: list(row.skipped).map((entry) => {
      const item = object(entry);
      if (!['covered', 'missing', 'regenerable', 'private'].includes(String(item.reason)))
        throw new Error('Native backup reported an unsupported omission');
      return {
        kind: textField(item.kind, 64),
        sourcePath: textField(item.sourcePath),
        reason: item.reason as string,
        ...(typeof item.coveredBy === 'string' ? { coveredBy: textField(item.coveredBy) } : {}),
      };
    }),
    skippedVolatileCount: count(row.skippedVolatileCount),
    warnings: [],
    location: {
      key,
      namespace: textField(location.namespace, 128),
      locationId: textField(location.locationId, 128),
      plaintextBytes: count(location.plaintextBytes),
      storedBytes: count(location.storedBytes),
    },
  };
}
export function parseVerification(value: unknown): NativeVerification {
  const row = object(value);
  if (
    row.ok !== true ||
    row.runtimeVersion !== OPENCLAW_VERSION ||
    row.sqliteInventoryVerified !== true ||
    (row.externalSymbolicLinks !== undefined &&
      (!Array.isArray(row.externalSymbolicLinks) || row.externalSymbolicLinks.length))
  )
    throw new Error(
      'Native remote verification did not prove a compatible complete archive without external links',
    );
  return {
    ok: true,
    runtimeVersion: OPENCLAW_VERSION,
    createdAt: textField(row.createdAt, 64),
    archiveRoot: textField(row.archiveRoot),
    assetCount: count(row.assetCount),
    entryCount: count(row.entryCount),
    symlinkCount: count(row.symlinkCount),
    sqliteInventoryVerified: true,
  };
}
const inside = (root: string, candidate: string) =>
  candidate === root ||
  (!path.relative(root, candidate).startsWith(`..${path.sep}`) &&
    path.relative(root, candidate) !== '..' &&
    !path.isAbsolute(path.relative(root, candidate)));
export function assertMemberCoverage(capture: NativeCaptureSummary, members: BackupMember[]) {
  const state = capture.assets.find((asset) => asset.kind === 'state');
  // Native capture folds config into state without a separate skipped record.
  // The credential inventory proves the actual source configuration path.
  if (
    !state ||
    capture.skipped.some(
      (entry) => entry.kind === 'config' && ['missing', 'private'].includes(entry.reason),
    )
  )
    throw new Error('Native backup omitted installation state or configuration');
  for (const member of members) {
    const agent = capture.agentRoots.find(
      (root) =>
        root.agentId === member.id &&
        path.resolve(root.sourcePath) === path.resolve(member.agentDir),
    );
    if (
      !agent ||
      capture.skipped.some(
        (entry) =>
          entry.reason === 'private' &&
          [member.agentDir, member.workspace].some((root) =>
            inside(path.resolve(root), path.resolve(entry.sourcePath)),
          ),
      ) ||
      !capture.assets.some((asset) =>
        inside(path.resolve(asset.sourcePath), path.resolve(member.agentDir)),
      ) ||
      !capture.assets.some((asset) =>
        inside(path.resolve(asset.sourcePath), path.resolve(member.workspace)),
      )
    )
      throw new Error('Native backup omitted a declared member root or workspace');
  }
}
export const supportedRuntime = { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION };

/** Filter remote metadata through the pinned native contracts before exposing it. */
export function parseCapturedBackup(value: unknown, job: BackupCaptureJob): CapturedBackup {
  const row = object(value);
  const runtime = object(row.runtime);
  const credentials = object(row.credentials);
  const gateway = object(row.gateway);
  if (
    row.schemaVersion !== 1 ||
    row.operationId !== job.operationId ||
    runtime.openclaw !== OPENCLAW_VERSION ||
    runtime.node !== OPENCLAW_NODE_VERSION ||
    credentials.mode !== 'full-native' ||
    typeof credentials.sourceEnvironmentIncluded !== 'boolean' ||
    !['active', 'inactive', 'failed'].includes(String(gateway.initial)) ||
    typeof gateway.restored !== 'boolean'
  )
    throw new Error('Capture metadata does not match the planned operation');
  const capture = parseCapture({
    ...object(row.capture),
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: true,
  });
  const configurationPath = textField(credentials.configurationPath);
  if (
    !capture.assets.some((asset) =>
      inside(path.resolve(asset.sourcePath), path.resolve(configurationPath)),
    )
  )
    throw new Error('Native backup omitted the source configuration');
  const members = parseMembers(row.members);
  let held: CapturedBackup['gateway']['held'];
  if (job.archive) {
    assertArchiveRoster(job.archive.expectedMembers, members);
    const proof = object(gateway.held);
    if (
      gateway.restored !== false ||
      proof.kind !== 'archive' ||
      proof.operationId !== job.operationId ||
      proof.requestDigest !== backupJobDigest(job)
    )
      throw new Error('Archive capture has no matching held-source proof');
    held = {
      kind: 'archive',
      operationId: job.operationId,
      requestDigest: proof.requestDigest as string,
    };
  } else if (gateway.held !== undefined) {
    throw new Error('Ordinary backup cannot adopt an archive service hold');
  }
  const verification = parseVerification(row.verification);
  assertMemberCoverage(capture, members);
  if (
    capture.location.namespace !== job.namespace ||
    verification.createdAt !== capture.createdAt ||
    verification.assetCount !== capture.assets.length
  )
    throw new Error('Capture metadata does not match native remote verification');
  const pins = object(row.objects);
  const names = ['openclaw-storage.json', `backups/${job.namespace}/${capture.location.key}`];
  if (Object.keys(pins).length !== names.length)
    throw new Error('Unexpected recovery object inventory');
  const objects = Object.fromEntries(
    names.map((name) => {
      const pin = object(pins[name]);
      const versionId = textField(pin.versionId, 1024);
      if (versionId === 'null' || [...versionId].some((character) => character.charCodeAt(0) < 32))
        throw new Error('Invalid recovery object version');
      return [name, { versionId, storedBytes: count(pin.storedBytes) }];
    }),
  );
  if (objects[names[1]].storedBytes !== capture.location.storedBytes)
    throw new Error('Recovery object size differs from native archive');
  return {
    schemaVersion: 1,
    operationId: job.operationId,
    runtime: supportedRuntime,
    capture,
    members,
    verification,
    objects,
    credentials: {
      mode: 'full-native',
      configurationPath,
      sourceEnvironmentIncluded: credentials.sourceEnvironmentIncluded,
      prerequisites: list(credentials.prerequisites).map((value) => textField(value)),
      ...(credentials.bedrock !== undefined
        ? { bedrock: parseBedrockRecoveryIntent(credentials.bedrock) }
        : {}),
      ...(credentials.team !== undefined
        ? { team: parseTeamRecovery(credentials.team, members) }
        : {}),
    },
    omissions: list(row.omissions).map((value) => textField(value)),
    gateway: {
      initial: gateway.initial as 'active' | 'inactive' | 'failed',
      restored: gateway.restored,
      ...(held ? { held } : {}),
    },
  };
}
