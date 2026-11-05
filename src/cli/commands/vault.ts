import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { resolveAwsTarget } from '../../aws/target.js';
import {
  createRecoveryVault,
  readRecoveryVault,
  registerRecoveryVault,
} from '../../operations/vault.js';
import { validateVaultSecurity } from '../../aws/vault-security.js';
import { assertSecretArn } from '../../aws/vault-security.js';
import { parseVaultUri } from '../../aws/recovery-store.js';
import { handleError, ValidationError } from '../utils/errors.js';

interface VaultArgs {
  action: string;
  locator?: string;
  region: string;
  profile?: string;
  keyArn?: string;
  yes?: boolean;
  json?: boolean;
}
export async function runVaultCommand(argv: VaultArgs) {
  if (!['create', 'register', 'inspect'].includes(argv.action) || !argv.locator)
    throw new ValidationError(
      'Use vault create <name>, vault register <s3-uri>, or vault inspect <s3-uri>',
    );
  if (argv.action === 'create' && !/^[a-z][a-z0-9-]{0,47}$/.test(argv.locator))
    throw new ValidationError(
      'Vault name must use 1–48 lowercase letters, digits or hyphens, beginning with a letter',
    );
  if (argv.action === 'register' && !argv.keyArn)
    throw new ValidationError(
      'Registering an existing bucket requires --key-arn for an independent Secrets Manager string passphrase',
    );
  if (argv.action !== 'create') parseVaultUri(argv.locator);
  const target = await resolveAwsTarget({ region: argv.region, profile: argv.profile });
  if (argv.action === 'register') assertSecretArn(target, argv.keyArn!);
  if (argv.action !== 'inspect') {
    const plan =
      argv.action === 'create'
        ? `Create or reuse independent stack OpenclawVault-${argv.locator} in ${target.account}/${target.region}: one private versioned S3 bucket and one retained Secrets Manager passphrase. No object expiry. Storage, versions and the secret remain billable after source deletion.`
        : `Validate ${argv.locator} in ${target.account}/${target.region}; retain a labeled version of ${argv.keyArn} and write immutable vault metadata. Bucket policies, lifecycle rules and encryption will be checked without changing them.`;
    if (argv.json) console.error(plan);
    else console.log(plan);
    if (!argv.yes) {
      if (!process.stdin.isTTY)
        throw new ValidationError('Noninteractive vault provisioning requires --yes');
      const { approved } = await prompts({
        type: 'confirm',
        name: 'approved',
        message: 'Apply this recovery vault plan?',
        initial: false,
      });
      if (!approved) return;
    }
  }
  const vault =
    argv.action === 'create'
      ? await createRecoveryVault(target, argv.locator)
      : argv.action === 'register'
        ? await registerRecoveryVault(target, { uri: argv.locator, keyArn: argv.keyArn! })
        : await readRecoveryVault(target, argv.locator);
  // Inspect reports live security validation as well as the independently stored identity.
  const security = await validateVaultSecurity(target, vault.uri, vault.key.arn);
  const result = {
    ...vault,
    encryptionMatchesRegistration: JSON.stringify(vault.encryption) === JSON.stringify(security),
  };
  if (argv.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Vault: ${vault.uri}\nAWS: ${vault.account}/${vault.region}\nRetention: indefinite; no automatic expiry\nIndependent key: ${vault.key.arn} (version ${vault.key.versionId})\nEncryption matches registration: ${result.encryptionMatchesRegistration}\nRemaining charges: S3 objects/versions and the retained secret${vault.encryption.s3Key || vault.encryption.secretKey ? ', plus any customer-managed KMS keys' : ''}.`,
    );
  }
}
export const vaultCommand: CommandModule<{}, VaultArgs> = {
  command: 'vault <action> [locator]',
  describe: 'Create, register or inspect an independent AWS recovery vault',
  builder: (yargs) =>
    yargs
      .positional('action', {
        choices: ['create', 'register', 'inspect'] as const,
        type: 'string',
        demandOption: true,
        describe: 'Vault operation',
      })
      .positional('locator', {
        type: 'string',
        describe: 'Vault name for create; s3://bucket/prefix for register/inspect',
      })
      .option('region', {
        type: 'string',
        demandOption: true,
        describe: 'Explicit AWS region for this vault',
      })
      .option('profile', { type: 'string', describe: 'Operator AWS profile' })
      .option('key-arn', {
        type: 'string',
        describe: 'Independent Secrets Manager passphrase ARN for an existing vault',
      })
      .option('yes', {
        type: 'boolean',
        default: false,
        describe: 'Approve the displayed vault plan',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Emit nonsecret vault metadata as JSON',
      }),
  handler: async (argv) => {
    try {
      await runVaultCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default vaultCommand;
