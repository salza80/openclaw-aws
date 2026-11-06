import { Stack, type StackProps } from 'aws-cdk-lib';
import { CfnRolePolicy, PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import { validBedrockRegion, type BedrockRoute } from '../aws/bedrock-routes.js';
import {
  BEDROCK_SELECTION_METADATA,
  bedrockSelectionMetadata,
  parseBedrockSelection,
} from '../aws/bedrock-selection.js';

export interface BedrockAccessProps extends StackProps {
  roleName: string;
  discoveryRegion: string;
  routes: BedrockRoute[];
}
/** Auxiliary policy only: never import/resynthesize an existing EC2 stack. */
export class BedrockAccessStack extends Stack {
  constructor(scope: Construct, id: string, props: BedrockAccessProps) {
    super(scope, id, props);
    if (
      !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(props.roleName) ||
      !validBedrockRegion(props.discoveryRegion) ||
      props.routes.length > 256 ||
      !props.env?.account ||
      !props.env.region
    )
      throw new Error('Bedrock access requires a concrete verified role, target and route union');
    const partition = RegionInfo.get(props.env.region).partition;
    if (!partition) throw new Error('CDK cannot establish the selected Bedrock partition');
    const identity = { account: props.env.account, partition };
    const selection = parseBedrockSelection(
      { discoveryRegion: props.discoveryRegion, routes: props.routes },
      identity,
    );
    const routes = selection.routes;
    this.templateOptions.metadata = {
      [BEDROCK_SELECTION_METADATA]: bedrockSelectionMetadata(selection, identity),
    };
    const document = new PolicyDocument({ minimize: true });
    const regions = [
      ...new Set([props.discoveryRegion, ...routes.map((route) => route.region)]),
    ].sort();
    document.addStatements(
      new PolicyStatement({
        actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestedRegion': regions } },
      }),
    );
    const invoke = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];
    for (const route of routes) {
      document.addStatements(
        new PolicyStatement({ actions: invoke, resources: [route.invocationArn] }),
      );
      if (route.kind !== 'foundation-model') {
        document.addStatements(
          new PolicyStatement({
            actions: invoke,
            resources: route.modelArns,
            conditions: { StringEquals: { 'bedrock:InferenceProfileArn': route.invocationArn } },
          }),
        );
        document.addStatements(
          new PolicyStatement({
            actions: ['bedrock:GetInferenceProfile'],
            resources: [route.invocationArn],
          }),
        );
      }
      document.addStatements(
        new PolicyStatement({
          actions: ['bedrock:GetFoundationModel'],
          resources: route.modelArns,
        }),
      );
    }
    const policy = document.toJSON();
    if (Buffer.byteLength(JSON.stringify(policy)) > 10240)
      throw new Error(
        'Bedrock route union exceeds the IAM role inline-policy quota; reduce its scope before applying',
      );
    new CfnRolePolicy(this, 'BedrockAccess', {
      roleName: props.roleName,
      policyName: this.stackName,
      policyDocument: policy,
    });
  }
}
