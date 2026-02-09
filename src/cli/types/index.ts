import { API_PROVIDERS } from "../constants.js";

export type Provider = typeof API_PROVIDERS[number]['value'];
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
  };
}

export interface StackConfig {
  projectName: string;
  instanceName: string;
  instanceType: {
    class: string;
    size: string;
  };
  enableCloudWatchLogs: boolean;
  useDefaultVpc: boolean;
}

export interface DeploymentStatus {
  stackName: string;
  stackStatus: string;
  instanceId?: string;
  instanceStatus?: string;
  ssmStatus?: string;
}
