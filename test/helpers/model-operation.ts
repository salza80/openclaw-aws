import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../../src/cli/constants.js';
import type { ModelJob } from '../../src/openclaw/model-contract.js';
export const modelJob: ModelJob = {
  schemaVersion: 1,
  operationId: 'eb4d5841-6a97-4014-8596-d372d73c99af',
  target: {
    deploymentName: 'test',
    stackId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-test/stack-id',
    instanceId: 'i-0123456789abcdef0',
    roleId: 'AROATESTHOSTROLE000001',
    account: '123456789012',
    region: 'eu-central-1',
  },
  scope: { kind: 'agent', agentId: 'researcher' },
  action: {
    kind: 'set',
    model: 'openrouter/new',
    expectedHash: 'opaque:revision:0',
    allowRestart: false,
  },
  bedrockRole: false,
  runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
};
