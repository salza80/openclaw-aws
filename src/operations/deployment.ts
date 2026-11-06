import { execa } from 'execa';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { AwsLocation } from '../aws/target.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { OpenClawConfig, Provider } from '../cli/types/index.js';
import { GetParametersByPathCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { createSsmClient } from '../cli/utils/aws-clients.js';
import { getApiKeyParamName, getGatewayTokenParamName } from '../cli/utils/api-keys.js';
import { getStackStatus, getInstanceIdFromStack, waitForSSM } from '../cli/utils/aws.js';
import { AWSError, StackNotFoundError, withRetry, isRetryableError } from '../cli/utils/errors.js';
import { getCDKBinary, getCDKAppCommand, withCDKWorkspace } from '../cli/utils/cdk.js';
import { resolveOutputsPath } from '../cli/utils/config-store.js';
import { validateConfig, validateProvisioningConfig } from '../cli/utils/config-validation.js';
import { assertDeploymentTarget, recordDeploymentState } from './state.js';
import { withDeploymentLock } from './lock.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';
import { validateProjectName } from '../cli/utils/validation.js';

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
  restoreOperationId?: string,
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
        ...(restoreOperationId
          ? { Tags: [{ Key: 'openclaw-aws:restore-id', Value: restoreOperationId }] }
          : {}),
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

type FreshProvision = {
  mode: 'fresh';
  apiProvider: Provider;
  apiKey: string;
  progress?: (message: string) => void;
};
type RestoreProvision = {
  mode: 'restore';
  restore: RestoreBootstrap;
  progress?: (message: string) => void;
  clonedFrom?: { pointId: string };
};

/** The shared, noninteractive provisioning operation. Callers own input and approval. */
export async function deployDeployment(
  ctx: CommandContext,
  options: Omit<FreshProvision, 'mode'>,
): Promise<Record<string, string>> {
  const captured = { ...ctx, config: structuredClone(ctx.config) };
  const provided: FreshProvision = { ...options, mode: 'fresh' };
  return withDeploymentLock(captured, () => provisionDeployment(captured, provided));
}

/** Keep the target lock through inactive provisioning and native recovery setup. */
export async function provisionInactiveTarget<T>(
  ctx: CommandContext,
  options: {
    restore: RestoreBootstrap;
    progress?: (message: string) => void;
    clonedFrom?: { pointId: string };
  },
  finish: (outputs: Record<string, string>) => Promise<T>,
): Promise<T> {
  const restore = parseRestoreBootstrap(options.restore);
  if (
    options.clonedFrom &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      options.clonedFrom.pointId,
    )
  )
    throw new Error('Clone lineage requires a completed recovery point UUID');
  const captured = { ...ctx, config: structuredClone(ctx.config) };
  return withDeploymentLock(captured, async () => {
    const outputs = await provisionDeployment(captured, {
      mode: 'restore',
      restore,
      progress: options.progress,
      clonedFrom: options.clonedFrom,
    });
    return finish(outputs);
  });
}
// Preserve the existing restore operation entrypoint and persisted behavior.
export const provisionRestoreTarget = provisionInactiveTarget;

export async function assertRestoreSecretNamespace(ctx: CommandContext) {
  if (validateProjectName(ctx.name) !== true) throw new AWSError('Invalid restore deployment name');
  const client = createSsmClient(ctx.target);
  const seen = new Set<string>();
  let next: string | undefined;
  const signal = AbortSignal.timeout(30000);
  try {
    do {
      const result = await client.send(
        new GetParametersByPathCommand({
          Path: `/openclaw/${ctx.name}/`,
          Recursive: true,
          WithDecryption: false,
          MaxResults: 1,
          NextToken: next,
        }),
        { abortSignal: signal },
      );
      if (!Array.isArray(result?.Parameters))
        throw new AWSError('AWS did not confirm an empty restore secret namespace');
      if (result.Parameters.length)
        throw new AWSError(
          'Target deployment SSM parameters already exist; choose an unused name or inspect the retained deployment',
        );
      next = result.NextToken;
      if (next && seen.has(next))
        throw new AWSError('Restore secret inventory pagination repeated');
      if (next) seen.add(next);
    } while (next);
  } finally {
    client.destroy();
  }
}

async function provisionDeployment(
  ctx: CommandContext,
  options: FreshProvision | RestoreProvision,
): Promise<Record<string, string>> {
  const restore = options.mode === 'restore' ? options.restore : undefined;
  const apiKey = options.mode === 'fresh' ? options.apiKey : '';
  const config = structuredClone(ctx.config);
  const snapshot = JSON.stringify(config);
  if (restore) validateConfig(config);
  else validateProvisioningConfig(config);
  assertDeploymentTarget({ ...ctx, config });
  // Recheck immediately before writing secrets: planning may have taken minutes.
  try {
    await getStackStatus(config.stack.name, ctx.target);
    throw new AWSError(`Deployment '${ctx.name}' already exists; provisioning was not started`);
  } catch (error) {
    if (!(error instanceof StackNotFoundError)) throw error;
  }
  if (restore) await assertRestoreSecretNamespace(ctx);
  const cdkBinary = getCDKBinary();
  try {
    await execa(cdkBinary, ['--version'], { reject: true });
  } catch {
    throw new AWSError('AWS CDK CLI not available', ['Reinstall @salza80/openclaw-aws']);
  }
  // Resolve a long-lived snapshot before any secret writes.
  const privateValues = new Set<string>([apiKey]);
  const operationEnvironment = async () => {
    const environment = await ctx.target.environment(30 * 60_000);
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      if (environment[key]) privateValues.add(environment[key]);
    }
    return {
      ...environment,
      OPENCLAW_CONFIG_NAME: ctx.name,
      OPENCLAW_CDK_OPERATION: restore ? 'restore' : 'deploy',
      OPENCLAW_RESTORE_BOOTSTRAP: restore ? JSON.stringify(restore) : undefined,
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
    if (options.mode === 'fresh')
      await storeApiKey(ctx.name, options.apiProvider, apiKey, ctx.target);
    const gatewayToken = crypto.randomBytes(24).toString('hex');
    privateValues.add(gatewayToken);
    await storeGatewayToken(ctx.name, gatewayToken, ctx.target, restore?.operationId);
    options.progress?.(
      restore
        ? 'Installing the pinned runtime with the Gateway masked and inactive...'
        : 'Installing and verifying OpenClaw... (this may take up to 20 minutes)',
    );
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
    if (!fs.existsSync(outputsFile)) {
      if (restore)
        throw new AWSError('Restore target outputs are missing; the Gateway remains masked');
      return {};
    }
    const outputs = JSON.parse(fs.readFileSync(outputsFile, 'utf8'))[config.stack.name] ?? {};
    if (restore) {
      const actual = await getStackStatus(config.stack.name, ctx.target);
      if (
        !actual.stackId ||
        !actual.instanceId ||
        actual.stackName !== config.stack.name ||
        actual.stackStatus !== 'CREATE_COMPLETE' ||
        actual.stackId !== outputs.DeploymentId ||
        actual.instanceId !== outputs.InstanceId
      )
        throw new AWSError(
          'Restore target outputs do not match the live AWS identity; the Gateway remains masked',
        );
    }
    recordDeploymentState(
      ctx,
      {
        stackName: config.stack.name,
        stackStatus: 'CREATE_COMPLETE',
        stackId: outputs.DeploymentId,
      },
      {
        newlyCreated: true,
        ...(restore
          ? options.mode === 'restore' && options.clonedFrom
            ? {
                clonedFrom: {
                  operationId: restore.operationId,
                  pointId: options.clonedFrom.pointId,
                },
              }
            : { restoredFrom: { operationId: restore.operationId } }
          : {}),
      },
    );
    return outputs;
  } catch (error) {
    throw deploymentFailure(error, ctx.name, config, apiKey, [...privateValues]);
  }
}
