import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { getCDKAppCommand, getCDKBinary, withCDKWorkspace } from '../../src/cli/utils/cdk.js';
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
      const callerHome = path.join(directory, 'caller-home');
      fs.mkdirSync(callerHome);
      fs.writeFileSync(
        path.join(callerHome, '.cdk.json'),
        JSON.stringify({ build: 'unrelated global build', profile: 'foreign' }),
      );
      fs.writeFileSync(
        path.join(directory, 'cdk.json'),
        JSON.stringify({ build: 'unrelated project build', profile: 'foreign' }),
      );
      let isolated: string | undefined;
      const config = JSON.parse(
        fs.readFileSync(path.join(directory, '.openclaw-aws/configs/offline.json'), 'utf8'),
      );
      const result = await withCDKWorkspace(
        {
          ...environment,
          HOME: callerHome,
          USERPROFILE: callerHome,
          OPENCLAW_CONFIG_NAME: 'offline',
          OPENCLAW_CDK_OPERATION: 'destroy',
          OPENCLAW_CONFIG_SNAPSHOT: JSON.stringify(config),
          CDK_DEFAULT_ACCOUNT: '123456789012',
          CDK_DEFAULT_REGION: 'eu-central-1',
          AWS_REGION: 'eu-central-1',
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_SHARED_CREDENTIALS_FILE: empty,
          AWS_CONFIG_FILE: empty,
          CDK_DISABLE_CLI_TELEMETRY: '1',
        },
        async (workspace) => {
          isolated = workspace.cwd;
          const processResult = await execa(
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
              ...workspace,
              extendEnv: false,
              timeout: 20000,
            },
          );
          const template = JSON.parse(
            fs.readFileSync(
              path.join(workspace.cwd, 'cdk.out/OpenclawStack-offline.template.json'),
              'utf8',
            ),
          );
          return {
            processResult,
            template,
            manifest: fs.existsSync(path.join(workspace.cwd, 'cdk.out/manifest.json')),
          };
        },
      );
      expect(result.processResult.exitCode).toBe(0);
      expect(result.template.Resources ?? {}).toEqual({});
      expect(result.manifest).toBe(true);
      expect(isolated).not.toBe(directory);
      expect(fs.existsSync(isolated!)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
