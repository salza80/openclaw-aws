import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { handleError } from '../utils/errors.js';
import { prepareInstancePower, applyInstancePower } from '../../operations/instances.js';

interface StopArgs {
  name?: string;
  force?: boolean;
}
export const stopCommand: CommandModule<{}, StopArgs> = {
  command: 'stop',
  describe: 'Stop EC2 compute while retaining its disk and recovery resources',
  builder: (yargs) =>
    yargs.option('name', { type: 'string', describe: 'Deployment name' }).option('force', {
      type: 'boolean',
      default: false,
      describe: 'Approve stopping without a prompt',
    }),
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const plan = await prepareInstancePower(ctx, 'stop');
      if (plan.before === 'stopped') {
        logger.info('Instance is already stopped. Retained storage may still incur AWS charges.');
        return;
      }
      console.log(
        `Stop ${plan.target.instanceId} on ${plan.target.account}/${plan.target.region}. Disk/recovery/shared-resource charges remain.`,
      );
      if (
        !argv.force &&
        !(
          await prompts({
            type: 'confirm',
            name: 'confirm',
            message: 'Stop this instance?',
            initial: false,
          })
        ).confirm
      ) {
        logger.warn('Stop cancelled');
        return;
      }
      const result = await applyInstancePower(ctx, plan, {
        progress: (message) => logger.info(message),
      });
      if (result.state === 'stopped')
        logger.success('Instance stopped. Data is retained; use start to restart it.');
      else
        logger.warn(
          `Stop requested; current instance state: ${result.state}. Refresh status before another action.`,
        );
    } catch (error) {
      handleError(error);
    }
  },
};
export default stopCommand;
