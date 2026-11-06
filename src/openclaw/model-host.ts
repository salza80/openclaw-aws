import { createNativeModelClient } from './model-client.js';
import { parseModelJob } from './model-contract.js';
import { runModelOperation, type ModelWorkerMode } from './model-worker.js';
import { createInstanceControlHost } from './native-control-host.js';

/** Model-only operations do not install a provider or silently create its profile. */
export async function runAwsModelWorker(
  input: unknown,
  mode: ModelWorkerMode,
  signal?: AbortSignal,
) {
  const job = parseModelJob(input);
  const host = await createInstanceControlHost(job, signal);
  let gatewayToken: string | undefined;
  try {
    return await runModelOperation(
      job,
      {
        home: host.home,
        async identify() {
          gatewayToken = await host.identify();
          if (job.bedrockRole) await host.requireBedrockProfile();
        },
        client(record) {
          if (!gatewayToken)
            throw new Error('Host identity must be verified before native model access');
          return createNativeModelClient({
            home: host.home,
            packageJson: host.packageJson,
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
    host.dispose();
  }
}
