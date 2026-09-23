// State store backed by a JSON file. Used by the CLI and the GitHub Actions path,
// where the file is committed back to the repo.
import fs from 'node:fs';
import { STATE_PATH, EMPTY_STATE } from '../config.mjs';

export const fileStore = {
  async read() {
    try {
      return { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
    } catch {
      return { ...EMPTY_STATE };
    }
  },
  async write(state) {
    // Write-then-rename so an interrupted run can never leave a truncated file.
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, STATE_PATH);
  },
};
