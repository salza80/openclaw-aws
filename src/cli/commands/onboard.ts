import type { CommandModule } from 'yargs';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { connectCommand } from './connect.js';
import { handleError } from '../utils/errors.js';

interface OnboardArgs {
  config?: string;
}

export const onboardCommand: CommandModule<{}, OnboardArgs> = {
  command: 'onboard',
  describe: 'Connect to instance with onboarding instructions',
  
  builder: (yargs) => {
    return yargs
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
      });
  },
  
  handler: async (argv) => {
    try {
      const config = loadConfig(argv.config);
      
      logger.title('OpenClaw Onboarding Guide');

      console.log(chalk.bold('Before you begin, have these ready:\n'));
      console.log('  ' + chalk.green('✓') + ' Anthropic API key (https://console.anthropic.com/)');
      console.log('  ' + chalk.gray('○') + ' WhatsApp/Telegram tokens (optional)');
      console.log('  ' + chalk.gray('○') + ' Brave Search API key (optional, for web search)\n');

      console.log(chalk.bold('Once connected, you\'ll run:\n'));
      console.log('  ' + chalk.cyan('$ openclaw onboard --install-daemon'));
      console.log('');

      console.log(chalk.bold('The wizard will guide you through:\n'));
      console.log('  1. Choosing gateway type (select "Local")');
      console.log('  2. Configuring authentication (Anthropic API key)');
      console.log('  3. Setting up channels (WhatsApp, Telegram, etc.)');
      console.log('  4. Installing background service (systemd)');
      console.log('');

      console.log(chalk.bold('After onboarding:\n'));
      console.log('  • Check status: ' + chalk.cyan('openclaw status'));
      console.log('  • Access dashboard: ' + chalk.cyan('openclaw-aws dashboard'));
      console.log('  • View logs: ' + chalk.cyan('journalctl -u openclaw -f'));
      console.log('');

      console.log(chalk.bold('For more info, visit:\n'));
      console.log('  ' + chalk.blue('https://docs.openclaw.ai/start/getting-started'));
      console.log('');

      console.log('='.repeat(50));
      console.log(chalk.bold('Connecting to your instance...'));
      console.log('='.repeat(50));
      console.log('');

      // Call connect command
      await connectCommand.handler(argv as any);

    } catch (error) {
      handleError(error);
    }
  },
};

export default onboardCommand;
