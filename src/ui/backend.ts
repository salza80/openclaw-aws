import { buildCommandContext } from '../cli/utils/context.js';
import { listDeploymentViews } from '../operations/deployment-view.js';
import { resolveAwsTarget } from '../aws/target.js';
import { inspectRecoverySource } from '../aws/recovery-source.js';
import { prepareInstancePower, applyInstancePower } from '../operations/instances.js';
import { prepareNativeDashboard } from '../operations/native-dashboard.js';
import {
  queryModels,
  prepareModelChange,
  applyModelChange,
  cancelModelChange,
  inspectModelOperation,
} from '../operations/models.js';
import {
  prepareBedrockConnection,
  applyBedrockConnection,
  cancelBedrockConnection,
  inspectBedrockConnection,
} from '../operations/bedrock.js';
import { prepareTeam, applyTeam, inspectTeamOperation } from '../operations/teams.js';
import { readTeamState } from '../operations/team-state.js';
import {
  prepareTeamArchive,
  stageTeamRestore,
  resumeTeamRestore,
} from '../operations/team-lifecycle.js';
import { createBackup, listBackups, inspectBackup } from '../operations/backup.js';
import {
  planArchive,
  createArchive,
  inspectArchive,
  resumeArchive,
  abortArchive,
} from '../operations/archive.js';
import { prepareRestore, stageRestore, resumeRestore } from '../operations/restore.js';
import { prepareClone, stageClone, resumeClone } from '../operations/clone.js';
import { cloneReport } from '../operations/clone-record.js';
import { parseTeamDefinition, teamNativeId } from '../openclaw/team-definition.js';
import { modelObject, modelText } from '../openclaw/model-contract.js';
import type {
  UiBackend,
  UiActionRequest,
  UiPlanView,
  UiPreparedAction,
  UiFact,
  UiTarget,
  UiRecoveryPointView,
} from './contracts.js';

const fact = (label: string, value: string | number | boolean | null | undefined): UiFact => ({
  label,
  value: value === '' ? 'None' : String(value ?? 'Unknown'),
});
const sourceTarget = (
  ctx: Awaited<ReturnType<typeof buildCommandContext>>,
  source: { stackId: string; instanceId: string },
): UiTarget => ({
  name: ctx.name,
  account: ctx.target.account,
  region: ctx.target.region,
  stackId: source.stackId,
  instanceId: source.instanceId,
});
const recoveryRequest = (
  request: UiActionRequest,
  operationId: string,
  recoveryKind: UiActionRequest['recoveryKind'],
): UiActionRequest => ({
  action: 'resume',
  name: request.name,
  operationId,
  recoveryKind,
  ...(request.vault ? { vault: request.vault } : {}),
  ...(request.region ? { region: request.region } : {}),
  ...(request.profile ? { profile: request.profile } : {}),
});

/** Thin application adapter. Only explicit public projections cross into HTTP;
 * private contexts and prepared native/IAM plans stay in these closures. */
export function createUiBackend(): UiBackend {
  const tunnels = new Map<string, Awaited<ReturnType<typeof prepareNativeDashboard>>>();
  const opening = new Map<string, Promise<{ publicUrl: string }>>();
  const backend: UiBackend = {
    deployments: listDeploymentViews,
    async openNative(name) {
      const prior = opening.get(name);
      if (prior) return prior;
      const work = (async () => {
        // Reopening rechecks the current named host rather than reusing a
        // credential/tunnel that may belong to an archived/replaced instance.
        tunnels.get(name)?.stop();
        const tunnel = await prepareNativeDashboard(await buildCommandContext({ name }));
        tunnels.set(name, tunnel);
        void tunnel.done
          .catch(() => {})
          .finally(() => {
            if (tunnels.get(name) === tunnel) tunnels.delete(name);
          });
        await tunnel.open();
        return { publicUrl: tunnel.publicUrl };
      })();
      opening.set(name, work);
      try {
        return await work;
      } finally {
        opening.delete(name);
      }
    },
    async models(name, agent) {
      const ctx = await buildCommandContext({ name });
      const scope = agent
        ? { kind: 'agent' as const, agentId: agent }
        : { kind: 'default' as const };
      const current = await queryModels(ctx, { scope, action: { kind: 'current' } });
      const models: { id: string; available: boolean | null }[] = [];
      let offset = 0;
      do {
        const page = await queryModels(ctx, {
          scope,
          action: { kind: 'list', offset, limit: 50 },
        });
        for (const value of page.models as unknown[]) {
          const row = modelObject(value);
          models.push({
            id: modelText(row.model),
            available: typeof row.available === 'boolean' ? row.available : null,
          });
        }
        if (page.nextOffset === null) break;
        offset = page.nextOffset as number;
        if (models.length >= 10000) throw new Error('Model inventory exceeds the supported view');
      } while (offset < 10000);
      return { current: modelText(current.effectiveForNewSessions), models };
    },
    async recovery(reference) {
      const target = await resolveAwsTarget(reference);
      const points = await listBackups(target, reference.uri);
      const views: UiRecoveryPointView[] = [];
      for (const point of points) {
        let archived = false;
        if (point.capture.gateway.held?.kind === 'archive') {
          try {
            archived =
              (
                await inspectArchive({
                  vaultUri: reference.uri,
                  operationId: point.id,
                  region: reference.region,
                  profile: reference.profile,
                })
              ).recordedPhase === 'archived';
          } catch {
            /* A held backup alone does not prove deleted compute. */
          }
        }
        const team = point.capture.credentials.team;
        views.push({
          id: point.id,
          name: point.job.archive?.deploymentName ?? point.source.stackName,
          vault: reference,
          savedAt: point.completedAt,
          state: archived ? 'archived' : 'backup',
          sourceStackId: point.source.stackId,
          agents: point.capture.members.map((member) => ({
            id: member.id,
            model: member.model,
            role: team?.roles.find((role) => role.nativeId === member.id)?.role,
          })),
          ...(team ? { teamId: team.id } : {}),
          minimumDiskGiB: point.source.instance.minimumDiskGiB,
        });
      }
      return views;
    },
    async prepare(request, id) {
      const view: UiPlanView = {
        id,
        action: request.action,
        title: request.action,
        createdAt: new Date().toISOString(),
        target: { name: request.name!, account: '', region: '' },
        facts: [],
        effects: [],
      };
      const prepared = (
        apply: UiPreparedAction['apply'],
        cancel?: UiPreparedAction['cancel'],
      ): UiPreparedAction => ({ view, apply, ...(cancel ? { cancel } : {}) });
      if (request.action === 'restore' || request.action === 'clone') {
        const recoveryTarget = await resolveAwsTarget({
          region: request.region!,
          profile: request.profile,
        });
        const options = {
          recoveryTarget,
          vaultUri: request.vault!,
          pointId: request.from!,
          name: request.name!,
          region: request.targetRegion,
          profile: request.targetProfile,
          instanceType: request.instanceType,
          volumeGiB: request.volumeGiB,
          operationId: id,
        };
        const plan =
          request.action === 'restore'
            ? await prepareRestore(options)
            : await prepareClone({
                ...options,
                apiProvider: request.provider as import('../cli/types/index.js').Provider,
                bedrockRegion: request.bedrockRegion,
              });
        if (
          request.action === 'restore' &&
          (plan as Awaited<ReturnType<typeof prepareRestore>>).sourcePresence.kind !== 'gone'
        )
          throw new Error(
            'Source identity remains present; archive it first or choose an independent clone',
          );
        view.target = {
          name: plan.context.name,
          account: plan.context.target.account,
          region: plan.context.target.region,
        };
        view.facts = [
          fact('Recovery point', plan.point.id),
          fact('Source stack', plan.point.source.stackId),
          fact('EC2 type', plan.context.config.instance.type),
          fact('Encrypted disk GiB', plan.bootstrap.volumeGiB),
          fact('Independent vault', request.vault),
        ];
        view.effects = [
          'Create one billed EC2 host and disk; retained independent vault and keys continue to incur storage costs.',
          'Stage verified saved content with the Gateway inactive. Activation is a separate reviewed operation.',
          ...(request.action === 'clone'
            ? [
                'Create a new identity with explicit target credentials; source conversations and external connections are not adopted.',
              ]
            : [
                'Restore saved native identity and sessions under recovery holds; source must be destroyed before activation.',
              ]),
        ];
        view.recovery = [recoveryRequest(request, id, request.action)];
        if (plan.bedrock) {
          view.facts.push(fact('Bedrock inference region', plan.bedrock.intent.inferenceRegion));
          for (const route of plan.bedrock.selection.routes)
            view.facts.push(
              fact('Bedrock invocation', route.invocationArn),
              fact('Backing model resources', route.modelArns.join(', ')),
            );
          view.effects.push(
            'Recreate the reviewed instance-role Bedrock connection, pinned model/embedding plugin and scoped IAM grants; model usage is billed through AWS.',
          );
        }
        if (request.action === 'restore') {
          const restore = plan as Awaited<ReturnType<typeof prepareRestore>>;
          view.facts.push(
            fact('Recovery prerequisites and omissions', restore.prerequisites.join('\n')),
          );
          return prepared(async (progress) => {
            const team = restore.point.capture.credentials.team;
            const result = team
              ? await stageTeamRestore({ ...restore, team }, recoveryTarget, { progress })
              : await stageRestore(restore, recoveryTarget, { progress });
            return {
              summary: 'Restoration staged. Gateway activation requires a separate approval.',
              facts: [fact('Phase', result.phase), fact('Operation', id)],
              recovery: [{ ...recoveryRequest(request, id, 'restore'), activate: true }],
            };
          });
        }
        const clone = plan as Awaited<ReturnType<typeof prepareClone>>;
        const report = cloneReport(clone.preview);
        view.facts.push(
          fact('Copied files', report.copiedFiles),
          fact('Required credential providers', report.providersInUse.join(', ')),
          fact('Copied native agents', report.agentIds.join(', ')),
          fact('Deliberately omitted content', report.omissions.join('\n')),
        );
        return prepared(async (progress) => {
          // Resolve only references after the user approves. Values never enter UI records.
          const { resolveCredentialReferences } =
            await import('../operations/credential-references.js');
          const values = await resolveCredentialReferences(
            request.credentials ?? [],
            clone.context.target,
          );
          const result = await stageClone(clone, recoveryTarget, values, { progress });
          return {
            summary: 'Independent copy staged with a fresh identity; activation is separate.',
            facts: [fact('Phase', result.phase), fact('Operation', id)],
            recovery: [{ ...recoveryRequest(request, id, 'clone'), activate: true }],
          };
        });
      }
      if (request.action === 'resume' && request.recoveryKind === 'archive') {
        const options = {
          vaultUri: request.vault!,
          operationId: request.operationId!,
          region: request.region!,
          profile: request.profile,
        };
        const status = await inspectArchive(options);
        const target = await resolveAwsTarget(options);
        view.target = { name: status.name, account: target.account, region: target.region };
        view.facts = [
          fact('Original archive', request.operationId),
          fact('Recorded phase', status.recordedPhase),
        ];
        view.effects = [
          request.accept === 'abort'
            ? 'Attempt an owned pre-teardown abort; no rollback of unknown work is claimed.'
            : 'Continue the original verified archive operation. Original capture and teardown journals remain authoritative.',
        ];
        return prepared(async () => {
          const result =
            request.accept === 'abort' ? await abortArchive(options) : await resumeArchive(options);
          return {
            summary: 'Original archive reconciled.',
            facts: [fact('Phase', result.recordedPhase)],
          };
        });
      }
      if (
        request.action === 'resume' &&
        (request.recoveryKind === 'restore' || request.recoveryKind === 'clone')
      ) {
        const { loadRestoreRecord } = await import('../operations/restore-record.js');
        const { loadCloneRecord } = await import('../operations/clone-record.js');
        const record =
          request.recoveryKind === 'restore'
            ? loadRestoreRecord(request.operationId!)
            : loadCloneRecord(request.operationId!);
        const target = await resolveAwsTarget(record.config.aws);
        view.target = { name: record.name, account: target.account, region: target.region };
        view.facts = [
          fact('Original operation', request.operationId),
          fact('Recorded phase', record.phase),
        ];
        view.effects = [
          request.activate
            ? 'Deliberately activate the original staged Gateway after its native recovery checks; retained historical work stays held.'
            : 'Inspect/reconcile the original staged operation without creating another host.',
        ];
        return prepared(async (progress) => {
          let result;
          if (request.recoveryKind === 'restore') {
            const point = await inspectBackup(
              await resolveAwsTarget({
                region: record.recovery.region,
                profile: record.recovery.profile,
              }),
              record.recovery.uri,
              record.recovery.pointId,
            );
            result = point.capture.credentials.team
              ? await resumeTeamRestore(request.operationId!, {
                  activate: request.activate,
                  progress,
                })
              : await resumeRestore(request.operationId!, { activate: request.activate, progress });
          } else
            result = await resumeClone(request.operationId!, {
              activate: request.activate,
              progress,
            });
          return {
            summary: 'Recovery operation reconciled.',
            facts: [fact('Phase', result.phase)],
          };
        });
      }
      if (request.action === 'create' || request.action === 'team-create') {
        const { prepareUiCreate } = await import('./create.js');
        return prepareUiCreate(request, view);
      }
      const ctx = await buildCommandContext({ name: request.name });
      const source = await inspectRecoverySource(ctx);
      view.target = sourceTarget(ctx, source);
      if (request.action === 'start' || request.action === 'stop') {
        const plan = await prepareInstancePower(ctx, request.action);
        view.target = {
          name: ctx.name,
          account: plan.target.account,
          region: plan.target.region,
          stackId: plan.target.stackId,
          instanceId: plan.target.instanceId,
        };
        view.facts = [
          fact('Current power', plan.before),
          fact('EC2 instance', plan.target.instanceId),
        ];
        view.effects = [
          request.action === 'start'
            ? 'Start compute billing. SSM readiness and Gateway health are separate observations.'
            : 'Stop compute billing. Disk, snapshots, addresses, vaults and keys can still incur costs.',
        ];
        return prepared(async (progress) => {
          const result = await applyInstancePower(ctx, plan, { progress });
          return {
            summary: `Observed EC2 state: ${result.state}.`,
            facts: [fact('SSM ready', result.ssmReady), fact('Checked', result.checkedAt)],
          };
        });
      }
      if (request.action === 'backup') {
        view.facts = [fact('Independent vault', request.vault), fact('Operation', id)];
        view.effects = [
          'Capture and verify the complete native installation in the independent vault, restoring the original Gateway state afterwards.',
          'Vault objects and encryption keys remain billable independently of this host.',
        ];
        return prepared(async (progress) => {
          const result = await createBackup(ctx, {
            vaultUri: request.vault!,
            operationId: id,
            progress,
            expectedSource: {
              stackId: source.stackId,
              instanceId: source.instanceId,
              roleId: source.role.id,
            },
          });
          return {
            summary: 'Verified backup saved.',
            facts: [fact('Recovery point', result.id), fact('Saved at', result.completedAt)],
          };
        });
      }
      if (request.action === 'archive') {
        let team = false;
        try {
          await readTeamState(ctx.name);
          team = true;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const options = {
          vaultUri: request.vault!,
          operationId: id,
          deleteConfig: !request.keepConfig,
        };
        const plan = team
          ? await prepareTeamArchive(ctx, options)
          : await planArchive(ctx, options);
        view.facts = [
          fact('Independent vault', plan.vaultUri),
          fact(
            'Complete native roster',
            plan.expectedMembers.map((member) => member.id).join(', '),
          ),
          fact('Delete local configuration', plan.deleteConfig),
          fact('Original source stack', plan.deletion.source.stackId),
          fact('Root volume to delete', plan.deletion.volumeId),
          fact(
            'Owned source parameters to delete',
            plan.deletion.parameters.map((parameter) => parameter.name).join('\n'),
          ),
          fact(
            'Hosting resources to delete',
            plan.deletion.source.resources
              .map((resource) => `${resource.type}: ${resource.id}`)
              .join('\n'),
          ),
          fact(
            'Shared resources retained',
            `${plan.config.network.useDefaultVpc ? 'Default VPC; ' : ''}CDK bootstrap; independent vault and key`,
          ),
        ];
        view.effects = [
          'Verify a complete backup, persist recovery metadata independently, then delete the approved original hosting stack and owned source credentials.',
          'Compute and hosting disk are removed; independent vault objects, versions and encryption keys remain billable.',
          'All agents on this host are included. Recovery can use the vault reference from a clean client.',
        ];
        view.recovery = [
          {
            ...recoveryRequest(request, id, 'archive'),
            region: ctx.target.region,
            profile: ctx.target.profile,
          },
        ];
        return prepared(async () => {
          const result = await createArchive(ctx, plan);
          return {
            summary: 'Hosting resources archived; independent recovery point retained.',
            facts: [
              fact('Recovery point', result.pointId),
              fact('Local configuration', result.localConfig),
              fact('Retained resources', result.retained.join(', ')),
            ],
          };
        });
      }
      if (request.action === 'model-set') {
        const plan = await prepareModelChange(ctx, {
          scope: request.agent ? { kind: 'agent', agentId: request.agent } : { kind: 'default' },
          model: request.model!,
          allowRestart: request.allowRestart,
          operationId: id,
        });
        view.facts = [
          fact('Scope', request.agent ?? 'Default'),
          fact('Before', plan.before.effectiveForNewSessions),
          fact('Requested', request.model),
          fact('Restart allowed', request.allowRestart ?? false),
        ];
        view.effects = [
          'Set the persistent native model for new sessions while preserving existing session selections and unrelated settings.',
          ...(plan.bedrock
            ? ['Apply the reviewed additive Bedrock role permissions required by this model.']
            : []),
        ];
        if (plan.bedrock) {
          view.facts.push(
            fact('Bedrock policy stack', plan.bedrock.access.stackName),
            fact('Reviewed policy digest', plan.bedrock.access.templateDigest),
          );
          for (const route of plan.bedrock.selection.routes)
            view.facts.push(
              fact('Bedrock invocation', route.invocationArn),
              fact('Backing model resources', route.modelArns.join(', ')),
            );
        }
        view.recovery = [recoveryRequest(request, id, 'model')];
        return prepared(
          async () => {
            const result = await applyModelChange(ctx, plan);
            if (result.phase !== 'complete') throw new Error('Model outcome requires inspection');
            return {
              summary: 'Persistent model selection confirmed.',
              facts: [fact('Model', modelText(result.effectiveForNewSessions))],
            };
          },
          () => cancelModelChange(ctx, plan),
        );
      }
      if (request.action === 'bedrock-enable') {
        const plan = await prepareBedrockConnection(ctx, {
          inferenceRegion: request.bedrockRegion!,
          models: request.model ? [request.model] : undefined,
          allowRestart: request.allowRestart,
          acceptPluginCapabilities: true,
          operationId: id,
        });
        view.facts = [
          fact('Inference region', request.bedrockRegion),
          fact('Approved routes', plan.selection.routes.map((route) => route.model).join(', ')),
          fact('Restart allowed', request.allowRestart ?? false),
          fact('Host role identity', plan.job.target.roleId),
          fact('Bedrock policy stack', plan.access.stackName),
          fact('Reviewed policy digest', plan.access.templateDigest),
        ];
        for (const route of plan.selection.routes)
          view.facts.push(
            fact('Bedrock invocation', route.invocationArn),
            fact('Backing model resources', route.modelArns.join(', ')),
          );
        view.effects = [
          'Enable the pinned native Bedrock model/embedding plugin and an instance-role connection; AWS bills model usage.',
          'Apply the prepared additive IAM change set for these routes, retaining sibling and fallback access. Preserve other provider credentials.',
        ];
        view.recovery = [recoveryRequest(request, id, 'bedrock')];
        return prepared(
          async () => {
            const result = await applyBedrockConnection(ctx, plan);
            if (result.phase !== 'complete') throw new Error('Bedrock setup requires inspection');
            return {
              summary: 'Bedrock connection configured. Paid inference has not been tested.',
              facts: [fact('Phase', result.phase)],
            };
          },
          () => cancelBedrockConnection(ctx, plan),
        );
      }
      if (request.action === 'team-configure') {
        let teamId: string | undefined;
        try {
          teamId = (await readTeamState(ctx.name)).teamId;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (teamId && request.teamId && teamId !== request.teamId)
          throw new Error('Requested team identity differs from this host’s saved team');
        teamId ??= request.teamId;
        const plan = await prepareTeam(ctx, {
          definition: parseTeamDefinition(request.definition),
          teamId,
          allowRestart: request.allowRestart,
          operationId: id,
        });
        view.facts = [
          fact('Team identity', plan.job.teamId),
          fact(
            'Roles',
            plan.job.definition.members.map((member) => `${member.id}: ${member.role}`).join(', '),
          ),
          fact('Restart allowed', request.allowRestart ?? false),
          fact(
            'Native concurrency / spawn depth',
            `${plan.job.definition.maxConcurrent} / ${plan.job.definition.maxSpawnDepth}`,
          ),
          fact('Bindings', JSON.stringify(plan.job.definition.bindings)),
        ];
        for (const member of plan.job.definition.members) {
          view.facts.push(
            fact(
              `Role ${member.id}`,
              `${member.role}; native ID ${teamNativeId(plan.job.definition, member.id)}; model ${JSON.stringify(member.model ?? 'inherit')}; send to ${member.sendTo.join(', ') || 'none'}; delegate to ${member.delegateTo.join(', ') || 'none'}; tools ${JSON.stringify(member.tools ?? 'inherit')}`,
            ),
            fact(`Instructions ${member.id}`, member.instructions),
          );
        }
        view.effects = [
          'Configure native agent roles, instructions and explicit communication/delegation on this one host. No second EC2 instance is created.',
          'Native OpenClaw remains responsible for coordination, conversations and work.',
        ];
        view.recovery = [recoveryRequest(request, id, 'team')];
        return prepared(async () => {
          const result = await applyTeam(ctx, plan);
          if (result.recordedPhase !== 'complete')
            throw new Error('Team configuration requires inspection');
          return {
            summary: 'Native team configuration confirmed.',
            facts: [fact('Team', result.teamId), fact('Phase', result.recordedPhase)],
          };
        });
      }
      if (request.action === 'resume') {
        view.facts = [
          fact('Original operation', request.operationId),
          fact('Recovery kind', request.recoveryKind),
          fact('Explicit acceptance', request.accept ?? 'Inspect/reconcile'),
        ];
        view.effects = [
          'Use the original native journal and pinned request. Unknown native writes are never automatically repeated.',
        ];
        return prepared(async () => {
          if (request.recoveryKind === 'team') {
            const result = await inspectTeamOperation(ctx, request.operationId!, {
              mode: request.accept === 'abort' ? 'abort' : 'resume',
            });
            return {
              summary: 'Team operation inspected/reconciled.',
              facts: [fact('Phase', result.result.recordedPhase)],
            };
          }
          if (request.recoveryKind === 'model') {
            if (request.accept === 'abort')
              throw new Error(
                'Choose explicit previous/requested-state acceptance for model recovery',
              );
            const result = await inspectModelOperation(ctx, request.operationId!, {
              accept: request.accept,
            });
            return {
              summary: 'Model operation inspected/reconciled.',
              facts: [fact('Phase', result.phase)],
            };
          }
          if (request.recoveryKind === 'bedrock') {
            const result = await inspectBedrockConnection(ctx, request.operationId!, {
              accept:
                request.accept === 'requested'
                  ? 'configured'
                  : request.accept === 'previous'
                    ? 'previous'
                    : undefined,
              abort: request.accept === 'abort',
            });
            return {
              summary: 'Provider operation inspected/reconciled.',
              facts: [fact('Phase', result.phase)],
            };
          }
          throw new Error('Unsupported recovery kind');
        });
      }
      throw new Error('Unsupported UI operation');
    },
    async close() {
      await Promise.allSettled([...tunnels.values()].map((tunnel) => tunnel.stop()));
      tunnels.clear();
    },
  };
  return backend;
}
