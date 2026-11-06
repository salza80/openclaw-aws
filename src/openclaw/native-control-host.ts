import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { bedrockRoleProfile } from './bedrock-profile.js';
import {
  parseModelHostTarget,
  parseModelRuntime,
  type ModelHostTarget,
  type ModelJob,
} from './model-contract.js';

/** Shared, private AWS identity boundary for native model/provider workers.
 * No credentials enter SSM arguments, records or public results. */
export async function createInstanceControlHost(
  input: { target: ModelHostTarget; runtime: ModelJob['runtime'] },
  signal?: AbortSignal,
) {
  const target = parseModelHostTarget(input.target);
  const runtime = parseModelRuntime(input.runtime);
  const home = homedir();
  const packageJson = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/openclaw/package.json',
  );
  if (
    process.getuid?.() === 0 ||
    home !== '/home/ubuntu' ||
    process.version !== `v${runtime.node}` ||
    JSON.parse(await readFile(packageJson, 'utf8')).version !== runtime.openclaw
  )
    throw new Error(
      'Model controls require the pinned Ubuntu-owned native runtime; no implicit upgrade was attempted',
    );
  // The metadata credential provider itself can honor endpoint environment
  // overrides. Refuse them even if a caller forgot the clean invocation env.
  const allowedAws = new Set([
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_EC2_METADATA_V1_DISABLED',
  ]);
  if (
    Object.keys(process.env).some(
      (key) => key.startsWith('AWS_') && !allowedAws.has(key) && process.env[key],
    )
  )
    throw new Error('Model worker requires isolated instance-role AWS inputs');
  if (
    process.env.AWS_CONFIG_FILE !== '/dev/null' ||
    process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null' ||
    process.env.AWS_EC2_METADATA_V1_DISABLED !== 'true'
  )
    throw new Error('Model worker requires explicit private AWS isolation');
  const credentials = fromInstanceMetadata({
    ec2MetadataV1Disabled: true,
    timeout: 3000,
    maxRetries: 2,
  });
  const config = { region: target.region, credentials, ignoreConfiguredEndpointUrls: true };
  const sts = new STSClient(config);
  const ssm = new SSMClient(config);
  const request = () => ({
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  return {
    home,
    packageJson,
    async identify() {
      const identity = await sts.send(new GetCallerIdentityCommand({}), request());
      const partition = target.stackId.split(':')[1];
      if (
        identity.Account !== target.account ||
        identity.UserId !== `${target.roleId}:${target.instanceId}` ||
        !identity.Arn?.startsWith(`arn:${partition}:sts::${target.account}:assumed-role/`) ||
        !identity.Arn.endsWith(`/${target.instanceId}`)
      )
        throw new Error('Model worker is not using the selected hosting instance role');
      const name = `/openclaw/${target.deploymentName}/gateway-token`;
      const token = await ssm.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
        request(),
      );
      if (
        token.Parameter?.Name !== name ||
        token.Parameter.Type !== 'SecureString' ||
        !token.Parameter.Value ||
        token.Parameter.ARN !==
          `arn:${partition}:ssm:${target.region}:${target.account}:parameter${name}`
      )
        throw new Error('Selected host Gateway credential is unavailable');
      return token.Parameter.Value;
    },
    async requireBedrockProfile() {
      const profile = bedrockRoleProfile(home, target.region);
      // Model-only operations never install or silently adopt another AWS
      // connection. Provider enablement owns creation/service environment.
      const file = await open(
        profile.filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          stat.mode & 0o077 ||
          stat.nlink !== 1 ||
          stat.size > 8192 ||
          (await file.readFile('utf8')) !== profile.contents
        )
          throw new Error('Managed Bedrock role profile requires explicit provider enablement');
      } finally {
        await file.close();
      }
    },
    dispose() {
      sts.destroy();
      ssm.destroy();
    },
  };
}
