#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenClawStack, OpenClawStackProps } from './stack.js';
import { loadConfigByName } from '../cli/utils/config.js';
import {
  validateConfig,
  validateConfigStructure,
  validateProvisioningConfig,
} from '../cli/utils/config-validation.js';
import { getApiKeyParamName, getGatewayTokenParamName } from '../cli/utils/api-keys.js';
import type { OpenClawConfig, StackConfig } from '../cli/types/index.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';

const destroyOnly = process.env.OPENCLAW_CDK_OPERATION === 'destroy';

// Load configuration
let config: OpenClawConfig;
let configName: string;
let restore: RestoreBootstrap | undefined;
try {
  if (process.env.OPENCLAW_CDK_OPERATION === 'restore')
    restore = parseRestoreBootstrap(JSON.parse(process.env.OPENCLAW_RESTORE_BOOTSTRAP ?? 'null'));
  const envConfigName = process.env.OPENCLAW_CONFIG_NAME;
  if (!envConfigName) {
    console.error('Error loading configuration: OPENCLAW_CONFIG_NAME is required');
    process.exit(1);
  }
  configName = envConfigName;
  if (process.env.OPENCLAW_CONFIG_SNAPSHOT) {
    const snapshot: unknown = JSON.parse(process.env.OPENCLAW_CONFIG_SNAPSHOT);
    if (!validateConfigStructure(snapshot))
      throw new Error('Invalid deployment configuration snapshot');
    config = snapshot;
    validateConfig(config);
    if (process.env.AWS_REGION && config.aws.region !== process.env.AWS_REGION) {
      throw new Error('Deployment snapshot does not match the selected AWS region');
    }
  } else {
    config = loadConfigByName(configName);
  }
  if (!destroyOnly && !restore) validateProvisioningConfig(config);
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
  restore,
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
