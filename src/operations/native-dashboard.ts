import { execa } from 'execa';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { CommandContext } from '../cli/utils/context.js';
import { createSsmClient } from '../cli/utils/aws-clients.js';
import { getGatewayTokenParamName } from '../cli/utils/api-keys.js';
import { validateSSMPlugin } from '../cli/utils/aws-validation.js';
import { checkSSMStatus, checkGatewayStatus } from '../cli/utils/aws.js';
import { inspectRecoverySource } from '../aws/recovery-source.js';
import { startDashboardTunnel } from '../aws/tunnel.js';

/** URLs are restricted to our owned loopback listener. Keep authenticated URLs
 * behind a deliberate browser handoff, outside logs and ordinary API results. */
export async function openLocalBrowser(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Browser opening requires an owned local HTTP URL');
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', url]] as const)
        : (['xdg-open', [url]] as const);
  const result = await execa(command, [...args], { reject: false });
  if (result.failed) throw new Error('The local browser could not be opened');
}
export async function prepareNativeDashboard(
  ctx: CommandContext,
  options: {
    localPort?: number;
    progress?: (message: string) => void;
  } = {},
) {
  await validateSSMPlugin();
  const source = await inspectRecoverySource(ctx);
  options.progress?.('Checking the instance and native Gateway...');
  if (!(await checkSSMStatus(source.instanceId, ctx.target)))
    throw new Error('Instance is not ready for SSM; start it and refresh its state');
  if (!(await checkGatewayStatus(source.instanceId, ctx.target)).running)
    throw new Error(
      'Native Gateway health is unavailable; inspect the deployment before opening its UI',
    );
  const ssm = createSsmClient(ctx.target);
  let token: string;
  try {
    const name = getGatewayTokenParamName(ctx.name);
    const response = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }), {
      abortSignal: AbortSignal.timeout(30000),
    });
    if (
      response.Parameter?.Name !== name ||
      response.Parameter.Type !== 'SecureString' ||
      !/^[a-f0-9]{48}$/.test(response.Parameter.Value ?? '')
    )
      throw new Error('The managed native Gateway credential is unavailable');
    token = response.Parameter.Value!;
  } finally {
    ssm.destroy();
  }
  options.progress?.('Opening an owned SSM port-forwarding session...');
  const tunnel = await startDashboardTunnel({
    instanceId: source.instanceId,
    target: ctx.target,
    localPort: options.localPort,
  });
  const publicUrl = `http://localhost:${tunnel.port}`;
  const authenticatedUrl = `${publicUrl}/#token=${encodeURIComponent(token)}`;
  return {
    port: tunnel.port,
    publicUrl,
    done: tunnel.done,
    stop: tunnel.stop,
    /** Only the explicit CLI --show-token path prints this private handoff. */
    browserUrl: (includeToken: boolean) => (includeToken ? authenticatedUrl : publicUrl),
    open: () => openLocalBrowser(authenticatedUrl),
  };
}
