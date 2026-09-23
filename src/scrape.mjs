import { chromium } from 'playwright';
import {
  PAGE_URL, NAV_TIMEOUT_MS, TABLE_TIMEOUT_MS, ATTEMPTS, RETRY_BASE_MS,
} from './config.mjs';

export class BlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedError'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// Small, realistic variation. The UA is deliberately NOT randomised: it must stay
// consistent with the real Chrome build we drive, or the fingerprint mismatch makes
// us look *more* like a bot, not less.
function humanViewport() {
  return {
    width: Math.round(rand(1360, 1520)),
    height: Math.round(rand(860, 960)),
  };
}

function looksBlocked(status, title, text) {
  if (status === 403 || status === 429) return true;
  const t = `${title} ${text}`.toLowerCase();
  return t.includes('attention required')
    || t.includes('sorry, you have been blocked')
    || t.includes('just a moment')
    || t.includes('checking your browser')
    || t.includes('verify you are human');
}

// Headless Chrome advertises itself as "HeadlessChrome/154.0.0.0", which is the
// loudest bot signal there is — so we do override the UA. But we derive it from the
// browser we actually launched and only strip the "Headless" marker, rather than
// hardcoding a string. That keeps the UA truthful about platform and version:
// a hardcoded macOS UA sent from a Linux CI runner is the exact fingerprint
// mismatch that makes you look automated.
async function realUserAgent(browser) {
  const probe = await browser.newContext();
  try {
    const page = await probe.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    return ua.replace('HeadlessChrome/', 'Chrome/');
  } finally {
    await probe.close().catch(() => {});
  }
}

async function scrapeOnce() {
  // Two things here are load-bearing, both verified against the live site:
  //
  //  1. launch() + newContext(), NOT launchPersistentContext(). A persistent
  //     context is reliably 403'd by Cloudflare; a normal launch passes.
  //  2. A FRESH context every run — no cookie reuse. Replaying a saved
  //     cf_clearance cookie into a new session also gets 403'd, because that
  //     cookie is bound to the session that earned it.
  //
  // So: clean browser, clean jar, every time. Don't "optimise" either away.
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',           // real Chrome, not bundled Chromium
  });
  const ctx = await browser.newContext({
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    userAgent: await realUserAgent(browser),
    viewport: humanViewport(),
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const resp = await page.goto(PAGE_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    const status = resp?.status() ?? 0;
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '').catch(() => '');

    if (looksBlocked(status, title, bodyText)) {
      throw new BlockedError(`blocked by WAF (status ${status}, title "${title}")`);
    }

    // Light, human-ish activity while the table's XHR resolves.
    await sleep(rand(600, 1600));
    await page.mouse.move(rand(200, 900), rand(200, 600)).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 250 + Math.random() * 400)).catch(() => {});

    // The table is rendered client-side from
    // https://enrol.cdc.com.sg/wscdctestdate/api/testdate/ — wait for the DOM it writes.
    await page.waitForFunction(
      () => document.querySelectorAll('#testdate table tr td').length > 0,
      null,
      { timeout: TABLE_TIMEOUT_MS },
    );
    await sleep(rand(300, 900));

    const rows = await page.evaluate(() => {
      const out = [];
      let section = '';
      for (const el of document.querySelectorAll('#testdate > *')) {
        if (el.tagName === 'H3') section = el.textContent.trim();
        if (el.tagName === 'TABLE') {
          for (const tr of el.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
            if (cells.length >= 2) {
              out.push({ section, description: cells[0], date: cells[1], day: cells[2] ?? '' });
            }
          }
        }
      }
      return out;
    });

    if (rows.length === 0) throw new Error('table rendered but no data rows parsed');
    return rows;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Scrape with bounded retries. Throws the last error if every attempt fails. */
export async function scrape({ log = console.log } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const rows = await scrapeOnce();
      log(`scrape ok on attempt ${attempt} (${rows.length} rows)`);
      return rows;
    } catch (err) {
      lastErr = err;
      log(`attempt ${attempt}/${ATTEMPTS} failed: ${err.name}: ${err.message}`);
      if (attempt < ATTEMPTS) {
        // Exponential backoff + jitter. If we were blocked, backing off matters more
        // than retrying fast — hammering a WAF is how a soft block becomes a hard one.
        const wait = RETRY_BASE_MS * 2 ** (attempt - 1) * rand(0.8, 1.4);
        log(`backing off ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}
