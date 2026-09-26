// On-disk state under <projectRoot>/.coworker/.
//
// Layout:
//   .coworker/.gitignore          "*"  (self-ignoring; nothing here is meant to be committed)
//   .coworker/config.json         optional project config
//   .coworker/threads/<name>.json thread metadata (sessionId, turns, …) — one file per thread, so
//                                 concurrent jobs on different threads never contend on one file
//   .coworker/threads/<name>.md   human-readable Claude ⇄ Astra transcript
//   .coworker/locks/<name>.lock   per-thread lock held by the running job's supervisor
//   .coworker/jobs/<jobId>/       prompt.md, events.jsonl, stderr.log, last.txt, meta.json, status.json
//   .coworker/work/               scratch area for Claude's drafts/messages

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// No dots: thread files are <name>.json / <name>.md / <name>.ledger.json, so a name like "x.ledger"
// would collide with thread x's ledger.
export const THREAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function stateDir(projectRoot) {
  return path.join(projectRoot, ".coworker");
}

export function ensureStateDir(projectRoot) {
  const dir = stateDir(projectRoot);
  for (const sub of ["threads", "locks", "jobs", "work"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return dir;
}

export function assertThreadName(name) {
  if (!THREAD_NAME_RE.test(String(name ?? ""))) {
    const error = new Error(`Invalid thread name "${name}". Use letters, digits, "_" or "-" (max 64 chars, must start alphanumeric).`);
    error.code = "USAGE";
    throw error;
  }
  return name;
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    // A torn/corrupt file must not wedge the whole tool; surface it but keep going.
    return { __corrupt: true, __error: error.message };
  }
}

// ---------------------------------------------------------------- threads

export function threadPaths(projectRoot, name) {
  const dir = path.join(stateDir(projectRoot), "threads");
  return { meta: path.join(dir, `${name}.json`), transcript: path.join(dir, `${name}.md`) };
}

export function readThread(projectRoot, name) {
  const meta = readJson(threadPaths(projectRoot, name).meta);
  return meta && !meta.__corrupt ? meta : null;
}

export function writeThread(projectRoot, name, meta) {
  writeJsonAtomic(threadPaths(projectRoot, name).meta, meta);
}

export function listThreads(projectRoot) {
  const dir = path.join(stateDir(projectRoot), "threads");
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json") && THREAD_NAME_RE.test(entry.slice(0, -5)))
    .map((entry) => {
      const name = entry.slice(0, -5);
      return { name, ...(readThread(projectRoot, name) ?? { corrupt: true }) };
    })
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function resetThread(projectRoot, name) {
  const paths = threadPaths(projectRoot, name);
  const removed = [];
  for (const file of [paths.meta, paths.transcript]) {
    if (fs.existsSync(file)) {
      const archived = `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
      fs.renameSync(file, archived);
      removed.push(archived);
    }
  }
  return removed;
}

export function appendTranscript(projectRoot, name, text) {
  const file = threadPaths(projectRoot, name).transcript;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
  return file;
}

// ---------------------------------------------------------------- jobs

export function newJobId(kind, date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  return `${stamp}-${kind}-${crypto.randomBytes(4).toString("hex")}`;
}

export function jobDir(projectRoot, jobId) {
  if (!/^[0-9A-Za-z_-]+$/.test(jobId)) throw new Error(`Invalid job id: ${jobId}`);
  return path.join(stateDir(projectRoot), "jobs", jobId);
}

export function jobPaths(projectRoot, jobId) {
  const dir = jobDir(projectRoot, jobId);
  return {
    dir,
    meta: path.join(dir, "meta.json"),
    status: path.join(dir, "status.json"),
    supervisorLog: path.join(dir, "supervisor.log"),
    cancel: path.join(dir, "cancel.request"),
    diff: path.join(dir, "diff.patch"),
    delta: path.join(dir, "delta.patch"),
    responses: path.join(dir, "responses.json"),
    prompt: path.join(dir, "prompt.md"),
    events: path.join(dir, "events.jsonl"),
    stderr: path.join(dir, "stderr.log"),
    last: path.join(dir, "last.txt"),
    result: path.join(dir, "result.md"),
    resultJson: path.join(dir, "result.json"),
  };
}

export function listJobs(projectRoot) {
  const dir = path.join(stateDir(projectRoot), "jobs");
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Newest first by creation time (ms); ids alone only have second resolution.
  return entries
    .filter((entry) => /^[0-9A-Za-z_-]+$/.test(entry))
    .map((jobId) => {
      const paths = jobPaths(projectRoot, jobId);
      return { jobId, meta: readJson(paths.meta), status: readJson(paths.status) };
    })
    .sort((a, b) => String(b.meta?.createdAt ?? "").localeCompare(String(a.meta?.createdAt ?? "")) || b.jobId.localeCompare(a.jobId));
}

// ---------------------------------------------------------------- process liveness + locks

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * True only if `pid` is alive AND its command line contains `marker`. Supervisor argv contains the
 * job dir and Codex argv contains `-o <jobDir>/last.txt`, so the job id identifies both and a reused
 * PID can never be mistaken for ours.
 */
export function processMatches(pid, marker) {
  if (!isPidAlive(pid)) return false;
  if (!marker) return true;
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").includes(marker);
    } catch {
      return false;
    }
  }
  const result = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  // If the identity check itself cannot run, err on the side of "still ours": wrongly declaring a live
  // supervisor dead would release its lock and let a second turn resume the same session.
  if (result.error || (result.status !== 0 && !result.stdout)) return isPidAlive(pid);
  return result.stdout.includes(marker);
}

export const TERMINAL_STATES = new Set([
  "succeeded",
  "invalid_output",
  "failed",
  "cancelled",
  "timed_out",
  "session_lost",
  "start_failed",
  "crashed",
  "interrupted",
]);

const LOCK_START_GRACE_MS = 15000;

export function lockPath(projectRoot, name) {
  return path.join(stateDir(projectRoot), "locks", `${name}.lock`);
}

export function readLock(projectRoot, name) {
  const lock = readJson(lockPath(projectRoot, name));
  return lock && !lock.__corrupt ? lock : null;
}

/**
 * A lock is stale when its job reached a terminal state, or when it is past the start grace period
 * and neither the job's supervisor nor its Codex process is alive (checked by identity, not bare pid).
 */
export function isLockStale(projectRoot, lock) {
  if (!lock?.jobId) return true;
  const status = readJson(jobPaths(projectRoot, lock.jobId).status);
  if (status && !status.__corrupt && TERMINAL_STATES.has(status.state)) return true;
  const age = Date.now() - Date.parse(lock.createdAt ?? 0);
  if (!(age >= LOCK_START_GRACE_MS)) return false;
  // The launcher's argv does not contain the job id (it is chosen after startup), so identify it by
  // the script name instead; PID reuse by another coworker process inside the window is negligible.
  if (processMatches(lock.launcherPid, "coworker.mjs")) return false;
  if (status && !status.__corrupt) {
    if (processMatches(status.supervisorPid, lock.jobId)) return false;
    if (processMatches(status.codexPid, lock.jobId)) return false;
  }
  return true;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Tiny critical section around "inspect lock → remove lock". Removal (breaking a stale lock, or an owner
 * releasing its own) only happens under this mutex, and acquisition is `link()`, which cannot succeed
 * while the lock file exists — so inside the mutex the lock file cannot change underneath us.
 *
 * The mutex is a directory published atomically WITH its owner record (mkdir a private temp dir, write
 * `owner`, rename it into place). It is never reclaimed automatically: POSIX has no atomic
 * compare-and-delete, so any automatic reclaim can race another reclaimer. A mutex whose owner died
 * inside the (millisecond-long) section is reported, and `coworker threads unlock <thread>` clears it.
 */
export class MutexStaleError extends Error {}

function withLockMutex(file, fn) {
  const dir = `${file}.mutex`;
  const mine = `${dir}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(mine);
  // Identify the holder by pid + its own script path, so a reused pid is never mistaken for the holder.
  const marker = path.basename(process.argv[1] ?? "node");
  fs.writeFileSync(path.join(mine, "owner"), JSON.stringify({ pid: process.pid, marker, at: new Date().toISOString() }));
  const deadline = Date.now() + 5000;
  let held = false;
  try {
    for (;;) {
      try {
        fs.renameSync(mine, dir);
        held = true;
        break;
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "EPERM", "EISDIR"].includes(error.code)) throw error;
      }
      const owner = readJson(path.join(dir, "owner"));
      // A live holder always removes its record before exiting, so "owner looks dead" only counts if the
      // very same record is STILL there after the liveness check (otherwise it was a normal release).
      const sameOwnerStill = () => {
        const again = readJson(path.join(dir, "owner"));
        return again && !again.__corrupt && again.pid === owner.pid && again.at === owner.at;
      };
      if (owner && !owner.__corrupt && !processMatches(owner.pid, owner.marker ?? "coworker.mjs") && sameOwnerStill()) {
        const thread = path.basename(file).replace(/\.lock$/, "");
        const error = new MutexStaleError(
          `A coworker process (pid ${owner.pid}) died while holding the lock mutex for thread "${thread}". ` +
            `If no other coworker command is running, clear it with: coworker threads unlock ${thread}`,
        );
        error.code = "MUTEX_STALE";
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Lock mutex ${dir} is held by live pid ${owner?.pid ?? "?"}; try again when that coworker process finishes.`);
      }
      sleepSync(15);
    }
    return fn();
  } finally {
    if (held) {
      // Release by renaming the directory away first. Deleting it in place would leave a moment where
      // the path is an EMPTY directory, which a contender's rename() may replace — and our recursive
      // delete would then destroy the new holder's mutex. The mutex path is never empty this way.
      const released = `${dir}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.released`;
      try {
        fs.renameSync(dir, released);
        fs.rmSync(released, { recursive: true, force: true });
      } catch {
        // nothing we can safely do; leave it for `threads unlock`
      }
    }
    fs.rmSync(mine, { recursive: true, force: true });
  }
}

/** Explicit recovery (user-initiated): remove a dead mutex and a stale lock for one thread. */
export function forceUnlockThread(projectRoot, name) {
  const file = lockPath(projectRoot, name);
  const removed = [];
  const owner = readJson(path.join(`${file}.mutex`, "owner"));
  if (fs.existsSync(`${file}.mutex`)) {
    if (owner && !owner.__corrupt && processMatches(owner.pid, owner.marker ?? "coworker.mjs")) {
      throw new Error(`The lock mutex is held by a live process (pid ${owner.pid}); not removing it.`);
    }
    fs.rmSync(`${file}.mutex`, { recursive: true, force: true });
    removed.push("mutex");
  }
  const lock = readJson(file);
  if (lock && !lock.__corrupt && !isLockStale(projectRoot, lock)) {
    throw new Error(`Thread "${name}" is held by a live job (${lock.jobId}); use \`coworker cancel ${lock.jobId}\` instead.`);
  }
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
    removed.push("lock");
  }
  return removed;
}

/**
 * Take the per-thread lock or throw THREAD_BUSY. Acquisition is `link(tmp, lock)`: atomic, fails with
 * EEXIST while held, and the lock file is never observed half-written. Stale locks are removed only
 * under withLockMutex after re-checking, then acquisition is retried.
 */
export function acquireThreadLock(projectRoot, name, owner, { retryMs = 2000 } = {}) {
  const file = lockPath(projectRoot, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { ...owner, createdAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  const deadline = Date.now() + retryMs;
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, file);
        return record;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let current = null;
      const removed = withLockMutex(file, () => {
        current = readJson(file);
        if (!current) return true; // released meanwhile — just retry the link
        if (!current.__corrupt && !isLockStale(projectRoot, current)) return false;
        fs.rmSync(file, { force: true });
        return true;
      });
      if (removed) continue;
      if (Date.now() >= deadline) {
        const busy = new Error(
          `Thread "${name}" is busy with job ${current?.jobId ?? "?"}. ` +
            `Wait for it (\`coworker wait ${current?.jobId ?? "<jobId>"}\`) or cancel it (\`coworker cancel ${current?.jobId ?? "<jobId>"}\`).`,
        );
        busy.code = "THREAD_BUSY";
        busy.jobId = current?.jobId;
        throw busy;
      }
      sleepSync(100);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Remove the lock only if `jobId` still owns it (checked and removed under the mutex). */
export function releaseThreadLock(projectRoot, name, jobId) {
  const file = lockPath(projectRoot, name);
  if (!fs.existsSync(file)) return false;
  return withLockMutex(file, () => {
    const current = readJson(file);
    if (!current) return false;
    if (!current.__corrupt && jobId && current.jobId !== jobId) return false;
    fs.rmSync(file, { force: true });
    return true;
  });
}
