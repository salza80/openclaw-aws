import { describe, it, expect } from 'vitest';
import {
  awsCredentialSuggestions,
  cdkBootstrapSuggestions,
  configNotFoundSuggestions,
  networkSuggestions,
  ssmSuggestions,
  stackNotFoundSuggestions,
} from '../../src/cli/utils/suggestions.js';

describe('suggestions', () => {
  it('includes complete AWS credential guidance', () => {
    const suggestions = awsCredentialSuggestions();
    expect(suggestions).toHaveLength(6);
    expect(suggestions).toContain('Session expired? Re-authenticate: aws sso login');
    expect(suggestions).toContain('First-time setup (IAM Identity Center/SSO): aws configure sso');
    expect(suggestions).toContain('Using access keys? Configure the AWS CLI: aws configure');
    expect(suggestions).toContain('Check env vars: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
    expect(suggestions).toContain('Check credentials file: ~/.aws/credentials');
    expect(suggestions).toContain('Verify IAM permissions for CloudFormation, EC2, and SSM');
  });

  it('includes CDK bootstrap guidance', () => {
    const suggestions = cdkBootstrapSuggestions();
    expect(suggestions).toHaveLength(2);
    expect(suggestions).toContain(
      'Bootstrap your account/region: cdk bootstrap aws://ACCOUNT-ID/REGION',
    );
    expect(suggestions).toContain(
      'Docs: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html',
    );
  });

  it('includes stack-not-found guidance', () => {
    const suggestions = stackNotFoundSuggestions();
    expect(suggestions).toHaveLength(3);
    expect(suggestions).toContain('Run: openclaw-aws deploy (to create the stack)');
    expect(suggestions).toContain('Check: openclaw-aws status (to see current state)');
    expect(suggestions).toContain('Confirm region/profile in your config');
  });

  it('includes init guidance for missing config', () => {
    const suggestions = configNotFoundSuggestions();
    expect(suggestions).toHaveLength(2);
    expect(suggestions).toContain('Create a deployment: openclaw-aws init --name <name>');
    expect(suggestions).toContain('List configs: openclaw-aws list');
  });

  it('includes SSM troubleshooting guidance', () => {
    const suggestions = ssmSuggestions();
    expect(suggestions).toHaveLength(3);
    expect(suggestions).toContain(
      'Install Session Manager plugin: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
    );
    expect(suggestions).toContain('Wait a few minutes after start/restart for SSM to be ready');
    expect(suggestions).toContain('Check: openclaw-aws status');
  });

  it('includes network troubleshooting guidance', () => {
    const suggestions = networkSuggestions();
    expect(suggestions).toHaveLength(3);
    expect(suggestions).toContain('Check your internet connection');
    expect(suggestions).toContain('Verify the AWS region is reachable from your network');
    expect(suggestions).toContain('Try again in a few moments');
  });
});
