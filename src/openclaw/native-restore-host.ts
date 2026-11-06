import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import {
  object,
  parseVerification,
  type BackupCaptureJob,
  type CapturedBackup,
} from './backup-contract.js';
import { nativeStorageReadConfig } from './storage-config.js';
import { planRestoreLayout } from './restore-layout.js';

/** Native decryption, archive validation and database verification into empty staging.
 * No restored executable, config or plugin is loaded by this step.
 */
export async function stageNativeRestore(options: {
  job: BackupCaptureJob;
  capture: CapturedBackup;
  passphrase: string;
  pluginDirectory: string;
  stagingDirectory: string;
  nativePackageJson?: string;
  home?: string;
  signal?: AbortSignal;
}) {
  const packageJson =
    options.nativePackageJson ??
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/openclaw/package.json');
  if (
    process.version !== `v${OPENCLAW_NODE_VERSION}` ||
    JSON.parse(await readFile(packageJson, 'utf8')).version !== OPENCLAW_VERSION
  )
    throw new Error('Restore requires the recorded, supported native runtime');
  const scratch = await mkdtemp(path.join(tmpdir(), 'openclaw-native-restore-'));
  let phase = 'native extraction';
  try {
    const key = path.join(scratch, 'key.json');
    const config = path.join(scratch, 'openclaw.json');
    await writeFile(key, JSON.stringify({ passphrase: options.passphrase }), { mode: 0o600 });
    await writeFile(
      config,
      JSON.stringify(
        nativeStorageReadConfig(
          options.pluginDirectory,
          {
            ...options.job.settings,
            readVersions: Object.fromEntries(
              Object.entries(options.capture.objects).map(([name, pin]) => [name, pin.versionId]),
            ),
          },
          key,
        ),
      ),
      { mode: 0o600 },
    );
    const env: Record<string, string> = {
      HOME: scratch,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      OPENCLAW_STATE_DIR: path.join(scratch, 'state'),
      OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_HIDE_BANNER: '1',
      NO_COLOR: '1',
      OPENCLAW_AWS_BACKUP_OPERATION_ID: options.job.operationId,
      AWS_REGION: options.job.settings.region,
      AWS_DEFAULT_REGION: options.job.settings.region,
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_EC2_METADATA_V1_DISABLED: 'true',
    };
    // Conformance fixtures can point IMDS/S3 at loopback; model credentials are never inherited.
    for (const name of ['AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_ENDPOINT_URL_S3'])
      if (process.env[name]) env[name] = process.env[name]!;
    const result = await execa(
      process.execPath,
      [
        path.join(path.dirname(packageJson), 'openclaw.mjs'),
        'backup',
        'restore',
        options.capture.capture.location.key,
        '--from=aws-vault',
        `--namespace=${options.job.namespace}`,
        `--target=${options.stagingDirectory}`,
        '--json',
      ],
      {
        env,
        extendEnv: false,
        timeout: 25 * 60 * 1000,
        cancelSignal: options.signal,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    phase = 'native verification result';
    const output = object(JSON.parse(result.stdout));
    const verification = parseVerification(output);
    if (
      output.targetPath !== options.stagingDirectory ||
      verification.archiveRoot !== options.capture.verification.archiveRoot ||
      verification.createdAt !== options.capture.verification.createdAt ||
      verification.assetCount !== options.capture.verification.assetCount
    )
      throw new Error('Native restored archive differs from the selected completed recovery point');
    phase = 'asset placement plan';
    const manifest = JSON.parse(
      await readFile(
        path.join(options.stagingDirectory, verification.archiveRoot, 'manifest.json'),
        'utf8',
      ),
    );
    return {
      verification,
      moves: planRestoreLayout({
        manifest,
        capture: options.capture,
        stagingDirectory: options.stagingDirectory,
        home: options.home,
      }),
    };
  } catch {
    throw new Error(
      `Native staged restore failed during ${phase}; the Gateway must remain inactive. Inspect retained staging before retrying.`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
