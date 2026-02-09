import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getInstanceIdFromStack, checkSSMStatus } from '../utils/aws.js';
import { handleError } from '../utils/errors.js';
import { requireAwsCredentials } from '../utils/aws-validation.js';
import { EC2Client, GetConsoleOutputCommand } from '@aws-sdk/client-ec2';

interface ReadyArgs {
  config?: string;
  watch?: boolean;
}

async function checkMarkerInLogs(
  instanceId: string, 
  region: string
): Promise<{ ready: boolean; logs: string }> {
  const client = new EC2Client({ region });
  
  try {
    const response = await client.send(
      new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: true })
    );
    
    const output = response.Output || '';
    
    // Check for marker file creation in logs
    const hasMarker = output.includes('openclaw-ready') || 
                      output.includes('OpenClaw CLI installed successfully');
    
    // Check for completion
    const isComplete = output.includes('Cloud-init v.') && output.includes('finished at');
    
    return {
      ready: hasMarker && isComplete,
      logs: output
    };
  } catch (error) {
    return {
      ready: false,
      logs: `Error checking logs: ${error instanceof Error ? error.message : String(error)}`
    };
  }
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

      await requireAwsCredentials(config);
      
      logger.title('OpenClaw AWS - Installation Status');

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      const instanceId = await getInstanceIdFromStack(config.stack.name, config.aws.region);
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
        const markerCheck = await checkMarkerInLogs(instanceId, config.aws.region);
        
        spinner.stop();

        // Show recent logs
        if (markerCheck.logs) {
          console.log('\n' + chalk.bold('Installation Logs:'));
          console.log(chalk.gray('─'.repeat(60)));
          const relevantLines = markerCheck.logs
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
          console.log('  ' + chalk.cyan('1.') + ' Run: ' + chalk.yellow('openclaw-aws onboard'));
          console.log('  ' + chalk.cyan('2.') + ' Or connect: ' + chalk.yellow('openclaw-aws connect'));
          
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
