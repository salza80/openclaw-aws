#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenClawStack } from './stack.js';
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
};

// Create CDK app
const app = new cdk.App();

new OpenClawStack(app, config.stack.name, stackConfig, {
  env: {
    region: config.aws.region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
});

app.synth();
