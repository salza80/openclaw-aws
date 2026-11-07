import path from 'node:path';
import { execa } from 'execa';
import { createInstanceControlHost } from './native-control-host.js';
import { createNativeModelClient, modelClientEnvironment } from './model-client.js';
import { parseTeamJob, type TeamWorkerMode } from './team-contract.js';
import { runTeamOperation } from './team-worker.js';
import type { NativeModelClient } from './model-control.js';
import { parseMembers } from './backup-contract.js';

/** Same pinned Ubuntu/IMDSv2/private-token boundary as provider and model
 * controls. Gateway and native CLI output stay private; only worker projections
 * cross SSM. The caller owns the shared flock. */
export async function runAwsTeamWorker(input: unknown, mode: TeamWorkerMode, signal?: AbortSignal) {
  const job = parseTeamJob(input);
  const control = await createInstanceControlHost(job, signal);
  let client: NativeModelClient | undefined;
  let token: string | undefined;
  const current = () => {
    if (!client) throw new Error('Team identity must be verified before native access');
    return client;
  };
  try {
    return await runTeamOperation(
      job,
      {
        home: control.home,
        async identify() {
          token = await control.identify();
          if (job.bedrockRole) await control.requireBedrockProfile();
          client = createNativeModelClient({
            home: control.home,
            packageJson: control.packageJson,
            gatewayToken: token,
            signal,
            record: async () => {},
            ...(job.bedrockRole ? { bedrockDeploymentRegion: job.target.region } : {}),
          });
        },
        client: {
          call: (method, params) => current().call(method, params),
          health: () => current().health(),
          restart: () => current().restart(),
          record: async () => {},
        },
        async members() {
          if (!token) throw new Error('Team native reads require verified instance identity');
          try {
            const result = await execa(
              process.execPath,
              [
                path.join(path.dirname(control.packageJson), 'openclaw.mjs'),
                'agents',
                'list',
                '--json',
              ],
              {
                env: modelClientEnvironment({
                  home: control.home,
                  gatewayToken: token,
                  ...(job.bedrockRole ? { bedrockDeploymentRegion: job.target.region } : {}),
                }),
                extendEnv: false,
                cwd: control.home,
                cancelSignal: signal,
                timeout: 60000,
                maxBuffer: 1024 * 1024,
              },
            );
            return parseMembers(JSON.parse(result.stdout));
          } catch {
            throw new Error('Native team roster read failed; private output was not published');
          }
        },
      },
      mode,
    );
  } finally {
    control.dispose();
  }
}
