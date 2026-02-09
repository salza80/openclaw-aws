import type { CommandModule } from 'yargs';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { listConfigNames, getCurrentName, setCurrentName } from '../utils/config-store.js';

interface ConfigArgs {
  action?: 'list' | 'use' | 'current';
  name?: string;
}

export const configCommand: CommandModule<{}, ConfigArgs> = {
  command: 'config <action> [name]',
  describe: 'Manage deployment configurations',
  builder: (yargs) => {
    return yargs
      .positional('action', {
        describe: 'Action',
        choices: ['list', 'use', 'current'] as const,
      })
      .positional('name', {
        describe: 'Deployment name (for use)',
        type: 'string',
      });
  },
  handler: async (argv) => {
    const action = argv.action;

    if (action === 'list') {
      const names = listConfigNames();
      if (names.length === 0) {
        logger.info('No deployments found');
        console.log('\nRun: ' + chalk.cyan('openclaw-aws init --name <name>'));
        return;
      }

      const current = getCurrentName();
      logger.title('OpenClaw AWS - Deployments');
      names.forEach((name) => {
        const marker = current === name ? chalk.green(' (current)') : '';
        console.log('  ' + chalk.cyan(name) + marker);
      });
      return;
    }

    if (action === 'current') {
      const current = getCurrentName();
      if (!current) {
        logger.info('No current deployment selected');
        console.log('\nUse: ' + chalk.cyan('openclaw-aws config use <name>'));
        return;
      }
      logger.info(`Current deployment: ${chalk.cyan(current)}`);
      return;
    }

    if (action === 'use') {
      if (!argv.name) {
        logger.error('Deployment name is required');
        console.log('\nUse: ' + chalk.cyan('openclaw-aws config use <name>'));
        return;
      }

      const names = listConfigNames();
      if (!names.includes(argv.name)) {
        logger.error(`Deployment not found: ${argv.name}`);
        console.log('\nCreate it first: ' + chalk.cyan(`openclaw-aws init --name ${argv.name}`));
        return;
      }

      setCurrentName(argv.name);
      logger.success(`Current deployment set to ${chalk.cyan(argv.name)}`);
      return;
    }
  },
};

export default configCommand;
