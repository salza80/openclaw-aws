import type { CommandModule } from 'yargs';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { handleError } from '../utils/errors.js';
import { prepareNativeDashboard } from '../../operations/native-dashboard.js';

interface DashboardArgs {
  name?: string;
  open?: boolean;
  localPort?: number;
  showToken?: boolean;
}
export const dashboardCommand: CommandModule<{}, DashboardArgs> = {
  command: 'dashboard',
  describe: 'Open the native OpenClaw UI through an owned SSM tunnel',
  builder: (yargs) =>
    yargs
      .option('name', { type: 'string', describe: 'Deployment name' })
      .option('local-port', { type: 'number', describe: 'Local port (automatic by default)' })
      .option('show-token', {
        type: 'boolean',
        default: false,
        describe: 'Explicitly print the private authenticated native UI URL',
      })
      .option('open', {
        type: 'boolean',
        default: true,
        describe: 'Open the browser automatically; use --no-open to keep only the tunnel',
      }),
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const session = await prepareNativeDashboard(ctx, {
        localPort: argv.localPort,
        progress: (message) => logger.info(message),
      });
      const cleanup = () => session.stop();
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
      try {
        console.log(`Native OpenClaw UI: ${session.browserUrl(Boolean(argv.showToken))}`);
        if (argv.showToken) console.log('Keep the authenticated URL private.');
        else console.log('The browser receives its native Gateway credential privately.');
        if (argv.open !== false) await session.open();
        console.log('Keep this terminal open. Ctrl+C closes this owned SSM tunnel.');
        await session.done;
      } finally {
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
        session.stop();
        await session.done.catch(() => {});
      }
    } catch (error) {
      handleError(error);
    }
  },
};
export default dashboardCommand;
