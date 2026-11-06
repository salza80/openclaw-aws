import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BedrockAccessStack } from '../../src/cdk/bedrock.js';
import type { BedrockRoute } from '../../src/aws/bedrock-routes.js';
const env = { account: '123456789012', region: 'eu-central-1' };
const foundationArn = 'arn:aws:bedrock:eu-central-1::foundation-model/provider.model-v1:0';
const profileArn =
  'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/global.provider.model';
const direct: BedrockRoute = {
  model: 'amazon-bedrock/provider.model-v1:0',
  region: env.region,
  kind: 'foundation-model',
  invocationArn: foundationArn,
  modelArns: [foundationArn],
};
const profile: BedrockRoute = {
  model: 'amazon-bedrock/global.provider.model',
  region: env.region,
  kind: 'inference-profile',
  invocationArn: profileArn,
  modelArns: [foundationArn, 'arn:aws:bedrock:::foundation-model/provider.model-v1:0'],
};
function template(routes: BedrockRoute[]) {
  return Template.fromStack(
    new BedrockAccessStack(new App(), 'BedrockAccess', {
      env,
      roleName: 'verified-existing-role',
      discoveryRegion: env.region,
      routes,
    }),
  );
}
describe('scoped auxiliary Bedrock IAM', () => {
  it('grants exact direct/profile invocation and profile-conditioned backing models without touching EC2', () => {
    const value = template([direct, profile]);
    value.resourceCountIs('AWS::IAM::RolePolicy', 1);
    expect(Object.keys(value.toJSON().Resources)).toEqual(['BedrockAccess']);
    const [policy] = Object.values(value.findResources('AWS::IAM::RolePolicy'));
    expect(policy.Properties.RoleName).toBe('verified-existing-role');
    const statements = policy.Properties.PolicyDocument.Statement;
    const backing = statements.find((statement: { Condition?: Record<string, unknown> }) =>
      JSON.stringify(statement.Condition ?? {}).includes('bedrock:InferenceProfileArn'),
    );
    expect(backing.Resource).toEqual(profile.modelArns.toSorted());
    expect(backing.Condition).toEqual({
      StringEquals: { 'bedrock:InferenceProfileArn': profileArn },
    });
    expect(JSON.stringify(value.toJSON())).not.toContain('AmazonBedrockFullAccess');
    for (const statement of statements) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (actions.some((action: string) => action.startsWith('bedrock:Invoke'))) {
        expect(JSON.stringify(statement.Resource)).not.toContain('*');
        expect(actions).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
      }
    }
  });
  it('can enable regional native discovery without granting invocation to an arbitrary model', () => {
    const value = template([]);
    const [policy] = Object.values(value.findResources('AWS::IAM::RolePolicy'));
    expect(policy.Properties.PolicyDocument.Statement).toEqual([
      {
        Action: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles'],
        Effect: 'Allow',
        Resource: '*',
        Condition: { StringEquals: { 'aws:RequestedRegion': ['eu-central-1'] } },
      },
    ]);
  });
  it('rejects wildcard role names and mismatched partition/account/route metadata', () => {
    expect(
      () =>
        new BedrockAccessStack(new App(), 'Unsafe', {
          env,
          roleName: '*',
          discoveryRegion: env.region,
          routes: [direct],
        }),
    ).toThrow();
    expect(() =>
      template([{ ...profile, invocationArn: profileArn.replace('123456789012', '999999999999') }]),
    ).toThrow();
    expect(() =>
      template([{ ...direct, invocationArn: foundationArn.replace('arn:aws:', 'arn:aws-cn:') }]),
    ).toThrow();
  });
  it('rejects a route union too large for an IAM role inline policy before AWS applies it', () => {
    const routes = Array.from({ length: 80 }, (_, index) => {
      const id = `provider.model-${index}-${'x'.repeat(32)}`;
      const arn = `arn:aws:bedrock:eu-central-1::foundation-model/${id}`;
      return { ...direct, model: `amazon-bedrock/${id}`, invocationArn: arn, modelArns: [arn] };
    });
    expect(() => template(routes)).toThrow('inline-policy quota');
  });
});
