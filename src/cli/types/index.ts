export interface OpenClawConfig {
  version: string;
  projectName: string;
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
    nodeVersion: number;
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
    apiProvider: 'anthropic' | 'openrouter' | 'openai' | 'custom';
    model?: string;
    enableSandbox?: boolean;
  };
}

export interface StackConfig {
  projectName: string;
  instanceName: string;
  instanceType: {
    class: string;
    size: string;
  };
  nodeVersion: number;
  enableCloudWatchLogs: boolean;
  useDefaultVpc: boolean;
  enableSsh?: boolean;
  sshSourceIp?: string;
}

export interface DeploymentStatus {
  stackName: string;
  stackStatus: string;
  instanceId?: string;
  instanceStatus?: string;
  ssmStatus?: string;
}
