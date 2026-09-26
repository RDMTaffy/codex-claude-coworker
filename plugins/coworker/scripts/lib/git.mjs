// Git helpers for review targets.
//
// Every review round snapshots the working tree into a git tree object using a throwaway index
// (GIT_INDEX_FILE → `git add -A` → `git write-tree`). The user's real index is never touched. The tree
// hash then serves three purposes:
//   1. the frozen review snapshot (diff = base..tree), so Claude's later edits cannot blur what was reviewed
//   2. staleness detection (tree at start vs. tree at finish)
//   3. exact round-to-round deltas for re-reviews (git diff <prevTree> <tree>)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BUFFER = 256 * 1024 * 1024;
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // SHA-1 repos only

/** The empty tree id for this repository's object format (SHA-1 or SHA-256). */
export function emptyTree(cwd) {
  const result = git(cwd, ["hash-object", "-t", "tree", "--stdin"], { allowFail: true, input: "" });
  return result.ok && result.stdout.trim() ? result.stdout.trim() : EMPTY_TREE;
}

export function git(cwd, args, { allowFail = false, env, input } = {}) {
  // quotePath=false: keep non-ASCII paths (e.g. 한글.txt) readable instead of octal-escaped.
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function isGitRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }).stdout.trim() === "true";
}

export function repoTop(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

function headCommit(cwd) {
  const result = git(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { allowFail: true });
  return result.ok ? result.stdout.trim() : null;
}

/** Snapshot the whole working tree (tracked + untracked, honoring .gitignore) into a tree object. */
export function snapshotTree(cwd) {
  const top = repoTop(cwd);
  const indexPath = path.resolve(top, git(top, ["rev-parse", "--git-path", "index"]).stdout.trim());
  const tmpIndex = path.join(os.tmpdir(), `coworker-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    // Seeding from the real index reuses its stat cache, so `add -A` only rehashes changed files.
    if (fs.existsSync(indexPath)) {
      fs.copyFileSync(indexPath, tmpIndex);
      // Keep the original index mtime: git's racy-clean detection compares entry mtimes against it, and a
      // fresh mtime would let a same-second, same-size edit look unchanged.
      const stat = fs.statSync(indexPath);
      fs.utimesSync(tmpIndex, stat.atime, stat.mtime);
    }
    const env = { GIT_INDEX_FILE: tmpIndex, GIT_OPTIONAL_LOCKS: "0" };
    git(top, ["add", "-A", "--", "."], { env });
    return git(top, ["write-tree"], { env }).stdout.trim();
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/**
 * Resolve a review target to {mode, label, base, head, live, paths}.
 *   live = true when `head` is a working-tree snapshot (so staleness matters)
 */
export function resolveTarget(cwd, target) {
  const paths = target.paths ?? [];
  if (!isGitRepo(cwd)) {
    if (target.mode !== "paths") {
      throw new Error("Not a git repository. Use --paths <file|dir>… to review specific files instead.");
    }
    return { mode: "paths", label: `files: ${paths.join(", ")}`, base: null, head: null, live: false, paths };
  }
  if (target.mode === "paths") {
    return { mode: "paths", label: `files: ${paths.join(", ")}`, base: null, head: null, live: false, paths };
  }
  if (target.mode === "commit") {
    const sha = git(cwd, ["rev-parse", "--verify", `${target.sha}^{commit}`]).stdout.trim();
    const parent = git(cwd, ["rev-parse", "--verify", "-q", `${sha}^1`], { allowFail: true });
    return {
      mode: "commit",
      label: `commit ${sha.slice(0, 12)} vs its first parent`,
      base: parent.ok ? parent.stdout.trim() : emptyTree(cwd),
      head: sha,
      live: false,
      paths,
    };
  }
  const head = snapshotTree(cwd);
  if (target.mode === "base") {
    const mergeBase = git(cwd, ["merge-base", "HEAD", target.ref], { allowFail: true });
    if (!mergeBase.ok) throw new Error(`Cannot find a merge-base between HEAD and "${target.ref}".`);
    const base = mergeBase.stdout.trim();
    return {
      mode: "base",
      label: `everything since ${target.ref} (merge-base ${base.slice(0, 12)}): commits + uncommitted + untracked`,
      base,
      head,
      live: true,
      paths,
    };
  }
  const commit = headCommit(cwd);
  return {
    mode: "uncommitted",
    label: "uncommitted changes vs HEAD (staged + unstaged + untracked)",
    base: commit ?? emptyTree(cwd),
    head,
    live: true,
    paths,
  };
}

export function diffBetween(cwd, base, head, paths = []) {
  const args = ["diff", "--no-color", "--no-ext-diff", "-M", base, head];
  if (paths.length) args.push("--", ...paths);
  return git(cwd, args).stdout;
}

export function diffStat(cwd, base, head, paths = []) {
  const args = ["diff", "--no-color", "--stat=200", "-M", base, head];
  if (paths.length) args.push("--", ...paths);
  return git(cwd, args).stdout;
}

export function changedFiles(cwd, base, head, paths = []) {
  // -z: raw NUL-separated names (quotePath=false still C-quotes names containing " or \).
  const args = ["diff", "--name-only", "-z", "-M", base, head];
  if (paths.length) args.push("--", ...paths);
  return git(cwd, args).stdout.split("\0").filter(Boolean);
}
