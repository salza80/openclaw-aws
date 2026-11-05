import type { AwsLocation } from '../aws/target.js';
import { executeSsm } from '../aws/ssm.js';
import { AWSError } from '../cli/utils/errors.js';

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Private-prefix installs and existing NVM hosts share Ubuntu's native state. */
export function asUbuntu(command: string): string {
  return `sudo -H -u ubuntu bash -c ${shellQuote(
    [
      'set -e',
      'export HOME=/home/ubuntu',
      'cd "$HOME"',
      'export XDG_RUNTIME_DIR=/run/user/$(id -u)',
      'export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus',
      'export PATH="$HOME/.openclaw/bin:$HOME/.openclaw/tools/node/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
      'if ! command -v openclaw >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
      command,
    ].join('\n'),
  )}`;
}

export async function openclawJson(
  instanceId: string,
  target: AwsLocation,
  args: string[],
  options: { executionSeconds?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  if (args.some((arg) => arg.includes('\0')))
    throw new AWSError('OpenClaw arguments cannot contain NUL bytes');
  const result = await executeSsm(
    instanceId,
    target,
    [asUbuntu(`openclaw ${[...args, '--json'].map(shellQuote).join(' ')}`)],
    options,
  );
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new AWSError(
      'OpenClaw returned invalid JSON; check the installed runtime version and diagnostics',
    );
  }
}
