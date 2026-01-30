#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import initCommand from './commands/init.js';
import deployCommand from './commands/deploy.js';
import destroyCommand from './commands/destroy.js';
import connectCommand from './commands/connect.js';
import onboardCommand from './commands/onboard.js';
import dashboardCommand from './commands/dashboard.js';
import statusCommand from './commands/status.js';
import outputsCommand from './commands/outputs.js';

yargs(hideBin(process.argv))
  .scriptName('openclaw-aws')
  .usage('$0 <command> [options]')
  .command(initCommand)
  .command(deployCommand)
  .command(connectCommand)
  .command(onboardCommand)
  .command(dashboardCommand)
  .command(statusCommand)
  .command(outputsCommand)
  .command(destroyCommand)
  .demandCommand(1, 'You must specify a command')
  .help()
  .alias('h', 'help')
  .version()
  .alias('v', 'version')
  .epilogue('For more information, visit: https://github.com/YOUR_GITHUB_USERNAME/openclaw-aws')
  .strict()
  .parse();
