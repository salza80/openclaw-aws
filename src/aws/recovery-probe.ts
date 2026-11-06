import type { AwsTarget } from './target.js';
import { executeSsm } from './ssm.js';
import { asUbuntu, shellQuote } from '../openclaw/commands.js';
import type { RestoreBootstrap } from './restore-bootstrap.js';
import { object } from '../openclaw/backup-contract.js';
/** Return bounded facts, never the contents of a remote control file. */
export async function probeRecoveryBootstrap(
  target: AwsTarget,
  instanceId: string,
  stackId: string,
  bootstrap: RestoreBootstrap,
) {
  const script = recoveryBootstrapProbeScript(stackId, bootstrap);
  const result = object(
    JSON.parse(
      (
        await executeSsm(instanceId, target, [asUbuntu(`node -e ${shellQuote(script)}`)], {
          executionSeconds: 30,
        })
      ).stdout,
    ),
  );
  if (
    result.verified !== true ||
    typeof result.masked !== 'boolean' ||
    typeof result.inactive !== 'boolean'
  )
    throw new Error('Recovery bootstrap probe did not establish target ownership');
  return { masked: result.masked, inactive: result.inactive };
}
export function recoveryBootstrapProbeScript(stackId: string, bootstrap: RestoreBootstrap) {
  const expected = {
    schemaVersion: 1,
    operationId: bootstrap.operationId,
    stackId,
    openclaw: bootstrap.runtime.openclaw,
    node: bootstrap.runtime.node,
    gateway: 'masked',
  };
  const script = `const fs=require('node:fs'),{isDeepStrictEqual}=require('node:util'),{execFileSync}=require('node:child_process');const value=JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw-aws/restore-bootstrap.json','utf8'));if(!isDeepStrictEqual(value,${JSON.stringify(expected)}))throw new Error('Inactive bootstrap identity differs');const states=execFileSync('systemctl',['--user','show','openclaw-gateway.service','--property=ActiveState','--property=LoadState','--value'],{encoding:'utf8',timeout:15000}).split('\\n');console.log(JSON.stringify({verified:true,masked:states.includes('masked'),inactive:states.some(state=>['inactive','failed'].includes(state))}));`;
  return script;
}
