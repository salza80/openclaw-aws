/** Browser-safe metadata only. AWS contexts, native credentials and executable
 * operation callbacks never belong in these response contracts. */
export type UiAction =
  | 'create'
  | 'team-create'
  | 'start'
  | 'stop'
  | 'backup'
  | 'archive'
  | 'restore'
  | 'clone'
  | 'team-configure'
  | 'model-set'
  | 'bedrock-enable'
  | 'resume';
export interface UiCredentialReference {
  provider: string;
  kind: 'env' | 'ssm';
  reference: string;
}
export interface UiActionRequest {
  action: UiAction;
  name?: string;
  region?: string;
  profile?: string;
  instanceType?: string;
  provider?: string;
  model?: string;
  bedrockRegion?: string;
  credentials?: UiCredentialReference[];
  definition?: unknown;
  teamId?: string;
  vault?: string;
  from?: string;
  targetRegion?: string;
  targetProfile?: string;
  volumeGiB?: number;
  agent?: string;
  allowRestart?: boolean;
  keepConfig?: boolean;
  operationId?: string;
  recoveryKind?: 'archive' | 'restore' | 'clone' | 'team' | 'model' | 'bedrock';
  accept?: 'requested' | 'previous' | 'abort';
  activate?: boolean;
}
export interface UiFact {
  label: string;
  value: string;
}
export interface UiTarget {
  name: string;
  account: string;
  region: string;
  stackId?: string;
  instanceId?: string;
}
export interface UiPlanView {
  id: string;
  action: UiAction;
  title: string;
  target: UiTarget;
  createdAt: string;
  facts: UiFact[];
  effects: string[];
  recovery?: UiActionRequest[];
}
export interface UiOutcome {
  summary: string;
  facts: UiFact[];
  recovery?: UiActionRequest[];
}
export interface UiJobView extends UiPlanView {
  phase: 'preview' | 'running' | 'complete' | 'uncertain' | 'cancelled';
  updatedAt: string;
  progress: string[];
  result?: UiOutcome;
}
export interface UiDeploymentView {
  name: string;
  account: string | null;
  region: string;
  profile?: string;
  state: 'running' | 'stopped' | 'changing' | 'missing' | 'unreachable';
  checkedAt: string;
  gateway: { healthy: boolean | null; checkedAt: string | null };
  runtime: { expected: string; observed: string | null; checkedAt: string | null };
  instanceId?: string;
  stackId?: string;
  team?: {
    id: string;
    coordinator: string;
    members: { id: string; role: string; model?: string }[];
    observed: boolean;
  };
  notice?: string;
}
export interface UiVaultReference {
  uri: string;
  region: string;
  profile?: string;
}
export interface UiRecoveryPointView {
  id: string;
  name: string;
  vault: UiVaultReference;
  savedAt: string;
  state: 'archived' | 'backup';
  sourceStackId: string;
  agents: { id: string; role?: string; model?: string }[];
  teamId?: string;
  minimumDiskGiB: number;
}

export interface UiPreparedAction {
  view: UiPlanView;
  apply(progress: (message: string) => void): Promise<UiOutcome>;
  cancel?(): Promise<void>;
}
export interface UiBackend {
  deployments(): Promise<UiDeploymentView[]>;
  recovery(reference: UiVaultReference): Promise<UiRecoveryPointView[]>;
  prepare(request: UiActionRequest, id: string): Promise<UiPreparedAction>;
  openNative(name: string): Promise<{ publicUrl: string }>;
  models(
    name: string,
    agent?: string,
  ): Promise<{ current: string; models: { id: string; available: boolean | null }[] }>;
  close(): Promise<void>;
}
