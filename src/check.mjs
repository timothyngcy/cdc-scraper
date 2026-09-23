// CLI / GitHub Actions entrypoint. State lives in a JSON file.
import { JITTER_MAX_SECONDS } from './config.mjs';
import { runCheck } from './monitor.mjs';
import { fileStore } from './stores/file.mjs';

const args = new Set(process.argv.slice(2));
const useJitter = args.has('--jitter');
const dryRun = args.has('--dry-run');   // scrape + compare, never send, never persist
const seedOnly = args.has('--seed');    // record current values without alerting

const ts = () => new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (useJitter && JITTER_MAX_SECONDS > 0) {
  // Spread the request randomly across the window instead of hitting exactly on
  // the minute like every other cron on the internet.
  // (The Lambda path does not do this — EventBridge Scheduler's flexible time
  // window randomises for free, rather than paying Lambda to sleep.)
  const delay = Math.floor(Math.random() * JITTER_MAX_SECONDS);
  log(`jitter: sleeping ${delay}s before request`);
  await sleep(delay * 1000);
}

const result = await runCheck({ store: fileStore, log, dryRun, seedOnly });
if (!result.ok) process.exitCode = 1;
