import type { CommandModule } from 'yargs';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { getCurrentName } from '../utils/config-store.js';

export const currentCommand: CommandModule = {
  command: 'current',
  describe: 'Show current config',
  handler: async () => {
    const current = getCurrentName();
    if (!current) {
      logger.info('No current config selected');
      console.log('\nUse: ' + chalk.cyan('openclaw-aws use <name>'));
      return;
    }
    logger.info(`Current config: ${chalk.cyan(current)}`);
  },
};

export default currentCommand;
