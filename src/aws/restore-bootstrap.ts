import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';

/** Internal CDK snapshot, distinct from the preserved public v1 deployment config. */
export interface RestoreBootstrap {
  operationId: string;
  volumeGiB: number;
  runtime: { openclaw: string; node: string };
}
export function parseRestoreBootstrap(value: unknown): RestoreBootstrap {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid restore bootstrap snapshot');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['operationId', 'volumeGiB', 'runtime'].includes(key)) ||
    typeof row.operationId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.operationId) ||
    !Number.isSafeInteger(row.volumeGiB) ||
    (row.volumeGiB as number) < 30 ||
    (row.volumeGiB as number) > 16384
  )
    throw new Error('Restore bootstrap needs an operation UUID and a 30–16384 GiB root disk');
  const runtime = row.runtime as Record<string, unknown> | undefined;
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    Array.isArray(runtime) ||
    Object.keys(runtime).some((key) => !['openclaw', 'node'].includes(key)) ||
    runtime.openclaw !== OPENCLAW_VERSION ||
    runtime.node !== OPENCLAW_NODE_VERSION
  )
    throw new Error(
      `Restore requires recorded OpenClaw ${OPENCLAW_VERSION} / Node ${OPENCLAW_NODE_VERSION}; use a matching CLI or an explicit verified native migration for another runtime`,
    );
  return {
    operationId: row.operationId,
    volumeGiB: row.volumeGiB as number,
    runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
  };
}
