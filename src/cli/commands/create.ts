import type { CommandModule } from 'yargs';
import { createFreshDeployment, type CreateArgs } from '../utils/create-flow.js';
import { handleError } from '../utils/errors.js';
import { PROVIDER_CONNECTIONS } from '../../openclaw/connections.js';
export { providerChoice } from '../utils/providers.js';
export const createDeployment = createFreshDeployment;

export const createCommand: CommandModule<{}, CreateArgs> = {
  command: 'create <name>',
  describe: 'Configure and deploy a new named OpenClaw installation',
  builder: (yargs) =>
    yargs
      .positional('name', { type: 'string', demandOption: true, describe: 'New deployment name' })
      .option('provider', {
        type: 'string',
        describe: 'Provider, e.g. openrouter, anthropic or bedrock',
        choices: [
          ...new Set([
            ...PROVIDER_CONNECTIONS.flatMap(({ value }) => [value, value.replace(/-api-key$/, '')]),
            'bedrock',
          ]),
        ],
      })
      .option('region', {
        type: 'string',
        describe: 'AWS region (defaults to current configuration)',
      })
      .option('profile', { type: 'string', describe: 'AWS credential profile' })
      .option('instance-type', { type: 'string', describe: 'EC2 instance type' })
      .option('model', { type: 'string', describe: 'Initial native provider/model reference' })
      .option('bedrock-region', {
        type: 'string',
        describe: 'Bedrock inference region (separate from EC2 region)',
      })
      .option('cloudflare-account-id', { type: 'string' })
      .option('cloudflare-gateway-id', { type: 'string' })
      .option('yes', {
        type: 'boolean',
        alias: 'y',
        default: false,
        describe: 'Use defaults and approve creation and required CDK bootstrap',
      }),
  handler: async (argv) => {
    try {
      await createDeployment(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default createCommand;
