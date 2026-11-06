import { readFileSync } from 'node:fs';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import type { Provider } from '../cli/types/index.js';

export interface OpenClawBootstrapOptions {
  region: string;
  stackId: string;
  logicalResourceId: string;
  apiProvider: Provider;
  model?: string;
  apiKeyParamName: string;
  gatewayTokenParamName: string;
  logGroupName?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  /** An inactive runtime target; ordinary onboarding must never touch restored state. */
  restoreOperationId?: string;
}

// Public config values remain compatible while upstream auth choices and env names evolve.
export const OPENCLAW_PROVIDER_SETUP: Record<
  Provider,
  {
    envVar: string;
    authChoice: string;
    providerId: string;
    providerAliases?: readonly string[];
    tokenProvider?: string;
  }
> = {
  'anthropic-api-key': {
    envVar: 'ANTHROPIC_API_KEY',
    providerId: 'anthropic',
    authChoice: 'apiKey',
    tokenProvider: 'anthropic',
  },
  'openrouter-api-key': {
    envVar: 'OPENROUTER_API_KEY',
    providerId: 'openrouter',
    authChoice: 'openrouter-api-key',
  },
  'openai-api-key': {
    envVar: 'OPENAI_API_KEY',
    providerId: 'openai',
    authChoice: 'openai-api-key',
  },
  'gemini-api-key': {
    envVar: 'GEMINI_API_KEY',
    providerId: 'google',
    authChoice: 'gemini-api-key',
  },
  'ai-gateway-api-key': {
    envVar: 'AI_GATEWAY_API_KEY',
    providerId: 'vercel-ai-gateway',
    authChoice: 'ai-gateway-api-key',
  },
  'cloudflare-ai-gateway-api-key': {
    envVar: 'CLOUDFLARE_AI_GATEWAY_API_KEY',
    providerId: 'cloudflare-ai-gateway',
    authChoice: 'cloudflare-ai-gateway-api-key',
  },
  'moonshot-api-key': {
    envVar: 'MOONSHOT_API_KEY',
    providerId: 'moonshot',
    authChoice: 'moonshot-api-key',
  },
  'kimi-code-api-key': {
    envVar: 'KIMI_API_KEY',
    providerId: 'kimi',
    providerAliases: ['kimi-coding'],
    authChoice: 'kimi-code-api-key',
  },
  'synthetic-api-key': {
    envVar: 'SYNTHETIC_API_KEY',
    providerId: 'synthetic',
    authChoice: 'synthetic-api-key',
  },
  'venice-api-key': {
    envVar: 'VENICE_API_KEY',
    providerId: 'venice',
    authChoice: 'venice-api-key',
  },
  'zai-api-key': { envVar: 'ZAI_API_KEY', providerId: 'zai', authChoice: 'zai-api-key' },
  'xiaomi-api-key': {
    envVar: 'XIAOMI_API_KEY',
    providerId: 'xiaomi',
    authChoice: 'xiaomi-api-key',
  },
  'xai-api-key': { envVar: 'XAI_API_KEY', providerId: 'xai', authChoice: 'xai-api-key' },
  'minimax-api-key': {
    envVar: 'MINIMAX_API_KEY',
    providerId: 'minimax',
    authChoice: 'minimax-global-api',
  },
  'opencode-zen-api-key': {
    envVar: 'OPENCODE_API_KEY',
    providerId: 'opencode',
    providerAliases: ['opencode-zen'],
    authChoice: 'opencode-zen',
  },
};

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Bootstrap settings cannot contain NUL bytes');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Public native onboarding arguments shared by fresh deployment and cloning. */
export function openClawProviderAuthArgs(options: {
  apiProvider: Provider;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
}): string[] {
  const setup = OPENCLAW_PROVIDER_SETUP[options.apiProvider];
  if (!setup) throw new Error(`Unsupported OpenClaw provider: ${options.apiProvider}`);
  const args = ['--auth-choice', setup.authChoice];
  if (setup.tokenProvider) args.push('--token-provider', setup.tokenProvider);
  if (options.apiProvider === 'cloudflare-ai-gateway-api-key') {
    if (!options.cloudflareAccountId?.trim() || !options.cloudflareGatewayId?.trim())
      throw new Error('Cloudflare AI Gateway requires both account and gateway IDs');
    args.push(
      '--cloudflare-ai-gateway-account-id',
      options.cloudflareAccountId,
      '--cloudflare-ai-gateway-gateway-id',
      options.cloudflareGatewayId,
    );
  }
  return args;
}

/** Render the same packaged bootstrap asset from either src/ or dist/. */
export function renderOpenClawBootstrap(options: OpenClawBootstrapOptions): string {
  if (
    options.restoreOperationId !== undefined &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      options.restoreOperationId,
    )
  )
    throw new Error('Restore bootstrap requires a valid operation UUID');
  const setup = OPENCLAW_PROVIDER_SETUP[options.apiProvider];
  if (!setup) throw new Error(`Unsupported OpenClaw provider: ${options.apiProvider}`);
  const authArgs = options.restoreOperationId
    ? ['--auth-choice', setup.authChoice]
    : openClawProviderAuthArgs(options);
  const gatewayLogPath = '/home/ubuntu/.openclaw/logs/gateway.log';
  const cloudWatchSetup = options.logGroupName
    ? `phase cloudwatch
download "https://amazoncloudwatch-agent-\${AWS_REGION}.s3.\${AWS_REGION}.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb" "$WORK_DIR/cloudwatch.deb"
dpkg -i "$WORK_DIR/cloudwatch.deb"
cat > /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json << 'CLOUDWATCH_CONFIG'
${JSON.stringify({
  agent: { region: options.region },
  logs: {
    logs_collected: {
      files: {
        collect_list: [
          { file_path: '/var/log/cloud-init-output.log', stream: 'bootstrap' },
          { file_path: '/var/log/cloud-init.log', stream: 'cloud-init' },
          { file_path: gatewayLogPath, stream: 'gateway' },
        ].map(({ file_path, stream }) => ({
          file_path,
          log_group_name: options.logGroupName,
          log_stream_name: `{instance_id}/${stream}`,
        })),
      },
    },
  },
})}
CLOUDWATCH_CONFIG
systemctl enable amazon-cloudwatch-agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json`
    : '';
  const replacements: Record<string, string> = {
    RESTORE_OPERATION_ID: shellQuote(options.restoreOperationId ?? ''),
    REGION: shellQuote(options.region),
    STACK_ID: shellQuote(options.stackId),
    LOGICAL_RESOURCE_ID: shellQuote(options.logicalResourceId),
    API_KEY_PARAM_NAME: shellQuote(options.apiKeyParamName),
    GATEWAY_TOKEN_PARAM_NAME: shellQuote(options.gatewayTokenParamName),
    PROVIDER_ENV: shellQuote(setup.envVar),
    AUTH_ARGS: authArgs.map(shellQuote).join(' '),
    MODEL_SETUP: options.model
      ? `as_ubuntu "$OPENCLAW_BIN" models set ${shellQuote(options.model)} > "$WORK_DIR/model.json" 2> "$WORK_DIR/model.err"`
      : '',
    OPENCLAW_VERSION: shellQuote(OPENCLAW_VERSION),
    NODE_VERSION: shellQuote(OPENCLAW_NODE_VERSION),
    CLOUDWATCH_SETUP: cloudWatchSetup,
    LOGGING_CONFIG: options.logGroupName
      ? `printf '%s\\n' '{"logging":{"file":"${gatewayLogPath}"}}' > "$STATE_DIR/openclaw.json"\n  chown ubuntu:ubuntu "$STATE_DIR/openclaw.json"`
      : '',
  };
  const template = readFileSync(
    new URL('../../templates/openclaw/bootstrap.sh', import.meta.url),
    'utf8',
  ).replace(
    '@@GATEWAY_SETUP@@',
    readFileSync(
      new URL(
        options.restoreOperationId
          ? '../../templates/openclaw/bootstrap-restore.sh'
          : '../../templates/openclaw/bootstrap-fresh.sh',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const rendered = template.replace(/@@([A-Z_]+)@@/g, (_, name: string) => {
    if (!(name in replacements)) throw new Error(`Unknown bootstrap placeholder: ${name}`);
    return replacements[name];
  });
  // CDK adds a shell header and resolves the stack-ID token to a longer ARN.
  // Leave room for those bytes within EC2's decoded 16 KiB user-data limit.
  if (Buffer.byteLength(rendered) > 16 * 1024 - 256) {
    throw new Error('OpenClaw bootstrap exceeds the EC2 user-data limit');
  }
  return rendered;
}
