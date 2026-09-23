import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'node:path';

// SSM parameter names holding the Telegram credentials. Created by you via the
// CLI (see README) rather than by CDK — secrets should never sit in source or in
// a CloudFormation template, where they would be readable in plaintext.
const TOKEN_PARAM = '/cdc-scraper/telegram-bot-token';
const CHAT_ID_PARAM = '/cdc-scraper/telegram-chat-id';

export class CdcScraperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- State -------------------------------------------------------------
    // One item holds the whole monitor state. PAY_PER_REQUEST because ~23
    // reads + 23 writes a day is far below any provisioned floor.
    const table = new dynamodb.Table(this, 'StateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,   // it's one date; rebuild it by re-seeding
      pointInTimeRecovery: false,
    });

    // ---- Compute -----------------------------------------------------------
    // Container image because Chrome will not fit in a 250MB zip.
    // x86_64 is REQUIRED: Google ships no ARM build of Chrome for Linux.
    const fn = new lambda.DockerImageFunction(this, 'CheckFunction', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '..', '..'), {
        file: 'lambda/Dockerfile',
        platform: require('aws-cdk-lib/aws-ecr-assets').Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      // Chrome is memory-hungry, and on Lambda CPU scales with memory — 2GB keeps
      // a run to ~20-30s. Lower and you pay for a slower run, not a cheaper one.
      memorySize: 2048,
      timeout: cdk.Duration.minutes(2),
      environment: {
        STATE_TABLE: table.tableName,
        TELEGRAM_TOKEN_PARAM: TOKEN_PARAM,
        TELEGRAM_CHAT_ID_PARAM: CHAT_ID_PARAM,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,   // don't pay to store logs forever
    });

    table.grantReadWriteData(fn);

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${TOKEN_PARAM}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${CHAT_ID_PARAM}`,
      ],
    }));
    // SecureString parameters are KMS-encrypted with the account's default SSM key.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [`arn:aws:kms:${this.region}:${this.account}:alias/aws/ssm`],
    }));

    // ---- Schedule ----------------------------------------------------------
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    fn.grantInvoke(schedulerRole);

    new scheduler.CfnSchedule(this, 'CheckSchedule', {
      // Native timezone support — no UTC arithmetic, and no second cron entry to
      // stop the last run spilling past 19:00 (compare the GitHub Actions file).
      scheduleExpression: 'cron(0,30 8-19 ? * * *)',
      scheduleExpressionTimezone: 'Asia/Singapore',
      // Randomises each invocation within a 15-minute window. This replaces the
      // in-process jitter sleep — AWS does it for free, Lambda would bill for it.
      flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 15 },
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
