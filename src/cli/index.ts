#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import initCommand from './commands/init.js';
import configCommand from './commands/config.js';
import deployCommand from './commands/deploy.js';
import destroyCommand from './commands/destroy.js';
import connectCommand from './commands/connect.js';
import dashboardCommand from './commands/dashboard.js';
import statusCommand from './commands/status.js';
import outputsCommand from './commands/outputs.js';
import stopCommand from './commands/stop.js';
import startCommand from './commands/start.js';
import restartCommand from './commands/restart.js';
import readyCommand from './commands/ready.js';

yargs(hideBin(process.argv))
  .scriptName('openclaw-aws')
  .usage('$0 <command> [options]')
  .command(initCommand)
  .command(configCommand)
  .command(deployCommand)
  .command(statusCommand)
  .command(readyCommand)
  .command(connectCommand)
  .command(dashboardCommand)
  .command(outputsCommand)
  .command(stopCommand)
  .command(startCommand)
  .command(restartCommand)
  .command(destroyCommand)
  .demandCommand(1, 'You must specify a command')
  .help()
  .alias('h', 'help')
  .version()
  .alias('v', 'version')
  .epilogue('For more information, visit: https://github.com/salza80/openclaw-aws')
  .strict()
  .parse();
