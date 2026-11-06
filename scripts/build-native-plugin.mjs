import { build } from 'esbuild';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import { OPENCLAW_VERSION } from '../dist/cli/constants.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'dist/native-plugins/aws-s3');
const host = JSON.parse(
  await readFile(path.join(root, 'node_modules/openclaw/package.json'), 'utf8'),
);
if (host.version !== OPENCLAW_VERSION)
  throw new Error('Native plugin ABI host differs from the supported OpenClaw version');
const helper = JSON.parse(
  await readFile(path.join(root, 'templates/openclaw/native-helper/package.json'), 'utf8'),
);
const helperLock = JSON.parse(
  await readFile(path.join(root, 'templates/openclaw/native-helper/package-lock.json'), 'utf8'),
);
if (
  helper.dependencies.openclaw !== OPENCLAW_VERSION ||
  helperLock.packages['node_modules/openclaw'].version !== OPENCLAW_VERSION
)
  throw new Error('Managed backup helper differs from the supported OpenClaw version');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const bundled = await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/openclaw/aws-s3-plugin/index.ts',
    worker: 'src/openclaw/capture-worker-entry.ts',
    'restore-worker': 'src/openclaw/restore-worker-entry.ts',
  },
  outdir: directory,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // The only external dependency is supplied by the native plugin host.
  external: ['openclaw/plugin-sdk/plugin-entry'],
  banner: {
    js: 'import { createRequire as __awsCreateRequire } from "node:module"; const require = __awsCreateRequire(import.meta.url);',
  },
  legalComments: 'linked',
  metafile: true,
});
// Model-only management uses chunked SSM delivery without a backup vault.
// Keep it outside the versioned recovery artifact's fixed nine-file inventory.
const modelDirectory = path.join(root, 'dist/model-worker');
await rm(modelDirectory, { recursive: true, force: true });
await mkdir(modelDirectory, { recursive: true });
const modelBundled = await build({
  absWorkingDir: root,
  entryPoints: ['src/openclaw/model-worker-entry.ts'],
  outfile: path.join(modelDirectory, 'worker.mjs'),
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: 'import { createRequire as __awsCreateRequire } from "node:module"; const require = __awsCreateRequire(import.meta.url);',
  },
  legalComments: 'linked',
  metafile: true,
});
const packages = new Set();
for (const input of new Set([
  ...Object.keys(bundled.metafile.inputs),
  ...Object.keys(modelBundled.metafile.inputs),
])) {
  const full = path.resolve(root, input).replaceAll('\\', '/');
  const marker = full.lastIndexOf('/node_modules/');
  if (marker < 0) continue;
  const parts = full.slice(marker + '/node_modules/'.length).split('/');
  packages.add(
    full.slice(0, marker + '/node_modules/'.length) +
      parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/'),
  );
}
const notices = [];
for (const packageDirectory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  const licenses = (await readdir(packageDirectory, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /^(licen[cs]e|copying)([.-].+)?$/i.test(entry.name),
  );
  if (!licenses.length && pkg.license === 'Apache-2.0') {
    notices.push(
      `${pkg.name}@${pkg.version} (${pkg.license})\n${await readFile(path.join(root, 'node_modules/@aws-sdk/client-s3/LICENSE'), 'utf8')}`,
    );
    continue;
  }
  if (!licenses.length) throw new Error(`Bundled package lacks license text: ${pkg.name}`);
  notices.push(
    `${pkg.name}@${pkg.version} (${pkg.license})\n${(await Promise.all(licenses.map((entry) => readFile(path.join(packageDirectory, entry.name), 'utf8')))).join('\n')}`,
  );
}
await writeFile(
  path.join(directory, 'THIRD-PARTY-LICENSES.txt'),
  notices.join('\n\n----------------------------------------\n\n'),
);
await writeFile(
  path.join(modelDirectory, 'THIRD-PARTY-LICENSES.txt'),
  notices.join('\n\n----------------------------------------\n\n'),
);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
await writeFile(
  path.join(directory, 'package.json'),
  json({
    name: '@salza80/openclaw-aws-s3',
    version: OPENCLAW_VERSION,
    private: true,
    type: 'module',
    license: 'MIT',
    engines: { node: host.engines.node },
    openclaw: {
      extensions: ['./index.js'],
      compat: { pluginApi: `=${OPENCLAW_VERSION}` },
      build: { openclawVersion: OPENCLAW_VERSION },
    },
  }),
);
await writeFile(
  path.join(directory, 'openclaw.plugin.json'),
  json({
    id: 'openclaw-aws-s3',
    name: 'OpenClaw AWS S3 storage',
    description: 'Private Amazon S3 transport using refreshable AWS credentials.',
    categories: ['infrastructure'],
    activation: { onStartup: false },
    contracts: { storageProviders: ['aws-s3'] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
