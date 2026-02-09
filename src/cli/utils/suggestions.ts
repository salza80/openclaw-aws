export function awsCredentialSuggestions(): string[] {
  return [
    'Session expired? Re-authenticate: aws sso login',
    'First-time setup (IAM Identity Center/SSO): aws configure sso',
    'Using access keys? Configure the AWS CLI: aws configure',
    'Check env vars: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
    'Check credentials file: ~/.aws/credentials',
    'Verify IAM permissions for CloudFormation, EC2, and SSM'
  ];
}

export function cdkBootstrapSuggestions(): string[] {
  return [
    'Bootstrap your account/region: cdk bootstrap aws://ACCOUNT-ID/REGION',
    'Docs: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html'
  ];
}

export function stackNotFoundSuggestions(): string[] {
  return [
    'Run: openclaw-aws deploy (to create the stack)',
    'Check: openclaw-aws status (to see current state)',
    'Confirm region/profile in your config'
  ];
}

export function configNotFoundSuggestions(): string[] {
  return [
    'Run: openclaw-aws init (to create configuration)',
    'Or pass an explicit path: --config /path/to/config.json'
  ];
}

export function ssmSuggestions(): string[] {
  return [
    'Install Session Manager plugin: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
    'Wait a few minutes after start/restart for SSM to be ready',
    'Check: openclaw-aws status'
  ];
}

export function networkSuggestions(): string[] {
  return [
    'Check your internet connection',
    'Verify the AWS region is reachable from your network',
    'Try again in a few moments'
  ];
}
