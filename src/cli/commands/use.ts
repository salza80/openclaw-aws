import type { CommandModule } from 'yargs';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { listConfigNames, setCurrentName } from '../utils/config-store.js';

interface UseArgs {
  name: string;
}

export const useCommand: CommandModule<{}, UseArgs> = {
  command: 'use <name>',
  describe: 'Select a deployment',
  builder: (yargs) => {
    return yargs.positional('name', {
      type: 'string',
      describe: 'Deployment name',
      demandOption: true,
    });
  },
  handler: async (argv) => {
    const names = listConfigNames();
    if (!names.includes(argv.name)) {
      logger.error(`Deployment not found: ${argv.name}`);
      console.log('\nCreate it first: ' + chalk.cyan(`openclaw-aws init --name ${argv.name}`));
      return;
    }

    setCurrentName(argv.name);
    logger.success(`Current deployment set to ${chalk.cyan(argv.name)}`);
  },
};

export default useCommand;
