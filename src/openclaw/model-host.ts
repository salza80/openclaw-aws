import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { bedrockRoleProfile } from './bedrock-profile.js';
import { createNativeModelClient } from './model-client.js';
import { parseModelJob } from './model-contract.js';
import { runModelOperation, type ModelWorkerMode } from './model-worker.js';

/** No static/operator credentials enter this worker. Invocation starts with
 * env -i; control-plane clients use IMDSv2 explicitly and native RPC receives
 * only the selected host's privately retrieved Gateway token. */
export async function runAwsModelWorker(
  input: unknown,
  mode: ModelWorkerMode,
  signal?: AbortSignal,
) {
  const job = parseModelJob(input);
  const home = homedir();
  const packageJson = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/openclaw/package.json',
  );
  if (
    process.getuid?.() === 0 ||
    home !== '/home/ubuntu' ||
    process.version !== `v${job.runtime.node}` ||
    JSON.parse(await readFile(packageJson, 'utf8')).version !== job.runtime.openclaw
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
  const config = { region: job.target.region, credentials, ignoreConfiguredEndpointUrls: true };
  const sts = new STSClient(config);
  const ssm = new SSMClient(config);
  const request = () => ({
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  let gatewayToken: string | undefined;
  try {
    return await runModelOperation(
      job,
      {
        home,
        async identify() {
          const identity = await sts.send(new GetCallerIdentityCommand({}), request());
          const partition = job.target.stackId.split(':')[1];
          if (
            identity.Account !== job.target.account ||
            identity.UserId !== `${job.target.roleId}:${job.target.instanceId}` ||
            !identity.Arn?.startsWith(
              `arn:${partition}:sts::${job.target.account}:assumed-role/`,
            ) ||
            !identity.Arn.endsWith(`/${job.target.instanceId}`)
          )
            throw new Error('Model worker is not using the selected hosting instance role');
          const name = `/openclaw/${job.target.deploymentName}/gateway-token`;
          const token = await ssm.send(
            new GetParameterCommand({ Name: name, WithDecryption: true }),
            request(),
          );
          if (
            token.Parameter?.Name !== name ||
            token.Parameter.Type !== 'SecureString' ||
            !token.Parameter.Value ||
            token.Parameter.ARN !==
              `arn:${partition}:ssm:${job.target.region}:${job.target.account}:parameter${name}`
          )
            throw new Error('Selected host Gateway credential is unavailable');
          gatewayToken = token.Parameter.Value;
          if (job.bedrockRole) {
            const profile = bedrockRoleProfile(home, job.target.region);
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
                throw new Error(
                  'Managed Bedrock role profile requires explicit provider enablement',
                );
            } finally {
              await file.close();
            }
          }
        },
        client(record) {
          if (!gatewayToken)
            throw new Error('Host identity must be verified before native model access');
          return createNativeModelClient({
            home,
            packageJson,
            gatewayToken,
            signal,
            record,
            ...(job.bedrockRole ? { bedrockDeploymentRegion: job.target.region } : {}),
          });
        },
      },
      mode,
    );
  } finally {
    sts.destroy();
    ssm.destroy();
  }
}
