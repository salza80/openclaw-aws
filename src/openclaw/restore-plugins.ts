import { object } from './backup-contract.js';

export interface RestoredPluginInstall {
  id: string;
  spec: string;
  integrity?: string;
}
/** Use the public registry's durable install records, never authored plugins.installs. */
export function restoredPluginInstalls(registry: unknown): RestoredPluginInstall[] {
  const records = object(object(object(registry).current).installRecords);
  return Object.entries(records).flatMap(([id, value]) => {
    const record = object(value);
    // Native/local bundles are retained by the archive. Diagnostics below must
    // still prove them loadable; no guessed download or floating update is used.
    if (record.source !== 'npm') return [];
    const name = record.resolvedName;
    const version = record.resolvedVersion;
    if (
      typeof name !== 'string' ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)
    )
      throw new Error(
        'A restored npm plugin lacks exact resolved provenance; repair it explicitly while the Gateway remains inactive',
      );
    const integrity = record.integrity;
    if (
      integrity !== undefined &&
      (typeof integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity))
    )
      throw new Error('A restored plugin has unsupported integrity metadata');
    return [{ id, spec: `npm:${name}@${version}`, ...(integrity ? { integrity } : {}) }];
  });
}
export function verifyRestoredPluginInstalls(expected: RestoredPluginInstall[], registry: unknown) {
  const actual = restoredPluginInstalls(registry);
  for (const entry of expected) {
    const installed = actual.find((item) => item.id === entry.id);
    if (
      !installed ||
      installed.spec !== entry.spec ||
      (entry.integrity && installed.integrity !== entry.integrity)
    )
      throw new Error(
        'Restored plugin provenance changed during dependency rebuild; Gateway remains inactive',
      );
  }
}

/** Our checksummed transport is intentionally loaded by path, outside the native
 * npm installation index. Exempt only its exact missing-provenance warning; all
 * load, dependency, capability and workspace diagnostics remain blocking.
 */
export function assertRestoredPluginHealth(report: unknown, managedSources: string[]) {
  const value = object(report);
  const fields = [
    'pluginErrors',
    'diagnostics',
    'sourceShadowing',
    'compatibility',
    'configurationWarnings',
  ] as const;
  for (const field of fields)
    if (!Array.isArray(value[field])) throw new Error('Native plugin diagnostics are incomplete');
  if (typeof value.ok !== 'boolean') throw new Error('Native plugin diagnostics are incomplete');
  const diagnostics = (value.diagnostics as unknown[]).filter((item) => {
    const diagnostic = object(item);
    return !(
      diagnostic.level === 'warn' &&
      diagnostic.pluginId === 'openclaw-aws-s3' &&
      typeof diagnostic.source === 'string' &&
      managedSources.includes(diagnostic.source) &&
      diagnostic.code === undefined &&
      typeof diagnostic.message === 'string' &&
      diagnostic.message.startsWith("OpenClaw can't verify where this plugin came from.") &&
      diagnostic.message.includes('reason=record-missing;')
    );
  });
  if (
    (value.pluginErrors as unknown[]).length ||
    diagnostics.length ||
    (value.sourceShadowing as unknown[]).length ||
    (value.configurationWarnings as unknown[]).length ||
    (value.compatibility as unknown[]).some((item) => object(item).severity !== 'info') ||
    (value.ok === false && !(value.diagnostics as unknown[]).length)
  )
    throw new Error(
      'Restored plugin diagnostics failed; inspect the inactive target and repair its declared plugin installation before activation',
    );
}
