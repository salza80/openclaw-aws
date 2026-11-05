#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenClawStack, OpenClawStackProps } from './stack.js';
import { loadConfigByName } from '../cli/utils/config.js';
import { validateProvisioningConfig } from '../cli/utils/config-validation.js';
import { getApiKeyParamName, getGatewayTokenParamName } from '../cli/utils/api-keys.js';
import type { StackConfig } from '../cli/types/index.js';

const destroyOnly = process.env.OPENCLAW_CDK_OPERATION === 'destroy';

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
  if (!destroyOnly) validateProvisioningConfig(config);
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

// Build stack config
const stackConfig: StackConfig = {
  projectName: process.env.OPENCLAW_CONFIG_NAME ?? 'openclaw',
  instanceName: config.instance.name,
  instanceType: config.instance.type,
  enableCloudWatchLogs: config.features.cloudWatchLogs,
  useDefaultVpc: config.network.useDefaultVpc,
};

// Gateway networking remains fixed for this installation.
// Gateway port is fixed in the stack (18789)

// Create CDK app
const app = new cdk.App({ builtinCloudFormationValidation: !destroyOnly });

// Build stack props
const stackProps: OpenClawStackProps = {
  config: stackConfig,
  apiProvider,
  model: config.openclaw?.model,
  cloudflareAccountId: config.openclaw?.cloudflare?.accountId,
  cloudflareGatewayId: config.openclaw?.cloudflare?.gatewayId,
  apiKeyParamName,
  gatewayTokenParamName,
  useDefaultVpc: config.network.useDefaultVpc,
  env: {
    region: config.aws.region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
};

if (destroyOnly) {
  // Deletion uses the deployed template; rebuilding bootstrap would require
  // provisioning metadata that legacy configs never contained.
  new cdk.Stack(app, config.stack.name, {
    env: stackProps.env,
    synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
  });
} else {
  new OpenClawStack(app, config.stack.name, stackProps);
}

app.synth();
