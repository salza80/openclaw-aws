import { describe, expect, it, vi } from 'vitest';
import {
  DeleteParameterCommand,
  GetParametersByPathCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-ssm';
import { deleteRestoreParameters } from '../../src/aws/restore-cleanup.js';
const owner = {
  deploymentName: 'alpha',
  deploymentId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-alpha/id',
  operationId: '11111111-1111-1111-1111-111111111111',
};
const gateway = '/openclaw/alpha/gateway-token';
const a = '/openclaw/alpha/providers/openrouter-api-key/api-key';
const b = '/openclaw/alpha/providers/anthropic-api-key/api-key';
function client(foreign = false, fail = false) {
  const deleted: string[] = [];
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetParametersByPathCommand) {
      expect(command.input.WithDecryption).toBe(false);
      return command.input.NextToken
        ? { Parameters: [{ Name: b }] }
        : { Parameters: [{ Name: gateway }, { Name: a }], NextToken: 'page2' };
    }
    if (command instanceof ListTagsForResourceCommand)
      return {
        TagList: [
          {
            Key: 'openclaw-aws:restore-id',
            Value: foreign && command.input.ResourceId === b ? 'foreign' : owner.operationId,
          },
          { Key: 'openclaw-aws:deployment-id', Value: owner.deploymentId },
        ],
      };
    if (command instanceof DeleteParameterCommand) {
      if (fail && command.input.Name === b) throw new Error('Denied');
      deleted.push(command.input.Name!);
      return {};
    }
    throw new Error('unexpected command');
  });
  return { send, deleted };
}
describe('restore credential cleanup', () => {
  it('checks every page and tag without decrypting and deletes the namespace sentinel last', async () => {
    const c = client();
    expect(await deleteRestoreParameters(c as never, owner)).toBe(3);
    expect(c.deleted).toEqual([a, b, gateway]);
  });
  it('leaves all credentials on a foreign ownership finding in a later page', async () => {
    const c = client(true);
    await expect(deleteRestoreParameters(c as never, owner)).rejects.toThrow('ownership');
    expect(c.deleted).toEqual([]);
  });
  it('retains the namespace sentinel if a provider deletion fails', async () => {
    const c = client(false, true);
    await expect(deleteRestoreParameters(c as never, owner)).rejects.toThrow('Denied');
    expect(c.deleted).toEqual([a]);
  });
});
