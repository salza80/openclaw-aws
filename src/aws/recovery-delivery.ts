import type { RecoveryArtifact } from './recovery-artifact.js';
import { asUbuntu, shellQuote } from '../openclaw/commands.js';

/** Root retrieves/checks nonsecret artifacts; Ubuntu alone executes the worker. */
export function recoveryRemoteCommand(options: {
  operationId: string;
  region: string;
  account: string;
  bucket: string;
  pluginDirectory: string;
  worker: 'worker.js' | 'restore-worker.js';
  mode?: 'stage' | 'activate';
  artifact: RecoveryArtifact;
  request: { key: string; versionId: string; sha256: string };
}): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.operationId))
    throw new Error('Recovery delivery requires an operation UUID');
  if (!['worker.js', 'restore-worker.js'].includes(options.worker))
    throw new Error('Unsupported recovery worker');
  if (
    (options.mode !== undefined && !['stage', 'activate'].includes(options.mode)) ||
    (options.mode === 'activate' && options.worker !== 'restore-worker.js')
  )
    throw new Error('Unsupported recovery worker mode');
  const { artifact, request } = options;
  if (
    artifact.files.some(
      (file) =>
        !/^[A-Za-z0-9_.-]+$/.test(file.name) ||
        ['.', '..'].includes(file.name) ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    ) ||
    !/^[a-f0-9]{64}$/.test(request.sha256)
  )
    throw new Error('Invalid recovery delivery artifact');
  const work = `/home/ubuntu/.openclaw-aws/jobs/${options.operationId}`;
  const clean = (home: string) =>
    `env -i HOME=${home} PATH="$PATH" AWS_REGION=${shellQuote(options.region)} AWS_DEFAULT_REGION=${shellQuote(options.region)} AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_V1_DISABLED=true`;
  const checksum = (sha256: string, filename: string) =>
    `printf '%s  %s\\n' ${shellQuote(sha256)} ${filename} | sha256sum --check --status`;
  const downloads = [
    ...artifact.files.map((file, index) => ({ ...file, staged: `artifact-${index}` })),
    { ...request, name: 'request.json', staged: 'request.json' },
  ];
  const rootPreparation = [
    'set -e',
    'umask 077',
    `delivery_dir=$(mktemp -d /var/tmp/openclaw-aws-delivery-${options.operationId}.XXXXXX)`,
    `trap 'rm -rf -- "$delivery_dir"' EXIT`,
    ...downloads.flatMap((file) => [
      `${clean('/root')} aws s3api get-object --bucket ${shellQuote(options.bucket)} --key ${shellQuote(file.key)} --version-id ${shellQuote(file.versionId)} --expected-bucket-owner ${shellQuote(options.account)} "$delivery_dir/${file.staged}" >/dev/null`,
      checksum(file.sha256, `"$delivery_dir/${file.staged}"`),
    ]),
    // AWS CLI may be private to root on an existing host. Its installation and
    // credential files are not changed; all downloaded code runs as Ubuntu.
    'chown -R ubuntu:ubuntu "$delivery_dir"',
  ];
  const install = (staged: string, sha256: string, destination: string) => {
    const incoming = `${destination}.incoming-${options.operationId}`;
    return [
      `test ! -L ${shellQuote(destination)}`,
      `if [ -f ${shellQuote(destination)} ] && ${checksum(sha256, shellQuote(destination))}; then :; else`,
      `test ! -L ${shellQuote(incoming)}`,
      `install -m 600 -- "$1/${staged}" ${shellQuote(incoming)}`,
      checksum(sha256, shellQuote(incoming)),
      `mv -f ${shellQuote(incoming)} ${shellQuote(destination)}`,
      'fi',
    ].join('\n');
  };
  const run = asUbuntu(
    [
      'umask 077',
      'test ! -L "$HOME/.openclaw-aws"',
      'mkdir -p "$HOME/.openclaw-aws/plugins" "$HOME/.openclaw-aws/jobs"',
      'test "$(stat -c %a "$HOME/.openclaw-aws")" = 700',
      `mkdir ${shellQuote(work)} 2>/dev/null || test -d ${shellQuote(work)}`,
      `test ! -L ${shellQuote(work)}`,
      `mkdir -p ${shellQuote(options.pluginDirectory)}`,
      `test ! -L ${shellQuote(options.pluginDirectory)}`,
      ...artifact.files.map((file, index) =>
        install(`artifact-${index}`, file.sha256, `${options.pluginDirectory}/${file.name}`),
      ),
      install('request.json', request.sha256, `${work}/request.json`),
      'set +e',
      `${clean('/home/ubuntu')}${options.worker === 'restore-worker.js' ? ' OPENCLAW_STATE_DIR=/home/ubuntu/.openclaw OPENCLAW_CONFIG_PATH=/home/ubuntu/.openclaw/openclaw.json' : ''} XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" node ${shellQuote(`${options.pluginDirectory}/${options.worker}`)} ${options.mode === 'activate' ? '--lock-activate' : '--lock'} ${shellQuote(`${work}/request.json`)} ${shellQuote(`${work}/result.json`)} >${shellQuote(`${work}/private.log`)} 2>&1`,
      'capture_status=$?',
      'set -e',
      `if [ -f ${shellQuote(`${work}/result.json`)} ]; then cat ${shellQuote(`${work}/result.json`)}; fi`,
      'exit "$capture_status"',
    ].join('\n'),
  );
  // bash -c receives the delivery directory as $1, without interpolating it into code.
  return [...rootPreparation, `${run} openclaw-backup-delivery "$delivery_dir"`].join('\n');
}
