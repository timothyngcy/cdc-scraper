#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CdcScraperStack } from '../lib/cdc-scraper-stack';

const app = new cdk.App();

new CdcScraperStack(app, 'CdcScraperStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Singapore — closest region to the target site.
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-1',
  },
  description: 'Monitors the CDC test date page and alerts via Telegram on change',
});
