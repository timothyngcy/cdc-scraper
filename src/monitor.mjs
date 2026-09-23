// Shared monitor logic. Deliberately knows nothing about *where* state lives —
// callers pass a store ({ read(), write(state) }), so the same code runs on
// GitHub Actions (JSON file) and on Lambda (DynamoDB).

import { WATCHED, FAILURE_ALERT_THRESHOLD, PAGE_URL } from './config.mjs';
import { scrape, BlockedError } from './scrape.mjs';
import { sendTelegram } from './notify.mjs';

// Normalise for matching: collapse whitespace, unify dash characters, lowercase.
const norm = (s) => s.replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function findRow(rows, watch) {
  return rows.find((r) => norm(r.description) === norm(watch.description)
    && (!watch.section || norm(r.section) === norm(watch.section)));
}

function changeMessage(c) {
  return `🚗 <b>CDC test date changed</b>\n\n`
    + `<b>${c.watch.label}</b>\n`
    + `Was: ${c.from.date} (${c.from.day})\n`
    + `Now: <b>${c.to.date}</b> (${c.to.day})\n\n`
    + `<a href="${PAGE_URL}">Open test date page</a>`;
}

/**
 * Scrape, compare against stored state, notify on change, persist.
 * Returns a summary so callers (e.g. Lambda) can surface it.
 */
export async function runCheck({
  store,
  log = console.log,
  notify = sendTelegram,
  dryRun = false,
  seedOnly = false,
} = {}) {
  const state = await store.read();
  let rows;

  try {
    rows = await scrape({ log });
  } catch (err) {
    const failures = state.consecutiveFailures + 1;
    log(`run failed (${failures} consecutive): ${err.name}: ${err.message}`);

    if (!dryRun) {
      await store.write({ ...state, consecutiveFailures: failures, lastCheckedAt: new Date().toISOString() });
    }

    // Stay quiet on a one-off blip; speak up once it looks like a real problem,
    // so the monitor can never fail silently for days.
    if (failures === FAILURE_ALERT_THRESHOLD && !dryRun) {
      const why = err instanceof BlockedError
        ? 'The site is blocking the scraper (Cloudflare).'
        : 'The scraper could not read the table.';
      await notify(
        `⚠️ <b>CDC monitor is failing</b>\n\n${why}\n`
        + `Failed ${failures} runs in a row.\n<code>${err.message}</code>`,
      ).catch((e) => log(`could not send failure alert: ${e.message}`));
    }
    return { ok: false, error: `${err.name}: ${err.message}`, consecutiveFailures: failures };
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

    if (prev && prev.date !== row.date) changes.push({ watch, from: prev, to: row });
    next[watch.id] = { date: row.date, day: row.day, description: row.description, seenAt: new Date().toISOString() };
  }

  if (dryRun) {
    log('dry run — state not written, no messages sent');
    return { ok: true, dryRun: true, changes: changes.length, current: next };
  }

  const now = new Date().toISOString();

  if (seedOnly) {
    await store.write({ watched: next, lastCheckedAt: now, lastChangedAt: state.lastChangedAt, consecutiveFailures: 0 });
    log('seeded state without alerting');
    return { ok: true, seeded: true, current: next };
  }

  // Notify BEFORE committing the new value. If Telegram is down we must not
  // record the new date, or the change would be swallowed and never re-announced.
  // Leaving the old value in place means the next run sees the change again and
  // retries the alert.
  let undelivered = 0;
  for (const c of changes) {
    try {
      await notify(changeMessage(c));
      log(`notified: ${c.watch.id} ${c.from.date} -> ${c.to.date}`);
    } catch (err) {
      undelivered++;
      log(`ALERT NOT DELIVERED for ${c.watch.id}: ${err.message} — keeping previous value so the next run retries`);
      next[c.watch.id] = state.watched[c.watch.id];   // roll this row back
    }
  }

  await store.write({
    watched: next,
    lastCheckedAt: now,
    lastChangedAt: changes.length > undelivered ? now : state.lastChangedAt,
    consecutiveFailures: 0,
  });

  if (!changes.length) log('no change');
  return { ok: undelivered === 0, changes: changes.length, undelivered, current: next };
}
