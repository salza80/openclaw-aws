import type { CommandModule } from 'yargs';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { listConfigNames, getCurrentName } from '../utils/config-store.js';

export const listCommand: CommandModule = {
  command: 'list',
  describe: 'List configs',
  handler: async () => {
    const names = listConfigNames();
    if (names.length === 0) {
      logger.info('No configs found');
      console.log('\nRun: ' + chalk.cyan('openclaw-aws init --name <name>'));
      return;
    }

    const current = getCurrentName();
    logger.title('OpenClaw AWS - Configs');
    names.forEach((name) => {
      const marker = current === name ? chalk.green(' (current)') : '';
      console.log('  ' + chalk.cyan(name) + marker);
    });
  },
};

export default listCommand;
