import { isDeepStrictEqual } from 'node:util';
import { archiveMemberIdentity, parseMembers, type ArchiveMember } from './backup-contract.js';
import { modelObject, modelText } from './model-contract.js';
import { parseTeamPreflight, type TeamJob, type TeamPreflight } from './team-contract.js';
import { teamDefinitionDigest, teamMembers } from './team-definition.js';
import { nativeModelReference } from './model-control.js';

export interface TeamResult {
  schemaVersion: 1;
  operationId: string;
  teamId: string;
  stackId: string;
  instanceId: string;
  definitionDigest: string;
  inferenceVerified: false;
  recordedPhase: string;
  checkedAt: string;
  gatewayHealthy: boolean | null;
  requestedConfigurationVerified: boolean;
  maintenanceHeld: boolean;
  members?: ArchiveMember[];
  preflight?: TeamPreflight;
  configHash?: string;
  retainedInstructionFiles?: boolean;
  retainedNativeConfiguration?: boolean;
  models?: { agentId: string; model: string }[];
}
/** Project only bounded, nonsecret worker metadata across the SSM boundary. */
export function parseTeamResult(value: unknown, job: TeamJob): TeamResult {
  const row = modelObject(value);
  const fields = [
    'ok',
    'schemaVersion',
    'operationId',
    'teamId',
    'stackId',
    'instanceId',
    'definitionDigest',
    'inferenceVerified',
    'recordedPhase',
    'checkedAt',
    'gatewayHealthy',
    'requestedConfigurationVerified',
    'maintenanceHeld',
    'members',
    'preflight',
    'configHash',
    'retainedInstructionFiles',
    'retainedNativeConfiguration',
    'models',
  ];
  if (
    Object.keys(row).some((key) => !fields.includes(key)) ||
    Buffer.byteLength(JSON.stringify(row)) > 18000 ||
    row.ok !== true ||
    row.schemaVersion !== 1 ||
    row.operationId !== job.operationId ||
    row.teamId !== job.teamId ||
    row.stackId !== job.target.stackId ||
    row.instanceId !== job.target.instanceId ||
    row.definitionDigest !== teamDefinitionDigest(job.definition) ||
    row.inferenceVerified !== false ||
    ![
      'preview',
      'observed',
      'not-started',
      'preparing',
      'configuration-uncertain',
      'roles-configured',
      'models-uncertain',
      'complete',
      'aborted',
    ].includes(String(row.recordedPhase)) ||
    !Number.isFinite(Date.parse(modelText(row.checkedAt, 64))) ||
    (row.gatewayHealthy !== null && typeof row.gatewayHealthy !== 'boolean') ||
    typeof row.requestedConfigurationVerified !== 'boolean' ||
    typeof row.maintenanceHeld !== 'boolean'
  )
    throw new Error('Invalid or identity-mismatched team worker result');
  const members =
    row.members === undefined ? undefined : archiveMemberIdentity(parseMembers(row.members));
  if (members) {
    const main = members.find((member) => member.id === 'main');
    if (
      !main ||
      !isDeepStrictEqual(
        members,
        archiveMemberIdentity(teamMembers(job.definition, '/home/ubuntu', main)),
      )
    )
      throw new Error('Team result has unexpected native member roots');
  }
  if (
    row.requestedConfigurationVerified &&
    (row.gatewayHealthy !== true || !members || !row.configHash)
  )
    throw new Error('Team readiness has no published configuration proof');
  const preflight =
    row.preflight === undefined ? undefined : parseTeamPreflight(row.preflight, job.definition);
  if (
    (row.recordedPhase === 'preview') !== Boolean(preflight) ||
    (preflight && job.action.kind !== 'preview')
  )
    throw new Error('Unexpected team preflight result');
  for (const key of ['retainedInstructionFiles', 'retainedNativeConfiguration'])
    if (row[key] !== undefined && typeof row[key] !== 'boolean')
      throw new Error('Invalid team retention result');
  let models: TeamResult['models'];
  if (row.models !== undefined) {
    if (!members || !Array.isArray(row.models) || row.models.length !== members.length)
      throw new Error('Team status has incomplete model observations');
    models = row.models.map((value) => {
      const model = modelObject(value);
      if (Object.keys(model).some((key) => !['agentId', 'model'].includes(key)))
        throw new Error('Unsupported team model observation');
      return { agentId: modelText(model.agentId, 64), model: nativeModelReference(model.model) };
    });
    if (
      !isDeepStrictEqual(
        models.map((model) => model.agentId).sort(),
        members.map((member) => member.id).sort(),
      )
    )
      throw new Error('Team status model ownership is inconsistent');
  }
  return {
    schemaVersion: 1,
    operationId: job.operationId,
    teamId: job.teamId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    definitionDigest: teamDefinitionDigest(job.definition),
    inferenceVerified: false,
    recordedPhase: String(row.recordedPhase),
    checkedAt: modelText(row.checkedAt, 64),
    gatewayHealthy: row.gatewayHealthy as boolean | null,
    requestedConfigurationVerified: row.requestedConfigurationVerified,
    maintenanceHeld: row.maintenanceHeld,
    ...(members ? { members } : {}),
    ...(models ? { models } : {}),
    ...(preflight ? { preflight } : {}),
    ...(row.configHash === undefined ? {} : { configHash: modelText(row.configHash) }),
    ...(row.retainedInstructionFiles === undefined
      ? {}
      : { retainedInstructionFiles: row.retainedInstructionFiles as boolean }),
    ...(row.retainedNativeConfiguration === undefined
      ? {}
      : { retainedNativeConfiguration: row.retainedNativeConfiguration as boolean }),
  };
}
