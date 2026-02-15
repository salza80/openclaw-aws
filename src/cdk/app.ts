#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenClawStack, OpenClawStackProps } from './stack.js';
import { loadConfigByName } from '../cli/utils/config.js';
import { getApiKeyParamName, getGatewayTokenParamName } from '../cli/utils/api-keys.js';
import type { StackConfig } from '../cli/types/index.js';

// Load configuration
let config;
let configName: string;
try {
  const envConfigName = process.env.OPENCLAW_CONFIG_NAME;
  if (!envConfigName) {
    console.error('Error loading configuration: OPENCLAW_CONFIG_NAME is required');
    process.exit(1);
  }
  configName = envConfigName;
  config = loadConfigByName(configName);
} catch (error) {
  console.error(
    'Error loading configuration:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}

// Determine API provider from config
const apiProvider = config.openclaw?.apiProvider || 'anthropic-api-key'; // Default to Anthropic if not set

const apiKeyParamName = getApiKeyParamName(configName, apiProvider);
const gatewayTokenParamName = getGatewayTokenParamName(configName);

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
  projectName: process.env.OPENCLAW_CONFIG_NAME ?? 'openclaw',
  instanceName: config.instance.name,
  instanceType: parseInstanceType(config.instance.type),
  enableCloudWatchLogs: config.features.cloudWatchLogs,
  useDefaultVpc: config.network.useDefaultVpc,
};

// Get configuration from environment (no model/sandbox in config anymore)
// Gateway port is fixed in the stack (18789)

// Create CDK app
const app = new cdk.App();

// Build stack props
const stackProps: OpenClawStackProps = {
  config: stackConfig,
  apiProvider,
  apiKeyParamName,
  gatewayTokenParamName,
  useDefaultVpc: config.network.useDefaultVpc,
  env: {
    region: config.aws.region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
};

new OpenClawStack(app, config.stack.name, stackProps);

app.synth();
