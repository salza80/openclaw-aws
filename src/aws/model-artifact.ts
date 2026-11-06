import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { shellQuote } from '../openclaw/commands.js';
import { executeSsm } from './ssm.js';
import type { AwsLocation } from './target.js';

export const modelArtifactFilenames = [
  'worker.mjs',
  'worker.mjs.LEGAL.txt',
  'THIRD-PARTY-LICENSES.txt',
] as const;
export interface ModelArtifactFile {
  name: (typeof modelArtifactFilenames)[number];
  sha256: string;
  size: number;
  compressedSha256: string;
  compressed: Uint8Array;
}
export interface ModelArtifact {
  digest: string;
  files: ModelArtifactFile[];
}
export interface ModelArtifactPin {
  digest: string;
  files: Omit<ModelArtifactFile, 'compressed'>[];
}
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const rootShell = (script: string) =>
  `env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin bash --noprofile --norc -c ${shellQuote(script)}`;
const descriptor = (files: ModelArtifactPin['files']) =>
  files.map(({ name, sha256, size, compressedSha256 }) => ({
    name,
    sha256,
    size,
    compressedSha256,
  }));
export function createModelArtifact(files: { name: string; body: Uint8Array }[]): ModelArtifact {
  const packed = modelArtifactFilenames.map((name) => {
    const selected = files.filter((file) => file.name === name);
    if (selected.length !== 1 || files.length !== modelArtifactFilenames.length)
      throw new Error('Model worker artifact inventory is incomplete or ambiguous');
    const body = selected[0].body;
    if (!body.length || body.length > 8 * 1024 * 1024)
      throw new Error('Model worker artifact file exceeds its bound');
    const compressed = gzipSync(body, { level: 9 });
    return {
      name,
      sha256: sha(body),
      size: body.length,
      compressedSha256: sha(compressed),
      compressed,
    };
  });
  return { digest: sha(JSON.stringify(descriptor(packed))), files: packed };
}
export async function packagedModelArtifact(): Promise<ModelArtifact> {
  return createModelArtifact(
    await Promise.all(
      modelArtifactFilenames.map(async (name) => ({
        name,
        body: await readFile(new URL(`../../dist/model-worker/${name}`, import.meta.url)),
      })),
    ),
  );
}
function validate(artifact: ModelArtifact) {
  parseModelArtifactPin(artifactPin(artifact));
  if (
    !artifact ||
    !Array.isArray(artifact.files) ||
    artifact.files.length !== modelArtifactFilenames.length ||
    !/^[a-f0-9]{64}$/.test(artifact.digest) ||
    artifact.digest !== sha(JSON.stringify(descriptor(artifact.files)))
  )
    throw new Error('Model worker artifact identity is invalid');
  artifact.files.forEach((file, index) => {
    if (
      file.name !== modelArtifactFilenames[index] ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !/^[a-f0-9]{64}$/.test(file.compressedSha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 8 * 1024 * 1024 ||
      !(file.compressed instanceof Uint8Array) ||
      file.compressed.length > 8 * 1024 * 1024 ||
      sha(file.compressed) !== file.compressedSha256
    )
      throw new Error('Model worker artifact contents are invalid');
    const body = gunzipSync(file.compressed, { maxOutputLength: 8 * 1024 * 1024 });
    if (body.length !== file.size || sha(body) !== file.sha256)
      throw new Error('Model worker artifact decompression failed integrity verification');
  });
}
const artifactPin = (artifact: ModelArtifact): ModelArtifactPin => ({
  digest: artifact.digest,
  files: descriptor(artifact.files),
});
export function pinModelArtifact(artifact: ModelArtifact): ModelArtifactPin {
  validate(artifact);
  return artifactPin(artifact);
}
export function parseModelArtifactPin(value: unknown): ModelArtifactPin {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid model artifact pin');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['digest', 'files'].includes(key)) ||
    typeof row.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.digest) ||
    !Array.isArray(row.files) ||
    row.files.length !== modelArtifactFilenames.length
  )
    throw new Error('Invalid model artifact pin inventory');
  const files = row.files.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid model artifact file pin');
    const file = value as Record<string, unknown>;
    if (
      Object.keys(file).some(
        (key) => !['name', 'sha256', 'size', 'compressedSha256'].includes(key),
      ) ||
      file.name !== modelArtifactFilenames[index] ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.compressedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.compressedSha256) ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 1 ||
      (file.size as number) > 8 * 1024 * 1024
    )
      throw new Error('Invalid model artifact file pin');
    return {
      name: modelArtifactFilenames[index],
      sha256: file.sha256,
      compressedSha256: file.compressedSha256,
      size: file.size as number,
    };
  });
  if (sha(JSON.stringify(descriptor(files))) !== row.digest)
    throw new Error('Model artifact pin identity digest changed');
  return { digest: row.digest, files };
}
export function modelArtifactDirectory(digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid model worker artifact digest');
  return `/var/lib/openclaw-aws/model-artifacts/${digest}`;
}
function rootPreparation(directory: string) {
  const directories = ['/var/lib/openclaw-aws', '/var/lib/openclaw-aws/model-artifacts', directory];
  return [
    'set -e',
    'umask 022',
    'test "$(id -u)" = 0',
    ...directories.flatMap((value) => [
      `mkdir ${shellQuote(value)} 2>/dev/null || test -d ${shellQuote(value)}`,
      `test ! -L ${shellQuote(value)}`,
      `test "$(stat -c '%u:%a' ${shellQuote(value)})" = 0:755`,
    ]),
  ];
}
export function verifyModelArtifactFiles(input: ModelArtifactPin): string[] {
  const pin = parseModelArtifactPin(input);
  const directory = modelArtifactDirectory(pin.digest);
  return [
    ...['/var/lib/openclaw-aws', '/var/lib/openclaw-aws/model-artifacts', directory].flatMap(
      (value) => [
        `test -d ${shellQuote(value)} && test ! -L ${shellQuote(value)}`,
        `test "$(/usr/bin/stat -c '%u:%a' ${shellQuote(value)})" = 0:755`,
      ],
    ),
    ...pin.files.flatMap((file) =>
      verifyFile(`${directory}/${file.name}`, file.sha256, file.size, true),
    ),
  ];
}
function verifyFile(filename: string, digest: string, size: number, absolute = false) {
  const stat = absolute ? '/usr/bin/stat' : 'stat';
  const checksum = absolute ? '/usr/bin/sha256sum' : 'sha256sum';
  return [
    `test -f ${shellQuote(filename)} && test ! -L ${shellQuote(filename)}`,
    `test "$( ${stat} -c '%u:%a:%h:%s' ${shellQuote(filename)})" = ${shellQuote(`0:644:1:${size}`)}`,
    `printf '%s  %s\\n' ${shellQuote(digest)} ${shellQuote(filename)} | ${checksum} --check --status`,
  ];
}
/** Passive probe: missing/incomplete artifacts may be delivered; unsafe or
 * changed existing content is an error rather than permission to overwrite. */
export function modelArtifactProbe(input: ModelArtifactPin) {
  const pin = parseModelArtifactPin(input);
  const directory = modelArtifactDirectory(pin.digest);
  const absent = `printf '%s' '{"ready":false}'; exit 0`;
  return rootShell(
    [
      'set -e',
      'test "$(id -u)" = 0',
      ...['/var/lib/openclaw-aws', '/var/lib/openclaw-aws/model-artifacts', directory].flatMap(
        (value) => [
          `test ! -L ${shellQuote(value)}`,
          `if [ ! -e ${shellQuote(value)} ]; then ${absent}; fi`,
          `test -d ${shellQuote(value)}`,
          `test "$(stat -c '%u:%a' ${shellQuote(value)})" = 0:755`,
        ],
      ),
      ...pin.files.flatMap((file) => [
        `test ! -L ${shellQuote(`${directory}/${file.name}`)}`,
        `if [ ! -e ${shellQuote(`${directory}/${file.name}`)} ]; then ${absent}; fi`,
        ...verifyFile(`${directory}/${file.name}`, file.sha256, file.size),
      ]),
      `printf '%s' '{"ready":true}'`,
    ].join('\n'),
  );
}
export async function hasModelArtifact(
  instanceId: string,
  target: AwsLocation,
  pin: ModelArtifactPin,
  signal?: AbortSignal,
) {
  const result = await executeSsm(instanceId, target, [modelArtifactProbe(pin)], {
    executionSeconds: 60,
    signal,
  });
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !('ready' in parsed) ||
      typeof parsed.ready !== 'boolean'
    )
      throw new Error('Invalid artifact probe result');
    return parsed.ready;
  } catch {
    throw new Error('Model artifact availability could not be verified');
  }
}
/** Root writes only under a root-owned artifact tree, never through Ubuntu's
 * state. Atomic create-only publication supports concurrent identical delivery;
 * foreign contents, links or permissions are refused instead of overwritten. */
function publication(
  directory: string,
  destination: string,
  digest: string,
  size: number,
  generate: string[],
) {
  return [
    ...rootPreparation(directory),
    `model_incoming=$(mktemp ${shellQuote(`${directory}/.incoming.XXXXXX`)})`,
    `trap 'rm -f -- "$model_incoming"' EXIT`,
    ...generate,
    `test "$(stat -c %s "$model_incoming")" = ${shellQuote(String(size))}`,
    `printf '%s  %s\\n' ${shellQuote(digest)} "$model_incoming" | sha256sum --check --status`,
    'chmod 644 "$model_incoming"',
    // ln cannot overwrite an existing destination. Remove the temporary link
    // before checking nlink so both newly published and adopted files equal 1.
    `ln -T -- "$model_incoming" ${shellQuote(destination)} 2>/dev/null || test -e ${shellQuote(destination)}`,
    'rm -f -- "$model_incoming"',
    ...verifyFile(destination, digest, size),
  ].join('\n');
}
/** Each script stays far below SSM's document limit. No secrets, inference,
 * native code execution or new AWS infrastructure are part of artifact upload. */
export function modelArtifactCommands(artifact: ModelArtifact): string[] {
  validate(artifact);
  const directory = modelArtifactDirectory(artifact.digest);
  const commands: string[] = [];
  for (const [index, file] of artifact.files.entries()) {
    const chunks: string[] = [];
    for (let offset = 0; offset < file.compressed.length; offset += 12 * 1024) {
      const body = file.compressed.subarray(offset, offset + 12 * 1024);
      const destination = `${directory}/chunk-${index}-${String(chunks.length).padStart(4, '0')}`;
      chunks.push(destination);
      commands.push(
        rootShell(
          publication(directory, destination, sha(body), body.length, [
            `printf '%s' ${shellQuote(Buffer.from(body).toString('base64'))} | base64 --decode >"$model_incoming"`,
          ]),
        ),
      );
    }
    commands.push(
      rootShell(
        publication(directory, `${directory}/${file.name}`, file.sha256, file.size, [
          // Verify the entire compressed stream before expanding it. The manifest
          // also pins the resulting bytes; no archive paths or member extraction.
          `cat -- ${chunks.map(shellQuote).join(' ')} >"$model_incoming"`,
          `printf '%s  %s\\n' ${shellQuote(file.compressedSha256)} "$model_incoming" | sha256sum --check --status`,
          `model_compressed=$(mktemp ${shellQuote(`${directory}/.compressed.XXXXXX`)})`,
          `trap 'rm -f -- "$model_incoming" "$model_compressed"' EXIT`,
          'mv -f -- "$model_incoming" "$model_compressed"',
          'gzip --decompress --stdout "$model_compressed" >"$model_incoming"',
        ]),
      ),
    );
  }
  if (commands.some((command) => Buffer.byteLength(command) > 24000))
    throw new Error('Model artifact command exceeds safe SSM payload size');
  return commands;
}
export async function deliverModelArtifact(
  instanceId: string,
  target: AwsLocation,
  artifact: ModelArtifact,
  signal?: AbortSignal,
) {
  const pin = pinModelArtifact(artifact);
  if (await hasModelArtifact(instanceId, target, pin, signal))
    return { digest: pin.digest, directory: modelArtifactDirectory(pin.digest) };
  const commands = modelArtifactCommands(artifact);
  // Preserve ordering: a file's final assembly depends on all of its chunks.
  // Batch only adjacent bounded commands, without concurrent host mutations.
  for (let index = 0; index < commands.length; index += 2) {
    await executeSsm(instanceId, target, ['set -e', ...commands.slice(index, index + 2)], {
      executionSeconds: 60,
      signal,
    });
  }
  if (!(await hasModelArtifact(instanceId, target, pin, signal)))
    throw new Error('Model artifact delivery was not fully verified');
  return { digest: artifact.digest, directory: modelArtifactDirectory(artifact.digest) };
}
