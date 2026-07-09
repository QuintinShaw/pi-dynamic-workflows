import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorktree as createWorktreeLive, removeWorktree } from "../src/worktree.js";

// ── Existing tests (unchanged) ──

test("createWorktree no-ops (not isolated) outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-nogit-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.match(wt.reason ?? "", /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorktree isolates in a git repo, then removeWorktree cleans up", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-9-0-edit");
    assert.equal(wt.isolated, true);
    assert.ok(wt.cwd !== repo && existsSync(wt.cwd), "worktree dir exists");
    assert.ok(existsSync(join(wt.cwd, "file.txt")), "worktree has a checkout");

    // Editing inside the worktree must not touch the base tree.
    writeFileSync(join(wt.cwd, "file.txt"), "changed in worktree\n");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.equal(branches.trim(), "", "branch deleted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── NEW TESTS ──

test("createWorktree falls back when git fails (non-git directory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-noexec-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");

    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.ok(wt.reason, "should provide a fallback reason when git fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when worktree directory is already missing", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-missing-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-missing-dir");
    assert.equal(wt.isolated, true);

    // Remove the worktree directory so git worktree remove --force fails
    rmSync(wt.cwd, { recursive: true, force: true });
    assert.ok(!existsSync(wt.cwd), "worktree dir removed manually before removeWorktree");

    // removeWorktree must not throw despite git commands failing
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree falls back when target branch already exists", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-conflict-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    // Pre-create the branch that createWorktree will try to create.
    // slug("conflict-branch") → "conflict-branch"
    const name = "conflict-branch";
    git("branch", "pi/wf/conflict-branch");

    // createWorktree should fail: git worktree add -b <existing-branch> errors out
    const wt = await createWorktreeLive(repo, name);
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, repo);
    assert.ok(
      /pi\/wf\/conflict-branch|conflict-branch/i.test(wt.reason ?? ""),
      `Expected branch conflict error, got: ${wt.reason}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when git operations fail (corrupted metadata)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-failrm-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-fail-rm");
    assert.equal(wt.isolated, true);

    // Remove worktree dir so git worktree remove fails
    rmSync(wt.cwd, { recursive: true, force: true });

    // Corrupt git worktree metadata so git worktree remove --force also fails
    const branchSuffix = wt.branch?.replace("pi/wf/", "") ?? "";
    const worktreeMeta = join(repo, ".git", "worktrees", branchSuffix);
    if (existsSync(worktreeMeta)) {
      writeFileSync(join(worktreeMeta, "gitdir"), "/nonexistent/path\n");
    }

    // Both git operations should fail silently — no throw from removeWorktree
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
