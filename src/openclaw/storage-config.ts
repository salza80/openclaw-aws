/** Minimal native context for readback, independent of any source configuration. */
export function nativeStorageReadConfig(
  pluginDirectory: string,
  settings: Record<string, unknown>,
  keyInput: string,
) {
  return {
    plugins: {
      allow: ['openclaw-aws-s3'],
      load: { paths: [pluginDirectory] },
      entries: { 'openclaw-aws-s3': { enabled: true } },
    },
    secrets: { providers: { 'aws-vault-key': { source: 'file', path: keyInput, mode: 'json' } } },
    storage: {
      locations: {
        'aws-vault': {
          provider: 'aws-s3',
          settings: { ...settings, readOnly: true },
          encryption: {
            passphrase: { source: 'file', provider: 'aws-vault-key', id: '/passphrase' },
          },
        },
      },
    },
  };
}
