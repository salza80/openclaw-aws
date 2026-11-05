import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'node:module';
import { AWSError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

/**
 * Get the path to the CDK binary.
 * Resolves the installed dependency, including npm-hoisted installations.
 * Retains source-checkout shims and the global CLI as legacy fallbacks.
 */
export function getCDKBinary(): string {
  // npm may hoist dependencies beside this package rather than inside it.
  try {
    const packageDirectory = path.dirname(require.resolve('aws-cdk/package.json'));
    const dependencyBins = path.join(path.dirname(packageDirectory), '.bin');
    if (process.platform === 'win32') {
      for (const name of ['cdk.cmd', 'cdk.ps1']) {
        const wrapper = path.join(dependencyBins, name);
        if (fs.existsSync(wrapper)) return wrapper;
      }
    }
    const dependencyBinary = path.join(packageDirectory, 'bin', 'cdk');
    if (fs.existsSync(dependencyBinary)) return dependencyBinary;
  } catch {
    // Retain the source-checkout/global fallback if the dependency is absent.
  }

  // Try to find local CDK binary
  // From src/cli/utils/ go up to package root, then to node_modules/.bin/cdk
  const binDir = path.resolve(__dirname, '../../../node_modules/.bin');
  const localCdkPath = path.join(binDir, 'cdk');
  const localCdkCmd = path.join(binDir, 'cdk.cmd');
  const localCdkPs1 = path.join(binDir, 'cdk.ps1');

  if (process.platform === 'win32') {
    if (fs.existsSync(localCdkCmd)) return localCdkCmd;
    if (fs.existsSync(localCdkPs1)) return localCdkPs1;
  }

  if (fs.existsSync(localCdkPath)) {
    return localCdkPath;
  }

  // Fallback to global CDK
  // This will throw if 'cdk' is not in PATH, which execa will catch
  return 'cdk';
}

/**
 * Validate that CDK is available (either local or global).
 * Throws AWSError if CDK cannot be found.
 */
export function validateCDKAvailable(): void {
  const cdkPath = getCDKBinary();

  // If using global CDK, we can't easily check if it exists without running it
  // execa will throw if the command doesn't exist, which is fine
  if (cdkPath === 'cdk') {
    // Global CDK - will be validated when we try to run it
    return;
  }

  // For local CDK, we already checked it exists in getCDKBinary()
  if (!fs.existsSync(cdkPath)) {
    throw new AWSError('AWS CDK CLI not found', [
      'Reinstall this package: npm install -g @salza80/openclaw-aws',
      'Or install CDK globally: npm install -g aws-cdk',
    ]);
  }
}

/** CDK evaluates --app through a shell, so installed paths may contain spaces. */
export function getCDKAppCommand(appPath: string): string {
  const quote = (value: string) => {
    if (process.platform === 'win32') {
      if (/%[^%]*%/.test(value))
        throw new AWSError(
          'CDK cannot safely run a Windows path containing %...%; rename that directory',
        );
      return `"${value}"`;
    }
    // Match CDK's supported double-quoted first-word format; POSIX shells
    // still require these four metacharacters to be escaped inside quotes.
    return '"' + value.replace(/[\\"$`]/g, (character) => '\\' + character) + '"';
  };
  // CDK's argument parser strips matching outer quotes from a whole --app
  // argument. A shell builtin prefix keeps both executable/path quotes intact.
  return `${process.platform === 'win32' ? 'call' : 'exec'} ${quote(process.execPath)} ${quote(appPath)}`;
}

/** Isolate CDK assemblies and user/project settings for concurrent deployments. */
export async function withCDKWorkspace<T>(
  environment: Record<string, string | undefined>,
  operation: (options: { cwd: string; env: Record<string, string | undefined> }) => Promise<T>,
): Promise<T> {
  const { tmpdir } = await import('node:os');
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'openclaw-aws-cdk-'));
  try {
    return await operation({
      cwd: directory,
      env: {
        ...environment,
        HOME: directory,
        USERPROFILE: directory,
        CDK_HOME: path.join(directory, '.cdk'),
      },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
