import { definePluginEntry, type StorageProvider } from 'openclaw/plugin-sdk/plugin-entry';
import { validateS3Settings, describeS3Target } from './settings.js';

export const awsS3StorageProvider: StorageProvider = {
  id: 'aws-s3',
  label: 'Amazon S3',
  validateSettings: validateS3Settings,
  describeTarget: describeS3Target,
  async open(params) {
    const { openS3Backend } = await import('./backend.js');
    return openS3Backend(params);
  },
};
export default definePluginEntry({
  id: 'openclaw-aws-s3',
  name: 'OpenClaw AWS S3 storage',
  description: 'Amazon S3 transport using the AWS credential chain and scoped backup prefixes.',
  register(api) {
    api.registerStorageProvider(awsS3StorageProvider);
  },
});
