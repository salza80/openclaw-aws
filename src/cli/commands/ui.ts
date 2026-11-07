import type { CommandModule } from 'yargs';
import { createUiApp } from '../../ui/server.js';
import { createUiBackend } from '../../ui/backend.js';
import { openLocalBrowser } from '../../operations/native-dashboard.js';
import { handleError } from '../utils/errors.js';

interface UiArgs {
  port?: number;
  open?: boolean;
}
export const uiCommand: CommandModule<{}, UiArgs> = {
  command: 'ui',
  describe: 'Open the local AWS lifecycle console for hosts, teams and recovery',
  builder: (yargs) =>
    yargs
      .option('port', { type: 'number', describe: 'Loopback port (automatic by default)' })
      .option('open', {
        type: 'boolean',
        default: true,
        describe: 'Open the browser; --no-open prints a private one-use pairing link',
      }),
  async handler(argv) {
    try {
      if (
        argv.port !== undefined &&
        (!Number.isInteger(argv.port) || argv.port < 1 || argv.port > 65535)
      )
        throw new Error('Choose a local port between 1 and 65535');
      const ui = await createUiApp(createUiBackend());
      try {
        const address = await ui.app.listen({ host: '127.0.0.1', port: argv.port ?? 0 });
        ui.setOrigin(address);
        const pairing = `${ui.origin}/#pair=${ui.bootstrapCode}`;
        console.log(`OpenClaw AWS local console: ${ui.origin}`);
        if (argv.open === false)
          console.log(`Private one-use pairing link (expires in 10 minutes): ${pairing}`);
        else await openLocalBrowser(pairing);
        console.log(
          'Keep this terminal open. Closing the browser does not cancel applied operations.',
        );
        let stop!: () => void;
        const stopped = new Promise<void>((resolve) => {
          stop = resolve;
        });
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          await stopped;
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
        console.log('Waiting for applied operations to finish before closing the console...');
      } finally {
        await ui.app.close();
      }
    } catch (error) {
      handleError(error);
    }
  },
};
export default uiCommand;
