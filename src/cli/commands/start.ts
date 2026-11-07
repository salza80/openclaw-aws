import type { CommandModule } from 'yargs';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { handleError } from '../utils/errors.js';
import { prepareInstancePower, applyInstancePower } from '../../operations/instances.js';

interface StartArgs {
  name?: string;
}
export const startCommand: CommandModule<{}, StartArgs> = {
  command: 'start',
  describe: 'Start a stopped EC2 instance',
  builder: (yargs) => yargs.option('name', { type: 'string', describe: 'Deployment name' }),
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const plan = await prepareInstancePower(ctx, 'start');
      const result = await applyInstancePower(ctx, plan, {
        progress: (message) => logger.info(message),
      });
      if (result.state !== 'running')
        logger.warn(
          `Start requested; current instance state: ${result.state}. Refresh status before another action.`,
        );
      else if (result.ssmReady)
        logger.success(
          'Instance running and ready for SSM. Use dashboard or status to inspect the native Gateway.',
        );
      else logger.warn('Instance running; SSM readiness is not confirmed yet.');
    } catch (error) {
      handleError(error);
    }
  },
};
export default startCommand;
