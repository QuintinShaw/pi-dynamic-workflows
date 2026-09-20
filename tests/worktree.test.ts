import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("createWorktree gives repeated long names independent retained worktrees", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-retained-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    // These names intentionally share the complete 32-character slug prefix.
    const name = "same-run-id-with-a-very-long-label-that-would-previously-collide";
    const first = await createWorktreeLive(repo, name);
    assert.equal(first.isolated, true);
    writeFileSync(join(first.cwd, "retained.txt"), "first execution\n");

    const second = await createWorktreeLive(repo, name);
    assert.equal(second.isolated, true);
    assert.notEqual(second.cwd, first.cwd, "a later execution must not reuse a retained worktree");
    assert.notEqual(second.branch, first.branch, "a later execution owns a distinct branch");
    assert.equal(readFileSync(join(first.cwd, "retained.txt"), "utf8"), "first execution\n");
    assert.equal(
      existsSync(join(second.cwd, "retained.txt")),
      false,
      "later worktree starts from base, not retained edits",
    );
    assert.equal(existsSync(join(repo, "retained.txt")), false, "retained edits never reach the base checkout");

    await removeWorktree(second);
    await removeWorktree(first);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree preserves the branch when a locked worktree cannot be removed", async () => {
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

    git("worktree", "lock", "--reason", "test lock", wt.cwd);
    await assert.doesNotReject(removeWorktree(wt));
    assert.ok(existsSync(wt.cwd), "a locked worktree remains inspectable after failed cleanup");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.notEqual(branches.trim(), "", "failed worktree removal must not delete its branch");

    git("worktree", "unlock", wt.cwd);
    await removeWorktree(wt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a hung git is bounded by the exec timeout (audit2 #21)", async () => {
  // A fake `git` that sleeps forever: createWorktree must fail fast instead of
  // blocking agent spawn indefinitely.
  const shimDir = mkdtempSync(join(tmpdir(), "pi-wt-shim-"));
  const shimPath = join(shimDir, process.platform === "win32" ? "git.cmd" : "git");
  writeFileSync(shimPath, "#!/bin/sh\nsleep 600\n");
  execFileSync("chmod", ["+x", shimPath]);
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-hang-"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath}`;
  try {
    const started = Date.now();
    const wt = await createWorktreeLive(repo, "run-hang-0-task", { timeoutMs: 150 });
    const elapsed = Date.now() - started;
    assert.equal(wt.isolated, false, "the timed-out git fails the worktree (falls back to base cwd)");
    assert.ok(elapsed < 10_000, `bounded (took ${elapsed}ms, not the default 30s or forever)`);
  } finally {
    process.env.PATH = originalPath;
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a timed-out worktree add cleans up only its half-created branch, tree, and registration (audit2 #21 r1)", async () => {
  // Real git repo, but a PATH shim that sleeps ONLY on `worktree add`:
  // rev-parse/branch -D/remove delegate to the real git.
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimDir = mkdtempSync(join(tmpdir(), "pi-wt-shim2-"));
  const shimPath = join(shimDir, "git");
  const commandLog = join(shimDir, "git-commands.log");
  const fixtureReady = join(shimDir, "fixture-ready");
  const fixtureRegistrations = join(shimDir, "fixture-registrations");
  const fixtureBranches = join(shimDir, "fixture-branches");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-add-hang-")));
  const staleWorktree = join(repo, "unrelated-missing-worktree");
  // The shim must leave REAL residue behind (r2: a pure-sleep shim made the
  // cleanup assertions vacuous): run the real `worktree add`, THEN hang so
  // the timeout kills us — the branch and tree exist when cleanup runs. It also
  // creates an unrelated missing worktree registration AFTER the target add;
  // this proves cleanup does not use global `git worktree prune`.
  writeFileSync(
    shimPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${commandLog}"\ncase "$*" in\n  *"worktree add"*)\n    "${realGit}" "$@"\n    "${realGit}" -C "$2" worktree add -b unrelated-stale "${staleWorktree}" HEAD\n    rm -rf "${staleWorktree}"\n    "${realGit}" -C "$2" worktree list --porcelain > "${fixtureRegistrations}"\n    "${realGit}" -C "$2" branch --list unrelated-stale > "${fixtureBranches}"\n    printf 'ready\\n' > "${fixtureReady}"\n    sleep 600\n    ;;\n  *) exec "${realGit}" "$@" ;;\nesac\n`,
  );
  execFileSync("chmod", ["+x", shimPath]);

  const git = (...args: string[]) =>
    execFileSync(realGit, ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const originalPath = process.env.PATH;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "init");

    process.env.PATH = `${shimDir}:${originalPath}`;
    const started = Date.now();
    // 2s is comfortably above the tiny repo's real `worktree add` (r3: 200ms
    // raced it — under load the add was killed before registering, making the
    // cleanup assertions vacuous again).
    const wt = await createWorktreeLive(repo, "run-addhang-0-task", { timeoutMs: 2_000 });
    const elapsed = Date.now() - started;
    process.env.PATH = originalPath;

    assert.equal(wt.isolated, false);
    assert.match(wt.reason ?? "", /timed out/, "an honest timeout reason, not 'not a git repository'");
    assert.ok(elapsed < 15_000, `bounded (took ${elapsed}ms)`);
    assert.equal(
      readFileSync(fixtureReady, "utf8"),
      "ready\n",
      "the wrapper created its unrelated stale fixture before timeout cleanup",
    );
    assert.ok(
      readFileSync(fixtureRegistrations, "utf8").includes(`worktree ${staleWorktree}`),
      "the unrelated missing registration existed before target cleanup",
    );
    assert.notEqual(
      readFileSync(fixtureBranches, "utf8").trim(),
      "",
      "the unrelated stale branch existed before target cleanup",
    );
    const commands = readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(
      !commands.some((command) => command.includes("worktree prune")),
      "cleanup never runs global worktree prune",
    );
    const cleanupRemovals = commands.filter((command) => command.includes("worktree remove --force"));
    assert.equal(cleanupRemovals.length, 2, "cleanup retries removal only for its known path after rm");
    const cleanupPaths = cleanupRemovals.map((command) => command.split(" ").at(-1));
    assert.equal(new Set(cleanupPaths).size, 1, "both cleanup removals target the same generated worktree");
    assert.notEqual(cleanupPaths[0], staleWorktree, "cleanup never targets the unrelated registration");
    const branches = git("branch", "--list", "pi/wf/*");
    assert.equal(branches.trim(), "", "the half-created branch was cleaned up");
    const worktreesDir = join(repo, ".pi", "worktrees");
    assert.ok(!existsSync(worktreesDir) || readdirSync(worktreesDir).length === 0, "no partial checkout left behind");
    const registrations = git("worktree", "list", "--porcelain");
    assert.equal(
      registrations.includes(`worktree ${cleanupPaths[0]}`),
      false,
      "no target worktree registration remains",
    );
    assert.ok(
      registrations.includes(`worktree ${staleWorktree}`),
      "unrelated missing registration survives target cleanup",
    );
    assert.notEqual(git("branch", "--list", "unrelated-stale").trim(), "", "unrelated stale branch survives too");
  } finally {
    process.env.PATH = originalPath;
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
