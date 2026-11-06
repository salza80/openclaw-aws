phase restore-inactive
as_ubuntu systemctl --user mask --now openclaw-gateway.service
if as_ubuntu systemctl --user is-active --quiet openclaw-gateway.service; then
  printf 'ERROR: restore target Gateway must be inactive\n' >&2
  exit 1
fi
if [[ -e "$STATE_DIR/openclaw.json" || -e "$STATE_DIR/.env" ]]; then
  printf 'ERROR: restore bootstrap refuses existing native configuration or credentials\n' >&2
  exit 1
fi
as_ubuntu install -d -m 700 /home/ubuntu/.openclaw-aws
as_ubuntu "$NODE_BIN" - @@RESTORE_OPERATION_ID@@ "$STACK_ID" "$OPENCLAW_VERSION" "$NODE_VERSION" <<'RESTORE_MARKER_JS'
const fs = require('node:fs');
const record = { schemaVersion: 1, operationId: process.argv[2], stackId: process.argv[3], openclaw: process.argv[4], node: process.argv[5], gateway: 'masked' };
const filename = '/home/ubuntu/.openclaw-aws/restore-bootstrap.json';
try {
  fs.writeFileSync(filename, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Unsafe restore bootstrap marker');
  const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!require('node:util').isDeepStrictEqual(current, record)) throw new Error('Another restore operation owns this target');
}
RESTORE_MARKER_JS
BOOTSTRAP_READY=1
exit 0
