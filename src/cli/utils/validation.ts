export function validateProjectName(name: string): string | boolean {
  if (!name || name.trim().length === 0) {
    return 'Project name is required';
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return 'Use lowercase letters, numbers, and hyphens only';
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    return 'Cannot start or end with a hyphen';
  }

  if (name.length > 50) {
    return 'Project name must be 50 characters or less';
  }

  return true;
}

export function validateInstanceName(name: string): string | boolean {
  if (!name || name.trim().length === 0) {
    return 'Instance name is required';
  }

  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return 'Use letters, numbers, and hyphens only';
  }

  if (name.length > 63) {
    return 'Instance name must be 63 characters or less';
  }

  return true;
}

export const AWS_REGIONS = [
  { title: 'US East (N. Virginia) - us-east-1', value: 'us-east-1' },
  { title: 'US East (Ohio) - us-east-2', value: 'us-east-2' },
  { title: 'US West (N. California) - us-west-1', value: 'us-west-1' },
  { title: 'US West (Oregon) - us-west-2', value: 'us-west-2' },
  { title: 'EU (Ireland) - eu-west-1', value: 'eu-west-1' },
  { title: 'EU (London) - eu-west-2', value: 'eu-west-2' },
  { title: 'EU (Paris) - eu-west-3', value: 'eu-west-3' },
  { title: 'EU (Frankfurt) - eu-central-1', value: 'eu-central-1' },
  { title: 'Asia Pacific (Tokyo) - ap-northeast-1', value: 'ap-northeast-1' },
  { title: 'Asia Pacific (Seoul) - ap-northeast-2', value: 'ap-northeast-2' },
  { title: 'Asia Pacific (Singapore) - ap-southeast-1', value: 'ap-southeast-1' },
  { title: 'Asia Pacific (Sydney) - ap-southeast-2', value: 'ap-southeast-2' },
];

export const INSTANCE_TYPES = [
  // {
  //   title: 't3.micro - 2 vCPU, 1 GB RAM (Free tier eligible)',
  //   value: 't3.micro',
  //   description: '$~7.50/month',
  // },
  { title: 't3.small - 2 vCPU, 2 GB RAM', value: 't3.small', description: '$~15/month' },
  { title: 't3.medium - 2 vCPU, 4 GB RAM', value: 't3.medium', description: '$~30/month' },
  { title: 't3.large - 2 vCPU, 8 GB RAM', value: 't3.large', description: '$~60/month' },
];
