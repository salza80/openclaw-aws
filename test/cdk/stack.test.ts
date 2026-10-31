import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { MachineImage } from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'node:child_process';
import { OpenClawStack } from '../../src/cdk/stack.js';

afterEach(() => vi.restoreAllMocks());

function bootstrap() {
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
      enableCloudWatchLogs: false,
      useDefaultVpc: false,
    },
  });
  const instances = Template.fromStack(stack).findResources('AWS::EC2::Instance');
  return Object.values(instances)[0].Properties.UserData['Fn::Base64'] as string;
}

describe('EC2 bootstrap', () => {
  it('generates valid bash and applies the token before installing the service', () => {
    const script = bootstrap();
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
    expect(script.indexOf('mv "$tmp_config" "$config_path"')).toBeLessThan(
      script.indexOf('openclaw gateway install'),
    );
    expect(script).not.toContain('openclaw daemon install');
  });

  it('propagates onboarding failure instead of reporting successful setup', () => {
    const script = bootstrap();
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
});
