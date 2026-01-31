import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getInstanceIdFromStack } from '../utils/aws.js';
import { checkCloudInitStatus, getInstallationProgress } from '../utils/cloud-init.js';
import { handleError } from '../utils/errors.js';
import { EC2Client, GetConsoleOutputCommand } from '@aws-sdk/client-ec2';

interface ReadyArgs {
  config?: string;
  watch?: boolean;
}

export const readyCommand: CommandModule<{}, ReadyArgs> = {
  command: 'ready',
  describe: 'Check if OpenClaw installation is complete',
  
  builder: (yargs) => {
    return yargs
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
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
      const config = loadConfig(argv.config);
      
      logger.title('OpenClaw AWS - Installation Status');

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      const instanceId = await getInstanceIdFromStack(config.stack.name, config.aws.region);
      spinner.succeed(`Checking instance: ${chalk.cyan(instanceId)}`);

      let attempts = 0;
      const maxAttempts = argv.watch ? 60 : 1; // 60 attempts = ~10 minutes in watch mode

      do {
        attempts++;
        
        spinner.start('Checking installation status...');
        
        const status = await checkCloudInitStatus(instanceId, config.aws.region);

        // Get detailed progress
        const client = new EC2Client({ region: config.aws.region });
        const outputResponse = await client.send(
          new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: true })
        );
        const consoleOutput = outputResponse.Output || '';
        const progress = getInstallationProgress(consoleOutput);

        spinner.stop();

        if (status.isComplete && status.isOpenClawInstalled) {
          // Installation complete!
          logger.success('OpenClaw installation complete!');
          console.log('\n' + chalk.bold('Status:') + ' ' + chalk.green('✓ Ready'));
          if (status.elapsedMinutes) {
            console.log(chalk.bold('Install Time:') + ` ${status.elapsedMinutes} minutes`);
          }
          
          console.log('\n' + chalk.bold('Next steps:'));
          console.log('  ' + chalk.cyan('1.') + ' Run: ' + chalk.yellow('openclaw-aws onboard'));
          console.log('  ' + chalk.cyan('2.') + ' Or connect: ' + chalk.yellow('openclaw-aws connect'));
          
          return;
        } else if (status.hasError && status.isComplete) {
          // Installation failed
          logger.error('OpenClaw installation failed');
          if (status.errorMessage) {
            console.log('\n' + chalk.red('Error: ') + status.errorMessage);
          }
          console.log('\n' + chalk.bold('View full logs:'));
          console.log('  ' + chalk.cyan('openclaw-aws connect'));
          console.log('  ' + chalk.gray('Then run: sudo tail -f /var/log/cloud-init-output.log'));
          
          process.exit(1);
        } else {
          // Still installing
          console.log('\n' + chalk.bold('Status:') + ' ' + chalk.yellow('⚙ Installing...'));
          console.log(chalk.bold('Progress:') + ' ' + progress);
          
          if (!argv.watch) {
            console.log('\n' + chalk.gray('Installation typically takes 10-15 minutes'));
            console.log('\n' + chalk.bold('Options:'));
            console.log('  • Wait and run: ' + chalk.cyan('openclaw-aws ready') + ' again');
            console.log('  • Watch progress: ' + chalk.cyan('openclaw-aws ready --watch'));
            console.log('  • View live logs: ' + chalk.cyan('openclaw-aws connect'));
            console.log('    ' + chalk.gray('(may hang if cloud-init still running)'));
          } else {
            // Watch mode - wait and check again
            console.log(chalk.gray(`\nChecking again in 10 seconds... (attempt ${attempts}/${maxAttempts})`));
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
        }

      } while (argv.watch && attempts < maxAttempts);

      if (argv.watch && attempts >= maxAttempts) {
        logger.warn('Installation not complete after 10 minutes');
        console.log('\n' + chalk.bold('Suggestions:'));
        console.log('  • Check for errors: ' + chalk.cyan('openclaw-aws connect'));
        console.log('  • View logs: ' + chalk.gray('sudo tail -f /var/log/cloud-init-output.log'));
        console.log('  • If stuck, try: ' + chalk.cyan('openclaw-aws restart'));
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default readyCommand;
