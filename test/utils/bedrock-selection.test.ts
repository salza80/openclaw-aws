import { describe, expect, it } from 'vitest';
import {
  bedrockSelectionMetadata,
  extendBedrockSelection,
  selectionFromBedrockMetadata,
} from '../../src/aws/bedrock-selection.js';
import type { BedrockRoute } from '../../src/aws/bedrock-routes.js';

const identity = { account: '123456789012', partition: 'aws' };
const region = 'eu-central-1';
const foundation = (id: string): BedrockRoute => {
  const arn = `arn:aws:bedrock:${region}::foundation-model/${id}`;
  return {
    model: `amazon-bedrock/${id}`,
    region,
    kind: 'foundation-model',
    invocationArn: arn,
    modelArns: [arn],
  };
};
const first = foundation('provider.first');
const second = foundation('provider.second');
const selection = (routes: BedrockRoute[]) => ({ discoveryRegion: region, routes });

describe('portable Bedrock route union', () => {
  it('canonicalizes selections and retains previous sibling/fallback routes on addition or an empty request', () => {
    const previous = selection([second]);
    const added = extendBedrockSelection(previous, selection([first]), identity);
    expect(added.routes).toEqual([first, second]);
    expect(extendBedrockSelection(added, selection([]), identity)).toEqual(added);
    expect(extendBedrockSelection(added, selection([first]), identity)).toEqual(added);
    expect(previous.routes).toEqual([second]);
    const metadata = bedrockSelectionMetadata(selection([second, first]), identity);
    expect(selectionFromBedrockMetadata(metadata, identity)).toEqual(added);
  });
  it('requires explicit review when a profile backing set or host inference region changes', () => {
    const profile: BedrockRoute = {
      ...first,
      model: 'amazon-bedrock/eu.provider.profile',
      kind: 'inference-profile',
      invocationArn: `arn:aws:bedrock:${region}:${identity.account}:inference-profile/eu.provider.profile`,
    };
    expect(() =>
      extendBedrockSelection(
        selection([profile]),
        selection([{ ...profile, modelArns: [second.invocationArn] }]),
        identity,
      ),
    ).toThrow(/backing metadata changed/);
    expect(() =>
      extendBedrockSelection(
        selection([first]),
        { discoveryRegion: 'us-east-1', routes: [second] },
        identity,
      ),
    ).toThrow(/whole-host region change/);
  });
  it('rejects foreign route grants, missing metadata, unknown fields, duplicates and unsupported versions', () => {
    const valid = bedrockSelectionMetadata(selection([first]), identity);
    for (const value of [
      null,
      {},
      { ...valid, schemaVersion: 2 },
      { ...valid, extra: true },
      { ...valid, routes: [first, first] },
      {
        ...valid,
        routes: [
          { ...first, invocationArn: first.invocationArn.replace('arn:aws:', 'arn:aws-cn:') },
        ],
      },
      { ...valid, routes: [{ ...first, modelArns: [null] }] },
    ])
      expect(() => selectionFromBedrockMetadata(value, identity)).toThrow();
  });
});
