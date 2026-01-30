export interface OpenClawConfig {
  version: string;
  projectName: string;
  aws: {
    region: string;
    profile?: string;
  };
  instance: {
    type: string;
    name: string;
    nodeVersion: number;
    amiType: 'amazon-linux-2' | 'amazon-linux-2023';
  };
  features: {
    cloudWatchLogs: boolean;
  };
  stack: {
    name: string;
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
}

export interface DeploymentStatus {
  stackName: string;
  stackStatus: string;
  instanceId?: string;
  instanceStatus?: string;
  ssmStatus?: string;
}
