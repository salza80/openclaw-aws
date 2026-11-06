import { describe, expect, it, vi } from 'vitest';
import {
  GetParameterCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { importRestoreProviderSecrets } from '../../src/openclaw/restore-secrets.js';
const owner = {
  deploymentName: 'restored',
  deploymentId:
    'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-restored/target-guid',
  operationId: '11111111-1111-1111-1111-111111111111',
};
const environment = {
  OPENROUTER_API_KEY: 'fixture-openrouter',
  ANTHROPIC_API_KEY: 'fixture-anthropic',
  AWS_SECRET_ACCESS_KEY: 'model-provider-aws',
  OPENCLAW_GATEWAY_TOKEN: 'old-gateway',
};
describe('private restored provider import', () => {
  it('creates only target provider credentials with immutable ownership tags and emits no values', async () => {
    const send = vi.fn(async () => ({ Version: 1 }));
    const result = await importRestoreProviderSecrets({ send }, owner, environment);
    expect(result.providers).toEqual(['anthropic-api-key', 'openrouter-api-key']);
    expect(JSON.stringify(result)).not.toContain('fixture-');
    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls as unknown as [PutParameterCommand][]) {
      expect(command).toBeInstanceOf(PutParameterCommand);
      expect(command.input).toMatchObject({
        Type: 'SecureString',
        Overwrite: false,
        Tags: [
          { Key: 'openclaw-aws:deployment-id', Value: owner.deploymentId },
          { Key: 'openclaw-aws:restore-id', Value: owner.operationId },
        ],
      });
      expect(command.input.Name).toMatch(/^\/openclaw\/restored\/providers\//);
    }
  });
  function existing(extraTags = true, value = 'fixture-openrouter') {
    return vi.fn(async (command) => {
      if (command instanceof PutParameterCommand)
        throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
      if (command instanceof ListTagsForResourceCommand)
        return {
          TagList: extraTags
            ? [
                { Key: 'openclaw-aws:deployment-id', Value: owner.deploymentId },
                { Key: 'openclaw-aws:restore-id', Value: owner.operationId },
              ]
            : [],
        };
      if (command instanceof GetParameterCommand)
        return { Parameter: { Name: command.input.Name, Type: 'SecureString', Value: value } };
      throw Error('Unexpected operation');
    });
  }
  it('adopts only an identical, operation-owned secret on retry', async () => {
    await expect(
      importRestoreProviderSecrets({ send: existing() }, owner, {
        OPENROUTER_API_KEY: 'fixture-openrouter',
      }),
    ).resolves.toMatchObject({ providers: ['openrouter-api-key'] });
    await expect(
      importRestoreProviderSecrets({ send: existing(false) }, owner, {
        OPENROUTER_API_KEY: 'fixture-openrouter',
      }),
    ).rejects.toThrow('another deployment');
    await expect(
      importRestoreProviderSecrets({ send: existing(true, 'different') }, owner, {
        OPENROUTER_API_KEY: 'fixture-openrouter',
      }),
    ).rejects.toThrow('differs');
  });
  it('refuses malformed scope and oversized credentials before any write and sanitizes write failures', async () => {
    const send = vi.fn();
    await expect(
      importRestoreProviderSecrets({ send }, { ...owner, deploymentName: '../other' }, environment),
    ).rejects.toThrow('owner');
    await expect(
      importRestoreProviderSecrets({ send }, owner, { OPENROUTER_API_KEY: 'x'.repeat(4097) }),
    ).rejects.toThrow('format');
    expect(send).not.toHaveBeenCalled();
    send.mockRejectedValue(new Error('private request fixture-openrouter'));
    await expect(
      importRestoreProviderSecrets({ send }, owner, { OPENROUTER_API_KEY: 'fixture-openrouter' }),
    ).rejects.not.toThrow('fixture-openrouter');
  });
});
