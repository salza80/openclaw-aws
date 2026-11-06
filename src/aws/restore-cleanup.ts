import {
  DeleteParameterCommand,
  GetParametersByPathCommand,
  ListTagsForResourceCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';
import type { RestoreSecretOwner } from '../openclaw/restore-secrets.js';

/** Call only after verifying that the owned deployment is absent. Never read values. */
export async function deleteRestoreParameters(
  client: Pick<SSMClient, 'send'>,
  owner: Omit<RestoreSecretOwner, 'deploymentId'> & { deploymentId?: string },
) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(owner.deploymentName) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.operationId)
  )
    throw new Error('Invalid restore credential owner');
  const prefix = `/openclaw/${owner.deploymentName}/`;
  const gateway = `${prefix}gateway-token`;
  const names: string[] = [];
  const tokens = new Set<string>();
  let next: string | undefined;
  do {
    const page = await client.send(
      new GetParametersByPathCommand({
        Path: prefix,
        Recursive: true,
        WithDecryption: false,
        NextToken: next,
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    for (const parameter of page.Parameters ?? []) {
      const name = parameter.Name;
      if (
        !name ||
        (name !== gateway && !new RegExp(`^${prefix}providers/[a-z0-9-]+/api-key$`).test(name)) ||
        names.includes(name)
      )
        throw new Error(
          'Restore credential namespace contains an unexpected parameter; nothing was deleted',
        );
      const tags = await client.send(
        new ListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: name }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      const owned = tags.TagList?.some(
        (tag) => tag.Key === 'openclaw-aws:restore-id' && tag.Value === owner.operationId,
      );
      const stackOwned =
        name === gateway ||
        (owner.deploymentId &&
          tags.TagList?.some(
            (tag) => tag.Key === 'openclaw-aws:deployment-id' && tag.Value === owner.deploymentId,
          ));
      if (!owned || !stackOwned)
        throw new Error('Restore credential ownership differs; nothing was deleted');
      names.push(name);
    }
    next = page.NextToken;
    if (next && tokens.has(next))
      throw new Error('Restore credential enumeration repeated a page; nothing was deleted');
    if (next) tokens.add(next);
  } while (next);
  // The create-only Gateway token reserves the namespace until all provider keys are gone.
  for (const name of [
    ...names.filter((name) => name !== gateway),
    ...names.filter((name) => name === gateway),
  ]) {
    try {
      await client.send(new DeleteParameterCommand({ Name: name }), {
        abortSignal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ParameterNotFound') throw error;
    }
  }
  return names.length;
}
