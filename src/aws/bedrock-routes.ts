import {
  BedrockClient,
  GetFoundationModelCommand,
  GetInferenceProfileCommand,
} from '@aws-sdk/client-bedrock';
import { awsClientConfig, type AwsTarget } from './target.js';
import { validAwsRegion as validBedrockRegion } from './regions.js';
export { validBedrockRegion };

export interface BedrockRoute {
  /** Native OpenClaw selection; it can contain an AWS model/profile ARN. */
  model: string;
  region: string;
  kind: 'foundation-model' | 'inference-profile' | 'application-inference-profile';
  invocationArn: string;
  modelArns: string[];
}
export interface BedrockIdentity {
  account: string;
  partition: string;
}
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,2047}$/;
function modelIdentifier(model: string) {
  if (!model.startsWith('amazon-bedrock/'))
    throw new Error('Use a native amazon-bedrock/<model-or-profile> reference');
  const identifier = model.slice('amazon-bedrock/'.length);
  if (
    identifier.length > 2048 ||
    (!identifierPattern.test(identifier) &&
      !/^arn:[a-z0-9-]+:bedrock:[a-z0-9-]*:[0-9]*:(?:foundation-model|inference-profile|application-inference-profile)\/[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(
        identifier,
      ))
  )
    throw new Error('Unsupported Bedrock model/profile identifier');
  return identifier;
}
function arnParts(arn: string) {
  const match =
    /^arn:([a-z0-9-]+):bedrock:([a-z0-9-]*):([0-9]*):(foundation-model|inference-profile|application-inference-profile)\/([A-Za-z0-9][A-Za-z0-9.:-]*)$/.exec(
      arn,
    );
  if (!match || arn.length > 2048) throw new Error('Unsupported Bedrock resource ARN');
  return { partition: match[1], region: match[2], account: match[3], kind: match[4], id: match[5] };
}

/** Validate exact metadata, never infer backing regions from a profile's name. */
export function validateBedrockRoute(input: BedrockRoute, identity: BedrockIdentity): BedrockRoute {
  if (
    typeof identity.account !== 'string' ||
    typeof identity.partition !== 'string' ||
    !/^\d{12}$/.test(identity.account) ||
    !/^[a-z0-9-]+$/.test(identity.partition)
  )
    throw new Error('Bedrock planning requires a pinned account/partition');
  const identifier = modelIdentifier(input.model);
  const invocation = arnParts(input.invocationArn);
  if (
    !validBedrockRegion(input.region) ||
    invocation.partition !== identity.partition ||
    invocation.region !== input.region ||
    invocation.kind !== input.kind ||
    (identifier !== input.invocationArn && identifier !== invocation.id) ||
    (input.kind === 'foundation-model'
      ? invocation.account !== ''
      : invocation.account !== identity.account) ||
    !Array.isArray(input.modelArns) ||
    !input.modelArns.length ||
    input.modelArns.length > 64
  )
    throw new Error('Bedrock route differs from its selected account, region or model');
  const modelArns = [...new Set(input.modelArns)].sort();
  for (const arn of modelArns) {
    const model = arnParts(arn);
    if (
      model.partition !== identity.partition ||
      model.account !== '' ||
      model.kind !== 'foundation-model' ||
      (model.region && !validBedrockRegion(model.region))
    )
      throw new Error('Bedrock profile contains an unsupported backing model ARN');
  }
  if (
    input.kind === 'foundation-model' &&
    (modelArns.length !== 1 || modelArns[0] !== input.invocationArn)
  )
    throw new Error('Direct Bedrock invocation must use its exact foundation model');
  return {
    model: input.model,
    region: input.region,
    kind: input.kind,
    invocationArn: input.invocationArn,
    modelArns,
  };
}

export class BedrockMetadataError extends Error {
  constructor(
    public readonly kind: 'access' | 'unavailable' | 'identifier' | 'connectivity',
    message: string,
  ) {
    super(message);
    this.name = 'BedrockMetadataError';
  }
}
function metadataFailure(errors: unknown[]): never {
  const names = errors.flatMap((error) =>
    error instanceof Error ? [error.name, 'code' in error ? String(error.code) : ''] : [],
  );
  if (names.includes('AccessDeniedException') || names.includes('UnrecognizedClientException'))
    throw new BedrockMetadataError(
      'access',
      'Bedrock route metadata was denied. Check the selected AWS identity, region and GetFoundationModel/GetInferenceProfile permissions; no inference was attempted',
    );
  if (
    names.some((name) =>
      [
        'TimeoutError',
        'AbortError',
        'NetworkingError',
        'UnknownEndpoint',
        'ThrottlingException',
        'InternalServerException',
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ETIMEDOUT',
        'EAI_AGAIN',
      ].includes(name),
    )
  )
    throw new BedrockMetadataError(
      'connectivity',
      'Bedrock route metadata is unavailable due to connectivity, throttling or a service error. No inference was attempted',
    );
  if (names.includes('ValidationException'))
    throw new BedrockMetadataError(
      'identifier',
      'Bedrock rejected this model/profile identifier in the selected region. Select a supported native catalog entry or explicit ARN; no inference was attempted',
    );
  throw new BedrockMetadataError(
    'unavailable',
    'The Bedrock model/profile is unavailable in the selected region, or its metadata could not be verified. No inference was attempted',
  );
}

/** Control-plane metadata for IAM scope only. Native OpenClaw owns inventory,
 * model capabilities and inference. Never fall back to guessed ARN/region grants.
 */
export async function resolveBedrockRoute(
  target: AwsTarget,
  model: string,
  region: string,
  signal?: AbortSignal,
): Promise<BedrockRoute> {
  if (!validBedrockRegion(region)) throw new Error('Invalid Bedrock inference region');
  signal?.throwIfAborted();
  const identifier = modelIdentifier(model);
  const identity = { account: target.account, partition: target.arn.split(':')[1] };
  const selected = identifier.startsWith('arn:') ? arnParts(identifier) : undefined;
  if (
    selected &&
    (selected.partition !== identity.partition ||
      selected.region !== region ||
      (selected.kind === 'foundation-model'
        ? selected.account !== ''
        : selected.account !== identity.account))
  )
    throw new Error(
      'Explicit Bedrock ARN belongs to another account, partition or inference region',
    );
  const client = new BedrockClient({ ...awsClientConfig(target), region });
  const request = {
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  };
  try {
    // Bare IDs may name a foundation model or an application/system profile.
    // Inspect both metadata surfaces rather than guessing from a geographic prefix.
    const [foundation, profile] = await Promise.allSettled([
      selected && selected.kind !== 'foundation-model'
        ? Promise.resolve(undefined)
        : client.send(new GetFoundationModelCommand({ modelIdentifier: identifier }), request),
      selected?.kind === 'foundation-model'
        ? Promise.resolve(undefined)
        : client.send(
            new GetInferenceProfileCommand({ inferenceProfileIdentifier: identifier }),
            request,
          ),
    ]);
    signal?.throwIfAborted();
    const detail = foundation.status === 'fulfilled' ? foundation.value?.modelDetails : undefined;
    const info = profile.status === 'fulfilled' ? profile.value : undefined;
    if (detail?.modelArn && info?.inferenceProfileArn)
      throw new Error('Bedrock identifier is ambiguous; select an explicit model/profile ARN');
    if (detail?.modelArn)
      return validateBedrockRoute(
        {
          model,
          region,
          kind: 'foundation-model',
          invocationArn: detail.modelArn,
          modelArns: [detail.modelArn],
        },
        identity,
      );
    if (info?.inferenceProfileArn) {
      if (
        info.status !== 'ACTIVE' ||
        !info.models?.length ||
        info.models.some((item) => !item.modelArn)
      )
        throw new BedrockMetadataError(
          'unavailable',
          'The selected Bedrock profile is not active or has incomplete backing-model metadata',
        );
      const kind = arnParts(info.inferenceProfileArn).kind;
      if (kind !== 'inference-profile' && kind !== 'application-inference-profile')
        throw new Error('Bedrock returned an invalid profile identity');
      return validateBedrockRoute(
        {
          model,
          region,
          kind,
          invocationArn: info.inferenceProfileArn,
          modelArns: info.models.map((item) => item.modelArn!),
        },
        identity,
      );
    }
    metadataFailure(
      [foundation, profile].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      ),
    );
  } finally {
    client.destroy();
  }
}
