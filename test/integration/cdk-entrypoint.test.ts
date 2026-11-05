import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { getCDKAppCommand, getCDKBinary } from '../../src/cli/utils/cdk.js';
import { runCli } from '../helpers/run-cli.js';

describe('compiled CDK entrypoint', () => {
  it('synthesizes from an installed path containing spaces and shell characters without AWS credentials', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-cdk-path-'));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const installed = path.join(directory, "installed folder's $(literal)");
    try {
      fs.mkdirSync(installed);
      fs.cpSync(path.join(root, 'dist'), path.join(installed, 'dist'), { recursive: true });
      fs.cpSync(path.join(root, 'templates'), path.join(installed, 'templates'), {
        recursive: true,
      });
      fs.symlinkSync(
        path.join(root, 'node_modules'),
        path.join(installed, 'node_modules'),
        'junction',
      );
      await runCli(['init', '--yes', '--name', 'offline', '--region', 'eu-central-1'], directory);
      const empty = path.join(directory, 'empty-aws-config');
      fs.writeFileSync(empty, '');
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('AWS_')),
      );
      const result = await execa(
        getCDKBinary(),
        [
          'synth',
          'OpenclawStack-offline',
          '--app',
          getCDKAppCommand(path.join(installed, 'dist/cdk/app.js')),
          '--no-lookups',
          '--no-notices',
          '--no-version-reporting',
        ],
        {
          cwd: directory,
          extendEnv: false,
          timeout: 20000,
          env: {
            ...environment,
            OPENCLAW_CONFIG_NAME: 'offline',
            OPENCLAW_CDK_OPERATION: 'destroy',
            CDK_DEFAULT_ACCOUNT: '123456789012',
            CDK_DEFAULT_REGION: 'eu-central-1',
            AWS_REGION: 'eu-central-1',
            AWS_EC2_METADATA_DISABLED: 'true',
            AWS_SHARED_CREDENTIALS_FILE: empty,
            AWS_CONFIG_FILE: empty,
            CDK_DISABLE_CLI_TELEMETRY: '1',
          },
        },
      );
      expect(result.exitCode).toBe(0);
      const template = JSON.parse(
        fs.readFileSync(
          path.join(directory, 'cdk.out/OpenclawStack-offline.template.json'),
          'utf8',
        ),
      );
      expect(template.Resources ?? {}).toEqual({});
      expect(fs.existsSync(path.join(directory, 'cdk.out/manifest.json'))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
