import chalk from 'chalk';

export const logger = {
  info: (msg: string) => console.log(chalk.blue('ℹ'), msg),
  success: (msg: string) => console.log(chalk.green('✓'), msg),
  warn: (msg: string) => console.log(chalk.yellow('⚠'), msg),
  error: (msg: string) => console.log(chalk.red('✗'), msg),
  
  title: (msg: string) => {
    const border = '─'.repeat(msg.length + 4);
    console.log(chalk.bold(`\n┌${border}┐`));
    console.log(chalk.bold(`│  ${msg}  │`));
    console.log(chalk.bold(`└${border}┘\n`));
  },

  box: (title: string, lines: string[]) => {
    const maxLen = Math.max(title.length, ...lines.map(l => l.length));
    const border = '─'.repeat(maxLen + 4);
    
    console.log(chalk.bold(`\n┌${border}┐`));
    console.log(chalk.bold(`│  ${title.padEnd(maxLen)}  │`));
    console.log(chalk.bold(`├${border}┤`));
    lines.forEach(line => {
      console.log(`│  ${line.padEnd(maxLen)}  │`);
    });
    console.log(chalk.bold(`└${border}┘\n`));
  }
};
