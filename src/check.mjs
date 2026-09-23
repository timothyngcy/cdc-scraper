import { WATCHED, JITTER_MAX_SECONDS, FAILURE_ALERT_THRESHOLD, PAGE_URL } from './config.mjs';
import { scrape, BlockedError } from './scrape.mjs';
import { readState, writeState } from './state.mjs';
import { sendTelegram } from './notify.mjs';

const args = new Set(process.argv.slice(2));
const useJitter = args.has('--jitter');
const dryRun = args.has('--dry-run');   // scrape + compare, never send, never persist
const seedOnly = args.has('--seed');    // record current values without alerting

const ts = () => new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise for matching: collapse whitespace, unify dash characters, lowercase.
const norm = (s) => s.replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function findRow(rows, watch) {
  return rows.find((r) => norm(r.description) === norm(watch.description)
    && (!watch.section || norm(r.section) === norm(watch.section)));
}

async function main() {
  if (useJitter && JITTER_MAX_SECONDS > 0) {
    // Spread the request randomly across the hour instead of hitting exactly on :00
    // like every other bot does.
    const delay = Math.floor(Math.random() * JITTER_MAX_SECONDS);
    log(`jitter: sleeping ${delay}s before request`);
    await sleep(delay * 1000);
  }

  const state = readState();
  let rows;

  try {
    rows = await scrape({ log });
  } catch (err) {
    const failures = state.consecutiveFailures + 1;
    log(`run failed (${failures} consecutive): ${err.name}: ${err.message}`);

    if (!dryRun) {
      writeState({ ...state, consecutiveFailures: failures, lastCheckedAt: new Date().toISOString() });
    }

    // Stay quiet on a one-off blip; speak up once it looks like a real problem,
    // so the monitor can never fail silently for days.
    if (failures === FAILURE_ALERT_THRESHOLD && !dryRun) {
      const why = err instanceof BlockedError
        ? 'The site is blocking the scraper (Cloudflare).'
        : 'The scraper could not read the table.';
      await sendTelegram(
        `⚠️ <b>CDC monitor is failing</b>\n\n${why}\n`
        + `Failed ${failures} runs in a row.\n<code>${err.message}</code>`,
      ).catch((e) => log(`could not send failure alert: ${e.message}`));
    }
    process.exitCode = 1;
    return;
  }

  const next = { ...state.watched };
  const changes = [];

  for (const watch of WATCHED) {
    const row = findRow(rows, watch);
    if (!row) {
      log(`WARN: watched row not found on page: "${watch.description}"`);
      continue;
    }
    const prev = state.watched[watch.id];
    log(`${watch.label}: ${row.date} (${row.day})${prev ? ` — previous: ${prev.date}` : ' — first reading'}`);

    if (prev && prev.date !== row.date) {
      changes.push({ watch, from: prev, to: row });
    }
    next[watch.id] = { date: row.date, day: row.day, description: row.description, seenAt: new Date().toISOString() };
  }

  if (dryRun) {
    log('dry run — state not written, no messages sent');
    return;
  }

  const now = new Date().toISOString();

  if (seedOnly) {
    writeState({ watched: next, lastCheckedAt: now, lastChangedAt: state.lastChangedAt, consecutiveFailures: 0 });
    log('seeded state without alerting');
    return;
  }

  // Notify BEFORE committing the new value. If Telegram is down we must not
  // record the new date, or the change would be swallowed and never re-announced.
  // Leaving the old value in place means the next run sees the change again and
  // retries the alert.
  let undelivered = 0;
  for (const c of changes) {
    const msg = `🚗 <b>CDC test date changed</b>\n\n`
      + `<b>${c.watch.label}</b>\n`
      + `Was: ${c.from.date} (${c.from.day})\n`
      + `Now: <b>${c.to.date}</b> (${c.to.day})\n\n`
      + `<a href="${PAGE_URL}">Open test date page</a>`;
    try {
      await sendTelegram(msg);
      log(`notified: ${c.watch.id} ${c.from.date} -> ${c.to.date}`);
    } catch (err) {
      undelivered++;
      log(`ALERT NOT DELIVERED for ${c.watch.id}: ${err.message} — keeping previous value so the next run retries`);
      next[c.watch.id] = state.watched[c.watch.id];   // roll this row back
    }
  }

  writeState({
    watched: next,
    lastCheckedAt: now,
    lastChangedAt: changes.length > undelivered ? now : state.lastChangedAt,
    consecutiveFailures: 0,
  });

  if (!changes.length) log('no change');
  if (undelivered) process.exitCode = 1;
}

main().catch((err) => {
  log('unexpected error:', err);
  process.exitCode = 1;
});
