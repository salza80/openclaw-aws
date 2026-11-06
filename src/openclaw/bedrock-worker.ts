import { parseBedrockJob, type BedrockJob, type BedrockWorkerMode } from './bedrock-contract.js';
import { bedrockHostJournal, type BedrockPhase } from './bedrock-journal.js';
import type { BedrockConfigurationEvent } from './bedrock-configuration.js';

export interface BedrockObservation {
  configHash: string;
  configured: boolean;
  pluginVerified: boolean;
  roleEnvironmentVerified: boolean;
  checkedAt: string;
}
export interface BedrockWorkerHost {
  home: string;
  identify(): Promise<void>;
  /** Read-only source/private environment/plugin-policy preflight. */
  preflight(
    job: BedrockJob,
  ): Promise<{ configHash: string; unrelatedHash: string; pluginInstalled: boolean }>;
  revision(): Promise<{ configHash: string; unrelatedHash: string }>;
  installPlugin(job: BedrockJob): Promise<void>;
  prepareEnvironment(job: BedrockJob): Promise<void>;
  configure(
    job: BedrockJob,
    revision: string,
    record: (event: BedrockConfigurationEvent) => Promise<void>,
    verify: () => Promise<void>,
  ): Promise<unknown>;
  refresh(
    job: BedrockJob,
  ): Promise<{ ready: true; visibleModels: number; checkedAt: string; inferenceVerified: false }>;
  observe(job: BedrockJob): Promise<BedrockObservation>;
}
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const configured = (value: BedrockObservation | null) =>
  value?.configured === true && value.pluginVerified && value.roleEnvironmentVerified;
/** Called under the shared host flock. Every side effect has durable prior
 * intent. A started operation is never replayed; explicit reconciliation only
 * accepts a freshly verified connection and fences any delayed original job. */
export async function runBedrockOperation(
  input: unknown,
  host: BedrockWorkerHost,
  mode: BedrockWorkerMode = 'execute',
) {
  const job = parseBedrockJob(input);
  if (
    !['preview', 'execute', 'inspect', 'accept-configured', 'accept-previous', 'abort'].includes(
      mode,
    )
  )
    throw new Error('Unsupported Bedrock worker mode');
  await host.identify();
  const header = {
    kind: job.kind,
    operationId: job.operationId,
    target: job.target,
    inferenceRegion: job.inferenceRegion,
    inferenceVerified: false as const,
    replayAllowed: false as const,
  };
  if (mode === 'preview') return { ...header, phase: 'preview', ...(await host.preflight(job)) };
  let journal;
  try {
    journal = await bedrockHostJournal(host.home, job, mode === 'execute');
  } catch (error) {
    if (mode === 'execute' || !missing(error)) throw error;
    if (mode === 'accept-configured' || mode === 'accept-previous')
      journal = await bedrockHostJournal(host.home, job, true);
  }
  if (mode !== 'execute') {
    let observed: BedrockObservation | null = null;
    try {
      observed = await host.observe(job);
    } catch {
      /* unavailable is not healthy */
    }
    const history = journal ? await journal.events() : [];
    const latest = history.at(-1);
    const held = journal ? await journal.ownsMaintenance() : null;
    if (mode === 'inspect')
      return {
        ...header,
        phase: latest?.phase ?? 'not-recorded',
        maintenanceHeld: held,
        recordedAt: latest?.checkedAt ?? null,
        observed,
      };
    if (mode === 'abort') {
      const before = history.find((event) => event.phase === 'preflight-ready');
      if (!journal || !before?.unrelatedHash)
        throw new Error(
          'This operation has no durable original-settings proof; inspect it or use unchanged-state reconciliation without guessing',
        );
      if (
        (!held && latest?.phase !== 'aborted') ||
        ['complete', 'rolled-back', 'unchanged'].includes(latest?.phase ?? '')
      )
        throw new Error('Only the original unresolved Bedrock maintenance owner can be aborted');
      if (history.some((event) => event.phase === 'config-intent'))
        throw new Error(
          'A native configuration write may have started; abort cannot cancel an in-flight or unacknowledged patch. Inspect/reconcile its outcome without clearing the hold',
        );
      const current = await host.revision();
      if (current.unrelatedHash !== before.unrelatedHash)
        throw new Error(
          'Native provider or other saved settings differ from the original preflight; abort cannot certify the previous configuration',
        );
      if (latest?.phase !== 'aborted') await journal.append({ phase: 'aborted' });
      if (await journal.ownsMaintenance()) await journal.release();
      return {
        ...header,
        phase: 'aborted',
        maintenanceHeld: false,
        reconciled: true,
        message:
          'Original native settings are verified, excluding only this plugin’s enablement bookkeeping. No plugin/config write was repeated. Installed plugin files, managed role files and additive IAM grants remain; inspect them before a new reviewed setup.',
      };
    }
    if (mode === 'accept-previous') {
      if (latest && ['config-rolled-back', 'rolled-back'].includes(latest.phase)) {
        const before = history.find((event) => event.phase === 'preflight-ready');
        if (!journal || !before?.unrelatedHash || (!held && latest.phase !== 'rolled-back'))
          throw new Error('Recorded rollback lacks its original proof or maintenance ownership');
        // Only the native configuration transaction's durable verified rollback
        // permits this path. An unchanged read cannot settle an in-flight write.
        const current = await host.revision();
        if (current.unrelatedHash !== before.unrelatedHash)
          throw new Error(
            'Native settings changed after rollback; previous-state acceptance refused',
          );
        if (latest.phase !== 'rolled-back') await journal.append({ phase: 'rolled-back' });
        if (await journal.ownsMaintenance()) await journal.release();
        return {
          ...header,
          phase: 'rolled-back',
          maintenanceHeld: false,
          reconciled: true,
          message:
            'Recorded native rollback and current original settings are verified. No provider write was repeated; installed plugin, role files and IAM grants remain for inspection.',
        };
      }
      if (!journal || history.some((event) => !['started', 'unchanged'].includes(event.phase)))
        throw new Error(
          'A started Bedrock plugin/configuration mutation cannot be certified unchanged',
        );
      const before = await host.revision();
      if (before.configHash !== job.expectedHash)
        throw new Error('Original native preview changed; previous-state acceptance refused');
      if (!held && latest?.phase !== 'unchanged') await journal.claim();
      if (latest?.phase !== 'unchanged') await journal.append({ phase: 'unchanged' });
      if (await journal.ownsMaintenance()) await journal.release();
      return {
        ...header,
        phase: 'unchanged',
        maintenanceHeld: false,
        reconciled: true,
        message:
          'Original native revision is unchanged and this pending delivery is fenced. Retained IAM review/applied policy requires separate inspection.',
      };
    }
    if (!journal || !configured(observed))
      throw new Error(
        'Bedrock reconciliation requires a freshly verified configured provider, plugin and role environment',
      );
    if (!held && latest?.phase !== 'complete' && history.length)
      throw new Error('This Bedrock operation does not own maintenance for reconciliation');
    // A read/acceptance may explicitly fence a never-started delivery, but must
    // never replay its original plugin/configuration writes.
    if (!history.length && !held) await journal.claim();
    await host.refresh(job);
    const confirmed = await host.observe(job);
    if (!configured(confirmed) || confirmed.configHash !== observed!.configHash)
      throw new Error('Native Bedrock configuration changed during reconciliation; hold retained');
    if (latest?.phase !== 'complete') {
      if (history.length && latest?.phase !== 'uncertain')
        await journal.append({ phase: 'uncertain' });
      await journal.append({ phase: 'complete' });
    }
    if (await journal.ownsMaintenance()) await journal.release();
    return {
      ...header,
      phase: 'complete',
      maintenanceHeld: false,
      reconciled: true,
      observed: confirmed,
    };
  }
  if (!journal) throw new Error('Bedrock journal is unavailable');
  await journal.claim();
  await journal.append({ phase: 'started' });
  try {
    if (!job.allowRestart || !job.acceptPluginCapabilities)
      throw new Error(
        'Bedrock setup requires explicit plugin capability and controlled-restart approval',
      );
    const before = await host.preflight(job);
    if (before.configHash !== job.expectedHash)
      throw new Error('Native configuration changed after Bedrock preview');
    await journal.append({ phase: 'preflight-ready', unrelatedHash: before.unrelatedHash });
    await journal.append({ phase: 'plugin-intent' });
    await host.installPlugin(job);
    const afterPlugin = await host.revision();
    if (before.unrelatedHash !== afterPlugin.unrelatedHash)
      throw new Error('Unrelated native settings changed during plugin setup');
    await journal.append({ phase: 'plugin-ready' });
    await journal.append({ phase: 'environment-intent' });
    await host.prepareEnvironment(job);
    await journal.append({ phase: 'environment-ready' });
    let discovery: Awaited<ReturnType<BedrockWorkerHost['refresh']>> | undefined;
    await host.configure(
      job,
      afterPlugin.configHash,
      (event) =>
        journal!.append({
          phase: `config-${event.phase}` as BedrockPhase,
          beforeHash: event.beforeHash,
        }),
      async () => {
        await journal!.append({ phase: 'discovery-intent' });
        discovery = await host.refresh(job);
      },
    );
    if (!discovery) throw new Error('Provider activation omitted verified native discovery');
    const observed = await host.observe(job);
    if (!configured(observed)) throw new Error('Bedrock connection readback is unconfirmed');
    await journal.append({ phase: 'complete' });
    await journal.release();
    return { ...header, phase: 'complete', maintenanceHeld: false, discovery, observed };
  } catch {
    const history = await journal.events();
    const latest = history.at(-1)?.phase;
    if (latest === 'started' || latest === 'preflight-ready') {
      await journal.append({ phase: 'unchanged' });
      await journal.release();
      return {
        ...header,
        phase: 'unchanged',
        maintenanceHeld: false,
        message:
          'Bedrock preflight refused this setup. Check the preview revision, plugin policy/provenance and conflicting saved AWS inputs; no provider write was attempted.',
      };
    }
    if (latest === 'config-rolled-back') {
      await journal.append({ phase: 'rolled-back' });
      await journal.release();
      return {
        ...header,
        phase: 'rolled-back',
        maintenanceHeld: false,
        message:
          'Previous native provider settings were restored. The installed plugin, managed role files and additive IAM permissions remain for inspection.',
      };
    }
    if (latest !== 'uncertain' && latest !== 'complete')
      await journal.append({ phase: 'uncertain' });
    return {
      ...header,
      phase: 'uncertain',
      maintenanceHeld: await journal.ownsMaintenance(),
      message:
        'Bedrock setup or discovery is unconfirmed. Inspect this operation and its retained maintenance; never replay plugin or configuration writes.',
    };
  }
}
