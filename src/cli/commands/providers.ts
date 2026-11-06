import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { buildCommandContext } from '../utils/context.js';
import { handleError, ValidationError } from '../utils/errors.js';
import {
  prepareBedrockConnection,
  applyBedrockConnection,
  cancelBedrockConnection,
  inspectBedrockConnection,
} from '../../operations/bedrock.js';
interface ProvidersArgs {
  action: string;
  name?: string;
  inferenceRegion?: string;
  grantModel?: string[];
  allowRestart?: boolean;
  acceptPluginCapabilities?: boolean;
  operationId?: string;
  accept?: 'configured' | 'previous';
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}
async function approve(argv: ProvidersArgs, description: string) {
  console.error(description);
  if (argv.yes) return true;
  if (!process.stdin.isTTY)
    throw new ValidationError(
      'Noninteractive provider changes require --yes to approve the displayed plan',
    );
  return (
    (
      await prompts({
        type: 'confirm',
        name: 'approved',
        message: 'Apply this provider operation?',
        initial: false,
      })
    ).approved === true
  );
}
export async function runProvidersCommand(argv: ProvidersArgs) {
  if (!['enable-bedrock', 'inspect', 'reconcile', 'abort'].includes(argv.action))
    throw new ValidationError('Use providers enable-bedrock, inspect, reconcile or abort');
  if (argv.action === 'enable-bedrock') {
    if (!argv.inferenceRegion || argv.accept !== undefined)
      throw new ValidationError(
        'Bedrock enablement requires --inference-region; reconciliation choices belong to providers reconcile',
      );
  } else {
    if (
      !argv.operationId ||
      argv.inferenceRegion !== undefined ||
      argv.grantModel !== undefined ||
      argv.allowRestart ||
      argv.acceptPluginCapabilities ||
      argv.dryRun
    )
      throw new ValidationError(
        'Provider inspection/reconciliation uses --operation-id and its original recorded setup; omit new connection options',
      );
    if (['inspect', 'abort'].includes(argv.action) && argv.accept !== undefined)
      throw new ValidationError('--accept belongs to providers reconcile');
    if (argv.action === 'reconcile' && !['configured', 'previous'].includes(argv.accept ?? ''))
      throw new ValidationError('Choose --accept configured or --accept previous explicitly');
  }
  const ctx = await buildCommandContext({ name: argv.name });
  if (argv.action === 'enable-bedrock') {
    const plan = await prepareBedrockConnection(ctx, {
      inferenceRegion: argv.inferenceRegion!,
      models: argv.grantModel,
      allowRestart: argv.allowRestart,
      acceptPluginCapabilities: argv.acceptPluginCapabilities,
      operationId: argv.operationId,
    });
    let applying = false;
    try {
      if (argv.dryRun) {
        console.log(JSON.stringify({ ...plan, reviewDiscarded: true }, null, 2));
        return;
      }
      if (!plan.job.allowRestart || !plan.job.acceptPluginCapabilities)
        throw new ValidationError(
          'Bedrock enablement requires --allow-restart and --accept-plugin-capabilities for the displayed exact plugin',
        );
      const routeDetails = plan.selection.routes.length
        ? plan.selection.routes
            .map(
              (route) =>
                `  ${route.model} (${route.kind}, ${route.region})\n    Invoke: ${route.invocationArn}\n    Backing models: ${route.modelArns.join(', ')}`,
            )
            .join('\n')
        : '  Discovery only; no model invocation grants.';
      if (
        !(await approve(
          argv,
          `Enable Amazon Bedrock on '${ctx.name}' (${ctx.target.account}/${ctx.target.region}, ${plan.job.target.instanceId}); inference region ${plan.job.inferenceRegion}. Install/enable exactly ${plan.job.plugin.spec} (${plan.job.plugin.integrity}) with its model/embedding provider capabilities; approval flag is ${plan.job.acceptPluginCapabilities ? 'set' : 'not set'}. Controlled shared Gateway restart is ${plan.job.allowRestart ? 'permitted' : 'not permitted'}. Apply only auxiliary role policy ${plan.access.stackName}, retaining ${plan.selection.routes.length} exact routes for this host.\n${routeDetails}\nPreserve OpenRouter, other credentials, agents, models and sessions. No hosting-stack replacement or inference probe. Model usage is billed through AWS; discovery does not prove invocation access. Operation: ${plan.job.operationId}.`,
        ))
      )
        return;
      applying = true;
      const result = await applyBedrockConnection(ctx, plan);
      console.log(JSON.stringify(result, null, 2));
      if (result.phase !== 'complete')
        throw new ValidationError(
          `Provider setup is ${result.phase}; inspect ${plan.job.operationId} before another mutation`,
        );
    } finally {
      if (!applying) await cancelBedrockConnection(ctx, plan);
    }
    return;
  }
  const observed = await inspectBedrockConnection(ctx, argv.operationId!);
  if (argv.action === 'inspect') {
    console.log(JSON.stringify(observed, null, 2));
    return;
  }
  if (
    !(await approve(
      argv,
      argv.action === 'abort'
        ? `Abort Bedrock operation ${argv.operationId} on '${ctx.name}' (${ctx.target.account}/${ctx.target.region}); recorded phase ${observed.phase}. Release only its own hold after verifying the original native settings, excluding this plugin's enablement bookkeeping. Refuse changed provider/settings. Retain plugin/role files and IAM grants for inspection. No config or plugin write is repeated.`
        : `Reconcile Bedrock operation ${argv.operationId} on '${ctx.name}' (${ctx.target.account}/${ctx.target.region}); recorded phase ${observed.phase}. Accept ${argv.accept === 'configured' ? 'a freshly verified configured provider and current IAM grants' : 'only an unchanged original native revision, fencing delayed delivery; retained IAM state requires separate inspection'}. Never repeat plugin/configuration writes.`,
    ))
  )
    return;
  console.log(
    JSON.stringify(
      await inspectBedrockConnection(
        ctx,
        argv.operationId!,
        argv.action === 'abort' ? { abort: true } : { accept: argv.accept },
      ),
      null,
      2,
    ),
  );
}
export const providersCommand: CommandModule<{}, ProvidersArgs> = {
  command: 'providers <action>',
  describe: 'Enable optional native model providers or inspect interrupted setup',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ['enable-bedrock', 'inspect', 'reconcile', 'abort'] as const,
        demandOption: true,
      })
      .option('name', { type: 'string' })
      .option('inference-region', {
        type: 'string',
        describe: 'Bedrock inference region; separate from the hosting deployment region',
      })
      .option('grant-model', {
        type: 'string',
        array: true,
        describe:
          'Native amazon-bedrock/model or profile references to grant; retain existing host routes',
      })
      .option('allow-restart', {
        type: 'boolean',
        describe: 'Approve a controlled shared Gateway restart for provider enablement',
      })
      .option('accept-plugin-capabilities', {
        type: 'boolean',
        describe: 'Approve the exact integrity-pinned official Bedrock model/embedding plugin',
      })
      .option('operation-id', { type: 'string', describe: 'Recorded provider operation UUID' })
      .option('accept', { type: 'string', choices: ['configured', 'previous'] as const })
      .option('dry-run', {
        type: 'boolean',
        describe: 'Show the immutable plan, then discard the unexecuted IAM review',
      })
      .option('yes', { type: 'boolean', default: false })
      .option('json', { type: 'boolean', default: false }),
  handler: async (argv) => {
    try {
      await runProvidersCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
