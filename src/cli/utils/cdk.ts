import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { AWSError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the path to the CDK binary.
 * Prefers the locally bundled CDK from node_modules/.bin/
 * Falls back to global 'cdk' if local not found.
 */
export function getCDKBinary(): string {
  // Try to find local CDK binary
  // From src/cli/utils/ go up to package root, then to node_modules/.bin/cdk
  const localCdkPath = path.resolve(__dirname, '../../../node_modules/.bin/cdk');
  
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
      'Reinstall this package: npm install -g openclaw-aws',
      'Or install CDK globally: npm install -g aws-cdk'
    ]);
  }
}
