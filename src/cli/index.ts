#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import createCommand from './commands/create.js';
import initCommand from './commands/init.js';
import listCommand from './commands/list.js';
import currentCommand from './commands/current.js';
import useCommand from './commands/use.js';
import deployCommand from './commands/deploy.js';
import destroyCommand from './commands/destroy.js';
import connectCommand from './commands/connect.js';
import dashboardCommand from './commands/dashboard.js';
import statusCommand from './commands/status.js';
import outputsCommand from './commands/outputs.js';
import logsCommand from './commands/logs.js';
import stopCommand from './commands/stop.js';
import startCommand from './commands/start.js';
import restartCommand from './commands/restart.js';
import vaultCommand from './commands/vault.js';
import backupCommand from './commands/backup.js';
import archiveCommand from './commands/archive.js';
import restoreCommand from './commands/restore.js';
import cloneCommand from './commands/clone.js';
import modelsCommand from './commands/models.js';
import { providersCommand } from './commands/providers.js';

yargs(hideBin(process.argv))
  .scriptName('openclaw-aws')
  .usage('$0 <command> [options]')
  .command(createCommand)
  .command(initCommand)
  .command(listCommand)
  .command(currentCommand)
  .command(useCommand)
  .command(deployCommand)
  .command(statusCommand)
  .command(connectCommand)
  .command(dashboardCommand)
  .command(outputsCommand)
  .command(logsCommand)
  .command(stopCommand)
  .command(startCommand)
  .command(restartCommand)
  .command(destroyCommand)
  .command(vaultCommand)
  .command(backupCommand)
  .command(archiveCommand)
  .command(restoreCommand)
  .command(cloneCommand)
  .command(modelsCommand)
  .command(providersCommand)
  .demandCommand(1, 'You must specify a command')
  .help()
  .alias('h', 'help')
  .version()
  .alias('v', 'version')
  .epilogue('For more information, visit: https://github.com/salza80/openclaw-aws')
  .strict()
  .parse();
