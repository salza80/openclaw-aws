import { API_PROVIDERS } from '../constants.js';

export type ApiKeyProvider = (typeof API_PROVIDERS)[number]['value'];
export type Provider = ApiKeyProvider | 'amazon-bedrock';
export interface OpenClawConfig {
  version: string;
  aws: {
    region: string;
    profile?: string;
  };
  network: {
    useDefaultVpc: boolean;
  };
  instance: {
    type: string;
    name: string;
  };
  security?: {
    enableSsh?: boolean;
    sshSourceIp?: string;
  };
  features: {
    cloudWatchLogs: boolean;
  };
  stack: {
    name: string;
  };
  openclaw?: {
    apiProvider: Provider;
    /** Omitted on legacy API-key configurations. Never model Gateway auth. */
    authMode?: 'api-key' | 'instance-role';
    bedrock?: { region: string };
    model?: string;
    cloudflare?: { accountId: string; gatewayId: string };
  };
}

export interface StackConfig {
  projectName: string;
  instanceName: string;
  instanceType: string;
  enableCloudWatchLogs: boolean;
  useDefaultVpc: boolean;
}

export interface DeploymentStatus {
  stackId?: string;
  stackName: string;
  stackStatus: string;
  instanceId?: string;
  instanceStatus?: string;
  ssmStatus?: string;
}
