import { execa } from 'execa';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { AwsLocation } from '../aws/target.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { OpenClawConfig, Provider } from '../cli/types/index.js';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { createSsmClient } from '../cli/utils/aws-clients.js';
import { getApiKeyParamName, getGatewayTokenParamName } from '../cli/utils/api-keys.js';
import { getStackStatus, getInstanceIdFromStack, waitForSSM } from '../cli/utils/aws.js';
import { AWSError, StackNotFoundError, withRetry, isRetryableError } from '../cli/utils/errors.js';
import { getCDKBinary, getCDKAppCommand, withCDKWorkspace } from '../cli/utils/cdk.js';
import { resolveOutputsPath } from '../cli/utils/config-store.js';
import { validateProvisioningConfig } from '../cli/utils/config-validation.js';
import { assertDeploymentTarget, recordDeploymentState } from './state.js';
import { withDeploymentLock } from './lock.js';

async function storeApiKey(
  configName: string,
  provider: Provider,
  apiKey: string,
  region: AwsLocation,
): Promise<string> {
  const client = createSsmClient(region);
  const paramName = getApiKeyParamName(configName, provider);
  try {
    await client.send(
      new PutParameterCommand({
        Name: paramName,
        Value: apiKey,
        Type: 'SecureString',
        Overwrite: false,
        Description: `OpenClaw API key for ${configName} (${provider})`,
      }),
    );
  } finally {
    client.destroy();
  }

  return paramName;
}

async function storeGatewayToken(
  configName: string,
  token: string,
  region: AwsLocation,
): Promise<string> {
  const client = createSsmClient(region);
  const paramName = getGatewayTokenParamName(configName);
  try {
    await client.send(
      new PutParameterCommand({
        Name: paramName,
        Value: token,
        Type: 'SecureString',
        Overwrite: false,
        Description: `OpenClaw gateway token for ${configName}`,
      }),
    );
  } finally {
    client.destroy();
  }

  return paramName;
}

async function confirmDeploymentAccess(config: OpenClawConfig, target: AwsLocation): Promise<void> {
  const instanceId = await getInstanceIdFromStack(config.stack.name, target);
  if (!(await waitForSSM(instanceId, target))) {
    throw new AWSError(
      `Stack '${config.stack.name}' was created but SSM connectivity was not confirmed`,
      [
        `Inspect the existing stack and instance ${instanceId}; deployment outputs are retained`,
        'Check the instance role, SSM agent, and outbound network access before retrying',
        'Do not create a second deployment or rotate secrets to recover this instance',
      ],
    );
  }
}

function deploymentFailure(
  error: unknown,
  configName: string,
  config: OpenClawConfig,
  apiKey: string,
  additionalSecrets: string[] = [],
): AWSError {
  const secrets = [
    ...new Set(
      [
        apiKey,
        ...additionalSecrets,
        ...Object.entries(process.env)
          .filter(([name]) => /token|password|secret|api_?key|credential|access_key/i.test(name))
          .map(([, value]) => value),
      ]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]),
    ),
  ].sort((a, b) => b.length - a.length);
  const redact = (text: string) => {
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  };
  const details = error instanceof Error ? error.message : 'Deployment failed';
  const failure = new AWSError(
    `${redact(details)}\nFailed deployment resources may remain and continue to incur AWS charges.`,
    [
      ...(error instanceof AWSError ? error.suggestions.map(redact) : []),
      `Inspect stack '${config.stack.name}' in ${config.aws.region} before attempting recovery`,
      `Use openclaw-aws connect --name ${configName} to inspect private bootstrap diagnostics when SSM is available`,
      `After diagnosis, explicitly remove retained resources: openclaw-aws destroy --name ${configName}`,
    ],
  );
  failure.cause = error;
  return failure;
}

export function rejectFailedStack(
  configName: string,
  config: OpenClawConfig,
  status: string,
): void {
  if (status.endsWith('_FAILED') || status.startsWith('ROLLBACK_')) {
    throw deploymentFailure(
      new AWSError(
        `Stack '${config.stack.name}' already exists in ${status}; a new deployment was not started`,
      ),
      configName,
      config,
      '',
    );
  }
}

async function deployFreshStack(
  config: OpenClawConfig,
  operation: () => Promise<unknown>,
  target: AwsLocation,
): Promise<void> {
  let attempted = false;
  let previousFailure: unknown;
  await withRetry(
    async () => {
      if (attempted) {
        let missing = false;
        try {
          await getStackStatus(config.stack.name, target);
        } catch (error) {
          if (!(error instanceof StackNotFoundError)) throw error;
          missing = true;
        }
        // A failed creation is preserved for diagnosis; retry only before a stack exists.
        if (!missing) throw previousFailure;
      }
      attempted = true;
      try {
        await operation();
      } catch (error) {
        previousFailure = error;
        throw error;
      }
    },
    {
      maxAttempts: 2,
      delayMs: 5000,
      shouldRetry: isRetryableError,
      operationName: 'CDK deploy',
    },
  );
}

/** The shared, noninteractive provisioning operation. Callers own input and approval. */
export async function deployDeployment(
  ctx: CommandContext,
  options: { apiProvider: Provider; apiKey: string; progress?: (message: string) => void },
): Promise<Record<string, string>> {
  const config = structuredClone(ctx.config);
  const snapshot = JSON.stringify(config);
  validateProvisioningConfig(config);
  assertDeploymentTarget({ ...ctx, config });
  return withDeploymentLock(ctx, async () => {
    // Recheck immediately before writing secrets: planning may have taken minutes.
    try {
      await getStackStatus(config.stack.name, ctx.target);
      throw new AWSError(`Deployment '${ctx.name}' already exists; provisioning was not started`);
    } catch (error) {
      if (!(error instanceof StackNotFoundError)) throw error;
    }
    const cdkBinary = getCDKBinary();
    try {
      await execa(cdkBinary, ['--version'], { reject: true });
    } catch {
      throw new AWSError('AWS CDK CLI not available', ['Reinstall @salza80/openclaw-aws']);
    }
    // Resolve a long-lived snapshot before any secret writes.
    const privateValues = new Set<string>([options.apiKey]);
    const operationEnvironment = async () => {
      const environment = await ctx.target.environment(30 * 60_000);
      for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
        if (environment[key]) privateValues.add(environment[key]);
      }
      return {
        ...environment,
        OPENCLAW_CONFIG_NAME: ctx.name,
        OPENCLAW_CDK_OPERATION: 'deploy',
        OPENCLAW_CONFIG_SNAPSHOT: snapshot,
        CDK_DISABLE_VERSION_CHECK: 'true',
        CDK_DISABLE_CLI_TELEMETRY: '1',
        CI: 'true',
      };
    };
    await operationEnvironment();
    const cdkAppPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cdk/app.js');
    const outputsFile = resolveOutputsPath(ctx.name);
    try {
      await storeApiKey(ctx.name, options.apiProvider, options.apiKey, ctx.target);
      const gatewayToken = crypto.randomBytes(24).toString('hex');
      privateValues.add(gatewayToken);
      await storeGatewayToken(ctx.name, gatewayToken, ctx.target);
      options.progress?.('Installing and verifying OpenClaw... (this may take up to 20 minutes)');
      await deployFreshStack(
        config,
        async () =>
          withCDKWorkspace(await operationEnvironment(), async ({ cwd, env }) =>
            execa(
              cdkBinary,
              [
                'deploy',
                config.stack.name,
                '--app',
                getCDKAppCommand(cdkAppPath),
                '--no-notices',
                '--no-version-reporting',
                '--no-rollback',
                '--require-approval',
                'never',
                '--outputs-file',
                outputsFile,
                '--progress',
                'events',
              ],
              {
                env,
                extendEnv: false,
                cwd,
                timeout: 25 * 60_000,
              },
            ),
          ),
        ctx.target,
      );
      options.progress?.('Confirming SSM access...');
      await confirmDeploymentAccess(config, ctx.target);
      if (!fs.existsSync(outputsFile)) return {};
      const outputs = JSON.parse(fs.readFileSync(outputsFile, 'utf8'))[config.stack.name] ?? {};
      recordDeploymentState(
        ctx,
        {
          stackName: config.stack.name,
          stackStatus: 'CREATE_COMPLETE',
          stackId: outputs.DeploymentId,
        },
        { newlyCreated: true },
      );
      return outputs;
    } catch (error) {
      throw deploymentFailure(error, ctx.name, config, options.apiKey, [...privateValues]);
    }
  });
}
