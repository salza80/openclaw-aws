#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenClawStack, OpenClawStackProps } from './stack.js';
import { loadConfigByName } from '../cli/utils/config.js';
import type { StackConfig } from '../cli/types/index.js';
import { Provider } from 'aws-cdk-lib/custom-resources/index.js';

// Load configuration
let config;
try {
  const configName = process.env.OPENCLAW_CONFIG_NAME;
  if (!configName) {
    console.error('Error loading configuration: OPENCLAW_CONFIG_NAME is required');
    process.exit(1);
  }
  config = loadConfigByName(configName);
} catch (error) {
  console.error('Error loading configuration:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Determine API provider from config
const apiProvider = config.openclaw?.apiProvider || 'anthropic-api-key'; // Default to Anthropic if not set

// Get API key based on provider
const envVarName = apiProvider.toUpperCase().replace(/-/g, '_');
const apiKey = process.env[envVarName];

// Validate required environment variables
if (!apiKey) {
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
  enableCloudWatchLogs: config.features.cloudWatchLogs,
  useDefaultVpc: config.network.useDefaultVpc,
};

// Get configuration from environment (no model/sandbox in config anymore)
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
  gatewayPort,
  browserPort,
  customApiBaseUrl,
  useDefaultVpc: config.network.useDefaultVpc,
  env: {
    region: config.aws.region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
};

new OpenClawStack(app, config.stack.name, stackProps);

app.synth();
