import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { getStackStatus, getSSMStatus, checkGatewayStatus } from '../utils/aws.js';
import { handleError, withRetry } from '../utils/errors.js';

interface StatusArgs {
  config?: string;
}

export const statusCommand: CommandModule<{}, StatusArgs> = {
  command: 'status',
  describe: 'Check deployment and instance status',
  
  builder: (yargs) => {
    return yargs
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
      });
  },
  
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ configPath: argv.config });
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

        console.log(chalk.bold('Stack:'), config.stack.name);
        
        // Stack status with color
        let stackStatusDisplay = status.stackStatus;
        if (status.stackStatus.includes('COMPLETE')) {
          stackStatusDisplay = chalk.green('✓ ' + status.stackStatus);
        } else if (status.stackStatus.includes('FAILED')) {
          stackStatusDisplay = chalk.red('✗ ' + status.stackStatus);
        } else if (status.stackStatus.includes('PROGRESS')) {
          stackStatusDisplay = chalk.yellow('⚙ ' + status.stackStatus);
        }
        
        console.log(chalk.bold('Status:'), stackStatusDisplay, chalk.gray(`(${config.aws.region})`));

        // Instance info if available
        if (status.instanceId) {
          console.log('\n' + chalk.bold('Instance:'), config.instance.name, chalk.gray(`(${status.instanceId})`));
          
          if (status.instanceStatus) {
            let instanceStatusDisplay = status.instanceStatus;
            if (status.instanceStatus === 'running') {
              instanceStatusDisplay = chalk.green('✓ Running');
            } else if (status.instanceStatus === 'stopped') {
              instanceStatusDisplay = chalk.yellow('○ Stopped') + chalk.gray(' (not incurring compute costs)');
            } else if (status.instanceStatus === 'stopping') {
              instanceStatusDisplay = chalk.yellow('⚙ Stopping...');
            } else if (status.instanceStatus === 'pending') {
              instanceStatusDisplay = chalk.yellow('⚙ Starting...');
            } else if (status.instanceStatus === 'terminated') {
              instanceStatusDisplay = chalk.red('✗ Terminated');
            } else {
              instanceStatusDisplay = chalk.yellow('⚙ ' + status.instanceStatus);
            }
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
              ssmDisplay = chalk.yellow('⚠ Not Ready');
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
