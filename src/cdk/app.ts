#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenClawStack, OpenClawStackProps } from './stack.js';
import { loadConfig } from '../cli/utils/config.js';
import type { StackConfig } from '../cli/types/index.js';

// Load configuration
let config;
try {
  config = loadConfig();
} catch (error) {
  console.error('Error loading configuration:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Determine API provider from config or environment
const apiProvider = config.openclaw?.apiProvider 
  || (process.env.OPENCLAW_API_PROVIDER as 'anthropic' | 'openrouter' | 'openai' | 'custom') 
  || 'anthropic';

// Get API key based on provider
let apiKey: string | undefined;
if (apiProvider === 'anthropic') {
  apiKey = process.env.ANTHROPIC_API_KEY;
} else if (apiProvider === 'openrouter') {
  apiKey = process.env.OPENROUTER_API_KEY;
} else if (apiProvider === 'openai') {
  apiKey = process.env.OPENAI_API_KEY;
} else if (apiProvider === 'custom') {
  apiKey = process.env.CUSTOM_API_KEY;
}

// Validate required environment variables
if (!apiKey) {
  const envVarName = apiProvider === 'anthropic' 
    ? 'ANTHROPIC_API_KEY'
    : apiProvider === 'openrouter'
    ? 'OPENROUTER_API_KEY'
    : apiProvider === 'openai'
    ? 'OPENAI_API_KEY'
    : 'CUSTOM_API_KEY';
  
  console.error(`Error: ${envVarName} environment variable is required`);
  console.error(`Set it with: export ${envVarName}=your-api-key`);
  console.error(`\nAPI Provider: ${apiProvider}`);
  if (!config.openclaw?.apiProvider) {
    console.error('To change provider, set OPENCLAW_API_PROVIDER environment variable');
  } else {
    console.error('To change provider, run: openclaw-aws init');
  }
  console.error('Supported providers: anthropic, openrouter, openai, custom');
  process.exit(1);
}

// Parse instance type
function parseInstanceType(type: string): { class: string; size: string } {
  const [family, size] = type.split('.');
  return {
    class: family.toUpperCase(),
    size: size.toUpperCase(),
  };
}

// Build stack config
const stackConfig: StackConfig = {
  projectName: config.projectName,
  instanceName: config.instance.name,
  instanceType: parseInstanceType(config.instance.type),
  nodeVersion: config.instance.nodeVersion,
  enableCloudWatchLogs: config.features.cloudWatchLogs,
  useDefaultVpc: config.network.useDefaultVpc,
  enableSsh: config.security?.enableSsh,
  sshSourceIp: config.security?.sshSourceIp,
};

// Get configuration from config file or environment
const model = config.openclaw?.model 
  || process.env.OPENCLAW_MODEL 
  || (apiProvider === 'anthropic' ? 'anthropic/claude-sonnet-4' : 'openrouter/anthropic/claude-sonnet-4');
const enableSandbox = config.openclaw?.enableSandbox ?? (process.env.OPENCLAW_ENABLE_SANDBOX !== 'false'); // default true
const gatewayPort = parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? '18789', 10);
const browserPort = parseInt(process.env.OPENCLAW_BROWSER_PORT ?? '18791', 10);
const customApiBaseUrl = process.env.OPENCLAW_CUSTOM_API_BASE_URL;

// Create CDK app
const app = new cdk.App();

// Build stack props
const stackProps: OpenClawStackProps = {
  config: stackConfig,
  apiProvider,
  apiKey,
  model,
  enableSandbox,
  gatewayPort,
  browserPort,
  customApiBaseUrl,
  useDefaultVpc: config.network.useDefaultVpc,
  enableSsh: config.security?.enableSsh,
  sshSourceIp: config.security?.sshSourceIp,
  env: {
    region: config.aws.region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
};

new OpenClawStack(app, config.stack.name, stackProps);

app.synth();
