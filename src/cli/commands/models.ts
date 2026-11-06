import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { buildCommandContext } from '../utils/context.js';
import { handleError, ValidationError } from '../utils/errors.js';
import { nativeModelScope } from '../../openclaw/model-control.js';
import {
  queryModels,
  prepareModelChange,
  applyModelChange,
  cancelModelChange,
  inspectModelOperation,
} from '../../operations/models.js';

interface ModelsArgs {
  action: string;
  model?: string;
  name?: string;
  agent?: string;
  provider?: string;
  offset?: number;
  limit?: number;
  operationId?: string;
  allowRestart?: boolean;
  accept?: 'requested' | 'previous';
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}
async function approve(argv: ModelsArgs, details: string) {
  console.error(details);
  if (argv.yes) return true;
  if (!process.stdin.isTTY)
    throw new ValidationError(
      'Noninteractive model changes require --yes to approve the displayed plan',
    );
  return (
    (
      await prompts({
        type: 'confirm',
        name: 'approved',
        message: 'Apply this model operation?',
        initial: false,
      })
    ).approved === true
  );
}
export async function runModelsCommand(argv: ModelsArgs) {
  if (!['current', 'list', 'set', 'inspect', 'reconcile'].includes(argv.action))
    throw new ValidationError('Use models current, list, set, inspect or reconcile');
  if ((argv.action === 'set') !== Boolean(argv.model))
    throw new ValidationError('Only models set accepts a fully qualified model argument');
  if (argv.action !== 'set' && (argv.allowRestart || argv.dryRun))
    throw new ValidationError('--allow-restart/--dry-run apply only to models set');
  if (
    argv.action !== 'list' &&
    (argv.provider !== undefined || argv.offset !== undefined || argv.limit !== undefined)
  )
    throw new ValidationError('Provider/page options apply only to models list');
  if (argv.action !== 'reconcile' && argv.accept !== undefined)
    throw new ValidationError('--accept applies only to models reconcile');
  if (
    ['inspect', 'reconcile'].includes(argv.action) &&
    (!argv.operationId || argv.agent !== undefined)
  )
    throw new ValidationError(
      'Model inspection/reconciliation requires --operation-id and uses its recorded scope; omit --agent',
    );
  if (argv.action === 'reconcile' && !['requested', 'previous'].includes(argv.accept ?? ''))
    throw new ValidationError('Explicitly select --accept requested or --accept previous');
  if (['current', 'list'].includes(argv.action) && argv.operationId !== undefined)
    throw new ValidationError('Model reads do not accept a mutation operation ID');
  const scope = nativeModelScope(
    argv.agent !== undefined ? { kind: 'agent', agentId: argv.agent } : { kind: 'default' },
  );
  const ctx = await buildCommandContext({ name: argv.name });
  let result: unknown;
  if (argv.action === 'set') {
    const plan = await prepareModelChange(ctx, {
      scope,
      model: argv.model!,
      allowRestart: argv.allowRestart,
      operationId: argv.operationId,
    });
    let applying = false,
      reviewHandled = false;
    try {
      if (argv.dryRun) {
        if (plan.bedrock) {
          reviewHandled = true;
          await cancelModelChange(ctx, plan);
        }
        console.log(
          JSON.stringify(plan.bedrock ? { ...plan, bedrockReviewDiscarded: true } : plan, null, 2),
        );
        return;
      }
      const target = plan.job.target;
      const label = scope.kind === 'agent' ? `agent ${scope.agentId}` : 'Gateway defaults';
      const grants = plan.bedrock
        ? `\nBedrock inference region: ${plan.bedrock.selection.discoveryRegion}; auxiliary policy: ${plan.bedrock.access.stackName}.\n${plan.bedrock.selection.routes.map((route) => `  ${route.model}: ${route.invocationArn}; backing models: ${route.modelArns.join(', ')}`).join('\n')}\nAdditive IAM grants remain after a native refusal or rollback; the hosting stack is not updated.`
        : '';
      if (
        !(await approve(
          argv,
          `Change ${label} on '${ctx.name}' (${target.account}/${target.region}, ${target.instanceId}) from ${plan.before.effectiveForNewSessions} to ${argv.model}. Native reload policy applies; controlled restart when reload is off is ${plan.job.action.kind === 'set' && plan.job.action.allowRestart ? 'permitted' : 'not permitted'}. Preserve sibling models, fallbacks and session selections. Metadata checks send no model prompts. Operation: ${plan.job.operationId}.${grants}`,
        ))
      )
        return;
      applying = true;
      result = await applyModelChange(ctx, plan);
    } finally {
      if (!applying && !reviewHandled && plan.bedrock) {
        await cancelModelChange(ctx, plan);
      }
    }
  } else if (argv.action === 'inspect' || argv.action === 'reconcile') {
    const observed = await inspectModelOperation(ctx, argv.operationId!);
    if (argv.action === 'inspect') result = observed;
    else {
      if (
        !(await approve(
          argv,
          `Reconcile model operation ${argv.operationId} on '${ctx.name}' (${ctx.target.account}/${ctx.target.region}). Recorded phase: ${observed.phase}; current observation: ${observed.observed === null ? 'unavailable' : 'available'}. Accept only the verified ${argv.accept} model state and release this operation's maintenance if owned. Do not repeat a model write.`,
        ))
      )
        return;
      result = await inspectModelOperation(ctx, argv.operationId!, { accept: argv.accept });
    }
  } else
    result = await queryModels(ctx, {
      scope,
      action:
        argv.action === 'list'
          ? {
              kind: 'list',
              ...(argv.provider !== undefined ? { provider: argv.provider } : {}),
              offset: argv.offset ?? 0,
              limit: argv.limit ?? 20,
            }
          : { kind: 'current' },
    });
  // Shared operations expose only validated bounded metadata. Keep machine
  // output stable and put prompts/plans on stderr when --json is used.
  console.log(JSON.stringify(result, null, 2));
  if (argv.action === 'set' && (result as { phase?: string }).phase !== 'complete')
    throw new ValidationError(
      `Model change did not complete. Inspect operation ${(result as { operationId: string }).operationId}; the write will not be replayed.`,
    );
}
export const modelsCommand: CommandModule<{}, ModelsArgs> = {
  command: 'models <action> [model]',
  describe: 'Inspect or change native models on an existing AWS claw',
  builder: (yargs) =>
    yargs
      .positional('action', {
        choices: ['current', 'list', 'set', 'inspect', 'reconcile'] as const,
        type: 'string',
        demandOption: true,
      })
      .positional('model', {
        type: 'string',
        describe: 'Fully qualified native provider/model key for set',
      })
      .option('name', { type: 'string', describe: 'Deployment name' })
      .option('agent', {
        type: 'string',
        describe: 'Existing native agent ID; omission targets Gateway defaults',
      })
      .option('provider', { type: 'string', describe: 'Native provider inventory filter' })
      .option('offset', { type: 'number', describe: 'Native inventory page offset' })
      .option('limit', { type: 'number', describe: 'Maximum page rows (1–50; default 20)' })
      .option('operation-id', { type: 'string', describe: 'Exact recorded model operation UUID' })
      .option('allow-restart', {
        type: 'boolean',
        default: false,
        describe: 'Permit controlled Gateway restart when native reload is off',
      })
      .option('accept', {
        type: 'string',
        choices: ['requested', 'previous'] as const,
        describe: 'Explicit observed outcome to accept during reconciliation',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'Preview a model change without changing native settings',
      })
      .option('yes', {
        type: 'boolean',
        default: false,
        describe: 'Approve the displayed model operation',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Return bounded structured model metadata',
      }),
  handler: async (argv) => {
    try {
      await runModelsCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default modelsCommand;
