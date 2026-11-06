import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '../cli/utils/context.js';
import { getConfigRoot } from '../cli/utils/config.js';
import type { DeploymentStatus } from '../cli/types/index.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { AWSError } from '../cli/utils/errors.js';
import { asUbuntu } from '../openclaw/commands.js';
import { executeSsm } from '../aws/ssm.js';

export interface RuntimeObservation {
  version: string;
  model: string;
  checkedAt: string;
}
interface DeploymentState {
  schemaVersion: 1;
  identity: { stackId: string; account: string; region: string; stackName: string };
  desired: { version: string; nodeVersion: string; provider: string; model?: string };
  observed?: RuntimeObservation;
  restoredFrom?: { operationId: string; pointId?: string };
  clonedFrom?: { operationId: string; pointId: string };
}
const validCloneLineage = (value: DeploymentState['clonedFrom']) =>
  value !== undefined &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value?.operationId) &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value?.pointId);
function statePath(ctx: CommandContext): string {
  return path.join(getConfigRoot(), 'deployments', `${ctx.name}.json`);
}
/** Remove only the exact historical identity after its AWS resources have been deleted. */
export function forgetRestoredDeployment(ctx: CommandContext, operationId: string): void {
  const saved = loadDeploymentState(ctx);
  if (!saved) return;
  assertDeploymentTarget(ctx);
  if ((saved.restoredFrom?.operationId ?? saved.clonedFrom?.operationId) !== operationId)
    throw new AWSError('Local deployment metadata belongs to another operation');
  fs.unlinkSync(statePath(ctx));
}
export function loadDeploymentState(ctx: CommandContext): DeploymentState | undefined {
  const filename = statePath(ctx);
  if (!fs.existsSync(filename)) return undefined;
  const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as DeploymentState;
  if (
    value.schemaVersion !== 1 ||
    !value.identity?.stackId ||
    !value.desired?.version ||
    (value.restoredFrom && value.clonedFrom) ||
    (value.clonedFrom !== undefined && !validCloneLineage(value.clonedFrom))
  ) {
    throw new AWSError('Invalid local deployment metadata; inspect it before proceeding');
  }
  return value;
}
/** Check saved ownership before any targeted mutation or secret cleanup. */
export function assertDeploymentTarget(ctx: CommandContext, status?: DeploymentStatus): void {
  if (ctx.config.aws.region !== ctx.target.region) {
    throw new AWSError('Configuration region does not match the selected AWS target');
  }
  const saved = loadDeploymentState(ctx);
  if (!saved) return;
  if (
    saved.identity.account !== ctx.target.account ||
    saved.identity.region !== ctx.target.region ||
    saved.identity.stackName !== ctx.config.stack.name ||
    (status && saved.identity.stackId !== status.stackId)
  ) {
    throw new AWSError(
      'Selected AWS target differs from the saved deployment identity; inspect the profile, region and stack before continuing',
    );
  }
}

export function recordDeploymentState(
  ctx: CommandContext,
  status: DeploymentStatus,
  options: {
    newlyCreated?: boolean;
    observed?: RuntimeObservation;
    restoredFrom?: { operationId: string; pointId?: string };
    clonedFrom?: { operationId: string; pointId: string };
  } = {},
): DeploymentState {
  const stackId = status.stackId;
  if (options.restoredFrom && options.clonedFrom)
    throw new AWSError('A deployment cannot adopt both restored and cloned identity lineage');
  if (options.clonedFrom !== undefined && !validCloneLineage(options.clonedFrom))
    throw new AWSError('Clone deployment lineage requires operation and recovery point UUIDs');
  if (
    !stackId ||
    !stackId.startsWith('arn:') ||
    stackId.split(':')[3] !== ctx.target.region ||
    stackId.split(':')[4] !== ctx.target.account ||
    !stackId.split(':').slice(5).join(':').startsWith(`stack/${ctx.config.stack.name}/`)
  ) {
    throw new AWSError(
      'AWS did not return a deployment identity matching the selected account and region',
    );
  }
  const previous = loadDeploymentState(ctx);
  if (previous && previous.identity.stackId !== stackId && !options.newlyCreated) {
    throw new AWSError(
      'The AWS deployment identity differs from the saved deployment; inspect the selected profile, account, region and stack before continuing',
    );
  }
  const value: DeploymentState = {
    schemaVersion: 1,
    identity: {
      stackId,
      account: ctx.target.account,
      region: ctx.target.region,
      stackName: ctx.config.stack.name,
    },
    desired:
      previous && !options.newlyCreated && !options.restoredFrom && !options.clonedFrom
        ? previous.desired
        : {
            version: OPENCLAW_VERSION,
            nodeVersion: OPENCLAW_NODE_VERSION,
            provider: options.restoredFrom
              ? 'native-restored'
              : options.clonedFrom
                ? 'native-cloned'
                : (ctx.config.openclaw?.apiProvider ?? 'anthropic-api-key'),
            model: ctx.config.openclaw?.model,
          },
    observed: options.observed ?? (options.newlyCreated ? undefined : previous?.observed),
    restoredFrom:
      options.restoredFrom ??
      (options.newlyCreated || options.clonedFrom ? undefined : previous?.restoredFrom),
    clonedFrom:
      options.clonedFrom ??
      (options.newlyCreated || options.restoredFrom ? undefined : previous?.clonedFrom),
  };
  const filename = statePath(ctx);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return value;
}
/** Native reads only. Store a small allowlist, never native auth/profile payloads. */
export async function observeRuntime(
  ctx: CommandContext,
  instanceId: string,
): Promise<RuntimeObservation> {
  const script = `const {execFileSync}=require('node:child_process');
const run=(args)=>execFileSync('openclaw',args,{encoding:'utf8',timeout:60000,maxBuffer:1048576});
const version=run(['--version']).match(/\\b[0-9]{4}\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?\\b/)?.[0];
const models=JSON.parse(run(['models','status','--json']));
console.log(JSON.stringify({version,model:models.resolvedDefault}));`;
  const result = await executeSsm(
    instanceId,
    ctx.target,
    [asUbuntu(`node -e '${script.replaceAll("'", "'\\''")}'`)],
    { executionSeconds: 150 },
  );
  let value: { version?: unknown; model?: unknown };
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new AWSError('Native runtime inspection returned invalid JSON');
  }
  if (
    typeof value.version !== 'string' ||
    !/^[0-9]{4}\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) ||
    typeof value.model !== 'string' ||
    value.model.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value.model)
  ) {
    throw new AWSError('Native runtime inspection returned an unsupported version/model result');
  }
  return { version: value.version, model: value.model, checkedAt: new Date().toISOString() };
}
