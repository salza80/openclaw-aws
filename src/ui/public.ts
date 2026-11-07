import { modelObject, modelText } from '../openclaw/model-contract.js';
import { teamId } from '../openclaw/team-contract.js';
import { validAwsRegion } from '../aws/regions.js';
import { uiActions, uiName, parseUiActionRequest } from './input.js';
import type { UiFact, UiOutcome, UiPlanView, UiTarget } from './contracts.js';

const exact = (row: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(row).some((key) => !keys.includes(key)))
    throw new Error('Unsupported public UI fields');
};
export function uiFacts(value: unknown): UiFact[] {
  if (!Array.isArray(value) || value.length > 96) throw new Error('Unsupported UI facts');
  return value.map((input) => {
    const row = modelObject(input);
    exact(row, ['label', 'value']);
    return { label: modelText(row.label, 80), value: modelText(row.value, 4096) };
  });
}
const recovery = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Unsupported UI recovery choices');
  return value.map(parseUiActionRequest);
};
function target(value: unknown): UiTarget {
  const row = modelObject(value);
  exact(row, ['name', 'account', 'region', 'stackId', 'instanceId']);
  const targetRegion = modelText(row.region, 64);
  if (!/^\d{12}$/.test(String(row.account)) || !validAwsRegion(targetRegion))
    throw new Error('Invalid UI target');
  return {
    name: uiName(row.name),
    account: row.account as string,
    region: targetRegion,
    ...(row.stackId === undefined ? {} : { stackId: modelText(row.stackId) }),
    ...(row.instanceId === undefined ? {} : { instanceId: modelText(row.instanceId, 32) }),
  };
}
export function parseUiPlanView(input: unknown): UiPlanView {
  const row = modelObject(input);
  exact(row, ['id', 'action', 'title', 'target', 'createdAt', 'facts', 'effects', 'recovery']);
  if (
    !uiActions.includes(row.action as UiPlanView['action']) ||
    !Number.isFinite(Date.parse(String(row.createdAt))) ||
    !Array.isArray(row.effects) ||
    row.effects.length > 32 ||
    Buffer.byteLength(JSON.stringify(row)) > 32768
  )
    throw new Error('Invalid UI operation preview');
  return {
    id: teamId(row.id),
    action: row.action as UiPlanView['action'],
    title: modelText(row.title, 160),
    target: target(row.target),
    createdAt: modelText(row.createdAt, 64),
    facts: uiFacts(row.facts),
    effects: row.effects.map((value) => modelText(value, 2048)),
    ...(row.recovery === undefined ? {} : { recovery: recovery(row.recovery) }),
  };
}
export function parseUiOutcome(input: unknown): UiOutcome {
  const row = modelObject(input);
  exact(row, ['summary', 'facts', 'recovery']);
  return {
    summary: modelText(row.summary, 500),
    facts: uiFacts(row.facts),
    ...(row.recovery === undefined ? {} : { recovery: recovery(row.recovery) }),
  };
}
