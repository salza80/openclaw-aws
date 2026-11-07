import { listConfigNames } from '../cli/utils/config-store.js';
import { loadConfigByName } from '../cli/utils/config.js';
import { buildCommandContext } from '../cli/utils/context.js';
import { getStackStatus, getSSMStatus, checkGatewayStatus } from '../cli/utils/aws.js';
import { OPENCLAW_VERSION } from '../cli/constants.js';
import {
  assertDeploymentTarget,
  loadDeploymentState,
  observeRuntime,
  recordDeploymentState,
} from './state.js';
import { readTeamState } from './team-state.js';
import { queryTeam } from './teams.js';
import { StackNotFoundError } from '../cli/utils/errors.js';
import { teamNativeId } from '../openclaw/team-definition.js';
import type { UiDeploymentView } from '../ui/contracts.js';

/** Each saved configuration owns its profile/region. Failed observations remain
 * unknown; they never imply that a host is absent or an agent is idle. */
export async function listDeploymentViews(): Promise<UiDeploymentView[]> {
  return Promise.all(
    listConfigNames().map(async (name) => {
      const view: UiDeploymentView = {
        name,
        account: null,
        region: 'Unknown',
        state: 'unreachable',
        checkedAt: new Date().toISOString(),
        gateway: { healthy: null, checkedAt: null },
        runtime: { expected: OPENCLAW_VERSION, observed: null, checkedAt: null },
      };
      try {
        const config = loadConfigByName(name);
        view.region = config.aws.region;
        view.profile = config.aws.profile;
      } catch {
        view.notice = 'Local configuration could not be read. Inspect it before any operation.';
        return view;
      }
      try {
        const saved = await readTeamState(name);
        view.team = {
          id: saved.teamId,
          coordinator: saved.definition.coordinator,
          members: saved.definition.members.map((member) => ({
            id: teamNativeId(saved.definition, member.id),
            role: member.role,
          })),
          observed: false,
        };
      } catch {
        /* Team metadata is optional and never a live roster claim. */
      }
      try {
        const ctx = await buildCommandContext({ name });
        view.account = ctx.target.account;
        const saved = loadDeploymentState(ctx);
        if (saved)
          view.runtime = {
            expected: saved.desired.version,
            observed: saved.observed?.version ?? null,
            checkedAt: saved.observed?.checkedAt ?? null,
          };
        const status = await getStackStatus(ctx.config.stack.name, ctx.target);
        assertDeploymentTarget(ctx, status);
        view.instanceId = status.instanceId;
        view.stackId = status.stackId;
        view.state =
          status.instanceStatus === 'running' || status.instanceStatus === 'stopped'
            ? status.instanceStatus
            : ['pending', 'stopping', 'shutting-down'].includes(status.instanceStatus ?? '')
              ? 'changing'
              : 'unreachable';
        if (
          view.state === 'running' &&
          status.instanceId &&
          (await getSSMStatus(status.instanceId, ctx.target)).status === 'Online'
        ) {
          const health = await checkGatewayStatus(status.instanceId, ctx.target);
          view.gateway = { healthy: health.running, checkedAt: new Date().toISOString() };
          if (health.running) {
            try {
              const observed = await observeRuntime(ctx, status.instanceId);
              recordDeploymentState(ctx, status, { observed });
              view.runtime = {
                expected: view.runtime.expected,
                observed: observed.version,
                checkedAt: observed.checkedAt,
              };
            } catch {
              view.notice = 'Runtime observation unavailable; any retained version is historical.';
            }
            if (view.team) {
              try {
                const current = await queryTeam(ctx);
                if (current.members) {
                  const roles = new Map(
                    view.team.members.map((member) => [member.id, member.role]),
                  );
                  view.team.members = current.members.map((member) => ({
                    id: member.id,
                    role: roles.get(member.id) ?? 'Native agent',
                    model: current.models?.find((model) => model.agentId === member.id)?.model,
                  }));
                  view.team.observed = true;
                }
              } catch {
                view.notice = 'Live team observation unavailable; showing saved membership.';
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof StackNotFoundError) {
          view.state = 'missing';
          view.notice = 'No hosting stack exists for this configuration.';
        } else
          view.notice =
            'AWS or Gateway observation unavailable. Check this profile’s sign-in and refresh; no absent/idle state is inferred.';
      }
      view.checkedAt = new Date().toISOString();
      return view;
    }),
  );
}
