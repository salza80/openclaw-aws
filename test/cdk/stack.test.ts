import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { MachineImage } from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'node:child_process';
import { OpenClawStack } from '../../src/cdk/stack.js';

afterEach(() => vi.restoreAllMocks());

function bootstrap(enableCloudWatchLogs = false) {
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
      instanceType: { class: 'T3', size: 'SMALL' },
      enableCloudWatchLogs,
      useDefaultVpc: false,
    },
  });
  const template = Template.fromStack(stack);
  const instances = template.findResources('AWS::EC2::Instance');
  const script = Object.values(instances)[0].Properties.UserData['Fn::Base64'] as string;
  return { template, script };
}

describe('EC2 bootstrap', () => {
  it('generates valid bash and applies the token before installing the service', () => {
    const { script } = bootstrap();
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
    expect(script.indexOf('mv "$tmp_config" "$config_path"')).toBeLessThan(
      script.indexOf('openclaw gateway install'),
    );
    expect(script).not.toContain('openclaw daemon install');
  });

  it('propagates onboarding failure instead of reporting successful setup', () => {
    const { script } = bootstrap();
    const body = script.split("bash << 'ONBOARD_SCRIPT'\n")[1].split('\nONBOARD_SCRIPT')[0];
    expect(body.startsWith('set -e\n')).toBe(true);
    const command = body.slice(body.indexOf('openclaw onboard'));
    const result = spawnSync(
      'bash',
      ['-c', `set -e\nopenclaw() { return 9; }\n${command}\necho setup-complete`],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(9);
    expect(result.stdout).not.toContain('setup-complete');
  });

  it('ships bootstrap and gateway logs with scoped permissions and bounded retention', () => {
    const { template, script } = bootstrap(true);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/openclaw/TestStack',
      RetentionInDays: 30,
    });
    const groups = template.findResources('AWS::Logs::LogGroup');
    const [groupId, group] = Object.entries(groups)[0];
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
    expect(script).toContain('dpkg -i /tmp/amazon-cloudwatch-agent.deb');
    expect(script).toContain('systemctl enable amazon-cloudwatch-agent');
    expect(script).toContain('amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s');
    expect(script).toContain('.logging.file = "/home/ubuntu/.openclaw/logs/gateway.log"');
    expect(script.indexOf('amazon-cloudwatch-agent-ctl')).toBeLessThan(
      script.indexOf('Running OpenClaw onboarding'),
    );
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);

    const policies = template.findResources('AWS::IAM::Policy');
    const logStatements = Object.values(policies)
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => statement.Action.includes('logs:PutLogEvents'));
    expect(logStatements).not.toHaveLength(0);
    for (const statement of logStatements) {
      expect(statement.Resource).not.toBe('*');
      expect(JSON.stringify(statement.Resource)).toContain(groupId);
    }
    expect(JSON.stringify(template.toJSON())).not.toContain('CloudWatchAgentServerPolicy');
    template.hasOutput('LogGroupName', { Value: { Ref: groupId } });
  });

  it('omits logging resources and agent installation when logging is disabled', () => {
    const { template, script } = bootstrap();
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
    expect(script).not.toContain('amazon-cloudwatch-agent');
    expect(script).not.toContain('.logging.file');
  });
});
