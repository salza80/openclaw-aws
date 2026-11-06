import type { NativeModelClient } from './model-control.js';

type Client = Pick<NativeModelClient, 'call'>;
export interface ArchiveSuspension {
  requestId: string;
  suspensionId: string;
  expiresAtMs: number;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const prefix = 'openclaw-aws-archive:';
const handoffBudgetMs = 30000;
export class ArchiveSuspensionBusyError extends Error {
  constructor() {
    super('Gateway has active work; archive did not force suspension or stop it');
    this.name = 'ArchiveSuspensionBusyError';
  }
}
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Native archive suspension returned an invalid result');
  return input as Record<string, unknown>;
}
function validLease(lease: ArchiveSuspension) {
  if (
    !lease.requestId.startsWith(prefix) ||
    !uuid.test(lease.requestId.slice(prefix.length)) ||
    !uuid.test(lease.suspensionId) ||
    !Number.isSafeInteger(lease.expiresAtMs)
  )
    throw new Error('Archive suspension has no valid operation ownership');
}
function idle(row: Record<string, unknown>, preparing: boolean) {
  if (row.status !== 'ready') {
    if (row.status === 'busy') throw new ArchiveSuspensionBusyError();
    if (row.status === 'draining')
      throw new Error('Gateway has active work; archive did not force suspension or stop it');
    throw new Error('Gateway suspension is unavailable or owned by another operation');
  }
  if (
    (preparing && row.activeCount !== 0) ||
    (row.activeCount !== undefined && row.activeCount !== 0) ||
    !Array.isArray(row.writeCustody) ||
    row.writeCustody.length > 128 ||
    row.writeCustody.some((entry) => record(entry).count !== 0) ||
    (row.blockers !== undefined && (!Array.isArray(row.blockers) || row.blockers.length !== 0))
  )
    throw new Error('Gateway has not confirmed idle work and clear write custody');
  if (
    !Number.isSafeInteger(row.expiresAtMs) ||
    (row.expiresAtMs as number) - Date.now() < handoffBudgetMs
  )
    throw new Error('Gateway suspension has insufficient time for a safe inactive handoff');
}

/** Caller journals intent and owns host maintenance before requesting this
 * short native lease. It is not a durable service hold and must never be used
 * alone to authorize capture or destruction. Busy work is never terminated.
 */
export async function prepareArchiveSuspension(
  client: Client,
  operationId: string,
): Promise<ArchiveSuspension> {
  if (!uuid.test(operationId)) throw new Error('Archive suspension requires an operation UUID');
  const requestId = `${prefix}${operationId}`;
  const row = record(
    await client.call('gateway.suspend.prepare', { requestId, terminalPolicy: 'preserve' }),
  );
  idle(row, true);
  const lease: ArchiveSuspension = {
    requestId,
    suspensionId: typeof row.suspensionId === 'string' ? row.suspensionId : '',
    expiresAtMs: row.expiresAtMs as number,
  };
  validLease(lease);
  await assertArchiveSuspension(client, lease);
  return lease;
}

/** A fresh owner/idle/custody check is required immediately before stopping
 * the Gateway and installing the separately journaled persistent service hold.
 */
export async function assertArchiveSuspension(client: Client, lease: ArchiveSuspension) {
  validLease(lease);
  const row = record(
    await client.call('gateway.suspend.status', {
      suspensionId: lease.suspensionId,
      includeLifecycle: true,
    }),
  );
  if (row.ownerId !== lease.requestId)
    throw new Error('Gateway suspension ownership changed; archive handoff was refused');
  idle(row, false);
}

/** Release only this operation's freshly observed lease. Expired/restarted
 * suspension is already running; a foreign or uncertain owner is never resumed.
 * This does not remove or authorize removal of a persistent service hold.
 */
export async function resumeArchiveSuspension(client: Client, lease: ArchiveSuspension) {
  validLease(lease);
  const current = record(
    await client.call('gateway.suspend.status', {
      suspensionId: lease.suspensionId,
      includeLifecycle: true,
    }),
  );
  if (current.status === 'running') return false;
  if (
    !['ready', 'draining'].includes(String(current.status)) ||
    current.ownerId !== lease.requestId
  )
    throw new Error('Gateway suspension ownership is uncertain; no resume was attempted');
  const resumed = record(
    await client.call('gateway.suspend.resume', { suspensionId: lease.suspensionId }),
  );
  if (resumed.ok !== true || resumed.status !== 'running' || typeof resumed.resumed !== 'boolean')
    throw new Error('Native suspension resume was not confirmed; inspect before retrying');
  return resumed.resumed;
}
