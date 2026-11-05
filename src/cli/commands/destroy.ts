import { withDeploymentLock } from '../../operations/lock.js';
import { assertDeploymentTarget } from '../../operations/state.js';
import type { AwsLocation } from '../../aws/target.js';
import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import prompts from 'prompts';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { getConfigPathByName } from '../utils/config.js';
import { buildCommandContext } from '../utils/context.js';
import { getStackStatus } from '../utils/aws.js';
import { handleError, AWSError, StackNotFoundError } from '../utils/errors.js';
import { getCDKBinary, getCDKAppCommand, withCDKWorkspace } from '../utils/cdk.js';
import {
  listConfigNames,
  clearCurrentName,
  getCurrentName,
  setCurrentName,
} from '../utils/config-store.js';
import { DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { createSsmClient } from '../utils/aws-clients.js';
import { getApiKeyParamName, getGatewayTokenParamName } from '../utils/api-keys.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { Provider } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DestroyArgs {
  force?: boolean;
  deleteConfig?: boolean;
  name?: string;
  all?: boolean;
}

async function deleteApiKeyParam(
  configName: string,
  provider: Provider,
  region: AwsLocation,
): Promise<void> {
  const client = createSsmClient(region);
  const paramName = getApiKeyParamName(configName, provider);
  try {
    await client.send(new DeleteParameterCommand({ Name: paramName }));
    logger.info(`Deleted SSM parameter: ${paramName}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'ParameterNotFound') {
      return;
    }
    logger.warn(`Failed to delete SSM parameter: ${paramName}`);
  } finally {
    client.destroy();
  }
}

async function deleteGatewayTokenParam(configName: string, region: AwsLocation): Promise<void> {
  const client = createSsmClient(region);
  const paramName = getGatewayTokenParamName(configName);
  try {
    await client.send(new DeleteParameterCommand({ Name: paramName }));
    logger.info(`Deleted SSM parameter: ${paramName}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'ParameterNotFound') {
      return;
    }
    logger.warn(`Failed to delete SSM parameter: ${paramName}`);
  } finally {
    client.destroy();
  }
}

function updateCurrentAfterDeletion(deletedNames: string[]): void {
  const current = getCurrentName();
  if (!current || !deletedNames.includes(current)) return;

  const remaining = listConfigNames();
  if (remaining.length > 0) {
    setCurrentName(remaining[0]);
    logger.info(`Current config set to ${remaining[0]}`);
  } else {
    clearCurrentName();
    logger.info('No configs remaining. Current config cleared');
  }
}

export const destroyCommand: CommandModule<{}, DestroyArgs> = {
  command: 'destroy',
  describe: 'Delete all AWS resources',

  builder: (yargs) => {
    return yargs
      .option('force', {
        type: 'boolean',
        describe: 'Skip confirmation prompt',
        default: false,
      })
      .option('delete-config', {
        type: 'boolean',
        describe: 'Delete configuration file after destroying',
        default: false,
      })
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      })
      .option('all', {
        type: 'boolean',
        describe: 'Destroy all configs',
        default: false,
      });
  },

  handler: async (argv) => {
    try {
      if (argv.all) {
        const names = listConfigNames();
        if (names.length === 0) {
          logger.info('No configs found');
          console.log('\nRun: ' + chalk.cyan('openclaw-aws init --name <name>'));
          return;
        }

        const { confirmText } = await prompts({
          type: 'text',
          name: 'confirmText',
          message: 'Type "DESTROY ALL" to confirm:',
          validate: (value) => value === 'DESTROY ALL' || 'You must type DESTROY ALL to confirm',
        });

        if (confirmText !== 'DESTROY ALL') {
          logger.warn('Destruction cancelled');
          return;
        }

        const cdkBinary = getCDKBinary();
        const cdkAppPath = path.resolve(__dirname, '../../cdk/app.js');

        for (const name of names) {
          const ctx = await buildCommandContext({ name });
          await withDeploymentLock(ctx, async () => {
            const config = structuredClone(ctx.config);
            const snapshot = JSON.stringify(config);
            const apiProvider = config.openclaw?.apiProvider || 'anthropic-api-key';

            logger.title('OpenClaw AWS - Destroy');
            logger.info(`Destroying ${chalk.cyan(ctx.name)}`);

            let stackExists = true;
            const spinner = ora('Checking stack status...').start();
            try {
              const status = await getStackStatus(config.stack.name, ctx.target);
              assertDeploymentTarget(ctx, status);
              spinner.succeed(`Stack found: ${config.stack.name}`);
            } catch (error) {
              if (!(error instanceof StackNotFoundError)) {
                spinner.fail('Could not verify stack status');
                throw error;
              }
              spinner.warn('Stack not found (may already be deleted)');
              stackExists = false;
            }

            if (!stackExists) {
              logger.info('No resources to delete');
              await deleteApiKeyParam(ctx.name, apiProvider, ctx.target);
              await deleteGatewayTokenParam(ctx.name, ctx.target);
              console.log('');
              return;
            }

            const env = {
              ...(await ctx.target.environment(30 * 60_000)),
              OPENCLAW_CONFIG_NAME: ctx.name,
              OPENCLAW_CDK_OPERATION: 'destroy',
              OPENCLAW_CONFIG_SNAPSHOT: snapshot,
              CDK_DISABLE_VERSION_CHECK: 'true',
              CDK_DISABLE_CLI_TELEMETRY: '1',
              CI: 'true',
            };
            const destroySpinner = ora('Destroying stack... (this may take 3-5 minutes)').start();

            try {
              await withCDKWorkspace(env, async (workspace) =>
                execa(
                  cdkBinary,
                  [
                    'destroy',
                    config.stack.name,
                    '--app',
                    getCDKAppCommand(cdkAppPath),
                    '--no-notices',
                    '--no-version-reporting',
                    '--force',
                  ],
                  {
                    env: workspace.env,
                    extendEnv: false,
                    timeout: 25 * 60_000,
                    cwd: workspace.cwd,
                  },
                ),
              );

              destroySpinner.succeed('Stack destroyed successfully');
              logger.success('Deployment stack removed');
              console.log('\nRetained data and shared AWS resources may still incur charges.');
              await deleteApiKeyParam(ctx.name, apiProvider, ctx.target);
              await deleteGatewayTokenParam(ctx.name, ctx.target);
            } catch {
              destroySpinner.fail('Destruction failed');
              throw new AWSError('Stack destruction failed', [
                'Check AWS Console CloudFormation page for details',
                'Some resources may need manual cleanup',
                'Try running destroy again after a few minutes',
              ]);
            }

            console.log('');
          });
        }

        if (argv.deleteConfig) {
          for (const name of names) {
            const configPath = getConfigPathByName(name);
            if (fs.existsSync(configPath)) {
              fs.unlinkSync(configPath);
              logger.success(`Configuration deleted: ${name}`);
            }
          }
          updateCurrentAfterDeletion(names);
        } else {
          const { deleteConfigs } = await prompts({
            type: 'confirm',
            name: 'deleteConfigs',
            message: 'Delete configuration files for all configs?',
            initial: false,
          });

          if (deleteConfigs) {
            for (const name of names) {
              const configPath = getConfigPathByName(name);
              if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
                logger.success(`Configuration deleted: ${name}`);
              }
            }
            updateCurrentAfterDeletion(names);
          } else {
            logger.info('Configurations kept');
          }
        }

        return;
      }

      // Load configuration
      const ctx = await buildCommandContext({ name: argv.name });
      await withDeploymentLock(ctx, async () => {
        const config = structuredClone(ctx.config);
        const snapshot = JSON.stringify(config);
        const apiProvider = config.openclaw?.apiProvider || 'anthropic-api-key';

        logger.title('OpenClaw AWS - Destroy');
        logger.info(`Destroying ${chalk.cyan(ctx.name)}`);

        // Try to get stack status
        let stackExists = true;
        let instanceId: string | undefined;

        const spinner = ora('Checking stack status...').start();
        try {
          const status = await getStackStatus(config.stack.name, ctx.target);
          assertDeploymentTarget(ctx, status);
          instanceId = status.instanceId;
          spinner.succeed(`Stack found: ${config.stack.name}`);
        } catch (error) {
          if (!(error instanceof StackNotFoundError)) {
            spinner.fail('Could not verify stack status');
            throw error;
          }
          spinner.warn('Stack not found (may already be deleted)');
          stackExists = false;
        }

        if (!stackExists) {
          logger.info('No resources to delete');
          console.log('\n' + chalk.bold('Next steps:'));
          console.log('  ' + chalk.cyan('openclaw-aws deploy') + '    - Create a deployment');
          console.log('  ' + chalk.cyan('openclaw-aws status') + '    - Check current status');
          await deleteApiKeyParam(ctx.name, apiProvider, ctx.target);
          await deleteGatewayTokenParam(ctx.name, ctx.target);
          if (argv.deleteConfig) {
            const configPath = getConfigPathByName(ctx.name);
            if (fs.existsSync(configPath)) {
              fs.unlinkSync(configPath);
              logger.success('Configuration file deleted');
            }
            updateCurrentAfterDeletion([ctx.name]);
          } else {
            const { deleteConfig } = await prompts({
              type: 'confirm',
              name: 'deleteConfig',
              message: 'Delete configuration file?',
              initial: false,
            });

            if (deleteConfig) {
              const configPath = getConfigPathByName(ctx.name);
              if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
                logger.success('Configuration file deleted');
              }
              updateCurrentAfterDeletion([ctx.name]);
            } else {
              logger.info(`Configuration kept at ${getConfigPathByName(ctx.name)}`);
            }
          }
          return;
        }

        // Show what will be deleted
        console.log('\n' + chalk.red('⚠ WARNING:') + ' This will permanently delete:\n');
        console.log(
          chalk.red(
            '  ✗ EC2 instance: ' + config.instance.name + (instanceId ? ` (${instanceId})` : ''),
          ),
        );
        console.log(chalk.red('  ✗ All data on the instance'));
        console.log(chalk.red('  ✗ Security group'));
        console.log(chalk.red('  ✗ IAM role'));
        console.log(chalk.red('  ✗ CloudFormation stack: ' + config.stack.name));
        console.log('\n' + chalk.bold('This action CANNOT be undone!\n'));

        // Confirmation
        if (!argv.force) {
          const { confirmText } = await prompts({
            type: 'text',
            name: 'confirmText',
            message: 'Type "DELETE" to confirm:',
            validate: (value) => value === 'DELETE' || 'You must type DELETE to confirm',
          });

          if (confirmText !== 'DELETE') {
            logger.warn('Destruction cancelled');
            return;
          }
        }

        // Get CDK binary (local from node_modules or global fallback)
        const cdkBinary = getCDKBinary();

        // Get CDK app path
        const cdkAppPath = path.resolve(__dirname, '../../cdk/app.js');

        // Set up environment
        const env = {
          ...(await ctx.target.environment(30 * 60_000)),
          OPENCLAW_CONFIG_NAME: ctx.name,
          OPENCLAW_CDK_OPERATION: 'destroy',
          OPENCLAW_CONFIG_SNAPSHOT: snapshot,
          CDK_DISABLE_VERSION_CHECK: 'true',
          CDK_DISABLE_CLI_TELEMETRY: '1',
          CI: 'true',
        };

        // Destroy stack
        const destroySpinner = ora('Destroying stack... (this may take 3-5 minutes)').start();

        try {
          await withCDKWorkspace(env, async (workspace) =>
            execa(
              cdkBinary,
              [
                'destroy',
                config.stack.name,
                '--app',
                getCDKAppCommand(cdkAppPath),
                '--no-notices',
                '--no-version-reporting',
                '--force',
              ],
              {
                env: workspace.env,
                extendEnv: false,
                timeout: 25 * 60_000,
                cwd: workspace.cwd,
              },
            ),
          );

          destroySpinner.succeed('Stack destroyed successfully');
          logger.success('Deployment stack removed');
          console.log('\nRetained data and shared AWS resources may still incur charges.');
          await deleteApiKeyParam(ctx.name, apiProvider, ctx.target);
          await deleteGatewayTokenParam(ctx.name, ctx.target);

          // Ask about config file
          if (argv.deleteConfig) {
            const configPath = getConfigPathByName(ctx.name);
            if (fs.existsSync(configPath)) {
              fs.unlinkSync(configPath);
              logger.success('Configuration file deleted');
            }
            updateCurrentAfterDeletion([ctx.name]);
          } else {
            const { deleteConfig } = await prompts({
              type: 'confirm',
              name: 'deleteConfig',
              message: 'Delete configuration file?',
              initial: false,
            });

            if (deleteConfig) {
              const configPath = getConfigPathByName(ctx.name);
              if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
                logger.success('Configuration file deleted');
              }
              updateCurrentAfterDeletion([ctx.name]);
            } else {
              logger.info(`Configuration kept at ${getConfigPathByName(ctx.name)}`);
            }
          }
        } catch {
          destroySpinner.fail('Destruction failed');
          throw new AWSError('Stack destruction failed', [
            'Check AWS Console CloudFormation page for details',
            'Some resources may need manual cleanup',
            'Try running destroy again after a few minutes',
          ]);
        }
      });
    } catch (error) {
      handleError(error);
    }
  },
};

export default destroyCommand;
