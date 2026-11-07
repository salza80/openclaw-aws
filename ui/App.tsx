import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import type {
  UiAction,
  UiActionRequest,
  UiDeploymentView,
  UiJobView,
  UiRecoveryPointView,
  UiVaultReference,
} from '../src/ui/contracts';
import styles from './App.module.css';

const actions: { value: UiAction; label: string }[] = [
  { value: 'create', label: 'Create a claw' },
  { value: 'team-create', label: 'Create a team host' },
  { value: 'start', label: 'Start' },
  { value: 'stop', label: 'Stop' },
  { value: 'backup', label: 'Back up' },
  { value: 'archive', label: 'Back up & destroy host' },
  { value: 'restore', label: 'Restore saved identity' },
  { value: 'clone', label: 'Copy into a new claw' },
  { value: 'team-configure', label: 'Configure native team' },
  { value: 'model-set', label: 'Switch model' },
  { value: 'bedrock-enable', label: 'Enable Bedrock' },
  { value: 'resume', label: 'Inspect / reconcile operation' },
];
const providers = [
  'openrouter-api-key',
  'amazon-bedrock',
  'anthropic-api-key',
  'openai-api-key',
  'gemini-api-key',
];
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Not observed');
const teamExample = JSON.stringify(
  {
    schemaVersion: 1,
    topology: 'single-host',
    coordinator: 'lead',
    members: [
      { id: 'lead', role: 'Coordinator', instructions: 'Coordinate the team and combine results.' },
      {
        id: 'researcher',
        role: 'Research',
        instructions: 'Research assigned questions and report evidence.',
      },
      {
        id: 'reviewer',
        role: 'Review',
        instructions: 'Review evidence, check conclusions and report problems to the coordinator.',
      },
    ],
  },
  null,
  2,
);
const title = (action: UiAction) => actions.find((item) => item.value === action)!.label;

export function App() {
  const [deployments, setDeployments] = useState<UiDeploymentView[]>([]);
  const [jobs, setJobs] = useState<UiJobView[]>([]);
  const [points, setPoints] = useState<UiRecoveryPointView[]>([]);
  const [request, setRequest] = useState<UiActionRequest>({
    action: 'create',
    region: 'eu-central-1',
    instanceType: 't3a.small',
    provider: 'openrouter-api-key',
  });
  const [vault, setVault] = useState<UiVaultReference>({ uri: '', region: 'eu-central-1' });
  const [definition, setDefinition] = useState(teamExample);
  const [credential, setCredential] = useState({ kind: 'env', reference: 'OPENROUTER_API_KEY' });
  const [additionalCredentials, setAdditionalCredentials] = useState('[]');
  const [catalog, setCatalog] = useState<{
    current: string;
    models: { id: string; available: boolean | null }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const form = useRef<HTMLElement>(null);
  const running = jobs.some((job) => job.phase === 'running');
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  const refresh = async () => {
    const result = await api<{ deployments: UiDeploymentView[]; jobs: UiJobView[] }>('state');
    setDeployments(result.deployments);
    setJobs(result.jobs);
  };
  useEffect(() => {
    void perform(async () => {
      const code = new URLSearchParams(window.location.hash.slice(1)).get('pair');
      window.history.replaceState(null, '', window.location.pathname);
      if (code) await api('session', { code });
      await refresh();
      setReady(true);
    });
  }, []);
  useEffect(() => {
    if (!ready || !running) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api<{ jobs: UiJobView[] }>('jobs')
        .then((result) => {
          if (active) setJobs(result.jobs);
        })
        .catch(() => {
          if (active)
            setError(
              'Progress connection lost. Reload to reconnect to the original operation; do not submit a replacement.',
            );
        });
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [ready, running]);
  const choose = (next: UiActionRequest) => {
    setRequest(next);
    setCatalog(null);
    setError('');
    if (next.definition) setDefinition(JSON.stringify(next.definition, null, 2));
    form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const update = (patch: Partial<UiActionRequest>) =>
    setRequest((previous) => ({ ...previous, ...patch }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const input = { ...request };
      if (input.action === 'team-create' || input.action === 'team-configure')
        input.definition = JSON.parse(definition);
      if (
        ['create', 'team-create', 'clone'].includes(input.action) &&
        input.provider !== 'amazon-bedrock'
      )
        input.credentials = [
          {
            provider: input.provider!,
            kind: credential.kind as 'env' | 'ssm',
            reference: credential.reference,
          },
        ];
      if (['create', 'team-create', 'clone'].includes(input.action)) {
        const additional: unknown = JSON.parse(additionalCredentials);
        if (!Array.isArray(additional))
          throw new Error('Additional credential references must be a JSON array.');
        input.credentials = [...(input.credentials ?? []), ...additional];
      }
      const job = await api<UiJobView>('plans', input);
      setJobs((previous) => [job, ...previous]);
      setNotice('Review the concrete target and effects below. No operation has been applied.');
      document.getElementById('operations')?.scrollIntoView({ behavior: 'smooth' });
    });
  };
  const creating = ['create', 'team-create'].includes(request.action);
  const recovering = ['restore', 'clone'].includes(request.action);
  const providerForm = creating || request.action === 'clone';
  const needsRegion =
    creating || recovering || (request.action === 'resume' && request.recoveryKind === 'archive');
  const needsVault =
    ['backup', 'archive', 'restore', 'clone'].includes(request.action) ||
    (request.action === 'resume' && request.recoveryKind === 'archive');
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            ⌘
          </span>
          <div>
            <strong>OpenClaw AWS</strong>
            <span>Local console</span>
          </div>
        </div>
        <span className={styles.local}>
          ● Local session · AWS credentials stay on this computer
        </span>
      </header>
      <main>
        <div className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>YOUR CLAWS, ON DEMAND</p>
            <h1>
              Bring a team to life.
              <br />
              Keep its work when it rests.
            </h1>
            <p>Create, run and archive OpenClaw hosts from one local console.</p>
          </div>
          <button disabled={busy || !ready} onClick={() => void perform(refresh)}>
            Refresh observations
          </button>
        </div>
        <div role="alert" className={error ? styles.error : styles.hidden}>
          {error}
        </div>
        <p role="status" className={styles.notice}>
          {busy ? 'Working with the local backend…' : notice}
        </p>
        {!ready && (
          <section className={styles.panel}>
            <h2>Connect this browser</h2>
            <p>
              Use the pairing link printed by <code>openclaw-aws ui</code>. Pairing expires after
              ten minutes; relaunch the command if needed.
            </p>
          </section>
        )}
        <section aria-labelledby="hosts-heading">
          <div className={styles.sectionTitle}>
            <h2 id="hosts-heading">Hosting deployments</h2>
            <span>{deployments.length} configured</span>
          </div>
          {ready && deployments.length === 0 && (
            <div className={styles.empty}>
              No local deployments yet. Create a claw below, or discover saved work from an
              independent vault.
            </div>
          )}
          <div className={styles.grid}>
            {deployments.map((host) => (
              <article key={host.name} className={styles.card}>
                <div className={styles.cardTitle}>
                  <h3>{host.name}</h3>
                  <span className={styles.badge} data-state={host.state}>
                    {host.state}
                  </span>
                </div>
                <p>
                  {host.region} · {host.profile ?? 'Environment/default profile'}
                </p>
                <p className={styles.mono}>
                  {host.account ?? 'Account unconfirmed'}{' '}
                  {host.instanceId && `· ${host.instanceId}`}
                </p>
                <dl className={styles.facts}>
                  <dt>Gateway</dt>
                  <dd>
                    {host.gateway.healthy === null
                      ? 'Unknown'
                      : host.gateway.healthy
                        ? 'Healthy'
                        : 'Unhealthy'}{' '}
                    · {date(host.gateway.checkedAt)}
                  </dd>
                  <dt>Runtime</dt>
                  <dd>
                    {host.runtime.observed ?? 'Unknown'}{' '}
                    <small>
                      expected {host.runtime.expected} · {date(host.runtime.checkedAt)}
                    </small>
                  </dd>
                </dl>
                {host.team && (
                  <div className={styles.team}>
                    <strong>Native team · one shared host</strong>
                    <small>
                      {host.team.observed
                        ? 'Observed membership'
                        : 'Saved membership · live state unknown'}
                    </small>
                    <ul>
                      {host.team.members.map((member) => (
                        <li key={member.id}>
                          <span>{member.role}</span>
                          <code>{member.id}</code>
                          {member.model && <small>{member.model}</small>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {host.notice && <p className={styles.warning}>{host.notice}</p>}
                <p className={styles.small}>
                  Observed {date(host.checkedAt)}. Activity is available in the native OpenClaw UI;
                  unknown activity is never shown as idle.
                </p>
                <div className={styles.buttons}>
                  <button
                    disabled={busy || host.state !== 'running'}
                    onClick={() =>
                      void perform(async () => {
                        await api(`native/${encodeURIComponent(host.name)}`, {});
                        setNotice(
                          'Opened the native OpenClaw UI through its owned local SSM tunnel.',
                        );
                      })
                    }
                  >
                    Open OpenClaw
                  </button>
                  {(host.state === 'running' || host.state === 'stopped') && (
                    <button
                      onClick={() =>
                        choose({
                          action: host.state === 'running' ? 'stop' : 'start',
                          name: host.name,
                        })
                      }
                    >
                      {host.state === 'running' ? 'Stop' : 'Start'}
                    </button>
                  )}
                  <button
                    onClick={() =>
                      choose({ action: 'backup', name: host.name, vault: vault.uri || undefined })
                    }
                  >
                    Back up
                  </button>
                  <button
                    onClick={() =>
                      choose({ action: 'archive', name: host.name, vault: vault.uri || undefined })
                    }
                  >
                    Archive host
                  </button>
                  <button onClick={() => choose({ action: 'model-set', name: host.name })}>
                    Models
                  </button>
                  <button onClick={() => choose({ action: 'team-configure', name: host.name })}>
                    Team
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
        <div className={styles.columns}>
          <section ref={form} className={styles.panel} aria-labelledby="action-heading">
            <h2 id="action-heading">Plan an operation</h2>
            <p>Prepare a concrete review, then apply it explicitly.</p>
            <form onSubmit={submit} className={styles.form}>
              <label>
                Operation
                <select
                  value={request.action}
                  onChange={(event) => choose({ action: event.target.value as UiAction })}
                >
                  {actions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {recovering ? 'New deployment name' : 'Deployment name'}
                <input
                  required={request.action !== 'resume' || request.recoveryKind !== 'archive'}
                  value={request.name ?? ''}
                  onChange={(event) => update({ name: event.target.value || undefined })}
                  autoComplete="off"
                  placeholder="research-team"
                />
              </label>
              {needsRegion && (
                <>
                  <label>
                    {recovering || request.action === 'resume' ? 'Vault AWS region' : 'AWS region'}
                    <input
                      required
                      value={request.region ?? ''}
                      onChange={(event) => update({ region: event.target.value })}
                      placeholder="eu-central-1"
                    />
                  </label>
                  <label>
                    AWS profile
                    <input
                      value={request.profile ?? ''}
                      onChange={(event) => update({ profile: event.target.value || undefined })}
                      placeholder="default"
                    />
                  </label>
                </>
              )}
              {(creating || recovering) && (
                <label>
                  EC2 instance type
                  <input
                    value={request.instanceType ?? ''}
                    onChange={(event) => update({ instanceType: event.target.value || undefined })}
                    placeholder="t3a.small (2 GiB minimum)"
                  />
                </label>
              )}
              {recovering && (
                <>
                  <label>
                    Saved recovery point ID
                    <input
                      required
                      value={request.from ?? ''}
                      onChange={(event) => update({ from: event.target.value })}
                    />
                  </label>
                  <label>
                    Target region (optional)
                    <input
                      value={request.targetRegion ?? ''}
                      onChange={(event) =>
                        update({ targetRegion: event.target.value || undefined })
                      }
                    />
                  </label>
                  <label>
                    Target profile (optional)
                    <input
                      value={request.targetProfile ?? ''}
                      onChange={(event) =>
                        update({ targetProfile: event.target.value || undefined })
                      }
                    />
                  </label>
                  <label>
                    Target disk GiB (optional)
                    <input
                      type="number"
                      min="30"
                      max="16384"
                      value={request.volumeGiB ?? ''}
                      onChange={(event) =>
                        update({
                          volumeGiB: event.target.value ? Number(event.target.value) : undefined,
                        })
                      }
                    />
                  </label>
                </>
              )}
              {needsVault && (
                <label>
                  Independent vault URI
                  <input
                    required
                    value={request.vault ?? ''}
                    onChange={(event) => update({ vault: event.target.value })}
                    placeholder="s3://my-recovery-bucket/prefix"
                  />
                </label>
              )}
              {providerForm && (
                <>
                  <label>
                    Initial provider
                    <select
                      required
                      value={request.provider ?? ''}
                      onChange={(event) =>
                        update({
                          provider: event.target.value,
                          ...(event.target.value === 'amazon-bedrock'
                            ? {}
                            : { bedrockRegion: undefined }),
                        })
                      }
                    >
                      <option value="" disabled>
                        Choose a provider
                      </option>
                      {providers.map((provider) => (
                        <option key={provider}>{provider}</option>
                      ))}
                    </select>
                  </label>
                  {request.provider && request.provider !== 'amazon-bedrock' && (
                    <>
                      <label>
                        Credential reference type
                        <select
                          value={credential.kind}
                          onChange={(event) =>
                            setCredential({ ...credential, kind: event.target.value })
                          }
                        >
                          <option value="env">Existing environment variable</option>
                          <option value="ssm">Existing SSM SecureString</option>
                        </select>
                      </label>
                      <label>
                        Credential reference · never paste an API key
                        <input
                          required
                          value={credential.reference}
                          onChange={(event) =>
                            setCredential({ ...credential, reference: event.target.value })
                          }
                          placeholder={
                            credential.kind === 'env'
                              ? 'OPENROUTER_API_KEY'
                              : '/openclaw/credentials/openrouter'
                          }
                        />
                      </label>
                    </>
                  )}
                </>
              )}
              {providerForm && (
                <label>
                  Additional credential references · JSON array
                  <textarea
                    rows={3}
                    value={additionalCredentials}
                    onChange={(event) => setAdditionalCredentials(event.target.value)}
                    spellCheck={false}
                  />
                  <small>
                    For mixed-provider teams/copies, e.g. [
                    {
                      '{"provider":"anthropic-api-key","kind":"env","reference":"ANTHROPIC_API_KEY"}'
                    }
                    ]. Values remain on this computer.
                  </small>
                </label>
              )}
              {(creating ||
                request.action === 'model-set' ||
                request.action === 'bedrock-enable') && (
                <label>
                  {request.action === 'model-set'
                    ? 'Requested native model'
                    : 'Initial / approved native model'}
                  <input
                    list="native-models"
                    required={
                      request.action === 'model-set' ||
                      request.action === 'bedrock-enable' ||
                      request.provider === 'amazon-bedrock'
                    }
                    value={request.model ?? ''}
                    onChange={(event) => update({ model: event.target.value || undefined })}
                    placeholder="provider/model"
                  />
                  <datalist id="native-models">
                    {catalog?.models
                      .filter((model) => model.available !== false)
                      .map((model) => (
                        <option key={model.id} value={model.id} />
                      ))}
                  </datalist>
                </label>
              )}
              {(request.provider === 'amazon-bedrock' || request.action === 'bedrock-enable') && (
                <label>
                  Bedrock inference region
                  <input
                    required
                    value={request.bedrockRegion ?? ''}
                    onChange={(event) => update({ bedrockRegion: event.target.value })}
                    placeholder="eu-central-1"
                  />
                </label>
              )}
              {request.action === 'model-set' && (
                <>
                  <label>
                    Native agent ID (empty for default)
                    <input
                      value={request.agent ?? ''}
                      onChange={(event) => {
                        update({ agent: event.target.value || undefined });
                        setCatalog(null);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !request.name}
                    onClick={() =>
                      void perform(async () =>
                        setCatalog(
                          await api(
                            `models/${encodeURIComponent(request.name!)}${request.agent ? `?agent=${encodeURIComponent(request.agent)}` : ''}`,
                          ),
                        ),
                      )
                    }
                  >
                    Load native model choices
                  </button>
                  {catalog && (
                    <p>
                      Current new-session model: <code>{catalog.current}</code>. Availability is
                      metadata, not proof of paid inference.
                    </p>
                  )}
                </>
              )}
              {(request.action === 'team-create' || request.action === 'team-configure') && (
                <label>
                  Native team definition · JSON
                  <textarea
                    rows={12}
                    required
                    value={definition}
                    onChange={(event) => setDefinition(event.target.value)}
                    spellCheck={false}
                  />
                  <small>
                    Roles, instructions, explicit send/delegate policy, and optional credential
                    references. One host serves the complete team.
                  </small>
                </label>
              )}
              {['model-set', 'bedrock-enable', 'team-configure'].includes(request.action) && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={request.allowRestart ?? false}
                    onChange={(event) => update({ allowRestart: event.target.checked })}
                  />
                  Allow a controlled Gateway restart if required
                </label>
              )}
              {request.action === 'archive' && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={request.keepConfig ?? false}
                    onChange={(event) => update({ keepConfig: event.target.checked })}
                  />
                  Keep this local configuration after verified destruction
                </label>
              )}
              {request.action === 'resume' && (
                <>
                  <label>
                    Recovery kind
                    <select
                      required
                      value={request.recoveryKind ?? ''}
                      onChange={(event) =>
                        update({
                          recoveryKind: event.target.value as UiActionRequest['recoveryKind'],
                        })
                      }
                    >
                      <option value="" disabled>
                        Choose original operation
                      </option>
                      {['archive', 'restore', 'clone', 'team', 'model', 'bedrock'].map((kind) => (
                        <option key={kind}>{kind}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Original operation ID
                    <input
                      required
                      value={request.operationId ?? ''}
                      onChange={(event) => update({ operationId: event.target.value })}
                    />
                  </label>
                  {['model', 'bedrock', 'team', 'archive'].includes(request.recoveryKind ?? '') && (
                    <label>
                      Reconciliation
                      <select
                        value={request.accept ?? ''}
                        onChange={(event) =>
                          update({
                            accept: event.target.value
                              ? (event.target.value as UiActionRequest['accept'])
                              : undefined,
                          })
                        }
                      >
                        <option value="">Inspect / continue original operation</option>
                        {['model', 'bedrock'].includes(request.recoveryKind ?? '') && (
                          <>
                            <option value="requested">
                              Accept freshly verified requested state
                            </option>
                            <option value="previous">Accept freshly verified previous state</option>
                          </>
                        )}
                        {request.recoveryKind !== 'model' && (
                          <option value="abort">Attempt owned pre-write abort</option>
                        )}
                      </select>
                    </label>
                  )}
                  {['restore', 'clone'].includes(request.recoveryKind ?? '') && (
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={request.activate ?? false}
                        onChange={(event) => update({ activate: event.target.checked })}
                      />
                      Deliberately activate the staged Gateway after recovery checks
                    </label>
                  )}
                </>
              )}
              <button className={styles.primary} disabled={busy || !ready} type="submit">
                Prepare review
              </button>
            </form>
          </section>
          <section className={styles.panel} aria-labelledby="vault-heading">
            <h2 id="vault-heading">Saved work</h2>
            <p>
              Discover backups and archived teams using an independent vault. Source hosts and local
              configurations are optional.
            </p>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const query = new URLSearchParams({
                    uri: vault.uri,
                    region: vault.region,
                    ...(vault.profile ? { profile: vault.profile } : {}),
                  });
                  setPoints(
                    (await api<{ points: UiRecoveryPointView[] }>(`recovery?${query}`)).points,
                  );
                  setNotice('Vault discovery complete. Saved metadata is historical.');
                });
              }}
            >
              <label>
                Vault URI
                <input
                  required
                  value={vault.uri}
                  onChange={(event) => setVault({ ...vault, uri: event.target.value })}
                  placeholder="s3://my-recovery-bucket/prefix"
                />
              </label>
              <label>
                Vault AWS region
                <input
                  required
                  value={vault.region}
                  onChange={(event) => setVault({ ...vault, region: event.target.value })}
                />
              </label>
              <label>
                Vault profile
                <input
                  value={vault.profile ?? ''}
                  onChange={(event) =>
                    setVault({ ...vault, profile: event.target.value || undefined })
                  }
                  placeholder="default"
                />
              </label>
              <button disabled={busy || !ready}>Discover recovery points</button>
            </form>
            <div className={styles.points}>
              {points.map((point) => (
                <article key={point.id}>
                  <div className={styles.cardTitle}>
                    <h3>{point.name}</h3>
                    <span className={styles.badge}>{point.state}</span>
                  </div>
                  <p>
                    {date(point.savedAt)} · {point.agents.length} agents · minimum{' '}
                    {point.minimumDiskGiB} GiB disk
                  </p>
                  <code className={styles.mono}>{point.id}</code>
                  <ul>
                    {point.agents.map((agent) => (
                      <li key={agent.id}>
                        {agent.role ?? agent.id}
                        {agent.model && ` · ${agent.model}`}
                      </li>
                    ))}
                  </ul>
                  <div className={styles.buttons}>
                    {(['restore', 'clone'] as const).map((action) => (
                      <button
                        key={action}
                        onClick={() =>
                          choose({
                            action,
                            vault: point.vault.uri,
                            from: point.id,
                            region: point.vault.region,
                            profile: point.vault.profile,
                            instanceType: 't3a.small',
                            ...(action === 'clone' ? { provider: 'openrouter-api-key' } : {}),
                          })
                        }
                      >
                        {action === 'restore' ? 'Restore identity' : 'Copy as new claw'}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <p className={styles.small}>
              Archived means a completed teardown receipt was found. A backup alone does not prove
              its source was destroyed. Vault storage and encryption keys remain billable.
            </p>
          </section>
        </div>
        <section id="operations" aria-labelledby="operations-heading">
          <div className={styles.sectionTitle}>
            <h2 id="operations-heading">Reviews & operations</h2>
            <span>Durable local history</span>
          </div>
          {jobs.length === 0 && (
            <p className={styles.empty}>Prepared reviews and operation results appear here.</p>
          )}
          {jobs.map((job) => (
            <article key={job.id} className={styles.operation}>
              <div className={styles.cardTitle}>
                <h3>
                  {title(job.action)} · {job.target.name}
                </h3>
                <span className={styles.badge}>{job.phase}</span>
              </div>
              <p>
                {job.target.account} · {job.target.region}{' '}
                {job.target.instanceId && `· ${job.target.instanceId}`}
              </p>
              <code className={styles.mono}>{job.id}</code>
              <dl className={styles.facts}>
                {job.facts.map((fact, index) => (
                  <div key={index}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
              <ul>
                {job.effects.map((effect, index) => (
                  <li key={index}>{effect}</li>
                ))}
              </ul>
              {job.phase === 'preview' && (
                <div className={styles.buttons}>
                  <button
                    className={styles.primary}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const updated = await api<UiJobView>(`plans/${job.id}/apply`, {});
                        setJobs((previous) =>
                          previous.map((item) => (item.id === updated.id ? updated : item)),
                        );
                      })
                    }
                  >
                    Apply reviewed operation
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const updated = await api<UiJobView>(`plans/${job.id}/cancel`, {});
                        setJobs((previous) =>
                          previous.map((item) => (item.id === updated.id ? updated : item)),
                        );
                      })
                    }
                  >
                    Discard review
                  </button>
                </div>
              )}
              {job.progress.length > 0 && (
                <ol className={styles.progress}>
                  {job.progress.map((message, index) => (
                    <li key={index}>{message}</li>
                  ))}
                </ol>
              )}
              {job.phase === 'uncertain' && (
                <p className={styles.warning}>
                  Outcome unconfirmed. Inspect the original operation. Reloading does not replay it;
                  a fresh submission could duplicate resources.
                </p>
              )}
              {job.result && (
                <div role="status">
                  <strong>{job.result.summary}</strong>
                  <dl className={styles.facts}>
                    {job.result.facts.map((fact, index) => (
                      <div key={index}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              {job.phase !== 'preview' &&
                job.phase !== 'running' &&
                (job.result?.recovery ?? job.recovery ?? []).map((next, index) => (
                  <button key={index} onClick={() => choose(next)}>
                    Prepare{' '}
                    {next.action === 'resume'
                      ? `${next.recoveryKind} recovery${next.activate ? ' / activation' : ''}`
                      : title(next.action)}
                  </button>
                ))}
            </article>
          ))}
        </section>
      </main>
      <footer>
        OpenClaw handles the agents. This console manages their AWS lifecycle. Closing the browser
        does not cancel an applied operation.
      </footer>
    </div>
  );
}
