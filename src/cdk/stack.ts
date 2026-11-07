import { Stack, StackProps, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Instance,
  InstanceType,
  HttpTokens,
  MachineImage,
  BlockDeviceVolume,
  EbsDeviceVolumeType,
  SecurityGroup,
  UserData,
  SubnetType,
  Vpc,
  IVpc,
} from 'aws-cdk-lib/aws-ec2';
import {
  Role,
  ServicePrincipal,
  ManagedPolicy,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { StackConfig } from '../cli/types/index.js';
import type { Provider } from '../cli/types/index.js';
import { renderOpenClawBootstrap, renderOpenClawLauncher } from '../openclaw/install.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';
import {
  parseTeamBootstrap,
  teamProviderParameters,
  type TeamBootstrap,
} from '../aws/team-bootstrap.js';

export interface OpenClawStackProps extends StackProps {
  config: StackConfig;
  apiProvider: Provider;
  model?: string;
  apiKeyParamName?: string;
  gatewayTokenParamName: string;
  useDefaultVpc: boolean;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  restore?: RestoreBootstrap;
  team?: TeamBootstrap;
}

export class OpenClawStack extends Stack {
  constructor(scope: Construct, id: string, props: OpenClawStackProps) {
    const restore = props.restore ? parseRestoreBootstrap(props.restore) : undefined;
    const team = props.team ? parseTeamBootstrap(props.team) : undefined;
    if (team && restore) throw new Error('Fresh team setup cannot be used for restore onboarding');
    super(scope, id, {
      ...props,
      tags: {
        ...props.tags,
        ...(restore ? { 'openclaw-aws:restore-id': restore.operationId } : {}),
        ...(team
          ? { 'openclaw-aws:team-id': team.teamId, 'openclaw-aws:team-create-id': team.operationId }
          : {}),
      },
    });

    const { config, apiProvider, apiKeyParamName, gatewayTokenParamName } = props;
    const gatewayPort = 18789;
    const logGroupName = `/openclaw/${this.stackName}`;
    const logGroup = config.enableCloudWatchLogs
      ? new LogGroup(this, 'OpenClawLogs', {
          logGroupName,
          retention: RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        })
      : undefined;

    // VPC Configuration - Use default or create new based on config
    let vpc: IVpc;
    if (props.useDefaultVpc) {
      // Use the account's default VPC when one is available.
      vpc = Vpc.fromLookup(this, 'DefaultVpc', {
        isDefault: true,
      });
    } else {
      // Create new dedicated VPC with public subnet
      vpc = new Vpc(this, 'OpenClawVpc', {
        cidr: '10.0.0.0/16',
        maxAzs: 1,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'Public',
            subnetType: SubnetType.PUBLIC,
          },
        ],
        natGateways: 0,
      });
    }

    // Security group - SSM access only (no inbound ports)
    const sg = new SecurityGroup(this, 'OpenClawEc2Sg', {
      vpc,
      description: 'Security group for OpenClaw instance - SSM access only, no inbound ports',
      allowAllOutbound: true,
    });

    // IAM role for SSM; log permissions are scoped to this deployment's log group.
    const managedPolicies = [
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    ];

    const role = new Role(this, 'OpenClawEc2Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies,
    });
    const logGrant = logGroup?.grantWrite(role);

    const apiKeyParamArn = apiKeyParamName
      ? Stack.of(this).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: apiKeyParamName.replace(/^\/+/, ''),
        })
      : undefined;
    const gatewayTokenParamArn = Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: gatewayTokenParamName.replace(/^\/+/, ''),
    });
    const secretResources = props.restore
      ? [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `openclaw/${config.projectName}/providers/*/api-key`,
          }),
          gatewayTokenParamArn,
        ]
      : [
          ...(apiKeyParamArn ? [apiKeyParamArn] : []),
          gatewayTokenParamArn,
          ...(team ? teamProviderParameters(config.projectName, team) : []).map(({ parameter }) =>
            this.formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: parameter.slice(1),
            }),
          ),
        ];
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: secretResources,
      }),
    );

    // The SSM core managed policy includes wildcard parameter reads. This boundary
    // keeps that agent policy from exposing other deployments' secrets.
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParameterHistory'],
        notResources: secretResources,
      }),
    );
    const readinessPolicy = role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['cloudformation:DescribeStackResource', 'cloudformation:SignalResource'],
        resources: [this.stackId],
      }),
    );

    // Determine AMI - Ubuntu 24.04 LTS
    const ami = MachineImage.lookup({
      name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
      owners: ['099720109477'], // Canonical
    });

    // Keep EC2 user data small; cfn-init retrieves the full installation from metadata.
    const userData = UserData.forLinux();

    // EC2 instance
    const instance = new Instance(this, 'OpenClawEc2', {
      vpc,
      instanceType: new InstanceType(config.instanceType),
      machineImage: ami,
      securityGroup: sg,
      role,
      userData,
      userDataCausesReplacement: false,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      // Use native metadata options. CDK's requireImdsv2 aspect creates a
      // fixed-name launch template that collides across named deployments.
      httpTokens: HttpTokens.REQUIRED,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: BlockDeviceVolume.ebs(props.restore?.volumeGiB ?? 30, {
            volumeType: EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    instance.instance.cfnOptions.creationPolicy = {
      resourceSignal: { count: 1, timeout: 'PT20M' },
    };
    const bootstrap = renderOpenClawBootstrap({
      region: this.region,
      stackId: this.stackId,
      logicalResourceId: this.getLogicalId(instance.instance),
      apiProvider,
      restoreOperationId: props.restore?.operationId,
      additionalProviders: team ? teamProviderParameters(config.projectName, team) : undefined,
      model: props.model,
      apiKeyParamName,
      gatewayTokenParamName,
      logGroupName: logGroup ? logGroupName : undefined,
      cloudflareAccountId: props.cloudflareAccountId,
      cloudflareGatewayId: props.cloudflareGatewayId,
    });
    instance.instance.addMetadata('AWS::CloudFormation::Init', {
      configSets: { default: ['install'] },
      install: {
        files: {
          '/opt/openclaw-aws/bootstrap.sh': {
            content: bootstrap,
            mode: '000700',
            owner: 'root',
            group: 'root',
          },
        },
        commands: { install: { command: '/bin/bash /opt/openclaw-aws/bootstrap.sh' } },
      },
    });
    userData.addCommands(
      renderOpenClawLauncher({
        region: this.region,
        stackId: this.stackId,
        logicalResourceId: this.getLogicalId(instance.instance),
        roleName: role.roleName,
      }),
    );
    if (readinessPolicy.policyDependable) {
      instance.node.addDependency(readinessPolicy.policyDependable);
    }
    logGrant?.applyBefore(instance);

    // Add tags for easy identification
    instance.instance.addPropertyOverride('Tags', [
      { Key: 'Name', Value: config.instanceName },
      { Key: 'Project', Value: config.projectName },
      { Key: 'ManagedBy', Value: 'openclaw-aws' },
    ]);

    // Outputs
    if (logGroup) {
      new CfnOutput(this, 'LogGroupName', {
        value: logGroup.logGroupName,
        description: 'CloudWatch log group for bootstrap and OpenClaw logs (30-day retention)',
      });
    }

    new CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
      exportName: `${id}-InstanceId`,
    });

    new CfnOutput(this, 'InstanceName', {
      value: config.instanceName,
      description: 'EC2 Instance Name',
    });

    new CfnOutput(this, 'GatewayPort', {
      value: gatewayPort.toString(),
      description: 'OpenClaw Gateway Port',
    });

    new CfnOutput(this, 'DeploymentId', {
      value: this.stackId,
      description: 'Stable CloudFormation deployment identity',
    });

    new CfnOutput(this, 'SSMConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${Stack.of(this).region}`,
      description: 'SSM connection command',
    });

    new CfnOutput(this, 'SSMPortForwardCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=${gatewayPort},localPortNumber=${gatewayPort}" --region ${Stack.of(this).region}`,
      description: `Port forwarding command for dashboard (access at http://localhost:${gatewayPort})`,
    });

    new CfnOutput(this, 'SetupInstructions', {
      value: [
        'Setup Instructions:',
        '1. Connect via SSM (recommended):',
        `   aws ssm start-session --target ${instance.instanceId}`,
        '',
        '2. Check OpenClaw status:',
        '   openclaw status',
        '',
        '3. Start gateway manually (if needed):',
        `   openclaw gateway --port ${gatewayPort}`,
        '',
        '4. Access dashboard via SSM port forward:',
        `   aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=${gatewayPort},localPortNumber=${gatewayPort}"`,
        `   Then open: http://localhost:${gatewayPort}`,
        '   Tip: Use openclaw-aws dashboard to include the token automatically.',
      ].join('\n'),
      description: 'Post-deployment instructions',
    });
  }
}

export default OpenClawStack;
