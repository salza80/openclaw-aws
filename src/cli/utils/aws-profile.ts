type ProfileEnvironment = Record<'AWS_PROFILE' | 'AWS_SDK_LOAD_CONFIG', string | undefined>;

let originalEnvironment: ProfileEnvironment | undefined;

export function getAwsProfileEnvironment(profile?: string): ProfileEnvironment {
  return profile
    ? { AWS_PROFILE: profile, AWS_SDK_LOAD_CONFIG: '1' }
    : (originalEnvironment ?? {
        AWS_PROFILE: process.env.AWS_PROFILE,
        AWS_SDK_LOAD_CONFIG: process.env.AWS_SDK_LOAD_CONFIG,
      });
}

// Batch commands run sequentially. Restore the caller's environment before selecting
// each config so a config without a profile never inherits the previous config's.
export function applyAwsProfile(profile?: string): void {
  const environment = getAwsProfileEnvironment(profile);
  if (profile && !originalEnvironment) {
    originalEnvironment = getAwsProfileEnvironment();
  }

  for (const key of ['AWS_PROFILE', 'AWS_SDK_LOAD_CONFIG'] as const) {
    if (environment[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = environment[key];
    }
  }

  if (!profile) originalEnvironment = undefined;
}
