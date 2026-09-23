// Central config. Everything tunable lives here.

export const PAGE_URL = 'https://www.cdc.com.sg/test-date/';

// Rows to watch, matched against the "Description" column (case-insensitive,
// whitespace-normalised, exact match after normalising).
// Add more entries here to watch additional rows — the rest of the pipeline
// already handles any number of them.
export const WATCHED = [
  {
    id: 'c3a',
    section: 'SCHOOL LEARNERS',
    description: 'Class 3A Practical Test for Auto Car - C3A',
    label: 'Class 3A Practical (Auto) — C3A',
  },
];

// Politeness / anti-block knobs.
export const JITTER_MAX_SECONDS = Number(process.env.JITTER_MAX_SECONDS ?? 900); // up to 15 min after the hour
export const NAV_TIMEOUT_MS = 60_000;
export const TABLE_TIMEOUT_MS = 45_000;
export const ATTEMPTS = 3;                 // attempts per run
export const RETRY_BASE_MS = 20_000;       // exponential backoff base between attempts

// Alert after this many consecutive failed runs (so a transient blip stays quiet,
// but a real block still reaches you).
export const FAILURE_ALERT_THRESHOLD = 3;

export const STATE_PATH = new URL('../state.json', import.meta.url).pathname;
