import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { resolveInstanceId, checkSSMStatus } from '../utils/aws.js';
import { handleError } from '../utils/errors.js';
import { getConsoleOutput } from '../utils/cloud-init.js';
import { buildCommandContext } from '../utils/context.js';

interface ReadyArgs {
  name?: string;
  watch?: boolean;
}

function getReadyStatusFromLogs(output: string): { ready: boolean } {
  const hasMarker = output.includes('openclaw-ready') ||
                    output.includes('OpenClaw CLI installed successfully');
  const isComplete = output.includes('Cloud-init v.') && output.includes('finished at');
  return { ready: hasMarker && isComplete };
}

export const readyCommand: CommandModule<{}, ReadyArgs> = {
  command: 'ready',
  describe: 'Check if OpenClaw installation is complete',
  
  builder: (yargs) => {
    return yargs
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      })
      .option('watch', {
        type: 'boolean',
        alias: 'w',
        describe: 'Keep checking until ready',
        default: false,
      });
  },
  
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const config = ctx.config;
      
      logger.title('OpenClaw AWS - Installation Status');
      logger.info(`Checking ${chalk.cyan(ctx.name)}`);

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      const instanceId = await resolveInstanceId(config.stack.name, config.aws.region);
      spinner.succeed(`Checking instance: ${chalk.cyan(instanceId)}`);

      let attempts = 0;
      const maxAttempts = argv.watch ? 60 : 1;

      do {
        attempts++;
        
        spinner.start('Checking installation status...');
        
        // Check SSM connectivity first
        const ssmReady = await checkSSMStatus(instanceId, config.aws.region);
        if (!ssmReady) {
          spinner.stop();
          console.log(chalk.yellow('\n⚠ SSM not ready yet. Waiting for instance to initialize...'));
          if (argv.watch) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            continue;
          }
          break;
        }
        
        // Check for marker in console logs
        const logs = await getConsoleOutput(instanceId, config.aws.region);
        const markerCheck = getReadyStatusFromLogs(logs);
        
        spinner.stop();

        // Show recent logs
        if (logs) {
          console.log('\n' + chalk.bold('Installation Logs:'));
          console.log(chalk.gray('─'.repeat(60)));
          const relevantLines = logs
            .split('\n')
            .filter((line: string) => 
              line.includes('node') || 
              line.includes('npm') || 
              line.includes('openclaw') ||
              line.includes('Complete') ||
              line.includes('finished') ||
              line.includes('openclaw-ready')
            )
            .slice(-10);
          
          relevantLines.forEach((line: string) => {
            if (line.includes('openclaw-ready') || line.includes('installed successfully')) {
              console.log(chalk.green('✓ ' + line));
            } else if (line.includes('error') || line.includes('Error')) {
              console.log(chalk.red(line));
            } else {
              console.log(chalk.gray(line));
            }
          });
          console.log(chalk.gray('─'.repeat(60)));
        }

        if (markerCheck.ready) {
          // Installation complete!
          logger.success('OpenClaw installation complete!');
          console.log('\n' + chalk.bold('Status:') + ' ' + chalk.green('✓ Ready'));
          console.log(chalk.bold('Marker:') + ' Installation complete');
          
          console.log('\n' + chalk.bold('Next steps:'));
          console.log('  ' + chalk.cyan('1.') + ' Connect to your instance: ' + chalk.yellow('openclaw-aws connect'));
          console.log('  ' + chalk.cyan('2.') + ' Check status: ' + chalk.yellow('openclaw-aws status'));
          
          return;
        } else {
          // Still installing
          console.log('\n' + chalk.bold('Status:') + ' ' + chalk.yellow('⚙ Installing...'));
          console.log(chalk.bold('Marker:') + ' Not yet complete');
          
          if (!argv.watch) {
            console.log('\n' + chalk.gray('Installation typically takes 10-15 minutes'));
            console.log('\n' + chalk.bold('Options:'));
            console.log('  • Wait and run: ' + chalk.cyan('openclaw-aws ready') + ' again');
            console.log('  • Watch progress: ' + chalk.cyan('openclaw-aws ready --watch'));
          } else {
            console.log(chalk.gray(`\nChecking again in 10 seconds... (attempt ${attempts}/${maxAttempts})`));
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
        }

      } while (argv.watch && attempts < maxAttempts);

      if (argv.watch && attempts >= maxAttempts) {
        logger.warn('Installation not complete after 10 minutes');
        console.log('\n' + chalk.bold('Troubleshooting:'));
        console.log('  1. Check SSM status: ' + chalk.cyan('openclaw-aws status'));
        console.log('  2. Try connecting: ' + chalk.cyan('openclaw-aws connect'));
        console.log('  3. View logs on instance: ' + chalk.gray('sudo tail -f /var/log/cloud-init-output.log'));
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default readyCommand;
