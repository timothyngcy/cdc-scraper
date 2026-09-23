// Lambda entrypoint. State lives in DynamoDB; Telegram credentials come from
// SSM Parameter Store (SecureString), fetched once per cold start.
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { runCheck } from '../src/monitor.mjs';
import { dynamoStore } from '../src/stores/dynamodb.mjs';

const ssm = new SSMClient({});
let credsLoaded = false;

// Cached across invocations on a warm container, so the SSM call costs nothing
// on all but the first run.
async function loadCredentials() {
  if (credsLoaded) return;
  // Already supplied (local container testing) — nothing to fetch.
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) { credsLoaded = true; return; }
  const names = [process.env.TELEGRAM_TOKEN_PARAM, process.env.TELEGRAM_CHAT_ID_PARAM].filter(Boolean);
  if (names.length !== 2) throw new Error('TELEGRAM_TOKEN_PARAM / TELEGRAM_CHAT_ID_PARAM env vars not set');

  const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  if (res.InvalidParameters?.length) {
    throw new Error(`SSM parameters not found: ${res.InvalidParameters.join(', ')}`);
  }
  for (const p of res.Parameters) {
    if (p.Name === process.env.TELEGRAM_TOKEN_PARAM) process.env.TELEGRAM_BOT_TOKEN = p.Value;
    if (p.Name === process.env.TELEGRAM_CHAT_ID_PARAM) process.env.TELEGRAM_CHAT_ID = p.Value;
  }
  credsLoaded = true;
}

const log = (...a) => console.log(...a);

export const handler = async (event = {}) => {
  // Smoke test: scrape only. Touches neither DynamoDB nor Telegram, so it works
  // before any state or credentials exist. This is the go/no-go probe for the
  // one real unknown — whether Cloudflare accepts a Lambda egress IP.
  if (event.selfTest === true) {
    const { scrape } = await import('../src/scrape.mjs');
    const rows = await scrape({ log });
    return { ok: true, selfTest: true, rows: rows.length, sample: rows.slice(0, 3) };
  }

  // No jitter here on purpose: EventBridge Scheduler's flexible time window
  // randomises the invocation for free. Sleeping inside Lambda would mean paying
  // GB-seconds to do nothing.
  await loadCredentials();

  const result = await runCheck({
    store: dynamoStore,
    log,
    dryRun: event.dryRun === true,
    seedOnly: event.seed === true,
  });

  log('result:', JSON.stringify(result));

  // Throw on failure so the invocation is recorded as an error — that is what
  // CloudWatch alarms and the Lambda Errors metric key off.
  if (!result.ok) throw new Error(result.error ?? 'check failed');
  return result;
};
