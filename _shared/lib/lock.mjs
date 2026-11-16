// Machine-wide lock for end-to-end runs: only one real n8n test run at a time on this laptop, whichever repo or
// workflow it comes from. The lock is a directory with a fixed name under os.tmpdir() (mkdir is atomic); it
// holds owner.json with the pid. A lock whose pid is gone is stale and is taken over.
// On macOS os.tmpdir() is per user, so "machine-wide" means every run by this user, which is every agent here.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOCK_DIR = join(tmpdir(), 'crit-n8n-e2e.lock');

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
export const readOwner = dir => {
  try { return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')); } catch { return null; }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A lock directory without a readable owner file is given 30 s (its creator may be between mkdir and write).
function isStale(dir, owner, now = Date.now()) {
  if (owner) return !alive(owner.pid);
  try { return now - statSync(dir).mtimeMs > 30000; } catch { return false; }
}

function tryTakeOver(dir, owner) {
  const aside = `${dir}.stale-${process.pid}-${Date.now()}`;
  try { renameSync(dir, aside); } catch { return; } // someone else moved it first
  const moved = readOwner(aside);
  // If what we moved is not the stale lock we judged (a fresh one appeared in between), put it back.
  if ((moved?.pid ?? null) !== (owner?.pid ?? null)) {
    try { renameSync(aside, dir); return; } catch { /* a newer lock exists; drop the moved one below */ }
  }
  rmSync(aside, { recursive: true, force: true });
}

// Returns a release() function. label shows up in owner.json so a waiting run can say who holds the lock.
// release() returns true when this process removed its own lock (the owner pid was this process), false otherwise;
// release.releasedOwn tells the same afterwards. A waiting run may take the lock the moment it is released, so
// "the lock directory is gone" is not a test of whether this run let go of it: this is.
export async function acquireLock({ label = 'e2e', dir = LOCK_DIR, timeoutMs = 60 * 60 * 1000, pollMs = 2000, log = console.log } = {}) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, label, host: hostname(), started_at: new Date().toISOString() }));
      let released = false;
      const release = () => {
        if (released) return release.releasedOwn;
        released = true;
        if (readOwner(dir)?.pid === process.pid) {
          rmSync(dir, { recursive: true, force: true });
          release.releasedOwn = true;
        }
        return release.releasedOwn;
      };
      release.releasedOwn = false;
      return release;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner(dir);
    if (isStale(dir, owner)) { tryTakeOver(dir, owner); continue; }
    if (Date.now() > deadline) throw new Error(`e2e lock ${dir} still held by ${owner ? `pid ${owner.pid} (${owner.label})` : 'an unknown process'} after ${timeoutMs / 1000}s`);
    if (!announced && log) { log(`waiting for the e2e lock held by ${owner ? `pid ${owner.pid} (${owner.label}, since ${owner.started_at})` : 'another run'}`); announced = true; }
    await sleep(pollMs);
  }
}
