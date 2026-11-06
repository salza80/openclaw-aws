import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { validAwsRegion } from '../aws/regions.js';
import { assertDirectoryChain } from './restore-layout.js';

export const BEDROCK_ROLE_PROFILE = 'openclaw-instance-role';
// A managed role connection cannot silently reuse another AWS identity,
// external credential endpoint or bearer token from saved native state.
const foreignIdentityVariables = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_BEDROCK_SKIP_AUTH',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_BEDROCK',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
] as const;
const systemdValue = (value: string) =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

/** A real, credential-free region profile makes native catalog auth visible.
 * AWS SDK default credentials still come from IMDS, not an API-key marker,
 * credential_process, copied profile or persisted temporary credentials.
 */
export function bedrockRoleProfile(home: string, deploymentRegion: string) {
  if (
    !path.isAbsolute(home) ||
    home === '/' ||
    path.resolve(home) !== home ||
    [...home].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !validAwsRegion(deploymentRegion)
  )
    throw new Error('Managed Bedrock profile requires a canonical home and deployment region');
  const filename = path.join(home, '.openclaw-aws', 'aws', 'config');
  const contents = `[profile ${BEDROCK_ROLE_PROFILE}]\nregion = ${deploymentRegion}\n`;
  const environment = {
    AWS_PROFILE: BEDROCK_ROLE_PROFILE,
    AWS_CONFIG_FILE: filename,
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true',
  };
  const serviceFilename = path.join(
    home,
    '.config/systemd/user/openclaw-gateway.service.d/20-openclaw-aws-bedrock.conf',
  );
  const serviceContents = `[Service]\n${Object.entries(environment)
    .map(([key, value]) => `Environment=${systemdValue(`${key}=${value}`)}`)
    .join('\n')}\nUnsetEnvironment=${foreignIdentityVariables.join(' ')}\n`;
  return { filename, contents, environment, serviceFilename, serviceContents };
}

/** Check saved config/.env and live service input privately before enabling the
 * managed role mode. Report variable names only; never copy their values.
 */
export function assertBedrockRoleInputs(
  home: string,
  region: string,
  values: Record<string, unknown>,
) {
  const plan = bedrockRoleProfile(home, region);
  const populated = (value: unknown) => value !== undefined && value !== null && value !== '';
  const conflicts: string[] = foreignIdentityVariables.filter((key) => populated(values[key]));
  for (const [key, expected] of Object.entries(plan.environment))
    if (populated(values[key]) && values[key] !== expected) conflicts.push(key);
  if (conflicts.length)
    throw new Error(
      `Managed instance-role authentication conflicts with configured AWS overrides: ${conflicts.join(', ')}. Review those settings before enabling Bedrock`,
    );
}

async function fixedPrivateFile(home: string, filename: string, contents: string) {
  await assertDirectoryChain(path.dirname(filename), home, true);
  let file;
  try {
    file = await open(
      filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const existing = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await existing.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.nlink !== 1 ||
        stat.size > 8192 ||
        (await existing.readFile('utf8')) !== contents
      )
        throw new Error(
          'Managed Bedrock profile/service file has foreign ownership or contents; automatic overwrite refused',
          { cause: error },
        );
    } finally {
      await existing.close();
    }
    return;
  }
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(path.dirname(filename), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Caller owns host maintenance and deliberately reloads/restarts the native
 * service afterward. Neither source credentials nor the native unit are edited.
 */
export async function prepareBedrockRoleProfile(
  home: string,
  region: string,
  options: { serviceEnvironment?: boolean } = {},
) {
  const plan = bedrockRoleProfile(home, region);
  await fixedPrivateFile(home, plan.filename, plan.contents);
  if (options.serviceEnvironment)
    await fixedPrivateFile(home, plan.serviceFilename, plan.serviceContents);
  return plan;
}
