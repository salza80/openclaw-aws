import { ListTagsForResourceCommand, type SSMClient } from '@aws-sdk/client-ssm';

/** A newly attached role policy can lag CloudFormation completion. Retry only
 * this read, never workspace installation, onboarding or any other mutation.
 */
export async function readCloneCredentialTags(
  client: Pick<SSMClient, 'send'>,
  name: string,
  request: () => { abortSignal: AbortSignal },
  signal?: AbortSignal,
) {
  const deadline = Date.now() + 120000;
  const timeout = AbortSignal.timeout(120000);
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let denied: boolean;
    try {
      return await client.send(
        new ListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: name }),
        {
          abortSignal: AbortSignal.any([
            request().abortSignal,
            timeout,
            ...(signal ? [signal] : []),
          ]),
        },
      );
    } catch (error) {
      signal?.throwIfAborted();
      denied =
        error instanceof Error && ['AccessDenied', 'AccessDeniedException'].includes(error.name);
    }
    // Discard the SDK context rather than attaching it to an exported error.
    if (!denied) throw new Error('Clone target credential ownership could not be read');
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
  throw new Error('Clone target credential ownership access did not become available');
}
