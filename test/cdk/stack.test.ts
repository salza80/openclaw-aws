import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { MachineImage } from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'node:child_process';
import { OpenClawStack } from '../../src/cdk/stack.js';

afterEach(() => vi.restoreAllMocks());

const stackArn = 'arn:aws:cloudformation:us-east-1:123456789012:stack/TestStack/test-id';

// UserData contains the deployment's StackId token; resolve only the intrinsics
// used by this stack, without relying on CDK's serialized Fn::Join shape.
function resolveString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') throw new Error('Expected a string intrinsic');
  const expression = value as Record<string, unknown>;
  if ('Ref' in expression) {
    const refs: Record<string, string> = {
      'AWS::Partition': 'aws',
      'AWS::Region': 'us-east-1',
      'AWS::AccountId': '123456789012',
      'AWS::StackId': stackArn,
    };
    const resolved = refs[expression.Ref as string];
    if (!resolved) throw new Error(`Unexpected reference: ${expression.Ref}`);
    return resolved;
  }
  if ('Fn::Join' in expression) {
    const [separator, parts] = expression['Fn::Join'] as [string, unknown[]];
    return parts.map(resolveString).join(separator);
  }
  throw new Error(`Unexpected string intrinsic: ${JSON.stringify(value)}`);
}

function bootstrap(enableCloudWatchLogs = false, instanceType = 't3.small') {
  vi.spyOn(MachineImage, 'lookup').mockReturnValue(
    MachineImage.genericLinux({ 'us-east-1': 'ami-0123456789abcdef0' }),
  );
  const stack = new OpenClawStack(new App(), 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    apiProvider: 'anthropic-api-key',
    apiKeyParamName: '/openclaw/test/key',
    gatewayTokenParamName: '/openclaw/test/token',
    useDefaultVpc: false,
    config: {
      projectName: 'test',
      instanceName: 'test',
      instanceType,
      enableCloudWatchLogs,
      useDefaultVpc: false,
    },
  });
  const template = Template.fromStack(stack);
  const [[instanceId, instance]] = Object.entries(template.findResources('AWS::EC2::Instance'));
  const userData = instance.Properties.UserData['Fn::Base64'];
  const script = resolveString(userData);
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement,
  );
  return { template, instanceId, instance, userData, script, policies, statements };
}

function actions(statement: { Action: string | string[] }): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

describe('EC2 bootstrap', () => {
  it('preserves valid AWS type names beyond the bundled CDK instance-class enum', () => {
    const { instance } = bootstrap(false, 't8i.small');
    expect(instance.Properties.InstanceType).toBe('t8i.small');
  });

  it('waits for a signal from this instance without changing existing resource identities', () => {
    const { template, instanceId, instance, userData, script } = bootstrap();
    expect(instanceId).toBe('OpenClawEc242967934');
    expect(instance.CreationPolicy).toEqual({ ResourceSignal: { Count: 1, Timeout: 'PT20M' } });
    expect(JSON.stringify(userData)).toContain('AWS::StackId');
    expect(JSON.stringify(userData)).not.toContain(`"Ref":"${instanceId}"`);
    expect(script).toContain(stackArn);
    expect(script).toContain(instanceId);
    expect(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
    expect(Buffer.byteLength(script)).toBeLessThanOrEqual(16 * 1024);

    const resources = template.toJSON().Resources;
    expect(resources.OpenClawVpc819234F9.Type).toBe('AWS::EC2::VPC');
    expect(resources.OpenClawEc2Sg737AD324.Type).toBe('AWS::EC2::SecurityGroup');
    expect(resources.OpenClawEc2Role03F62F3B.Type).toBe('AWS::IAM::Role');
    expect(resources.OpenClawEc2InstanceProfile0ACC5015.Type).toBe('AWS::IAM::InstanceProfile');
    expect(instance.Properties.Tags).toEqual([
      { Key: 'Name', Value: 'test' },
      { Key: 'Project', Value: 'test' },
      { Key: 'ManagedBy', Value: 'openclaw-aws' },
    ]);
  });

  it('preserves IMDSv2, encrypted disposable gp3 storage and SSM-only inbound access', () => {
    const { template } = bootstrap();
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/sda1',
          Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 30, VolumeType: 'gp3' },
        },
      ],
    });
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    for (const group of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) {
      expect(group.Properties.SecurityGroupIngress ?? []).toEqual([]);
    }
  });

  it('limits secret retrieval despite the SSM managed policy and scopes signalling to this stack', () => {
    const { statements } = bootstrap();
    const parameterArns = [
      'arn:aws:ssm:us-east-1:123456789012:parameter/openclaw/test/key',
      'arn:aws:ssm:us-east-1:123456789012:parameter/openclaw/test/token',
    ];
    const secretAllows = statements.filter(
      (statement) =>
        statement.Effect === 'Allow' && actions(statement).includes('ssm:GetParameter'),
    );
    expect(secretAllows).toHaveLength(1);
    expect(actions(secretAllows[0])).toEqual(['ssm:GetParameter']);
    expect(secretAllows[0].Resource.map(resolveString)).toEqual(parameterArns);

    const secretDenies = statements.filter(
      (statement) => statement.Effect === 'Deny' && actions(statement).includes('ssm:GetParameter'),
    );
    expect(secretDenies).toHaveLength(1);
    expect(actions(secretDenies[0])).toEqual(
      expect.arrayContaining(['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParameterHistory']),
    );
    expect(secretDenies[0].NotResource.map(resolveString)).toEqual(parameterArns);
    expect(secretDenies[0].Resource).toBeUndefined();

    const signalStatements = statements.filter((statement) =>
      actions(statement).includes('cloudformation:SignalResource'),
    );
    expect(signalStatements).toHaveLength(1);
    expect(signalStatements[0].Effect).toBe('Allow');
    expect(actions(signalStatements[0])).toEqual(['cloudformation:SignalResource']);
    expect(resolveString(signalStatements[0].Resource)).toBe(stackArn);
  });

  it('ships bootstrap and gateway logs with scoped permissions and bounded retention', () => {
    const { template, instance, script, policies, statements } = bootstrap(true);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/openclaw/TestStack',
      RetentionInDays: 30,
    });
    const [[groupId, group]] = Object.entries(template.findResources('AWS::Logs::LogGroup'));
    expect(groupId).toBe('OpenClawLogsCE2A867F');
    expect(group.DeletionPolicy).toBe('Delete');

    const agentConfig = JSON.parse(
      script.split("<< 'CLOUDWATCH_CONFIG'\n")[1].split('\nCLOUDWATCH_CONFIG')[0],
    );
    expect(agentConfig.agent.region).toBe('us-east-1');
    expect(agentConfig.logs.logs_collected.files.collect_list).toEqual([
      {
        file_path: '/var/log/cloud-init-output.log',
        log_group_name: '/openclaw/TestStack',
        log_stream_name: '{instance_id}/bootstrap',
      },
      {
        file_path: '/var/log/cloud-init.log',
        log_group_name: '/openclaw/TestStack',
        log_stream_name: '{instance_id}/cloud-init',
      },
      {
        file_path: '/home/ubuntu/.openclaw/logs/gateway.log',
        log_group_name: '/openclaw/TestStack',
        log_stream_name: '{instance_id}/gateway',
      },
    ]);
    expect(script).toContain('dpkg -i "$WORK_DIR/cloudwatch.deb"');
    expect(script).toContain('systemctl enable amazon-cloudwatch-agent');
    expect(script).toContain('amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s');
    expect(script).toContain('/home/ubuntu/.openclaw/logs/gateway.log');
    expect(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
    expect(Buffer.byteLength(script)).toBeLessThanOrEqual(16 * 1024);

    const logStatements = statements.filter((statement) =>
      actions(statement).includes('logs:PutLogEvents'),
    );
    expect(logStatements).not.toHaveLength(0);
    for (const statement of logStatements) {
      expect(statement.Resource).not.toBe('*');
      expect(JSON.stringify(statement.Resource)).toContain(groupId);
    }
    const logPolicyIds = Object.entries(policies)
      .filter(([, policy]) =>
        policy.Properties.PolicyDocument.Statement.some(
          (statement: { Action: string | string[] }) =>
            actions(statement).includes('logs:PutLogEvents'),
        ),
      )
      .map(([id]) => id);
    expect(instance.DependsOn).toEqual(expect.arrayContaining(logPolicyIds));
    expect(JSON.stringify(template.toJSON())).not.toContain('CloudWatchAgentServerPolicy');
    template.hasOutput('LogGroupName', { Value: { Ref: groupId } });
  });

  it('omits logging resources and agent installation when logging is disabled', () => {
    const { template, script, statements } = bootstrap();
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
    expect(script).not.toContain('amazon-cloudwatch-agent');
    expect(script).not.toContain('logging.file');
    expect(statements.some((statement) => actions(statement).includes('logs:PutLogEvents'))).toBe(
      false,
    );
  });
});
