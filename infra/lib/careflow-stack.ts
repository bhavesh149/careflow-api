import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { type Construct } from 'constructs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const API_PORT = 3000;
const WORKER_HEALTH_PORT = 3100;
const DATABASE_NAME = 'careflow';
const DATABASE_USER = 'careflow_owner';

/**
 * Showcase-sized Careflow backend.
 *
 * Sized for a few days behind the ALB DNS name (HTTP, no domain / ACM). 3 API tasks,
 * one of each worker, single-AZ RDS, no NAT (Fargate in public subnets with a public IP;
 * RDS and Redis stay isolated). Destroy the stack when the demo is over.
 */
export class CareflowStack extends Stack {
  /**
   * Pin AZs so `cdk synth` does not call `ec2:DescribeAvailabilityZones`.
   * Mumbai has these two as the usual pair for a 2-AZ showcase VPC.
   */
  public override get availabilityZones(): string[] {
    return ['ap-south-1a', 'ap-south-1b'];
  }

  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    Tags.of(this).add('Project', 'careflow');
    Tags.of(this).add('Purpose', 'showcase');

    const imageTag = (this.node.tryGetContext('imageTag') as string | undefined) ?? 'latest';
    const corsOrigins =
      (this.node.tryGetContext('corsOrigins') as string | undefined) ??
      'http://localhost:5173,http://localhost:3000,http://localhost:8080';
    const certificateArn = this.node.tryGetContext('certificateArn') as string | undefined;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Careflow ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from the internet');
    if (certificateArn) {
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from the internet');
    }

    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'Careflow ECS tasks',
      allowAllOutbound: true,
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(API_PORT), 'API from the ALB only');

    const dataSg = new ec2.SecurityGroup(this, 'DataSg', {
      vpc,
      description: 'Careflow RDS and Redis',
      allowAllOutbound: false,
    });
    dataSg.addIngressRule(taskSg, ec2.Port.tcp(5432), 'Postgres from ECS');
    dataSg.addIngressRule(taskSg, ec2.Port.tcp(6379), 'Redis from ECS');

    const database = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dataSg],
      databaseName: DATABASE_NAME,
      credentials: rds.Credentials.fromGeneratedSecret(DATABASE_USER),
      allocatedStorage: 20,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: true,
      cloudwatchLogsRetention: logs.RetentionDays.ONE_WEEK,
    });

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'Careflow Redis (isolated subnets)',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [dataSg.securityGroupId],
    });
    redis.addResourceDependency(redisSubnetGroup);

    const dlq = new sqs.Queue(this, 'EventsDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const queue = new sqs.Queue(this, 'Events', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const jwtSecret = new secretsmanager.Secret(this, 'Jwt', {
      description: 'Careflow JWT signing secret',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'careflow',
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    const image =
      imageTag === 'latest'
        ? ecs.ContainerImage.fromDockerImageAsset(
            new ecrAssets.DockerImageAsset(this, 'AppImage', {
              directory: BACKEND_ROOT,
              file: 'Dockerfile',
              platform: ecrAssets.Platform.LINUX_AMD64,
            }),
          )
        : ecs.ContainerImage.fromEcrRepository(repository, imageTag);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Careflow API and worker runtime',
    });
    queue.grantSendMessages(taskRole);
    queue.grantConsumeMessages(taskRole);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Careflow task execution (ECR pull, secrets, logs)',
    });
    repository.grantPull(executionRole);
    jwtSecret.grantRead(executionRole);
    database.secret?.grantRead(executionRole);
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
    );

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const sharedEnvironment: Record<string, string> = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      HOST: '0.0.0.0',
      DB_HOST: database.instanceEndpoint.hostname,
      DB_PORT: String(database.instanceEndpoint.port),
      DB_NAME: DATABASE_NAME,
      DB_USER: DATABASE_USER,
      DB_SSL: 'true',
      REDIS_URL: `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`,
      REDIS_ENABLED: 'true',
      JWT_ISSUER: 'careflow',
      JWT_AUDIENCE: 'careflow-api',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'lax',
      CORS_ORIGINS: corsOrigins,
      APP_TIMEZONE: 'Asia/Kolkata',
      QUEUE_DRIVER: 'sqs',
      AWS_REGION: Stack.of(this).region,
      SQS_QUEUE_URL: queue.queueUrl,
      SWAGGER_ENABLED: 'true',
      RATE_LIMIT_LOGIN_MAX: '30',
      RATE_LIMIT_LOGIN_WINDOW_SECONDS: '300',
    };

    const sharedSecrets: Record<string, ecs.Secret> = {
      JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
    };

    const apiTask = this.createTaskDefinition({
      id: 'ApiTask',
      family: 'careflow-api',
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole,
      image,
      containerName: 'api',
      command: ['node', 'dist/main.js'],
      port: API_PORT,
      healthPath: '/health',
      environment: {
        ...sharedEnvironment,
        SERVICE_NAME: 'careflow-api',
        PORT: String(API_PORT),
      },
      secrets: sharedSecrets,
      logGroup,
      streamPrefix: 'api',
    });

    const migrateTask = this.createTaskDefinition({
      id: 'MigrateTask',
      family: 'careflow-migrate',
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole,
      image,
      containerName: 'migrate',
      command: [
        'sh',
        '-c',
        'node dist/shared/database/migrate.js && node dist/shared/database/seed.js',
      ],
      environment: {
        ...sharedEnvironment,
        SERVICE_NAME: 'careflow-migrator',
        INSTANCE_ID: 'migrate',
      },
      secrets: sharedSecrets,
      logGroup,
      streamPrefix: 'migrate',
    });

    const apiService = new ecs.FargateService(this, 'Api', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: 3,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSg],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      minHealthyPercent: 66,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(90),
    });

    this.createWorkerService({
      id: 'Outbox',
      cluster,
      taskRole,
      executionRole,
      image,
      sharedEnvironment,
      sharedSecrets,
      logGroup,
      taskSg,
      containerName: 'outbox',
      family: 'careflow-outbox',
      command: ['node', 'dist/workers/outbox-publisher/main.js'],
      serviceName: 'careflow-outbox-publisher',
    });

    this.createWorkerService({
      id: 'Notifications',
      cluster,
      taskRole,
      executionRole,
      image,
      sharedEnvironment,
      sharedSecrets,
      logGroup,
      taskSg,
      containerName: 'notifications',
      family: 'careflow-notifications',
      command: ['node', 'dist/workers/notification-consumer/main.js'],
      serviceName: 'careflow-notification-consumer',
    });

    this.createWorkerService({
      id: 'Sweeper',
      cluster,
      taskRole,
      executionRole,
      image,
      sharedEnvironment,
      sharedSecrets,
      logGroup,
      taskSg,
      containerName: 'sweeper',
      family: 'careflow-sweeper',
      command: ['node', 'dist/workers/hold-sweeper/main.js'],
      serviceName: 'careflow-hold-sweeper',
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: Duration.seconds(60),
      deletionProtection: false,
    });

    const target = new elbv2.ApplicationTargetGroup(this, 'ApiTargets', {
      vpc,
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: Duration.seconds(15),
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    target.addTarget(
      apiService.loadBalancerTarget({
        containerName: 'api',
        containerPort: API_PORT,
      }),
    );

    if (certificateArn) {
      const https = alb.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
        open: true,
      });
      https.addTargetGroups('HttpsForward', { targetGroups: [target] });
      alb.addListener('HttpRedirect', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: true,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    } else {
      alb.addListener('Http', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: true,
        defaultTargetGroups: [target],
      });
    }

    const apiUrl = certificateArn ? `https://${alb.loadBalancerDnsName}` : `http://${alb.loadBalancerDnsName}`;

    new CfnOutput(this, 'ApiUrl', {
      value: apiUrl,
      description: 'Base URL of the API (ALB). Open /docs for Swagger.',
    });
    new CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
    });
    new CfnOutput(this, 'MigrateTaskDefinitionFamily', {
      value: migrateTask.family,
    });
    new CfnOutput(this, 'TaskSubnetIds', {
      value: Fn.join(',', vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds),
      description: 'Public subnets where Fargate tasks run (assignPublicIp ENABLED).',
    });
    new CfnOutput(this, 'IsolatedSubnetIds', {
      value: Fn.join(',', vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds),
      description:
        'Subnets used by the Deploy workflow RunTask. Public + assignPublicIp for this showcase VPC.',
    });
    new CfnOutput(this, 'TaskSecurityGroupId', {
      value: taskSg.securityGroupId,
    });
    new CfnOutput(this, 'RepositoryUri', {
      value: repository.repositoryUri,
    });
  }

  private createTaskDefinition(options: {
    readonly id: string;
    readonly family: string;
    readonly cpu: number;
    readonly memoryLimitMiB: number;
    readonly taskRole: iam.IRole;
    readonly executionRole: iam.IRole;
    readonly image: ecs.ContainerImage;
    readonly containerName: string;
    readonly command: string[];
    readonly environment: Record<string, string>;
    readonly secrets: Record<string, ecs.Secret>;
    readonly logGroup: logs.ILogGroup;
    readonly streamPrefix: string;
    readonly port?: number;
    readonly healthPath?: string;
  }): ecs.FargateTaskDefinition {
    const task = new ecs.FargateTaskDefinition(this, options.id, {
      family: options.family,
      cpu: options.cpu,
      memoryLimitMiB: options.memoryLimitMiB,
      taskRole: options.taskRole,
      executionRole: options.executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = task.addContainer(options.containerName, {
      image: options.image,
      command: options.command,
      environment: options.environment,
      secrets: options.secrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: options.logGroup,
        streamPrefix: options.streamPrefix,
      }),
      healthCheck: options.healthPath
        ? {
            command: [
              'CMD-SHELL',
              `curl -fsS http://127.0.0.1:${options.port ?? API_PORT}${options.healthPath} || exit 1`,
            ],
            interval: Duration.seconds(15),
            timeout: Duration.seconds(3),
            retries: 3,
            startPeriod: Duration.seconds(25),
          }
        : undefined,
    });

    if (options.port !== undefined) {
      container.addPortMappings({ containerPort: options.port });
    }

    return task;
  }

  private createWorkerService(options: {
    readonly id: string;
    readonly cluster: ecs.ICluster;
    readonly taskRole: iam.IRole;
    readonly executionRole: iam.IRole;
    readonly image: ecs.ContainerImage;
    readonly sharedEnvironment: Record<string, string>;
    readonly sharedSecrets: Record<string, ecs.Secret>;
    readonly logGroup: logs.ILogGroup;
    readonly taskSg: ec2.ISecurityGroup;
    readonly containerName: string;
    readonly family: string;
    readonly command: string[];
    readonly serviceName: string;
  }): ecs.FargateService {
    const task = this.createTaskDefinition({
      id: `${options.id}Task`,
      family: options.family,
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: options.taskRole,
      executionRole: options.executionRole,
      image: options.image,
      containerName: options.containerName,
      command: options.command,
      port: WORKER_HEALTH_PORT,
      healthPath: '/health',
      environment: {
        ...options.sharedEnvironment,
        SERVICE_NAME: options.serviceName,
        INSTANCE_ID: `${options.containerName}-1`,
        WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
      },
      secrets: options.sharedSecrets,
      logGroup: options.logGroup,
      streamPrefix: options.containerName,
    });

    return new ecs.FargateService(this, options.id, {
      cluster: options.cluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [options.taskSg],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
  }
}
