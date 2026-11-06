import { isDeepStrictEqual } from 'node:util';
import {
  validateBedrockRoute,
  validBedrockRegion,
  type BedrockIdentity,
  type BedrockRoute,
} from './bedrock-routes.js';

export interface BedrockAccessSelection {
  discoveryRegion: string;
  /** All routes still required by defaults, agents and fallbacks on the host. */
  routes: BedrockRoute[];
}

/** Nonsecret CloudFormation metadata is the portable inventory of this exact
 * policy. It survives local configuration loss; IAM is not a model catalog. */
export const BEDROCK_SELECTION_METADATA = 'OpenclawAwsBedrock';

export function parseBedrockSelection(
  input: unknown,
  identity: BedrockIdentity,
): BedrockAccessSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Bedrock access selection is missing or invalid');
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['discoveryRegion', 'routes'].includes(key)) ||
    typeof row.discoveryRegion !== 'string' ||
    !validBedrockRegion(row.discoveryRegion) ||
    !Array.isArray(row.routes) ||
    row.routes.length > 256
  )
    throw new Error('Invalid Bedrock discovery region or route inventory');
  const seen = new Set<string>();
  const routes = row.routes.map((value): BedrockRoute => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['model', 'region', 'kind', 'invocationArn', 'modelArns'].includes(key),
      )
    )
      throw new Error('Invalid Bedrock route metadata');
    const route = value as BedrockRoute;
    if (
      typeof route.model !== 'string' ||
      typeof route.region !== 'string' ||
      typeof route.invocationArn !== 'string' ||
      !Array.isArray(route.modelArns) ||
      route.modelArns.some((arn) => typeof arn !== 'string')
    )
      throw new Error('Incomplete Bedrock route metadata');
    const parsed = validateBedrockRoute(route, identity);
    const key = `${parsed.region}/${parsed.model}`;
    if (seen.has(key)) throw new Error('Repeated Bedrock route selection');
    seen.add(key);
    return parsed;
  });
  routes.sort((a, b) => a.region.localeCompare(b.region) || a.model.localeCompare(b.model));
  return { discoveryRegion: row.discoveryRegion, routes };
}

export function bedrockSelectionMetadata(input: BedrockAccessSelection, identity: BedrockIdentity) {
  return { schemaVersion: 1, ...parseBedrockSelection(input, identity) };
}

export function selectionFromBedrockMetadata(
  input: unknown,
  identity: BedrockIdentity,
): BedrockAccessSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Bedrock policy has no managed route metadata; inspect before updating');
  const { schemaVersion, ...selection } = input as Record<string, unknown>;
  if (schemaVersion !== 1) throw new Error('Unsupported Bedrock policy route metadata version');
  return parseBedrockSelection(selection, identity);
}

/** Provider/model enablement is additive. Removing grants needs an explicit
 * whole-host review; selecting OpenRouter for one agent cannot revoke siblings.
 * Changed AWS backing metadata is not silently adopted under an old route. */
export function extendBedrockSelection(
  existing: BedrockAccessSelection | undefined,
  requested: BedrockAccessSelection,
  identity: BedrockIdentity,
): BedrockAccessSelection {
  const next = parseBedrockSelection(requested, identity);
  if (!existing) return next;
  const previous = parseBedrockSelection(existing, identity);
  if (previous.discoveryRegion !== next.discoveryRegion)
    throw new Error(
      'Bedrock is already configured with another inference region; review a whole-host region change before enabling this selection',
    );
  const routes = new Map(previous.routes.map((route) => [`${route.region}/${route.model}`, route]));
  for (const route of next.routes) {
    const key = `${route.region}/${route.model}`;
    const before = routes.get(key);
    if (before && !isDeepStrictEqual(before, route))
      throw new Error(
        'Bedrock route backing metadata changed; review its permission change before selecting this model',
      );
    routes.set(key, route);
  }
  return parseBedrockSelection({ ...next, routes: [...routes.values()] }, identity);
}
