export interface S3StorageSettings {
  bucket: string;
  region: string;
  prefix: string;
  expectedBucketOwner: string;
  probePrefix: string;
  readOnly: boolean;
  readVersions: ReadonlyMap<string, string>;
}
const allowed = new Set([
  'bucket',
  'region',
  'prefix',
  'expectedBucketOwner',
  'probePrefix',
  'readOnly',
  'readVersions',
]);

/** Keys remain relative to the selected vault; do not normalize traversal away. */
export function relativeKey(value: string, allowEmpty = false): string {
  if (
    (value === '' && !allowEmpty) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '.' || part === '..') ||
    Buffer.byteLength(value, 'utf8') > 1024
  ) {
    throw new Error('Invalid relative S3 storage key');
  }
  return value;
}
function prefix(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 512)
    throw new Error(`S3 ${field} must be a nonempty relative prefix of at most 512 bytes`);
  const result = value.replace(/\/+$/, '');
  relativeKey(result);
  if (result.includes('//')) throw new Error(`S3 ${field} cannot contain empty path components`);
  return result;
}
export function parseSettings(settings: Readonly<Record<string, unknown>>): S3StorageSettings {
  if (Object.keys(settings).some((key) => !allowed.has(key)))
    throw new Error(
      'Unrecognized S3 storage setting; credentials must use the AWS credential chain',
    );
  if (
    typeof settings.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket) ||
    settings.bucket.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(settings.bucket)
  ) {
    throw new Error('S3 bucket must be a general-purpose bucket name');
  }
  if (typeof settings.region !== 'string' || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(settings.region))
    throw new Error('S3 region must be explicit');
  if (
    typeof settings.expectedBucketOwner !== 'string' ||
    !/^\d{12}$/.test(settings.expectedBucketOwner)
  )
    throw new Error('S3 expectedBucketOwner must be an AWS account ID');
  if (settings.readOnly !== undefined && typeof settings.readOnly !== 'boolean')
    throw new Error('S3 readOnly must be boolean');
  const versions = new Map<string, string>();
  if (settings.readVersions !== undefined) {
    if (
      !settings.readVersions ||
      typeof settings.readVersions !== 'object' ||
      Array.isArray(settings.readVersions)
    )
      throw new Error('S3 readVersions must map relative keys to exact object versions');
    for (const [key, version] of Object.entries(settings.readVersions)) {
      relativeKey(key);
      if (
        typeof version !== 'string' ||
        !version ||
        version === 'null' ||
        version.length > 1024 ||
        [...version].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error('Invalid exact S3 object version');
      versions.set(key, version);
    }
  }
  return {
    bucket: settings.bucket,
    region: settings.region,
    expectedBucketOwner: settings.expectedBucketOwner,
    prefix: prefix(settings.prefix, 'prefix'),
    probePrefix: prefix(settings.probePrefix ?? '_probes', 'probePrefix'),
    readOnly: settings.readOnly === true,
    readVersions: versions,
  };
}
export function validateS3Settings(
  settings: Readonly<Record<string, unknown>>,
): string | undefined {
  try {
    parseSettings(settings);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid S3 storage settings';
  }
}
export function describeS3Target(settings: Readonly<Record<string, unknown>>): string | undefined {
  try {
    const value = parseSettings(settings);
    return `s3://${value.bucket}/${value.prefix}/`;
  } catch {
    return undefined;
  }
}
