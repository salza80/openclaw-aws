import { asUbuntu, shellQuote } from '../openclaw/commands.js';
import { parseModelJob, type ModelJob } from '../openclaw/model-contract.js';
import type { ModelWorkerMode } from '../openclaw/model-worker.js';
import {
  parseBedrockJob,
  type BedrockJob,
  type BedrockWorkerMode,
} from '../openclaw/bedrock-contract.js';
import {
  parseModelArtifactPin,
  modelArtifactDirectory,
  verifyModelArtifactFiles,
  type ModelArtifactPin,
} from './model-artifact.js';
import { parseTeamJob, type TeamJob, type TeamWorkerMode } from '../openclaw/team-contract.js';

/** Only nonsecret request metadata enters SSM. Ubuntu checks the immutable
 * root-owned code/license pins before installing its own private request and
 * launching the shared flock worker. No root writes or credentials in argv. */
export function modelRemoteCommand(input: {
  pin: ModelArtifactPin;
  job: ModelJob;
  mode: ModelWorkerMode;
}) {
  const pin = parseModelArtifactPin(input.pin);
  const job = parseModelJob(input.job);
  if (!['execute', 'inspect', 'accept-requested', 'accept-previous'].includes(input.mode))
    throw new Error('Unsupported model dispatch mode');
  if (input.mode !== 'execute' && job.action.kind !== 'set')
    throw new Error('Only recorded model mutations can be inspected or reconciled');
  return controlCommand(pin, job, input.mode, 'model');
}
export function bedrockRemoteCommand(input: {
  pin: ModelArtifactPin;
  job: BedrockJob;
  mode: BedrockWorkerMode;
}) {
  const pin = parseModelArtifactPin(input.pin);
  const job = parseBedrockJob(input.job);
  if (
    !['preview', 'execute', 'inspect', 'accept-configured', 'accept-previous', 'abort'].includes(
      input.mode,
    )
  )
    throw new Error('Unsupported Bedrock dispatch mode');
  return controlCommand(pin, job, input.mode, 'bedrock');
}
export function teamRemoteCommand(input: {
  pin: ModelArtifactPin;
  job: TeamJob;
  mode: TeamWorkerMode;
}) {
  const pin = parseModelArtifactPin(input.pin);
  const job = parseTeamJob(input.job);
  if (
    !['execute', 'inspect', 'resume', 'abort'].includes(input.mode) ||
    (job.action.kind !== 'configure' && input.mode !== 'execute')
  )
    throw new Error('Unsupported team dispatch mode');
  return controlCommand(pin, job, input.mode, 'team');
}
function controlCommand(
  pin: ModelArtifactPin,
  job: ModelJob | BedrockJob | TeamJob,
  mode: string,
  family: 'model' | 'bedrock' | 'team',
) {
  const encoded = Buffer.from(JSON.stringify(job)).toString('base64');
  if (encoded.length > (family === 'team' ? 48000 : 16000))
    throw new Error('Native control dispatch exceeds the bounded request');
  const command = asUbuntu(
    [
      'set -e',
      'umask 077',
      ...verifyModelArtifactFiles(pin),
      `env -i HOME=/home/ubuntu PATH="$PATH" AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_V1_DISABLED=true XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" node ${shellQuote(`${modelArtifactDirectory(pin.digest)}/worker.mjs`)} ${family === 'model' ? '--dispatch' : '--' + family + '-dispatch'} ${shellQuote(mode)} ${shellQuote(encoded)}`,
    ].join('\n'),
  );
  if (Buffer.byteLength(command) > 60000)
    throw new Error('Model dispatch command exceeds the SSM document bound');
  return command;
}
