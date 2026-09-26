// Job transport: every Astra turn is a job owned by a detached supervisor process.
//
// Lifecycle (status.json `state`):
//   created → starting → running → one terminal state (see TERMINAL_STATES in state.mjs)
//
// Survival: Claude Code stops a Bash task by killing its whole descendant tree (found via PPID), so a
// plain `detached` child dies with the foreground. We double-fork: launcher → `_spawn` (exits at once)
// → `_supervise`, which is reparented to pid 1 and survives Esc/TaskStop/timeouts.
//
// Single-writer rule: the launcher writes the job dir + initial status, then only reads. The supervisor
// writes everything after that (status, events via Codex's fds, thread file, ledger, transcript) and
// releases the lock. Writing the terminal status is the commit point and happens LAST. `wait`/`jobs`
// only read, except that they mark a job `interrupted` when its supervisor verifiably vanished.
// `cancel` only drops a request file and signals the supervisor.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { classifyError, createEventFolder, LineBuffer, parseEventLine } from "./events.mjs";
import {
  acquireThreadLock,
  jobPaths,
  readThread,
  writeThread,
  newJobId,
  processMatches,
  readJson,
  releaseThreadLock,
  TERMINAL_STATES,
  writeJsonAtomic,
} from "./state.mjs";

const STARTUP_ACK_MS = 15000;
const SIGINT_GRACE_MS = 10000;
const POLL_MS = 300;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readStatus(projectRoot, jobId) {
  const status = readJson(jobPaths(projectRoot, jobId).status);
  return status && !status.__corrupt ? status : null;
}

export function writeStatus(projectRoot, jobId, patch) {
  const file = jobPaths(projectRoot, jobId).status;
  const current = readJson(file);
  const next = { ...(current && !current.__corrupt ? current : {}), ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(file, next);
  return next;
}

/** All descendants of `rootPid` (snapshot), so helpers in their own process groups are not orphaned. */
function descendants(rootPid) {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const children = new Map();
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * Startup handshake: exactly one of {supervisor, launcher-gives-up, reconcile} creates `ack` (O_EXCL).
 * A supervisor that loses this race must not run Codex; a launcher that loses it knows the supervisor
 * is up after all.
 */
export function claimAck(jobDir, who) {
  // Publish a COMPLETE record atomically: write a private temp file, then link() it into place (fails
  // with EEXIST if someone else already claimed). Readers never see an empty or half-written ack.
  const tmp = path.join(jobDir, `ack.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${who} ${process.pid} ${new Date().toISOString()}\n`);
  try {
    fs.linkSync(tmp, path.join(jobDir, "ack"));
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The supervisor normally clears activeJobId in finalize; recovery paths must do it themselves. */
function clearActiveJob(projectRoot, threadName, jobId, state) {
  const thread = readThread(projectRoot, threadName);
  if (!thread) return;
  const at = new Date().toISOString();
  const turns = thread.turns ?? [];
  const recorded = turns.some((turn) => turn.jobId === jobId);
  const meta = readJson(jobPaths(projectRoot, jobId).meta) ?? {};
  writeThread(projectRoot, threadName, {
    ...thread,
    activeJobId: thread.activeJobId === jobId ? null : thread.activeJobId,
    lastFailed: { jobId, state, at },
    turns: recorded ? turns : [...turns, { jobId, kind: meta.kind, round: meta.round, state, effort: meta.effort, finishedAt: at, usage: null }].slice(-200),
  });
}

export function readAck(jobDir) {
  try {
    const [who, pid] = fs.readFileSync(path.join(jobDir, "ack"), "utf8").trim().split(/\s+/);
    const parsed = { who, pid: Number(pid) };
    return who && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- launch (foreground side)

/**
 * Create the job directory, take the thread lock (unless the caller already holds it) and launch the
 * supervisor through a double fork. Returns once the supervisor has acknowledged startup.
 * @param {object} spec {projectRoot, thread, kind, prompt, codex:{bin,args,cwd}, timeoutSec, meta, script, lockHeld}
 */
export async function launchJob(spec) {
  const jobId = spec.jobId ?? newJobId(spec.kind);
  const paths = jobPaths(spec.projectRoot, jobId);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.prompt, spec.prompt, { mode: 0o600 });
  for (const file of [paths.events, paths.stderr, paths.supervisorLog]) fs.writeFileSync(file, "", { mode: 0o600 });
  const meta = {
    jobId,
    jobDir: paths.dir,
    projectRoot: spec.projectRoot,
    thread: spec.thread,
    kind: spec.kind,
    createdAt: new Date().toISOString(),
    codex: spec.codex,
    timeoutSec: spec.timeoutSec,
    ...spec.meta,
  };
  writeJsonAtomic(paths.meta, meta);
  writeStatus(spec.projectRoot, jobId, { state: "created", launcherPid: process.pid });

  if (!spec.lockHeld) {
    try {
      acquireThreadLock(spec.projectRoot, spec.thread, { jobId, launcherPid: process.pid });
    } catch (error) {
      writeStatus(spec.projectRoot, jobId, { state: "start_failed", error: error.message, finishedAt: new Date().toISOString() });
      throw error;
    }
  }
  spec.onLocked?.(jobId);

  // Every "give up" path must win the ack race first; otherwise a supervisor is (or will be) running.
  const fail = (message) => {
    if (!claimAck(paths.dir, "launcher-gave-up")) return false;
    releaseThreadLock(spec.projectRoot, spec.thread, jobId);
    writeStatus(spec.projectRoot, jobId, { state: "start_failed", error: message, finishedAt: new Date().toISOString() });
    const error = new Error(`Job ${jobId}: ${message}`);
    error.code = "START_FAILED";
    throw error;
  };
  const waitForAck = async () => {
    const deadline = Date.now() + STARTUP_ACK_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(path.join(paths.dir, "ack"))) return true;
      await sleep(100);
    }
    return false;
  };

  const middle = spawnSync(process.execPath, [spec.script, "_spawn", paths.dir], {
    cwd: spec.projectRoot,
    stdio: "ignore",
    env: process.env,
    timeout: 10000,
  });
  // Even if the middle process failed, it may already have forked the supervisor: wait for the ack
  // before declaring failure, and only fail by winning the ack race.
  if (await waitForAck()) return { jobId, paths, meta };
  const log = safeTail(paths.supervisorLog, 800);
  const reason = middle.error || middle.status !== 0
    ? `could not start supervisor (${middle.error?.message ?? `exit ${middle.status}`})`
    : "supervisor did not acknowledge startup";
  if (fail(`${reason}${log ? `: ${log}` : ""}`) === false) return { jobId, paths, meta };
  return null;
}

/** Middle process of the double fork: start the supervisor fully detached, then exit immediately. */
export function spawnSupervisor(script, jobDir) {
  const logFd = fs.openSync(path.join(jobDir, "supervisor.log"), "a");
  const child = spawn(process.execPath, [script, "_supervise", jobDir], {
    cwd: path.dirname(jobDir),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

function safeTail(file, bytes) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.slice(-bytes).trim();
  } catch {
    return "";
  }
}

// --------------------------------------------------------------------- supervisor (detached side)

/**
 * Runs inside the detached supervisor.
 * @param {string} jobDir
 * @param {{finalize: (ctx) => object}} hooks  finalize(ctx) does the kind-specific post-processing
 *        (thread file, ledger, transcript, result rendering) and returns extra status fields. It runs
 *        while this job still holds the thread lock.
 */
export async function superviseJob(jobDir, { finalize }) {
  const meta = readJson(path.join(jobDir, "meta.json"));
  if (!meta || meta.__corrupt) throw new Error(`bad job dir ${jobDir}`);
  const { projectRoot, jobId, thread } = meta;
  const paths = jobPaths(projectRoot, jobId);
  if (!claimAck(paths.dir, "supervisor")) {
    // The launcher (or a reconcile) already gave up on this job and released its lock; running Codex now
    // would race a newer turn on the same session.
    fs.appendFileSync(paths.supervisorLog, "[supervisor] startup was abandoned before we acknowledged; exiting without running Codex\n");
    return;
  }
  let committed = false;

  // Commit order: terminal status FIRST, then the lock. A terminal status makes the lock stale for any
  // contender (isLockStale), so the next turn is never blocked; and if we die in between, readers see
  // the real outcome instead of "interrupted".
  const commit = (outcome) => {
    if (committed) return;
    committed = true;
    writeStatus(projectRoot, jobId, { ...outcome, finishedAt: new Date().toISOString() });
    releaseThreadLock(projectRoot, thread, jobId);
  };
  let codexRef = null;
  const crash = (error) => {
    try {
      fs.appendFileSync(paths.supervisorLog, `\n[crash] ${error?.stack ?? error}\n`);
    } catch {
      // ignore
    }
    // Never leave Codex running behind a job we are about to declare crashed.
    if (codexRef?.pid && codexRef.exitCode === null && codexRef.signalCode === null) {
      for (const pid of descendants(codexRef.pid)) signal(pid, "SIGKILL");
      signal(-codexRef.pid, "SIGKILL");
      signal(codexRef.pid, "SIGKILL");
    }
    try {
      clearActiveJob(projectRoot, thread, jobId, "crashed");
    } catch {
      // best effort
    }
    commit({ state: "crashed", error: String(error?.message ?? error) });
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  writeStatus(projectRoot, jobId, { state: "starting", supervisorPid: process.pid, startedAt: new Date().toISOString() });

  let stopReason = null;
  let codex = null;
  let exited = false;
  const stop = (reason) => {
    if (stopReason || !codex || exited) return;
    stopReason = reason;
    // SIGINT is the only signal Codex handles gracefully (it shuts down its MCP helpers). Snapshot the
    // tree first: helpers live in their own process groups and would be orphaned by a group kill.
    const tree = descendants(codex.pid);
    signal(codex.pid, "SIGINT");
    setTimeout(() => {
      if (exited) return;
      for (const pid of [...tree, ...descendants(codex.pid)]) signal(pid, "SIGKILL");
      signal(-codex.pid, "SIGKILL");
      signal(codex.pid, "SIGKILL");
    }, SIGINT_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => stop("cancel"));
  process.on("SIGINT", () => stop("cancel"));
  process.on("SIGHUP", () => {});

  const promptFd = fs.openSync(paths.prompt, "r");
  const eventsFd = fs.openSync(paths.events, "a");
  const stderrFd = fs.openSync(paths.stderr, "a");
  const started = Date.now();
  const exit = new Promise((resolve) => {
    try {
      codex = spawn(meta.codex.bin, meta.codex.args, {
        cwd: meta.codex.cwd,
        detached: true,
        stdio: [promptFd, eventsFd, stderrFd],
        env: process.env,
      });
    } catch (error) {
      resolve({ code: null, signal: null, error });
      return;
    }
    codexRef = codex;
    codex.on("error", (error) => resolve({ code: null, signal: null, error }));
    codex.on("exit", (code, sig) => resolve({ code, signal: sig }));
  });
  for (const fd of [promptFd, eventsFd, stderrFd]) fs.closeSync(fd);
  if (codex?.pid) writeStatus(projectRoot, jobId, { state: "running", codexPid: codex.pid });

  const timeoutTimer = setTimeout(() => stop("timeout"), (meta.timeoutSec ?? 1800) * 1000);
  const tail = createTail(paths.events);
  let sessionSeen = false;
  let result = null;
  exit.then((value) => {
    exited = true;
    result = value;
  });
  while (result === null) {
    tail.pump();
    if (!sessionSeen && tail.state.sessionId) {
      sessionSeen = true;
      writeStatus(projectRoot, jobId, { sessionId: tail.state.sessionId });
    }
    if (!stopReason && fs.existsSync(paths.cancel)) stop("cancel");
    await sleep(POLL_MS);
  }
  clearTimeout(timeoutTimer);
  tail.pump();
  tail.finish();

  const folded = tail.state;
  // Codex normally writes -o; if it did not but the turn completed, its last agent message is the answer.
  let lastText = fs.existsSync(paths.last) ? fs.readFileSync(paths.last, "utf8") : null;
  if (lastText === null && folded.completed && folded.messages.length) lastText = folded.messages[folded.messages.length - 1];
  const stderrText = safeTail(paths.stderr, 20000);
  const outcome = classifyOutcome({ result, folded, lastText, stopReason, stderrText, expectJson: Boolean(meta.schemaPath) });
  Object.assign(outcome, {
    exitCode: result.code,
    signal: result.signal,
    sessionId: folded.sessionId,
    usage: folded.usage,
    elapsedMs: Date.now() - started,
    commands: folded.commands,
  });

  let extra = {};
  try {
    extra = finalize({ meta, paths, outcome, folded, lastText }) ?? {};
  } catch (error) {
    fs.appendFileSync(paths.supervisorLog, `\n[finalize] ${error.stack ?? error}\n`);
    extra = { finalizeError: String(error.message ?? error) };
    if (outcome.state === "succeeded") outcome.state = "crashed";
    // finalize normally clears the thread's active job; make sure a crash there never strands the thread.
    try {
      clearActiveJob(projectRoot, thread, jobId, outcome.state);
    } catch {
      // best effort
    }
  }
  commit({ ...outcome, ...extra });
}

/**
 * Precedence (first match wins):
 *  1 turn.completed + exit 0 + final message       → succeeded (even if a cancel arrived late)
 *  2 same, but structured output does not parse    → invalid_output (the session DID advance)
 *  3 we stopped it for cancel                       → cancelled
 *  4 we stopped it for timeout                      → timed_out
 *  5 stderr "no rollout found"                      → session_lost
 *  6 turn.failed                                    → failed (with its message)
 *  7 no thread.started and nonzero exit / spawn err → start_failed
 *  8 anything else                                  → crashed
 * Top-level `error` events are transient retries and item errors are warnings: log lines only.
 */
export function classifyOutcome({ result, folded, lastText, stopReason, stderrText = "", expectJson }) {
  const completed = folded.completed && !folded.failed && result.code === 0 && lastText !== null;
  if (completed) {
    if (expectJson) {
      let parsed;
      try {
        parsed = JSON.parse(lastText);
      } catch (error) {
        return { state: "invalid_output", error: `structured output did not parse: ${error.message}` };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { state: "invalid_output", error: "structured output is not a JSON object" };
      }
    }
    return { state: "succeeded" };
  }
  const deliveryUnknown = Boolean(folded.sessionId) && !folded.completed;
  if (stopReason === "cancel") return { state: "cancelled", deliveryUnknown };
  if (stopReason === "timeout") return { state: "timed_out", deliveryUnknown };
  if (/no rollout found/i.test(stderrText)) {
    return { state: "session_lost", error: "Codex no longer has this session (pruned, archived, or a different CODEX_HOME)." };
  }
  if (folded.failed) {
    const message = folded.failure ?? "turn failed";
    return { state: "failed", error: message, deliveryUnknown, ...hint(message) };
  }
  if (!folded.sessionId && (result.error || result.code !== 0)) {
    const filtered = stderrText
      .split("\n")
      .filter((line) => line.trim() && !/rmcp::|responses_websocket|Reading additional input from stdin/.test(line))
      .slice(-6)
      .join("\n");
    const message = result.error?.message ?? (filtered || `codex exited with ${result.code ?? result.signal}`);
    return { state: "start_failed", error: message, ...hint(message) };
  }
  return { state: "crashed", error: `codex exited with ${result.code ?? result.signal} before finishing the turn`, deliveryUnknown };
}

function hint(message) {
  const classified = classifyError(message);
  return classified.hint ? { errorCode: classified.code, hint: classified.hint } : { errorCode: classified.code };
}

/** Incremental reader for events.jsonl (byte offsets + StringDecoder, so multibyte text never splits). */
export function createTail(file, { onProgress, fromOffset = 0 } = {}) {
  const folder = createEventFolder({ onProgress });
  const decoder = new StringDecoder("utf8");
  const buffer = new LineBuffer();
  let offset = fromOffset;
  const feed = (lines) => {
    for (const line of lines) {
      const event = parseEventLine(line);
      if (event) folder.fold(event);
    }
  };
  return {
    state: folder.state,
    pump() {
      let fd;
      try {
        fd = fs.openSync(file, "r");
      } catch {
        return;
      }
      try {
        const size = fs.fstatSync(fd).size;
        while (offset < size) {
          const length = Math.min(size - offset, 4 * 1024 * 1024);
          const chunk = Buffer.alloc(length);
          const read = fs.readSync(fd, chunk, 0, length, offset);
          if (read <= 0) break;
          offset += read;
          feed(buffer.push(decoder.write(chunk.subarray(0, read))));
        }
      } finally {
        fs.closeSync(fd);
      }
    },
    finish() {
      feed([...buffer.push(decoder.end()), ...buffer.flush()]);
    },
    get offset() {
      return offset;
    },
  };
}

// --------------------------------------------------------------------- readers

/** Mark a job `interrupted` if its supervisor verifiably vanished. Returns the fresh status. */
export function reconcile(projectRoot, jobId) {
  const status = readStatus(projectRoot, jobId);
  if (!status || TERMINAL_STATES.has(status.state)) return status;
  if (status.supervisorPid && processMatches(status.supervisorPid, jobId)) return status;
  if (!status.supervisorPid) {
    // Not acknowledged yet: give the double fork its startup grace period, then claim the ack ourselves
    // so a very late supervisor cannot start Codex after we declare the job dead.
    const age = Date.now() - Date.parse(status.updatedAt ?? status.startedAt ?? 0);
    if (!(age >= STARTUP_ACK_MS * 2)) return status;
    if (!claimAck(jobPaths(projectRoot, jobId).dir, "reconcile")) {
      // Someone acknowledged. If it was a supervisor that is still alive, the job is fine; if that
      // supervisor died before recording its pid (or a giving-up party died before recording the failure),
      // no supervisor can ever start now, so it is safe to settle the job below.
      const ack = readAck(jobPaths(projectRoot, jobId).dir);
      const current = readStatus(projectRoot, jobId);
      if (!current || TERMINAL_STATES.has(current.state)) return current;
      if (!ack) return current; // unreadable ack: not evidence that its owner died
      if (ack?.who === "supervisor" && processMatches(ack.pid, jobId)) return current;
      if (ack && ack.who !== "supervisor" && processMatches(ack.pid, "coworker.mjs")) return current;
    }
  }
  // The supervisor is verifiably gone (or never started), so it can no longer write. Re-read: it may
  // have committed a terminal state between our first read and the liveness check — never overwrite it.
  const fresh = readStatus(projectRoot, jobId);
  if (!fresh || TERMINAL_STATES.has(fresh.state)) return fresh;
  if (fresh.supervisorPid && processMatches(fresh.supervisorPid, jobId)) return fresh;
  if (status.codexPid && processMatches(status.codexPid, jobId)) {
    for (const pid of descendants(status.codexPid)) signal(pid, "SIGKILL");
    signal(status.codexPid, "SIGKILL");
  }
  const meta = readJson(jobPaths(projectRoot, jobId).meta);
  const settled = writeStatus(projectRoot, jobId, {
    state: "interrupted",
    error: "The supervisor process disappeared before the job finished.",
    deliveryUnknown: Boolean(status.sessionId),
    finishedAt: new Date().toISOString(),
  });
  if (meta?.thread) settleThreadAfterRecovery(projectRoot, meta.thread, jobId, "interrupted");
  return settled;
}

/**
 * After a job was declared dead, fix up the thread file — but only while holding the thread lock, so a
 * newer turn's thread state is never overwritten with a stale copy. The job's terminal status (written
 * first) makes its old lock stale, so we can take it over; if a newer job holds the lock, it owns the
 * thread now and we leave the file alone.
 */
function settleThreadAfterRecovery(projectRoot, threadName, jobId, state) {
  const owner = `recover-${jobId}`;
  try {
    acquireThreadLock(projectRoot, threadName, { jobId: owner, launcherPid: process.pid }, { retryMs: 0 });
  } catch {
    return false;
  }
  try {
    const thread = readThread(projectRoot, threadName);
    if (thread?.activeJobId === jobId) clearActiveJob(projectRoot, threadName, jobId, state);
    return true;
  } finally {
    releaseThreadLock(projectRoot, threadName, owner);
  }
}

export async function cancelJob(projectRoot, jobId) {
  const paths = jobPaths(projectRoot, jobId);
  let status = reconcile(projectRoot, jobId);
  if (!status) throw new Error(`No such job: ${jobId}`);
  if (TERMINAL_STATES.has(status.state)) return { status, alreadyFinished: true };
  fs.writeFileSync(paths.cancel, new Date().toISOString());
  if (processMatches(status.supervisorPid, jobId)) signal(status.supervisorPid, "SIGTERM");
  const deadline = Date.now() + SIGINT_GRACE_MS + 8000;
  while (Date.now() < deadline) {
    status = reconcile(projectRoot, jobId);
    if (status && TERMINAL_STATES.has(status.state)) return { status };
    await sleep(250);
  }
  return { status, pending: true };
}

/**
 * Follow a job: stream progress through onProgress and resolve with the terminal status, or with
 * {state: "waiting"} once budgetMs elapses (the job keeps running in the background).
 */
export async function followJob(projectRoot, jobId, { budgetMs, onProgress = () => {}, heartbeatMs = 30000, fromOffset = 0 }) {
  const paths = jobPaths(projectRoot, jobId);
  const tail = createTail(paths.events, { onProgress, fromOffset });
  const started = Date.now();
  let lastBeat = started;
  let lastReconcile = 0;
  for (;;) {
    tail.pump();
    const now = Date.now();
    const status = now - lastReconcile >= 2000 ? reconcile(projectRoot, jobId) : readStatus(projectRoot, jobId);
    if (now - lastReconcile >= 2000) lastReconcile = now;
    if (status && TERMINAL_STATES.has(status.state)) {
      tail.pump();
      return status;
    }
    if (now - lastBeat >= heartbeatMs) {
      lastBeat = now;
      const since = status?.startedAt ? Math.round((now - Date.parse(status.startedAt)) / 1000) : Math.round((now - started) / 1000);
      onProgress(`… still working (${since}s)`);
    }
    if (now - started >= budgetMs) return { ...(status ?? {}), state: "waiting", jobState: status?.state };
    await sleep(400);
  }
}
