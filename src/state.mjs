import fs from 'node:fs';
import { STATE_PATH } from './config.mjs';

const EMPTY = { watched: {}, lastCheckedAt: null, lastChangedAt: null, consecutiveFailures: 0 };

export function readState() {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return { ...EMPTY };
  }
}

export function writeState(state) {
  // Write-then-rename so an interrupted run can never leave a truncated state file.
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE_PATH);
}
