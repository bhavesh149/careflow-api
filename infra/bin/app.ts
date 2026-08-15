#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { CareflowStack } from '../lib/careflow-stack.js';

/**
 * CDK entrypoint.
 *
 * Context (passed with `-c` / `--context`):
 *   imageTag        ECR tag to run. CI sets this to the git SHA.
 *   certificateArn  ACM certificate for the ALB HTTPS listener. Without it the stack
 *                   still synths and deploys an HTTP listener, which is how we keep
 *                   `cdk synth` runnable in CI before a domain exists.
 *   corsOrigins     Comma-separated browser origins. Required in production.
 */
const app = new App();

const region = (app.node.tryGetContext('region') as string | undefined) ?? 'ap-south-1';

new CareflowStack(app, 'Careflow', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '853184314326',
    region,
  },
  description: 'Careflow appointment booking backend (API, workers, data, queue).',
});
