import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { getStackStatus, getSSMStatus, checkGatewayStatus } from '../utils/aws.js';
import { handleError, withRetry } from '../utils/errors.js';
import { listConfigNames } from '../utils/config-store.js';

function formatStackStatus(status: string): string {
  if (status.includes('COMPLETE')) return chalk.green('✓ ' + status);
  if (status.includes('FAILED')) return chalk.red('✗ ' + status);
  if (status.includes('PROGRESS')) return chalk.yellow('⚙ ' + status);
  return chalk.yellow('⚙ ' + status);
}

function formatInstanceStatus(status: string): string {
  if (status === 'running') return chalk.green('✓ Running');
  if (status === 'stopped') return chalk.yellow('○ Stopped') + chalk.gray(' (not incurring compute costs)');
  if (status === 'stopping') return chalk.yellow('⚙ Stopping...');
  if (status === 'pending') return chalk.yellow('⚙ Starting...');
  if (status === 'terminated') return chalk.red('✗ Terminated');
  return chalk.yellow('⚙ ' + status);
}

function formatSSMStatus(status: string): string {
  if (status === 'ready') return chalk.green('✓ Ready');
  if (status === 'not-ready') return chalk.yellow('⚠ Not Ready');
  return chalk.yellow('⚠ ' + status);
}

function formatGatewayStatus(running: boolean, error?: string): string {
  if (running) return chalk.green('✓ Running');
  if (error) return chalk.red('✗ Not Running') + chalk.gray(` (${error})`);
  return chalk.red('✗ Not Running');
}

interface StatusArgs {
  name?: string;
  all?: boolean;
}

export const statusCommand: CommandModule<{}, StatusArgs> = {
  command: 'status',
  describe: 'Check deployment and instance status',
  
  builder: (yargs) => {
    return yargs
      .option('all', {
        type: 'boolean',
        describe: 'Show status for all deployments',
        default: false,
      })
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      });
  },
  
  handler: async (argv) => {
    try {
      if (argv.all) {
        const names = listConfigNames();
        if (names.length === 0) {
          logger.info('No deployments found');
          console.log('\nRun: ' + chalk.cyan('openclaw-aws init --name <name>'));
          return;
        }

        logger.title('OpenClaw AWS - All Deployment Status');
        for (const name of names) {
          const ctx = await buildCommandContext({ name });
          const config = ctx.config;
          const spinner = ora(`Checking ${name}...`).start();
          try {
            const status = await withRetry(
              () => getStackStatus(config.stack.name, config.aws.region),
              { maxAttempts: 2, operationName: 'get stack status' }
            );
            spinner.succeed(`${name}: ${status.stackStatus}`);
            const stackDisplay = formatStackStatus(status.stackStatus);
            const instanceDisplay = status.instanceStatus ? formatInstanceStatus(status.instanceStatus) : chalk.gray('unknown');
            const ssmDisplay = status.ssmStatus ? formatSSMStatus(status.ssmStatus) : chalk.gray('unknown');

            let gatewayDisplay = chalk.gray('unknown');
            if (status.instanceStatus === 'running' && status.instanceId) {
              const detailedSSM = await getSSMStatus(status.instanceId, config.aws.region);
              if (detailedSSM.status === 'Online') {
                try {
                  const gatewayStatus = await checkGatewayStatus(status.instanceId, config.aws.region);
                  gatewayDisplay = formatGatewayStatus(gatewayStatus.running, gatewayStatus.error);
                } catch {
                  gatewayDisplay = chalk.yellow('⚠ Unknown');
                }
              } else {
                gatewayDisplay = chalk.yellow('⚠ Unknown');
              }
            }

            console.log(
              '  ' +
              chalk.bold('Stack:') + ' ' + stackDisplay + '  ' +
              chalk.bold('Instance:') + ' ' + instanceDisplay + '  ' +
              chalk.bold('SSM:') + ' ' + ssmDisplay + '  ' +
              chalk.bold('Gateway:') + ' ' + gatewayDisplay
            );
            console.log('  ' + chalk.bold('Region:') + ' ' + chalk.gray(config.aws.region) + '  ' +
              chalk.bold('Type:') + ' ' + chalk.cyan(config.instance.type));
            console.log('');
          } catch (error) {
            spinner.warn(`${name}: not deployed`);
            console.log(chalk.bold('  Region:'), chalk.gray(config.aws.region));
            console.log(chalk.bold('  Instance Type:'), chalk.cyan(config.instance.type));
            console.log('');
          }
        }
        return;
      }

      const ctx = await buildCommandContext({ name: argv.name });
      const config = ctx.config;
      
      const spinner = ora('Checking status...').start();
      
      try {
        const status = await withRetry(
          () => getStackStatus(config.stack.name, config.aws.region),
          { maxAttempts: 2, operationName: 'get stack status' }
        );
        spinner.succeed('Status retrieved');

        // Display status
        logger.title('OpenClaw AWS - Deployment Status');
        logger.info(`Status for ${chalk.cyan(ctx.name)}`);

        console.log(chalk.bold('Stack:'), config.stack.name);
        
        // Stack status with color
        const stackStatusDisplay = formatStackStatus(status.stackStatus);
        
        console.log(chalk.bold('Status:'), stackStatusDisplay, chalk.gray(`(${config.aws.region})`));

        // Instance info if available
        if (status.instanceId) {
          console.log('\n' + chalk.bold('Instance:'), config.instance.name, chalk.gray(`(${status.instanceId})`));
          
          if (status.instanceStatus) {
            const instanceStatusDisplay = formatInstanceStatus(status.instanceStatus);
            console.log(chalk.bold('Status:'), instanceStatusDisplay);
          }

          if (status.ssmStatus) {
            // Get detailed SSM status
            let ssmDisplay = '';
            if (status.ssmStatus === 'ready') {
              // Double-check with detailed status
              const detailedSSM = await getSSMStatus(status.instanceId!, config.aws.region);
              if (detailedSSM.status === 'Online') {
                ssmDisplay = chalk.green('✓ Ready (Online)');
              } else if (detailedSSM.status === 'ConnectionLost') {
                ssmDisplay = chalk.red('✗ Connection Lost') + chalk.gray(` (last ping: ${detailedSSM.lastPing || 'unknown'})`);
              } else {
                ssmDisplay = chalk.yellow(`⚠ ${detailedSSM.status}`);
              }
            } else {
              ssmDisplay = formatSSMStatus(status.ssmStatus);
            }
            console.log(chalk.bold('SSM:'), ssmDisplay);
          }

          console.log(chalk.bold('Type:'), config.instance.type);
        }

        // OpenClaw Gateway status (only if instance is running and SSM is ready)
        if (status.instanceStatus === 'running' && status.instanceId) {
          console.log('\n' + chalk.bold('OpenClaw Gateway:'));
          
          // Check if SSM is online before checking gateway
          const detailedSSM = await getSSMStatus(status.instanceId, config.aws.region);
          if (detailedSSM.status === 'Online') {
            try {
              const gatewayStatus = await checkGatewayStatus(status.instanceId, config.aws.region);
              if (gatewayStatus.running) {
                console.log(chalk.bold('Status:'), chalk.green('✓ Running'));
              } else {
                console.log(chalk.bold('Status:'), chalk.red('✗ Not Running'));
                if (gatewayStatus.error) {
                  console.log(chalk.gray('  Error:'), chalk.gray(gatewayStatus.error));
                }
              }
            } catch (error) {
              console.log(chalk.bold('Status:'), chalk.yellow('⚠ Unknown'), chalk.gray('(check failed)'));
            }
          } else {
            console.log(chalk.bold('Status:'), chalk.yellow('⚠ Unknown'), chalk.gray('(SSM not connected)'));
          }
        }

        // Quick commands based on instance state
        console.log('\n' + chalk.bold('Quick Commands:'));
        
        if (status.instanceStatus === 'running') {
          console.log(`  ${chalk.cyan('openclaw-aws connect')}    - Connect via SSM`);
          console.log(`  ${chalk.cyan('openclaw-aws dashboard')}  - Access dashboard`);
          console.log(`  ${chalk.cyan('openclaw-aws stop')}       - Stop instance (save costs)`);
          console.log(`  ${chalk.cyan('openclaw-aws restart')}    - Reboot instance`);
        } else if (status.instanceStatus === 'stopped') {
          console.log(`  ${chalk.cyan('openclaw-aws start')}      - Start instance`);
          console.log(`  ${chalk.cyan('openclaw-aws destroy')}    - Delete deployment`);
        } else {
          console.log(`  ${chalk.cyan('openclaw-aws status')}     - Check current status`);
        }
        
        if (status.instanceStatus === 'running' || status.instanceStatus === 'stopped') {
          console.log(`  ${chalk.cyan('openclaw-aws destroy')}    - Delete deployment`);
        }

      } catch (error) {
        spinner.fail('Failed to get status');
        
        if (error instanceof Error && error.message.includes('not found')) {
          console.log('\n' + chalk.yellow('⚠ No deployment found'));
          console.log('\nRun: ' + chalk.cyan('openclaw-aws deploy'));
        } else {
          throw error;
        }
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default statusCommand;
