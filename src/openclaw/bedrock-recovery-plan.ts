import { isDeepStrictEqual } from 'node:util';
import { parseBedrockSelection, type BedrockAccessSelection } from '../aws/bedrock-selection.js';
import type { BedrockIdentity } from '../aws/bedrock-routes.js';
import { modelObject } from './model-contract.js';
import {
  parseBedrockRecoveryIntent,
  type BedrockRecoveryIntent,
} from './bedrock-recovery-intent.js';

/** Reviewed before a destination exists. AWS validates the backing metadata
 * again before the target's separate role-policy change set can execute. */
export interface BedrockRecoveryPlan {
  intent: BedrockRecoveryIntent;
  selection: BedrockAccessSelection;
}
export function parseBedrockRecoveryPlan(
  input: unknown,
  identity: BedrockIdentity,
): BedrockRecoveryPlan {
  const row = modelObject(input);
  if (Object.keys(row).some((key) => !['intent', 'selection'].includes(key)))
    throw new Error('Unsupported Bedrock recovery permission plan');
  const intent = parseBedrockRecoveryIntent(row.intent);
  const selection = parseBedrockSelection(row.selection, identity);
  if (
    selection.discoveryRegion !== intent.inferenceRegion ||
    !isDeepStrictEqual(selection.routes.map((route) => route.model).sort(), intent.models) ||
    selection.routes.some((route) => route.region !== intent.inferenceRegion)
  )
    throw new Error('Bedrock recovery permissions differ from the saved connection/model intent');
  return { intent, selection };
}
