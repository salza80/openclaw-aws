import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { API_PROVIDERS, OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../../src/cli/constants.js';
import type { Provider } from '../../src/cli/types/index.js';
import {
  renderOpenClawBootstrap,
  type OpenClawBootstrapOptions,
} from '../../src/openclaw/install.js';

const options: OpenClawBootstrapOptions = {
  region: 'us-east-1',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/TestStack/test-id',
  logicalResourceId: 'OpenClawEc242967934',
  apiProvider: 'anthropic-api-key',
  apiKeyParamName: '/openclaw/test/key',
  gatewayTokenParamName: '/openclaw/test/token',
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-bootstrap-test-'));
  directories.push(directory);
  return directory;
}

const bootstrap = () => renderOpenClawBootstrap(options);

function expectBefore(script: string, first: string, second: string) {
  const firstIndex = script.indexOf(first);
  const secondIndex = script.indexOf(second);
  expect(firstIndex, `Missing bootstrap step: ${first}`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `Missing bootstrap step: ${second}`).toBeGreaterThanOrEqual(0);
  expect(firstIndex).toBeLessThan(secondIndex);
}

// Execute only individual, explicitly named functions. The root bootstrap's
// package installation, service changes and other top-level commands never run.
function functions(script: string, names: string[]) {
  return names
    .map((name) => {
      const body = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
      if (!body) throw new Error(`Missing bootstrap function: ${name}`);
      return body;
    })
    .join('\n');
}

function bash(body: string, environment: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\n${body}`], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    timeout: 10_000,
  });
}

const providerCases: [Provider, string, string][] = [
  ['anthropic-api-key', 'ANTHROPIC_API_KEY', 'apiKey'],
  ['openrouter-api-key', 'OPENROUTER_API_KEY', 'openrouter-api-key'],
  ['openai-api-key', 'OPENAI_API_KEY', 'openai-api-key'],
  ['gemini-api-key', 'GEMINI_API_KEY', 'gemini-api-key'],
  ['ai-gateway-api-key', 'AI_GATEWAY_API_KEY', 'ai-gateway-api-key'],
  [
    'cloudflare-ai-gateway-api-key',
    'CLOUDFLARE_AI_GATEWAY_API_KEY',
    'cloudflare-ai-gateway-api-key',
  ],
  ['moonshot-api-key', 'MOONSHOT_API_KEY', 'moonshot-api-key'],
  ['kimi-code-api-key', 'KIMI_API_KEY', 'kimi-code-api-key'],
  ['synthetic-api-key', 'SYNTHETIC_API_KEY', 'synthetic-api-key'],
  ['venice-api-key', 'VENICE_API_KEY', 'venice-api-key'],
  ['zai-api-key', 'ZAI_API_KEY', 'zai-api-key'],
  ['xiaomi-api-key', 'XIAOMI_API_KEY', 'xiaomi-api-key'],
  ['xai-api-key', 'XAI_API_KEY', 'xai-api-key'],
  ['minimax-api-key', 'MINIMAX_API_KEY', 'minimax-global-api'],
  ['opencode-zen-api-key', 'OPENCODE_API_KEY', 'opencode-zen'],
];

describe('OpenClaw bootstrap renderer', () => {
  it.each(providerCases)(
    'renders the supported %s auth choice and canonical environment key',
    (apiProvider, envVar, authChoice) => {
      const script = renderOpenClawBootstrap({
        ...options,
        apiProvider,
        cloudflareAccountId: 'test-account',
        cloudflareGatewayId: 'test-gateway',
      });
      expect(script).toContain(`write_dotenv_entry '${envVar}' "$API_KEY"`);
      expect(script).toContain(`auth_args=('--auth-choice' '${authChoice}'`);
      if (apiProvider === 'anthropic-api-key') {
        expect(script).toContain("'--token-provider' 'anthropic'");
      }
      if (apiProvider === 'cloudflare-ai-gateway-api-key') {
        expect(script).toContain("'--cloudflare-ai-gateway-account-id' 'test-account'");
        expect(script).toContain("'--cloudflare-ai-gateway-gateway-id' 'test-gateway'");
      }
      expect(script).toContain('--secret-input-mode ref');
      expect(script).toContain('--gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN');
      expect(script).not.toContain(`--${apiProvider} "$`);
      expect(script).not.toMatch(/sudo[^\n]*(?:API_KEY|GATEWAY_TOKEN)=/);
      expect(script).not.toMatch(/jq[^\n]*--arg(?:json)?\s+\S+\s+"\$(?:API_KEY|GATEWAY_TOKEN)"/);
      expect(script).not.toMatch(/@@[A-Z_]+@@/);
      expect(Buffer.byteLength(script)).toBeLessThanOrEqual(16 * 1024);
      const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      expect(syntax.stderr).toBe('');
      expect(syntax.status).toBe(0);
    },
  );

  it('covers every public provider and rejects missing Cloudflare routing identifiers', () => {
    expect(providerCases.map(([provider]) => provider).sort()).toEqual(
      API_PROVIDERS.map(({ value }) => value).sort(),
    );
    for (const ids of [
      {},
      { cloudflareAccountId: 'account' },
      { cloudflareGatewayId: 'gateway' },
    ]) {
      expect(() =>
        renderOpenClawBootstrap({
          ...options,
          apiProvider: 'cloudflare-ai-gateway-api-key',
          ...ids,
        }),
      ).toThrow('requires both account and gateway IDs');
    }
    expect(() =>
      renderOpenClawBootstrap({ ...options, apiProvider: 'unsupported' as Provider }),
    ).toThrow('Unsupported OpenClaw provider');
  });

  it('pins the installer and sibling policy by source commit and checksum with the selected runtimes', () => {
    const script = bootstrap();
    expect(script).toContain(
      'https://raw.githubusercontent.com/openclaw/openclaw/4ffdd2047d192dd65554de3c8c46c0e0197c6e2a/scripts',
    );
    expect(script).toContain('d3e5e557c6364da0308a0a88b506db70e1cc0639b3ab7b04d0bc168540e80f38');
    expect(script).toContain('704d74675d3d61e8856e3461f8f4713fdfe8c154797b0c31876d030662879cc6');
    expectBefore(script, 'sha256sum -c -', 'as_ubuntu bash "$INSTALL_DIR/install-cli.sh"');
    expect(script).toContain(`OPENCLAW_VERSION='${OPENCLAW_VERSION}'`);
    expect(script).toContain(`NODE_VERSION='${OPENCLAW_NODE_VERSION}'`);
    expect(script).toContain('--no-onboard --runtime-only');
    expect(script).toContain(
      '[[ "$(as_ubuntu "$NODE_BIN" -p \'process.version\')" == "v$NODE_VERSION" ]]',
    );
    expect(script).toContain('process.argv[2]) process.exit(1)');
    expect(script).not.toMatch(/curl[^\n]*\|\s*(?:sh|bash)/);
    expect(script).not.toMatch(
      /get\.docker\.com|Homebrew\/install|brew install|nvm install|NVM_DIR/,
    );
    expect(script).not.toMatch(
      /apt-get (?:install|upgrade)[^\n]*(?:docker|build-essential|gcc|python|snapd)/,
    );
    expect(script).not.toContain('apt-get upgrade');
  });

  it('quotes configuration as literal shell values and rejects NUL bytes', () => {
    const directory = scratch();
    const injectedValue = `stack'$(touch "${join(directory, 'executed')}")\nsecond line`;
    const script = renderOpenClawBootstrap({ ...options, stackId: injectedValue });
    // This assignment spans lines because the literal value contains a newline.
    const assignment = script.slice(
      script.indexOf('STACK_ID='),
      script.indexOf('\nLOGICAL_RESOURCE_ID='),
    );
    const result = bash(`${assignment}\nprintf '%s' "$STACK_ID"`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(injectedValue);
    expect(existsSync(join(directory, 'executed'))).toBe(false);
    expect(() => renderOpenClawBootstrap({ ...options, stackId: 'stack\0id' })).toThrow('NUL');
    expect(() => renderOpenClawBootstrap({ ...options, stackId: 'x'.repeat(16 * 1024) })).toThrow(
      'user-data limit',
    );
  });

  it('loads packaged assets from the compiled module outside the repository working directory', () => {
    const moduleUrl = new URL('../../dist/openclaw/install.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {renderOpenClawBootstrap} = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(renderOpenClawBootstrap(${JSON.stringify(options)}));`,
      ],
      { cwd: scratch(), encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(bootstrap());
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(packageJson.files).toContain('templates/');
    expect(
      existsSync(fileURLToPath(new URL('../../templates/openclaw/bootstrap.sh', import.meta.url))),
    ).toBe(true);
  });

  it('preserves existing state and uses private files and environment references for fresh onboarding', () => {
    const script = bootstrap();
    expectBefore(script, 'set +x', 'fetch_parameter');
    expectBefore(script, 'umask 077', 'WORK_DIR="$(mktemp');
    expect(script).toContain('if [[ -e "$STATE_DIR/openclaw.json" ]]; then');
    expect(script).toContain('gateway install --force');
    expect(script).toContain(
      'install -o ubuntu -g ubuntu -m 600 "$WORK_DIR/openclaw.env" "$STATE_DIR/.env"',
    );
    expectBefore(script, '"$WORK_DIR/openclaw.env" "$STATE_DIR/.env"', 'phase onboarding');
    expectBefore(script, 'unset API_KEY GATEWAY_TOKEN', 'phase onboarding');
    expect(script).toContain('--gateway-bind loopback');
    expect(script).toContain('--suppress-gateway-token-output');
    expect(script).not.toContain('gateway restart');
  });

  it.each([true, false])(
    'preserves existing state and fails closed on an orphan environment (configured=%s)',
    (configured) => {
      const directory = scratch();
      const state = join(directory, 'state');
      mkdirSync(state);
      writeFileSync(join(state, '.env'), 'existing-credentials-sentinel');
      writeFileSync(join(state, 'sessions.json'), 'existing-sessions-sentinel');
      if (configured) writeFileSync(join(state, 'openclaw.json'), 'existing-config-sentinel');
      const script = bootstrap();
      const branchStart = script.indexOf('if [[ -e "$STATE_DIR/openclaw.json" ]]');
      const branchEnd = script.indexOf('\nphase service');
      expect(branchStart).toBeGreaterThanOrEqual(0);
      expect(branchEnd).toBeGreaterThan(branchStart);
      const result = bash(
        `${functions(script, ['phase'])}
STATE_DIR="$TEST_DIR/state"
OPENCLAW_BIN="$STATE_DIR/bin/openclaw"
as_ubuntu() { printf '%s\n' "$*" >> "$TEST_DIR/calls"; }
fetch_parameter() { printf 'unexpected credential fetch\n' >&2; return 88; }
${script.slice(branchStart, branchEnd)}`,
        { TEST_DIR: directory },
      );
      expect(result.status).toBe(configured ? 0 : 1);
      expect(readFileSync(join(state, '.env'), 'utf8')).toBe('existing-credentials-sentinel');
      expect(readFileSync(join(state, 'sessions.json'), 'utf8')).toBe('existing-sessions-sentinel');
      expect(result.stdout + result.stderr).not.toContain('existing-credentials-sentinel');
      expect(result.stderr).not.toContain('unexpected credential fetch');
      if (configured) {
        expect(readFileSync(join(state, 'openclaw.json'), 'utf8')).toBe('existing-config-sentinel');
        expect(readFileSync(join(directory, 'calls'), 'utf8').trim()).toBe(
          `${state}/bin/openclaw gateway install --force`,
        );
      } else {
        expect(result.stderr).toContain('existing OpenClaw environment without configuration');
        expect(existsSync(join(directory, 'calls'))).toBe(false);
      }
    },
  );
});

describe('bootstrap credential helpers', () => {
  it.each([
    'secret-with-"double-quotes"',
    "secret-with-'single-quotes'",
    'secret-with-`backticks`',
    String.raw`secret-with-literal-\n-and-\r`,
    'secret-$(this-is-literal)-$HOME-\\-end',
  ])('preserves credential bytes in dotenv: %s', (value) => {
    const result = bash(
      `${functions(bootstrap(), ['write_dotenv_entry'])}\nwrite_dotenv_entry API_KEY "$TEST_SECRET"`,
      { TEST_SECRET: value },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseDotenv(result.stdout).API_KEY).toBe(value);
  });

  it.each(['', 'secret\nsecond-line', 'secret\rsecond-line', "secret'and`both-delimiters"])(
    'rejects unrepresentable credentials without printing them: %j',
    (value) => {
      const result = bash(
        `${functions(bootstrap(), ['write_dotenv_entry'])}\nwrite_dotenv_entry API_KEY "$TEST_SECRET"`,
        { TEST_SECRET: value },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      if (value) expect(result.stderr).not.toContain(value);
    },
  );

  it.each([
    { response: { Parameter: { Value: 'test-secret' } }, code: 0, expected: 0 },
    { response: { Parameter: { Value: '' } }, code: 0, expected: 1 },
    { response: { Parameter: { Value: 'secret\nline' } }, code: 0, expected: 1 },
    { response: { Parameter: { Value: 'secret\0byte' } }, code: 0, expected: 1 },
    { response: { Parameter: { Value: 'secret\rline' } }, code: 0, expected: 1 },
    { response: { Parameter: { Value: 42 } }, code: 0, expected: 1 },
    { response: { Parameter: { Value: { value: 'test-secret' } } }, code: 0, expected: 1 },
    { response: { Parameter: {} }, code: 0, expected: 1 },
    { response: { Parameter: { Value: 'test-secret' } }, code: 17, expected: 17 },
  ])(
    'validates an SSM credential and preserves retrieval failure ($expected)',
    ({ response, code, expected }) => {
      const directory = scratch();
      const result = bash(
        `${functions(bootstrap(), ['fetch_parameter'])}
aws() { printf '%s\n' "$*" > "$TEST_DIR/ssm-call"; printf '%s' "$TEST_RESPONSE"; return "$TEST_AWS_CODE"; }
fetch_parameter /openclaw/test/key "$TEST_DIR/credential.json"`,
        {
          TEST_DIR: directory,
          TEST_RESPONSE: JSON.stringify(response),
          TEST_AWS_CODE: String(code),
          AWS_REGION: options.region,
        },
      );
      expect(result.status).toBe(expected);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('test-secret');
      expect(result.stderr).not.toContain('secret');
      expect(readFileSync(join(directory, 'ssm-call'), 'utf8')).toContain(
        'ssm get-parameter --with-decryption --name /openclaw/test/key --region us-east-1',
      );
    },
  );
});

function exitHarness({
  ready = false,
  exitCode = 0,
  signalCode = 0,
  phase = 'readiness',
  command = '',
  markerFails = false,
} = {}) {
  const directory = scratch();
  mkdirSync(join(directory, 'work'));
  mkdirSync(join(directory, 'install'));
  const script = bootstrap();
  const trap = script.split('\n').find((line) => line === "trap 'on_exit $?' EXIT");
  expect(trap).toBeDefined();
  expectBefore(script, trap!, 'phase dependencies');
  const result = bash(
    `${functions(script, ['phase', 'on_exit'])}
PHASE=initializing
BOOTSTRAP_READY="$TEST_READY"
WORK_DIR="$TEST_DIR/work"
INSTALL_DIR="$TEST_DIR/install"
SETUP_MARKER="$TEST_DIR/$TEST_MARKER"
signal_result() { printf '%s\n' "$1" >> "$TEST_DIR/signals"; return "$TEST_SIGNAL_CODE"; }
${trap}
phase "$TEST_PHASE"
PRIVATE_CREDENTIAL=secret-redaction-sentinel
${command || 'bash -c \'exit "$TEST_EXIT_CODE"\''}`,
    {
      TEST_DIR: directory,
      TEST_READY: ready ? '1' : '0',
      TEST_EXIT_CODE: String(exitCode),
      TEST_SIGNAL_CODE: String(signalCode),
      TEST_PHASE: phase,
      TEST_MARKER: markerFails ? 'missing/setup-complete' : 'setup-complete',
    },
  );
  return {
    ...result,
    signals: readFileSync(join(directory, 'signals'), 'utf8').trim().split('\n'),
    marker: existsSync(join(directory, 'setup-complete')),
    cleaned: !existsSync(join(directory, 'work')) && !existsSync(join(directory, 'install')),
  };
}

describe('bootstrap completion trap', () => {
  it.each(['dependencies', 'installer', 'onboarding', 'service', 'readiness'])(
    'preserves failures in phase %s and signals FAILURE without a readiness marker',
    (phase) => {
      const result = exitHarness({ phase, exitCode: 9 });
      expect(result.status).toBe(9);
      expect(result.signals).toEqual(['FAILURE']);
      expect(result.stderr).toContain(`FAILED phase=${phase} exit=9`);
      expect(result.stdout).not.toContain('READY');
      expect(result.stdout + result.stderr).not.toContain('secret-redaction-sentinel');
      expect(result.marker).toBe(false);
      expect(result.cleaned).toBe(true);
    },
  );

  it('rejects a zero exit before readiness, including an unavailable failure signal', () => {
    const result = exitHarness({ signalCode: 1 });
    expect(result.status).toBe(1);
    expect(result.signals).toEqual(['FAILURE']);
    expect(result.stderr).toContain('failure signal unavailable');
    expect(result.marker).toBe(false);
    expect(result.cleaned).toBe(true);
  });

  it('writes the marker and READY only after the success signal has been delivered', () => {
    const result = exitHarness({ ready: true });
    expect(result.status).toBe(0);
    expect(result.signals).toEqual(['SUCCESS']);
    expect(result.stdout).toContain('OPENCLAW_BOOTSTRAP READY');
    expect(result.marker).toBe(true);
    expect(result.cleaned).toBe(true);
  });

  it('fails without marking readiness when the success signal cannot be delivered', () => {
    const result = exitHarness({ ready: true, signalCode: 1 });
    expect(result.status).toBe(1);
    expect(result.signals).toEqual(['SUCCESS']);
    expect(result.stderr).toContain('FAILED phase=signal');
    expect(result.stdout).not.toContain('READY');
    expect(result.marker).toBe(false);
    expect(result.cleaned).toBe(true);
  });

  it('preserves onboarding failure and keeps captured command output private', () => {
    const script = bootstrap();
    const onboarding = script.slice(
      script.indexOf('  phase onboarding'),
      script.indexOf('\nfi\n\nphase service'),
    );
    expect(onboarding).toContain('onboard --non-interactive');
    const result = exitHarness({
      phase: 'onboarding',
      command: `OPENCLAW_BIN=/home/ubuntu/.openclaw/bin/openclaw
as_ubuntu() { printf 'private-onboarding-output secret-redaction-sentinel'; printf 'private-error secret-redaction-sentinel' >&2; return 9; }
${onboarding}`,
    });
    expect(result.status).toBe(9);
    expect(result.signals).toEqual(['FAILURE']);
    expect(result.stdout + result.stderr).not.toContain('secret-redaction-sentinel');
    expect(result.marker).toBe(false);
    expect(result.cleaned).toBe(true);
  });

  it('retains a delivered success signal when the optional local marker cannot be written', () => {
    const result = exitHarness({ ready: true, markerFails: true });
    expect(result.status).toBe(0);
    expect(result.signals).toEqual(['SUCCESS']);
    expect(result.stdout).toContain('OPENCLAW_BOOTSTRAP READY');
    expect(result.stderr).toContain('completion marker unavailable');
    expect(result.marker).toBe(false);
    expect(result.cleaned).toBe(true);
  });
});

describe('authenticated native gateway readiness', () => {
  it.each([
    ['ready', '{"ok":true}', 0, 0, 1],
    ['starting', '{"status":"starting"}', 0, 1, 30],
    ['failed', '{"status":"failed"}', 0, 1, 30],
    ['false', '{"ok":false}', 0, 1, 30],
    ['string true', '{"ok":"true"}', 0, 1, 30],
    ['malformed JSON', 'not-json', 0, 1, 30],
    ['RPC error', '{"ok":true}', 19, 1, 30],
  ])(
    'accepts only healthy RPC output: %s',
    (_name, response, commandCode, expectedCode, expectedCalls) => {
      const directory = scratch();
      const result = bash(
        `${functions(bootstrap(), ['wait_for_health'])}
WORK_DIR="$TEST_DIR"
OPENCLAW_BIN=/home/ubuntu/.openclaw/bin/openclaw
as_ubuntu() { printf '%s\n' "$*" >> "$TEST_DIR/calls"; printf '%s' "$TEST_RESPONSE"; return "$TEST_COMMAND_CODE"; }
sleep() { :; }
wait_for_health`,
        {
          TEST_DIR: directory,
          TEST_RESPONSE: String(response),
          TEST_COMMAND_CODE: String(commandCode),
        },
      );
      expect(result.status).toBe(expectedCode);
      expect(result.stdout).toBe('');
      const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n');
      expect(calls).toHaveLength(Number(expectedCalls));
      expect(
        calls.every(
          (call) => call === '/home/ubuntu/.openclaw/bin/openclaw health --json --timeout 10000',
        ),
      ).toBe(true);
      expect(result.stderr).not.toContain(String(response));
    },
  );

  it('polls through starting state and finishes as soon as authenticated health is ready', () => {
    const directory = scratch();
    const result = bash(
      `${functions(bootstrap(), ['wait_for_health'])}
WORK_DIR="$TEST_DIR"
OPENCLAW_BIN=/home/ubuntu/.openclaw/bin/openclaw
CALLS=0
as_ubuntu() { CALLS=$((CALLS + 1)); if [[ "$CALLS" -lt 3 ]]; then printf '%s' '{"status":"starting"}'; else printf '%s' '{"ok":true}'; fi; }
sleep() { :; }
wait_for_health
printf '%s' "$CALLS"`,
      { TEST_DIR: directory },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('3');
    const script = bootstrap();
    expectBefore(script, 'phase service', 'phase readiness');
    expectBefore(script, '\nwait_for_health\n', 'BOOTSTRAP_READY=1');
  });
});

describe('CloudFormation readiness signal', () => {
  it.each([
    ['token request fails', 7, 0, 'i-test-instance'],
    ['instance metadata request fails', 0, 8, 'i-test-instance'],
    ['instance metadata is invalid', 0, 0, 'invalid-id'],
  ])('fails without signalling when %s', (_name, tokenCode, instanceCode, instanceId) => {
    const directory = scratch();
    const result = bash(
      `${functions(bootstrap(), ['signal_result'])}
INSTANCE_ID=''
curl() {
  case "$*" in
    */api/token*) printf token; return "$TEST_TOKEN_CODE" ;;
    */meta-data/instance-id*) cat >/dev/null; printf '%s' "$TEST_INSTANCE_ID"; return "$TEST_INSTANCE_CODE" ;;
    *) return 97 ;;
  esac
}
aws() { printf 'unexpected AWS signal' > "$TEST_DIR/signal"; return 0; }
sleep() { :; }
signal_result SUCCESS`,
      {
        TEST_DIR: directory,
        TEST_TOKEN_CODE: String(tokenCode),
        TEST_INSTANCE_CODE: String(instanceCode),
        TEST_INSTANCE_ID: String(instanceId),
      },
    );
    expect(result.status).toBe(1);
    expect(existsSync(join(directory, 'signal'))).toBe(false);
    expect(result.stdout).toBe('');
  });

  it.each([
    [0, 1, 0],
    [2, 3, 0],
    [5, 5, 1],
  ])(
    'retries delivery failures a bounded number of times (%s failures)',
    (failures, expectedCalls, expectedCode) => {
      const directory = scratch();
      const result = bash(
        `${functions(bootstrap(), ['signal_result'])}
INSTANCE_ID=''
STACK_ID="$TEST_STACK_ID"
LOGICAL_RESOURCE_ID=OpenClawEc242967934
AWS_CALLS=0
curl() {
  printf 'curl %s\n' "$*" >> "$TEST_DIR/calls"
  case "$*" in
    */api/token*) printf '%s' private-imds-token ;;
    */meta-data/instance-id*) cat > "$TEST_DIR/imds-header"; printf '%s' i-test-instance ;;
    *) return 97 ;;
  esac
}
aws() {
  AWS_CALLS=$((AWS_CALLS + 1))
  printf 'aws %s\n' "$*" >> "$TEST_DIR/calls"
  [[ "$AWS_CALLS" -gt "$TEST_FAILURES" ]]
}
sleep() { :; }
signal_result SUCCESS`,
        {
          TEST_DIR: directory,
          TEST_STACK_ID: options.stackId,
          TEST_FAILURES: String(failures),
          AWS_REGION: options.region,
        },
      );
      expect(result.status).toBe(expectedCode);
      expect(result.stdout).toBe('');
      const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n');
      const awsCalls = calls.filter((line) => line.startsWith('aws '));
      expect(awsCalls).toHaveLength(expectedCalls);
      for (const call of awsCalls) {
        expect(call).toContain(`cloudformation signal-resource --stack-name ${options.stackId}`);
        expect(call).toContain(
          '--logical-resource-id OpenClawEc242967934 --unique-id i-test-instance --status SUCCESS',
        );
        expect(call).toContain('--region us-east-1');
      }
      expect(calls.filter((line) => line.startsWith('curl '))).toHaveLength(2);
      expect(calls[0]).toContain('-X PUT');
      expect(calls[0]).toContain('X-aws-ec2-metadata-token-ttl-seconds: 60');
      expect(calls[1]).toContain('--config -');
      expect(calls.join('\n')).not.toContain('private-imds-token');
      expect(readFileSync(join(directory, 'imds-header'), 'utf8')).toContain('private-imds-token');
    },
  );
});
