import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  activeCheckoutProofsForTesting,
  createWorktree as createWorktreeLive,
  createWorktreeOperationsForTesting,
  DEFAULT_WORKTREE_OPERATIONS,
  populateCleanedWorktreeCacheForTesting,
  RetainedWorktreeRegistry,
  removeWorktree,
  type Worktree,
} from "../src/worktree.js";

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

function gitCommonRoot(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
}

function checkoutQuarantineRoot(repo: string): string {
  return join(gitCommonRoot(repo), "pi-dynamic-workflows-checkout-cleanup");
}

function directCleanupClaimPaths(repo: string, kind: "checkout" | "registration"): string[] {
  const commonRoot = gitCommonRoot(repo);
  const prefix = `.pi-dynamic-workflows-${kind}-cleanup-`;
  return readdirSync(commonRoot)
    .filter((entry) => entry.startsWith(prefix) && !entry.endsWith(".json"))
    .map((entry) => join(commonRoot, entry));
}

function directCleanupPendingRecords(repo: string): string[] {
  return readdirSync(gitCommonRoot(repo)).filter((entry) =>
    /^\.pi-dynamic-workflows-(?:checkout|registration)-cleanup-.*\.json$/.test(entry),
  );
}

function operationLockRoot(repo: string): string {
  return join(gitCommonRoot(repo), "pi-dynamic-workflows-operation-lock");
}

function operationLockUniquePath(repo: string, token: string): string {
  return join(gitCommonRoot(repo), `.pi-dynamic-workflows-operation-lock-owner-${token}`);
}

function installOperationLock(
  repo: string,
  owner: { version: 1; token: string; pid: number; createdAtMs: number },
): string {
  const uniquePath = operationLockUniquePath(repo, owner.token);
  writeFileSync(uniquePath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  linkSync(uniquePath, operationLockRoot(repo));
  return uniquePath;
}

function excludePath(repo: string): string {
  return join(gitCommonRoot(repo), "info", "exclude");
}

function isGitIgnored(repo: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "check-ignore", "--quiet", "--no-index", path], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function sentinelExcludeBlock(proof: { fileName: string; token: string; excludeLeadingNewline?: boolean }): string {
  const ownership = createHash("sha256").update(`${proof.fileName}\0${proof.token}`).digest("hex");
  return `${proof.excludeLeadingNewline ? "\n" : ""}# pi-dynamic-workflows-owned-sentinel:${ownership}\n/${proof.fileName}\n`;
}

function runCleanupWorker(
  repo: string,
  name: string,
  probeRoot: string,
  mode: "same-repo" | "different-repo" | "stale-race",
): Promise<void> {
  return new Promise<void>((resolveWorker, rejectWorker) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL("./fixtures/worktree-cleanup-worker.ts", import.meta.url).pathname,
        repo,
        name,
        probeRoot,
        mode,
      ],
      { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectWorker);
    child.once("exit", (code) => {
      if (code === 0) resolveWorker();
      else rejectWorker(new Error(`cleanup worker exited ${code}: ${stdout}${stderr}`));
    });
  });
}

function assertCleanupQuarantinesEmpty(repo: string): void {
  const commonRoot = gitCommonRoot(repo);
  for (const root of [
    join(commonRoot, "pi-dynamic-workflows-checkout-cleanup"),
    join(commonRoot, "pi-dynamic-workflows-cleanup"),
  ]) {
    if (existsSync(root)) assert.deepEqual(readdirSync(root), [], `${root} has no per-cleanup leftovers`);
  }
  assert.deepEqual(
    readdirSync(commonRoot).filter((entry) => /^\.pi-dynamic-workflows-(?:checkout|registration)-cleanup-/.test(entry)),
    [],
    "no direct-child cleanup claims or pending records remain",
  );
}

function assertNoCreationArtifacts(repo: string): void {
  const commonRoot = gitCommonRoot(repo);
  assert.deepEqual(
    readdirSync(commonRoot).filter((entry) => entry.startsWith("pi-workflow-checkout-")),
    [],
    "no runtime checkout direct child remains",
  );
  assert.equal(
    execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length,
    1,
    "no linked worktree registration remains",
  );
  assert.equal(
    execFileSync("git", ["-C", repo, "branch", "--list", "pi/wf/*"], { encoding: "utf8" }).trim(),
    "",
    "no temporary branch remains",
  );
  assert.equal(
    execFileSync("git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup/"], {
      encoding: "utf8",
    }).trim(),
    "",
    "no internal cleanup ref remains",
  );
  assertCleanupQuarantinesEmpty(repo);
}

function supportsSha256Repositories(): boolean {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-sha256-capability-"));
  try {
    execFileSync("git", ["init", "-q", "--object-format=sha256", repo], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const SHA256_REPOSITORIES_SUPPORTED = supportsSha256Repositories();

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
    assert.equal(join(wt.cwd, ".."), gitCommonRoot(repo), "the checkout is a direct Git-common-dir child");
    assert.match(wt.cwd, /pi-workflow-checkout-/);
    assert.equal(wt.repoRoot, repo, "canonical repository root is retained");
    assert.equal(wt.branchRef, `refs/heads/${wt.branch}`, "full temporary branch ref is retained");
    assert.equal(
      wt.baseSha,
      execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      "exact base SHA is retained",
    );
    assert.equal(wt.cleanupMetadata?.version, 4);
    const createdIdentity = lstatSync(wt.cwd, { bigint: true });
    assert.deepEqual(wt.cleanupMetadata?.checkoutIdentity, {
      dev: createdIdentity.dev.toString(10),
      ino: createdIdentity.ino.toString(10),
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(wt.cleanupMetadata?.gitDir ?? "", "pi-dynamic-workflows-registration"), "utf8")),
      wt.cleanupMetadata,
      "the per-worktree Git metadata stores the complete versioned cleanup identity",
    );

    // Agents may commit after creation; cleanup verifies stable registration
    // identity rather than comparing mutable HEAD with the creation SHA.
    writeFileSync(join(wt.cwd, "file.txt"), "changed in worktree\n");
    execFileSync("git", ["-C", wt.cwd, "add", "."]);
    execFileSync("git", ["-C", wt.cwd, "commit", "-q", "-m", "agent commit"]);
    assert.notEqual(execFileSync("git", ["-C", wt.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), wt.baseSha);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

    await removeWorktree(wt);
    assert.deepEqual(
      await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(wt),
      [],
      "repeated cleanup is an idempotent no-op",
    );
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.equal(branches.trim(), "", "branch deleted");
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── NEW TESTS ──

test("current checkout descriptors stay open across cleanup retries and close on terminal paths", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-proof-lifecycle-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const baseline = activeCheckoutProofsForTesting().descriptorCount;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const current = await createWorktreeLive(repo, "descriptor-retry");
    assert.equal(current.isolated, true);
    assert.equal(activeCheckoutProofsForTesting().descriptorCount, baseline + 1);

    const failed = await createWorktreeOperationsForTesting({
      afterIdentityVerification() {
        throw new Error("injected retryable verification failure");
      },
    }).removeWorktree(current);
    assert.equal(failed.length, 1);
    assert.equal(activeCheckoutProofsForTesting().descriptorCount, baseline + 1, "retry retains the original fd");

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(current), []);
    assert.equal(activeCheckoutProofsForTesting().descriptorCount, baseline, "successful retry closes the fd");

    const retained = await createWorktreeLive(repo, "retained-release");
    assert.equal(retained.isolated, true);
    const registry = new RetainedWorktreeRegistry();
    const handle = registry.register(retained);
    assert.equal(activeCheckoutProofsForTesting().descriptorCount, baseline + 1);
    await registry.release(handle);
    assert.equal(activeCheckoutProofsForTesting().descriptorCount, baseline, "retained release closes the fd");

    const fallback = await createWorktreeLive(repo, "creation-fallback", {
      afterBranchCreationBeforeGitAdd() {
        throw new Error("injected creation fallback");
      },
    });
    assert.equal(fallback.isolated, false);
    assert.equal(activeCheckoutProofsForTesting().descriptorCount, baseline, "creation fallback leaks no fd");
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("allocation descriptors remain live through replacement-safe allocation and branch rollback", async (t) => {
  for (const stage of ["unsafe-allocation", "branch-create"] as const) {
    await t.test(stage, async () => {
      const repo = mkdtempSync(join(tmpdir(), `pi-wt-allocation-rollback-${stage}-`));
      const baseline = activeCheckoutProofsForTesting();
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      let checkoutPath = "";
      let displacedPath = "";
      const replaceCheckout = () => {
        assert.equal(
          activeCheckoutProofsForTesting().allocationDescriptorCount,
          baseline.allocationDescriptorCount + 1,
          "the allocated inode remains descriptor-bound before rollback",
        );
        displacedPath = `${checkoutPath}-displaced`;
        renameSync(checkoutPath, displacedPath);
        mkdirSync(checkoutPath);
        writeFileSync(join(checkoutPath, "replacement-sentinel.txt"), `${stage} replacement survives\n`);
      };

      try {
        git("init", "-q");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(repo, "file.txt"), "base\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");

        const result = await createWorktreeLive(repo, `allocation-rollback-${stage}`, {
          simulateReusedAllocationPathIdentity: true,
          afterAtomicDirectoryCreation(_gitCommonRoot, path) {
            checkoutPath = path;
            if (stage === "unsafe-allocation") replaceCheckout();
          },
          async execGit(args) {
            if (stage === "branch-create" && args.includes("update-ref")) {
              replaceCheckout();
              throw new Error("injected branch creation failure after replacement");
            }
            return { stdout: execFileSync("git", args, { encoding: "utf8" }) };
          },
        } as Parameters<typeof createWorktreeLive>[2] & {
          simulateReusedAllocationPathIdentity: boolean;
        });

        assert.equal(result.isolated, false);
        assert.match(result.reason ?? "", stage === "unsafe-allocation" ? /unsafe_allocation/ : /branch_create/);
        assert.equal(result.recoveryFailures?.length, 1, "replacement rollback emits one bounded recovery record");
        assert.equal(result.recoveryFailures?.[0]?.stage, "worktree_remove");
        assert.ok((result.recoveryFailures?.[0]?.message.length ?? Infinity) <= 1024);
        assert.equal(
          readFileSync(join(checkoutPath, "replacement-sentinel.txt"), "utf8"),
          `${stage} replacement survives\n`,
        );
        assert.equal(
          existsSync(displacedPath),
          true,
          "descriptor-owned displaced state is never confused with replacement",
        );
        assert.deepEqual(
          activeCheckoutProofsForTesting(),
          baseline,
          "terminal fallback closes the allocation descriptor",
        );
      } finally {
        if (checkoutPath) rmSync(checkoutPath, { recursive: true, force: true });
        if (displacedPath) rmSync(displacedPath, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

test("portable finalization retains the allocation descriptor until rollback completes", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-portable-finalization-fd-"));
  const baseline = activeCheckoutProofsForTesting();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let observedDuringFinalization = 0;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const result = await createWorktreeLive(repo, "portable-finalization-fd", {
      directoryDescriptorMode: "unsupported",
      beforeRegistrationRecordWrite() {
        observedDuringFinalization = activeCheckoutProofsForTesting().allocationDescriptorCount;
        throw new Error("injected portable finalization failure");
      },
    } as never);

    assert.equal(result.isolated, false);
    assert.equal(
      observedDuringFinalization,
      baseline.allocationDescriptorCount + 1,
      "portable proof creation does not close the allocation descriptor before finalization can fail",
    );
    assert.deepEqual(
      activeCheckoutProofsForTesting(),
      baseline,
      "successful rollback closes every creation descriptor",
    );
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("current Git registration descriptors reject replacement directories and close only after successful retry", async (t) => {
  for (const replacement of ["directory", "symlink", "inode-reuse"] as const) {
    await t.test(replacement, async () => {
      const repo = mkdtempSync(join(tmpdir(), `pi-wt-gitdir-proof-${replacement}-`));
      const external = mkdtempSync(join(tmpdir(), `pi-wt-gitdir-proof-${replacement}-external-`));
      const baseline = activeCheckoutProofsForTesting();
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      try {
        git("init", "-q");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(repo, "file.txt"), "base\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");

        const worktree = await createWorktreeLive(repo, `gitdir-proof-${replacement}`);
        if (worktree.cleanupMetadata?.version !== 4) throw new Error("expected current cleanup metadata");
        const gitDir = worktree.cleanupMetadata.gitDir;
        const originalIdentity = lstatSync(gitDir, { bigint: true });
        assert.deepEqual(worktree.cleanupMetadata.gitDirIdentity, {
          dev: originalIdentity.dev.toString(10),
          ino: originalIdentity.ino.toString(10),
        });
        const displaced = `${gitDir}-displaced`;
        renameSync(gitDir, displaced);
        if (replacement === "symlink") {
          const copied = join(external, "copied-registration");
          cpSync(displaced, copied, { recursive: true });
          writeFileSync(join(copied, "replacement.txt"), "symlink replacement survives\n");
          symlinkSync(copied, gitDir, "dir");
        } else {
          cpSync(displaced, gitDir, { recursive: true });
          writeFileSync(join(gitDir, "replacement.txt"), `${replacement} replacement survives\n`);
        }

        const failures = await createWorktreeOperationsForTesting({
          simulateReusedGitDirIdentity: replacement === "inode-reuse",
        } as never).removeWorktree(worktree);
        assert.equal(failures.length, 1);
        assert.equal(failures[0]?.stage, "identity_verification");
        assert.equal(existsSync(worktree.cwd), true, "checkout remains untouched");
        assert.match(git("branch", "--list", worktree.branch ?? ""), /gitdir-proof/);
        assert.equal(
          readFileSync(join(gitDir, "replacement.txt"), "utf8"),
          `${replacement === "symlink" ? "symlink" : replacement} replacement survives\n`,
        );
        assert.equal(activeCheckoutProofsForTesting().gitDirDescriptorCount, baseline.gitDirDescriptorCount + 1);

        rmSync(gitDir, { recursive: true, force: true });
        renameSync(displaced, gitDir);
        assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
        assert.deepEqual(activeCheckoutProofsForTesting(), baseline, "terminal cleanup closes every identity fd");
      } finally {
        rmSync(external, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

test("portable exclude descriptors reject deletion, replacement, symlink, and simulated inode reuse", async (t) => {
  for (const replacement of ["deleted", "file", "symlink", "inode-reuse"] as const) {
    await t.test(replacement, async () => {
      const repo = mkdtempSync(join(tmpdir(), `pi-wt-exclude-proof-${replacement}-`));
      const external = mkdtempSync(join(tmpdir(), `pi-wt-exclude-proof-${replacement}-external-`));
      const baseline = activeCheckoutProofsForTesting();
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      try {
        git("init", "-q");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(repo, "file.txt"), "base\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");
        writeFileSync(excludePath(repo), "# caller rule\n*.keep\n");

        const worktree = await createWorktreeLive(repo, `exclude-proof-${replacement}`, {
          directoryDescriptorMode: "unsupported",
        } as never);
        if (worktree.cleanupMetadata?.version !== 4 || worktree.cleanupMetadata.checkoutProof.kind !== "sentinel") {
          throw new Error("expected portable sentinel proof");
        }
        const proof = worktree.cleanupMetadata.checkoutProof;
        const originalStats = lstatSync(excludePath(repo), { bigint: true });
        assert.deepEqual(proof.excludeIdentity, {
          dev: originalStats.dev.toString(10),
          ino: originalStats.ino.toString(10),
        });
        const pristine = readFileSync(excludePath(repo), "utf8");
        const displaced = `${excludePath(repo)}-displaced`;
        renameSync(excludePath(repo), displaced);
        let replacementContents: string | undefined;
        if (replacement === "symlink") {
          const target = join(external, "exclude");
          replacementContents = `${pristine}# symlink replacement survives\n`;
          writeFileSync(target, replacementContents);
          symlinkSync(target, excludePath(repo));
        } else if (replacement !== "deleted") {
          replacementContents = `${pristine}# ${replacement} replacement survives\n`;
          writeFileSync(excludePath(repo), replacementContents);
        }

        const failures = await createWorktreeOperationsForTesting({
          simulateReusedExcludeIdentity: replacement === "inode-reuse",
        } as never).removeWorktree(worktree);
        assert.equal(failures.length, 1);
        assert.equal(failures[0]?.stage, "identity_verification");
        assert.equal(existsSync(worktree.cwd), true, "exclude mismatch stops before checkout claim");
        assert.match(git("branch", "--list", worktree.branch ?? ""), /exclude-proof/);
        if (replacementContents === undefined) {
          assert.equal(existsSync(excludePath(repo)), false, "cleanup never recreates a deleted exclude file");
        } else {
          assert.equal(readFileSync(excludePath(repo), "utf8"), replacementContents);
        }
        assert.equal(
          activeCheckoutProofsForTesting().excludeDescriptorCount,
          baseline.excludeDescriptorCount + 1,
          "retry retains the original exclude fd",
        );

        rmSync(excludePath(repo), { force: true });
        renameSync(displaced, excludePath(repo));
        assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
        assert.equal(readFileSync(excludePath(repo), "utf8").includes(proof.fileName), false);
        assert.deepEqual(activeCheckoutProofsForTesting(), baseline, "successful retry closes portable proof fds");
      } finally {
        rmSync(external, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

test("durable checkout proof rejects simulated inode reuse and preserves replacement contents", async () => {
  for (const mode of ["descriptor", "sentinel"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-proof-reuse-${mode}-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      const original = await createWorktreeLive(
        repo,
        `proof-reuse-${mode}`,
        (mode === "sentinel" ? { directoryDescriptorMode: "unsupported" } : {}) as never,
      );
      assert.equal(original.isolated, true);
      assert.equal(
        execFileSync("git", ["-C", original.cwd, "status", "--porcelain", "--untracked-files=all"], {
          encoding: "utf8",
        }).trim(),
        "",
      );
      const displaced = `${original.cwd}-displaced`;
      const gitPointer = readFileSync(join(original.cwd, ".git"), "utf8");
      renameSync(original.cwd, displaced);
      mkdirSync(original.cwd);
      writeFileSync(join(original.cwd, ".git"), gitPointer);
      writeFileSync(join(original.cwd, "replacement.txt"), `${mode} replacement survives\n`);

      const failures = await createWorktreeOperationsForTesting({
        simulateReusedCheckoutIdentity: true,
      } as never).removeWorktree(original);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.stage, "identity_verification");
      assert.equal(readFileSync(join(original.cwd, "replacement.txt"), "utf8"), `${mode} replacement survives\n`);

      rmSync(original.cwd, { recursive: true, force: true });
      renameSync(displaced, original.cwd);
      assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(original), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("ordinary and retained checkout paths never enter the main worktree status namespace", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-status-namespace-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const created: Worktree[] = [];
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    created.push(await createWorktreeLive(repo, "ordinary-status"));
    created.push(await createWorktreeLive(repo, "retained-status"));
    for (const worktree of created) {
      assert.equal(worktree.isolated, true, worktree.reason);
      assert.equal(join(worktree.cwd, ".."), gitCommonRoot(repo));
      assert.match(worktree.cwd, /pi-workflow-checkout-/);
    }

    assert.equal(git("status", "--porcelain"), "", "runtime checkouts are invisible to status");
    git("add", "-A");
    assert.equal(git("diff", "--cached", "--name-only"), "", "git add -A cannot stage a checkout gitlink");

    await Promise.all(created.map((worktree) => removeWorktree(worktree)));
    assertNoCreationArtifacts(repo);
  } finally {
    await Promise.all(created.filter((worktree) => worktree.isolated).map((worktree) => removeWorktree(worktree)));
    rmSync(repo, { recursive: true, force: true });
  }
});

test("creation uses the canonical common directory when invoked from a linked main checkout", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-linked-main-"));
  const linked = mkdtempSync(join(tmpdir(), "pi-wt-linked-source-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let worktree: Worktree | undefined;
  let linkedRegistered = false;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    rmSync(linked, { recursive: true });
    git("worktree", "add", "-q", "-b", "linked-main", linked, "HEAD");
    linkedRegistered = true;

    worktree = await createWorktreeLive(linked, "linked-main-runtime");

    assert.equal(worktree.isolated, true, worktree.reason);
    assert.equal(worktree.repoRoot, realpathSync(linked));
    assert.equal(join(worktree.cwd, ".."), gitCommonRoot(repo));
    assert.equal(worktree.cleanupMetadata?.gitCommonRoot, gitCommonRoot(repo));
    assert.equal(execFileSync("git", ["-C", linked, "status", "--porcelain"], { encoding: "utf8" }), "");

    await removeWorktree(worktree);
    worktree = undefined;
    git("worktree", "remove", "--force", linked);
    linkedRegistered = false;
    git("branch", "-D", "linked-main");
    assertNoCreationArtifacts(repo);
  } finally {
    if (worktree?.isolated) await removeWorktree(worktree);
    if (linkedRegistered) {
      try {
        git("worktree", "remove", "--force", linked);
        git("branch", "-D", "linked-main");
      } catch {
        // Best-effort fixture cleanup.
      }
    }
    rmSync(linked, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("descriptor-unavailable failed git worktree add rolls back branch-only, registered, and nonempty partial states", async () => {
  for (const partialState of ["branch-only", "registered", "nonempty"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-add-failure-${partialState}-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      const worktree = await createWorktreeLive(repo, `partial-${partialState}`, {
        directoryDescriptorMode: "unsupported",
        async execGit(args) {
          if (args.includes("worktree") && args.includes("add")) {
            if (partialState === "registered") {
              execFileSync("git", [...args.slice(0, -1), "--no-checkout", args.at(-1) ?? ""], { stdio: "pipe" });
            } else if (partialState === "nonempty") {
              execFileSync("git", args, { stdio: "pipe" });
              const checkoutPath = args.at(-2) ?? "";
              writeFileSync(join(checkoutPath, "partial-untracked.txt"), "partial contents\n");
            }
            throw new Error(`injected git worktree add failure after ${partialState}`);
          }
          return { stdout: execFileSync("git", args, { encoding: "utf8" }) };
        },
      });

      assert.equal(worktree.isolated, false);
      assert.match(worktree.reason ?? "", /git_add/);
      assert.deepEqual(worktree.recoveryFailures, undefined, "successful rollback preserves ordinary fallback");
      assertNoCreationArtifacts(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("failed git worktree add preserves a temporary branch advanced from its expected start OID", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-add-failure-advanced-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const branchRef = "refs/heads/pi/wf/partial-advanced-branch";
  let checkoutPath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const baseSha = git("rev-parse", "HEAD").trim();

    const worktree = await createWorktreeLive(repo, "partial-advanced-branch", {
      async execGit(args) {
        if (args.includes("worktree") && args.includes("add")) {
          execFileSync("git", args, { stdio: "pipe" });
          checkoutPath = args.at(-2) ?? "";
          const advancedOid = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "advanced during failure").trim();
          git("update-ref", branchRef, advancedOid, baseSha);
          throw new Error("injected git worktree add failure after branch advance");
        }
        return { stdout: execFileSync("git", args, { encoding: "utf8" }) };
      },
    });

    assert.equal(worktree.isolated, false);
    assert.equal(worktree.recoveryFailures?.length, 1);
    assert.match(worktree.recoveryFailures?.[0]?.message ?? "", /cleanup failed.*cleanup_dispatch.*recovery ID/i);
    assert.match(worktree.recoveryFailures?.[0]?.identity.recoveryId ?? "", /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(worktree.recoveryFailures).includes(checkoutPath), false);
    assert.equal(existsSync(checkoutPath), true, "the checkout is preserved when branch ownership changed");
    assert.notEqual(git("rev-parse", branchRef).trim(), baseSha);
  } finally {
    if (checkoutPath && existsSync(checkoutPath)) {
      try {
        git("worktree", "remove", "--force", checkoutPath);
      } catch {
        // Best-effort fixture cleanup.
      }
    }
    try {
      git("update-ref", "-d", branchRef);
    } catch {
      // Best-effort fixture cleanup.
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("creation finalization preserves an advanced temporary branch while removing only owned runtime artifacts", async () => {
  for (const advancement of ["post-hook", "concurrent"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-finalization-advanced-${advancement}-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    const branchRef = `refs/heads/pi/wf/finalization-${advancement}`;
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      const baseSha = git("rev-parse", "HEAD").trim();
      let advancedOid = "";

      const worktree = await createWorktreeLive(repo, `finalization-${advancement}`, {
        async afterRegistrationRecordWrite() {
          advancedOid = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", advancement).trim();
          git("update-ref", branchRef, advancedOid, baseSha);
          if (advancement === "concurrent") await new Promise<void>((resolve) => setImmediate(resolve));
        },
      });

      assert.equal(worktree.isolated, false);
      assert.equal(git("rev-parse", branchRef).trim(), advancedOid, "the advanced commit remains reachable");
      assert.deepEqual(
        readdirSync(gitCommonRoot(repo)).filter((entry) => entry.startsWith("pi-workflow-checkout-")),
        [],
        "only the exact runtime checkout and registration are rolled back",
      );
      assert.equal(
        git("worktree", "list", "--porcelain")
          .split("\n")
          .filter((line) => line.startsWith("worktree ")).length,
        1,
      );
      assert.equal(
        worktree.creationRecoveryWorktree,
        undefined,
        "advanced refs never receive normal terminal cleanup authority",
      );
      assert.equal(worktree.recoveryFailures?.length, 1);
      assert.equal(worktree.recoveryFailures?.[0]?.stage, "branch_delete");
      assert.ok((worktree.recoveryFailures?.[0]?.message.length ?? Infinity) <= 1024);
    } finally {
      try {
        git("update-ref", "-d", branchRef);
      } catch {
        // Best-effort fixture cleanup.
      }
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("creation recovery keeps exact branch authorization across a concurrent rollback advance", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-creation-recovery-advance-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const branchRef = "refs/heads/pi/wf/creation-recovery-advance";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const baseSha = git("rev-parse", "HEAD").trim();
    let advancedOid = "";
    let advanced = false;
    const result = await createWorktreeLive(repo, "creation-recovery-advance", {
      afterRegistrationRecordWrite() {
        throw new Error("force creation rollback");
      },
      creationCleanupHooks: {
        afterIdentityVerification() {
          if (advanced) return;
          advanced = true;
          advancedOid = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "concurrent advance").trim();
          git("update-ref", branchRef, advancedOid, baseSha);
        },
      },
    });

    assert.equal(result.isolated, false);
    assert.ok(result.creationRecoveryWorktree, "the interrupted rollback retains exact recovery authority");
    const retryFailures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(result.creationRecoveryWorktree as Worktree);
    assert.equal(retryFailures.length, 1);
    assert.equal(retryFailures[0]?.stage, "branch_delete");
    assert.equal(git("rev-parse", branchRef).trim(), advancedOid);
    assert.equal(
      git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
  } finally {
    try {
      git("update-ref", "-d", branchRef);
    } catch {
      // Best-effort fixture cleanup.
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("descriptor-relative proof writes never follow replaced checkout or registration parents", async () => {
  for (const target of ["checkout", "registration"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-proof-parent-race-${target}-`));
    const external = mkdtempSync(join(tmpdir(), `pi-wt-proof-parent-race-${target}-external-`));
    let displaced = "";
    try {
      execFileSync("git", ["-C", repo, "init", "-q"]);
      execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
      writeFileSync(join(repo, "file.txt"), "base\n");
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const result = await createWorktreeLive(repo, `proof-parent-race-${target}`, {
        ...(target === "checkout" ? { directoryDescriptorMode: "unsupported" as const } : {}),
        async beforeDescriptorRelativeWrite(kind, path) {
          if (kind !== target || displaced) return;
          displaced = `${path}-displaced`;
          renameSync(path, displaced);
          symlinkSync(external, path, "dir");
        },
      } as never);

      assert.equal(result.isolated, false);
      assert.deepEqual(readdirSync(external), [], "no marker or sentinel is created through the replacement symlink");
    } finally {
      for (const line of execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }).split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== repo) {
          try {
            execFileSync("git", ["-C", repo, "worktree", "remove", "--force", line.slice(9)]);
          } catch {
            // Best-effort fixture cleanup.
          }
        }
      }
      if (displaced) rmSync(displaced, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("safe-proof capability failures fall back without artifacts or diagnostics", async () => {
  for (const mode of ["descriptor-open", "descriptor-alias"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-safe-proof-${mode}-`));
    try {
      execFileSync("git", ["-C", repo, "init", "-q"]);
      execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
      writeFileSync(join(repo, "file.txt"), "base\n");
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const result = await createWorktreeLive(repo, `safe-proof-${mode}`, {
        directoryDescriptorMode: mode === "descriptor-open" ? "open-unsupported" : "unsupported",
        descriptorAliasMode: mode === "descriptor-alias" ? "unsupported" : "supported",
      } as never);
      assert.equal(result.isolated, false);
      assert.equal(result.recoveryFailures, undefined);
      assertNoCreationArtifacts(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("failed git worktree add reports bounded deterministic recovery identity when rollback fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-add-failure-cleanup-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const expectedBase = git("rev-parse", "HEAD").trim();
    const options = {
      directoryDescriptorMode: "unsupported" as const,
      async execGit(args: string[]) {
        if (args.includes("worktree") && args.includes("add")) {
          execFileSync("git", args, { stdio: "pipe" });
          throw new Error("injected git worktree add failure after registration");
        }
        return { stdout: execFileSync("git", args, { encoding: "utf8" }) };
      },
      creationCleanupHooks: {
        afterBranchClaim() {
          throw new Error(`injected creation cleanup-stage failure ${"x".repeat(5000)}`);
        },
      },
    } as Parameters<typeof createWorktreeLive>[2] & {
      creationCleanupHooks: { afterBranchClaim(): void };
    };

    const worktree = await createWorktreeLive(repo, "partial-cleanup-failure", options);

    assert.equal(worktree.isolated, false);
    assert.equal(worktree.recoveryFailures?.length, 1);
    assert.equal(worktree.recoveryFailures?.[0]?.stage, "cleanup_dispatch");
    assert.ok((worktree.recoveryFailures?.[0]?.message.length ?? Infinity) <= 1024);
    assert.deepEqual(worktree.recoveryFailures?.[0]?.identity, {
      recoveryId: worktree.recoveryFailures?.[0]?.identity.recoveryId,
      branchRef: "refs/heads/pi/wf/partial-cleanup-failure",
      baseSha: expectedBase,
    });
    assert.match(worktree.recoveryFailures?.[0]?.identity.recoveryId ?? "", /^[0-9a-f]{64}$/);
    const registeredCheckout = git("worktree", "list", "--porcelain")
      .split("\n")
      .find((line) => line.startsWith("worktree ") && line.slice("worktree ".length) !== repo)
      ?.slice("worktree ".length);
    assert.ok(registeredCheckout, "the exact registration remains available for deterministic recovery");
    assert.equal(JSON.stringify(worktree.recoveryFailures).includes(registeredCheckout ?? "missing"), false);
    assert.match(git("branch", "--list", "pi/wf/partial-cleanup-failure"), /partial-cleanup-failure/);
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    for (const line of git("worktree", "list", "--porcelain").split("\n")) {
      if (line.startsWith("worktree ") && line.slice("worktree ".length) !== repo) {
        try {
          git("worktree", "remove", "--force", line.slice("worktree ".length));
        } catch {
          // Best-effort fixture cleanup.
        }
      }
    }
    try {
      git("branch", "-D", "pi/wf/partial-cleanup-failure");
    } catch {
      // Best-effort fixture cleanup.
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree upgrades a genuinely legacy version-two identity and then pins its inode", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-v2-upgrade-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const current = await createWorktreeLive(repo, "legacy-v2-upgrade");
    assert.equal(current.cleanupMetadata?.version, 4);
    if (current.cleanupMetadata?.version !== 4) throw new Error("expected current cleanup metadata");
    const {
      checkoutIdentity: _checkoutIdentity,
      checkoutProof: _checkoutProof,
      version: _version,
      ...legacyFields
    } = current.cleanupMetadata;
    const legacy = { ...current, cleanupMetadata: { version: 2 as const, ...legacyFields } };
    writeFileSync(
      join(current.cleanupMetadata.gitDir, "pi-dynamic-workflows-registration"),
      `${JSON.stringify(legacy.cleanupMetadata)}\n`,
      { mode: 0o600 },
    );

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(JSON.parse(JSON.stringify(legacy))), []);
    assert.equal(existsSync(current.cwd), false);
    assert.equal(git("branch", "--list", current.branch ?? "").trim(), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree accepts structured clones and JSON-round-tripped worktrees", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-clone-cleanup-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const clonedSource = await createWorktreeLive(repo, "structured-clone");
    assert.equal(clonedSource.isolated, true);
    await removeWorktree(structuredClone(clonedSource));
    assert.equal(existsSync(clonedSource.cwd), false);

    const serializedSource = await createWorktreeLive(repo, "json-round-trip");
    assert.equal(serializedSource.isolated, true);
    await removeWorktree(JSON.parse(JSON.stringify(serializedSource)) as Worktree);
    assert.equal(existsSync(serializedSource.cwd), false);

    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .match(/^worktree /gm)?.length,
      1,
    );
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree rejects a round-tripped worktree with a substituted temporary branch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-substituted-branch-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let original: Worktree | undefined;
  const substitutedBranch = "pi/wf/substituted-branch";
  const substitutedRef = `refs/heads/${substitutedBranch}`;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    original = await createWorktreeLive(repo, "original-cleanup-identity");
    assert.equal(original.isolated, true);
    const substitutedOid = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "substituted commit")
      .toString()
      .trim();
    git("update-ref", substitutedRef, substitutedOid);
    const mutated = JSON.parse(JSON.stringify(original)) as Worktree;
    mutated.branch = substitutedBranch;
    mutated.branchRef = substitutedRef;

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(mutated);

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /cleanup failed.*identity_verification.*recovery ID/i);
    assert.equal(existsSync(original.cwd), true, "the original checkout is preserved");
    assert.match(git("branch", "--list", original.branch ?? "").toString(), /original-cleanup-identity/);
    assert.equal(git("rev-parse", "--verify", substitutedRef).toString().trim(), substitutedOid);
  } finally {
    if (original?.isolated && existsSync(original.cwd)) await removeWorktree(original);
    try {
      git("update-ref", "-d", substitutedRef);
    } catch {
      // Best-effort test cleanup.
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("current-version registrations never fresh-adopt stripped plain worktree values", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-legacy-cleanup-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const sources = await Promise.all([
      createWorktreeLive(repo, "legacy-plain"),
      createWorktreeLive(repo, "legacy-clone"),
      createWorktreeLive(repo, "legacy-json"),
      createWorktreeLive(repo, "legacy-repo-root"),
    ]);
    const legacy = (source: Worktree): Worktree => ({
      isolated: true,
      cwd: source.cwd,
      branch: source.branch,
    });
    const values = [
      legacy(sources[0] as Worktree),
      structuredClone(legacy(sources[1] as Worktree)),
      JSON.parse(JSON.stringify(legacy(sources[2] as Worktree))) as Worktree,
      { ...legacy(sources[3] as Worktree), repoRoot: repo },
    ];

    const operations = createWorktreeOperationsForTesting({});
    const cleanupResults = await Promise.all(values.map((value) => operations.removeWorktree(value)));

    for (const [index, source] of sources.entries()) {
      assert.equal(cleanupResults[index]?.length, 1);
      assert.equal(cleanupResults[index]?.[0]?.stage, "identity_verification");
      assert.equal(existsSync(source.cwd), true, `stripped current checkout ${index} is preserved`);
      await removeWorktree(source);
    }
    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .match(/^worktree /gm)?.length,
      1,
    );
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("concurrent legacy and current cleanup serializes destructive repository metadata changes", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-concurrent-cleanup-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    for (let round = 0; round < 6; round++) {
      const sources = await Promise.all(
        Array.from({ length: 6 }, (_, index) => createWorktreeLive(repo, `concurrent-cleanup-${round}-${index}`)),
      );
      for (const source of sources) assert.equal(source.isolated, true, source.reason);

      const values = [
        sources[0] as Worktree,
        structuredClone(sources[1] as Worktree),
        JSON.parse(JSON.stringify(sources[2])) as Worktree,
        sources[3] as Worktree,
        structuredClone(sources[4] as Worktree),
        JSON.parse(JSON.stringify(sources[5])) as Worktree,
      ];

      let activeMetadataCleanups = 0;
      let maximumActiveMetadataCleanups = 0;
      const operations = createWorktreeOperationsForTesting({
        async beforePostClaimRegistrationCheck() {
          activeMetadataCleanups++;
          maximumActiveMetadataCleanups = Math.max(maximumActiveMetadataCleanups, activeMetadataCleanups);
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        },
        afterRegistrationClaim() {
          activeMetadataCleanups--;
        },
      });
      const cleanupResults = await Promise.all(values.map((value) => operations.removeWorktree(value)));

      for (const [index, source] of sources.entries()) {
        assert.deepEqual(cleanupResults[index], [], `cleanup ${index} failed for ${source.cwd}`);
        assert.equal(existsSync(source.cwd), false, `cleanup ${index} left ${source.cwd}`);
      }
      assert.equal(activeMetadataCleanups, 0);
      assert.equal(maximumActiveMetadataCleanups, 1, "repository metadata cleanup must not overlap");
      assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
      assert.equal(
        git("for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup/").toString().trim(),
        "",
      );
      assert.equal(
        git("worktree", "list", "--porcelain")
          .toString()
          .match(/^worktree /gm)?.length,
        1,
      );
      assertCleanupQuarantinesEmpty(repo);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cross-process cleanup serializes one repository and leaves no Git metadata leaks", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-cross-process-same-"));
  const probeRoot = mkdtempSync(join(tmpdir(), "pi-wt-cross-process-probe-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    await Promise.all([
      runCleanupWorker(repo, "cross-process-one", probeRoot, "same-repo"),
      runCleanupWorker(repo, "cross-process-two", probeRoot, "same-repo"),
    ]);

    assert.deepEqual(
      readFileSync(join(probeRoot, "events.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(" ")[0]),
      ["enter", "exit", "enter", "exit"],
      "the cross-process destructive intervals do not overlap",
    );
    assertNoCreationArtifacts(repo);
    assert.equal(existsSync(operationLockRoot(repo)), false, "the repository lock is released");
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("two processes racing stale reclaim and new ownership never overlap", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-cross-process-stale-reclaim-"));
  const probeRoot = mkdtempSync(join(tmpdir(), "pi-wt-cross-process-stale-reclaim-probe-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const first = runCleanupWorker(repo, "stale-reclaim-one", probeRoot, "stale-race");
    for (let attempt = 0; attempt < 500; attempt++) {
      if (readdirSync(probeRoot).filter((entry) => entry.startsWith("ready-")).length === 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (attempt === 499) throw new Error("the first stale-reclaim worker did not finish creation");
    }
    const second = runCleanupWorker(repo, "stale-reclaim-two", probeRoot, "stale-race");
    for (let attempt = 0; attempt < 500; attempt++) {
      if (readdirSync(probeRoot).filter((entry) => entry.startsWith("ready-")).length === 2) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (attempt === 499) throw new Error("the second stale-reclaim worker did not finish creation");
    }
    installOperationLock(repo, {
      version: 1,
      token: "8".repeat(64),
      pid: 2_147_483_647,
      createdAtMs: Date.now() - 120_000,
    });
    writeFileSync(join(probeRoot, "go"), "go\n", { flag: "wx" });

    await Promise.all([first, second]);

    assert.deepEqual(
      readFileSync(join(probeRoot, "events.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(" ")[0]),
      ["enter", "exit", "enter", "exit"],
    );
    assertNoCreationArtifacts(repo);
    assert.equal(existsSync(operationLockRoot(repo)), false);
    assert.equal(existsSync(operationLockUniquePath(repo, "8".repeat(64))), false);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cross-process cleanup remains parallel for unrelated repositories", async () => {
  const probeRoot = mkdtempSync(join(tmpdir(), "pi-wt-cross-process-unrelated-probe-"));
  const repos = [
    mkdtempSync(join(tmpdir(), "pi-wt-cross-process-unrelated-a-")),
    mkdtempSync(join(tmpdir(), "pi-wt-cross-process-unrelated-b-")),
  ];
  try {
    for (const repo of repos) {
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
    }

    await Promise.all(
      repos.map((repo, index) =>
        runCleanupWorker(repo, `cross-process-unrelated-${index}`, probeRoot, "different-repo"),
      ),
    );

    assert.equal(readdirSync(probeRoot).filter((entry) => entry.startsWith("entered-")).length, 2);
    for (const repo of repos) assertNoCreationArtifacts(repo);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  }
});

test("repository operation locks recover only strict stale owners and fail closed for bounded malformed owners", async () => {
  for (const lockState of ["stale", "malformed", "symlink"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-operation-lock-${lockState}-`));
    const external = mkdtempSync(join(tmpdir(), `pi-wt-operation-lock-${lockState}-external-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    let worktree: Worktree | undefined;
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      worktree = await createWorktreeLive(repo, `operation-lock-${lockState}`);
      assert.equal(worktree.isolated, true);
      const lockRoot = operationLockRoot(repo);
      if (lockState === "symlink") {
        writeFileSync(join(external, "sentinel.txt"), "external survives\n");
        symlinkSync(external, lockRoot, "file");
      } else if (lockState === "malformed") {
        writeFileSync(lockRoot, "not-json\n");
        writeFileSync(join(external, "sentinel.txt"), "external survives\n");
      } else {
        installOperationLock(repo, {
          version: 1,
          token: "a".repeat(64),
          pid: 2_147_483_647,
          createdAtMs: Date.now() - 120_000,
        });
      }

      const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
      if (lockState === "stale") {
        assert.deepEqual(failures, []);
        assert.equal(existsSync(lockRoot), false);
        worktree = undefined;
      } else {
        assert.equal(failures.length, 1, `${lockState} lock fails in bounded time`);
        assert.equal(existsSync(worktree.cwd), true);
        assert.match(git("branch", "--list", worktree.branch ?? ""), /operation-lock/);
        assert.equal(
          readFileSync(join(worktree.cleanupMetadata?.gitDir ?? "", "pi-dynamic-workflows-registration"), "utf8")
            .length > 0,
          true,
        );
        if (lockState === "malformed" || lockState === "symlink") {
          assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "external survives\n");
          assert.deepEqual(readdirSync(external), ["sentinel.txt"], "the lock path is never followed");
        }
        rmSync(lockRoot, { recursive: true, force: true });
        assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
        worktree = undefined;
      }
    } finally {
      if (worktree?.isolated) {
        rmSync(operationLockRoot(repo), { recursive: true, force: true });
        await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
      }
      rmSync(external, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("repository operation lock live-owner waits settle within a configurable acquisition deadline", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-live-operation-lock-deadline-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let worktree: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    worktree = await createWorktreeLive(repo, "live-operation-lock-holder");
    assert.equal(worktree.isolated, true);
    const lockRoot = operationLockRoot(repo);
    const ownerRecord = {
      version: 1 as const,
      token: "c".repeat(64),
      pid: process.pid,
      createdAtMs: Date.now(),
    };
    const ownerUniquePath = installOperationLock(repo, ownerRecord);
    const release = setTimeout(() => {
      rmSync(lockRoot, { force: true });
      rmSync(ownerUniquePath, { force: true });
    }, 1_200);
    const started = Date.now();
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    clearTimeout(release);
    assert.ok(Date.now() - started >= 1_100, "a legitimate 1.2 second owner is allowed to finish");
    worktree = undefined;

    worktree = await createWorktreeLive(repo, "forged-live-operation-lock-holder");
    assert.equal(worktree.isolated, true);
    const forgedOwnerRecord = {
      version: 1 as const,
      token: "d".repeat(64),
      pid: process.pid,
      createdAtMs: Date.now() - 120_000,
    };
    const forgedOwner = `${JSON.stringify(forgedOwnerRecord)}\n`;
    const forgedUniquePath = installOperationLock(repo, forgedOwnerRecord);
    const bounded = createWorktreeOperationsForTesting({
      repositoryOperationLockAcquisitionDeadlineMs: 100,
      repositoryOperationLockRetryMs: 10,
    } as never);
    const forgedStarted = Date.now();
    const failures = await bounded.removeWorktree(worktree);
    const elapsed = Date.now() - forgedStarted;
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
    assert.ok(elapsed >= 80 && elapsed < 1_000, `bounded live-owner wait took ${elapsed}ms`);
    assert.equal(readFileSync(lockRoot, "utf8"), forgedOwner, "a live lock is never stolen or mutated");
    assert.equal(existsSync(worktree.cwd), true);

    rmSync(lockRoot, { force: true });
    rmSync(forgedUniquePath, { force: true });
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    worktree = undefined;
  } finally {
    rmSync(operationLockRoot(repo), { recursive: true, force: true });
    if (worktree?.isolated) await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy directory repository locks fail closed with bounded manual-recovery diagnostics", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-legacy-operation-lock-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let worktree: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    worktree = await createWorktreeLive(repo, "legacy-operation-lock");
    assert.equal(worktree.isolated, true);
    mkdirSync(operationLockRoot(repo), { mode: 0o700 });
    writeFileSync(join(operationLockRoot(repo), "owner"), "legacy\n");

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
    assert.equal(failures.length, 1);
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
    assert.equal(existsSync(worktree.cwd), true);

    rmSync(operationLockRoot(repo), { recursive: true, force: true });
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    worktree = undefined;
  } finally {
    rmSync(operationLockRoot(repo), { recursive: true, force: true });
    if (worktree?.isolated) await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stale lock reclaim never unlinks a concurrently installed new owner", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-operation-lock-reclaim-race-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let worktree: Worktree | undefined;
  let newUniquePath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    worktree = await createWorktreeLive(repo, "operation-lock-reclaim-race");
    assert.equal(worktree.isolated, true);
    const staleToken = "e".repeat(64);
    const staleUniquePath = installOperationLock(repo, {
      version: 1,
      token: staleToken,
      pid: 2_147_483_647,
      createdAtMs: Date.now() - 120_000,
    });
    const newOwner = { version: 1 as const, token: "f".repeat(64), pid: process.pid, createdAtMs: Date.now() };
    let replaced = false;
    const operations = createWorktreeOperationsForTesting({
      beforeRepositoryOperationLockUnlink(path, token) {
        if (replaced || token !== staleToken) return;
        replaced = true;
        unlinkSync(path);
        unlinkSync(staleUniquePath);
        newUniquePath = installOperationLock(repo, newOwner);
      },
      repositoryOperationLockAcquisitionDeadlineMs: 100,
      repositoryOperationLockRetryMs: 10,
    } as never);

    const failures = await operations.removeWorktree(worktree);
    assert.equal(failures.length, 1);
    assert.equal(readFileSync(operationLockRoot(repo), "utf8"), `${JSON.stringify(newOwner)}\n`);
    assert.equal(existsSync(worktree.cwd), true, "the competing live owner keeps exclusive admission");

    unlinkSync(operationLockRoot(repo));
    unlinkSync(newUniquePath);
    newUniquePath = "";
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    worktree = undefined;
  } finally {
    rmSync(operationLockRoot(repo), { force: true });
    if (newUniquePath) rmSync(newUniquePath, { force: true });
    if (worktree?.isolated) await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an initialized hard-link lock survives owner crash and is safely reclaimed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-operation-lock-crash-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let worktree: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    worktree = await createWorktreeLive(repo, "operation-lock-crash");
    assert.equal(worktree.isolated, true);
    const token = "9".repeat(64);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require('node:fs');
const [uniquePath, lockPath, token] = process.argv.slice(1);
fs.writeFileSync(uniquePath, JSON.stringify({ version: 1, token, pid: process.pid, createdAtMs: Date.now() - 120000 }) + '\\n', { flag: 'wx', mode: 0o600 });
fs.linkSync(uniquePath, lockPath);
process.kill(process.pid, 'SIGKILL');`,
        operationLockUniquePath(repo, token),
        operationLockRoot(repo),
        token,
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (_code, signal) => {
        try {
          assert.equal(signal, "SIGKILL");
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    assert.equal(existsSync(operationLockRoot(repo)), false);
    assert.equal(existsSync(operationLockUniquePath(repo, token)), false);
    worktree = undefined;
  } finally {
    rmSync(operationLockRoot(repo), { force: true });
    if (worktree?.isolated) await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy cleanup rejects arbitrary paths and non-runtime branches", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-legacy-reject-"));
  const outsidePath = mkdtempSync(join(tmpdir(), "pi-wt-legacy-outside-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let trustedSource: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    git("worktree", "add", "-q", "-b", "pi/wf/outside", outsidePath, "HEAD");
    await removeWorktree({ isolated: true, cwd: outsidePath, branch: "pi/wf/outside" });
    assert.equal(existsSync(outsidePath), true, "a runtime-looking branch cannot authorize an arbitrary path");
    assert.match(git("branch", "--list", "pi/wf/outside").toString(), /outside/);

    trustedSource = await createWorktreeLive(repo, "legacy-wrong-branch");
    assert.equal(trustedSource.isolated, true);
    await removeWorktree({ isolated: true, cwd: trustedSource.cwd, branch: "customer/keep" });
    assert.equal(existsSync(trustedSource.cwd), true, "a trusted path cannot authorize a non-runtime branch");
    assert.match(git("branch", "--list", trustedSource.branch ?? "").toString(), /legacy-wrong-branch/);
  } finally {
    if (trustedSource?.isolated) await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(trustedSource);
    try {
      git("worktree", "remove", "--force", outsidePath);
      git("branch", "-D", "pi/wf/outside");
    } catch {
      // Best-effort test cleanup.
    }
    rmSync(outsidePath, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup removes detached checkouts while preserving their unrelated commit object", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-detached-cleanup-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const worktree = await createWorktreeLive(repo, "detached-cleanup");
    execFileSync("git", ["-C", worktree.cwd, "checkout", "--detach", "-q"], { stdio: "pipe" });
    writeFileSync(join(worktree.cwd, "detached.txt"), "detached commit\n");
    execFileSync("git", ["-C", worktree.cwd, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", worktree.cwd, "commit", "-q", "-m", "detached commit"], { stdio: "pipe" });
    const detachedOid = execFileSync("git", ["-C", worktree.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    assert.equal(existsSync(worktree.cwd), false);
    assert.equal(
      git("branch", "--list", worktree.branch ?? "")
        .toString()
        .trim(),
      "",
    );
    assert.equal(git("cat-file", "-t", detachedOid).toString().trim(), "commit");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .match(/^worktree /gm)?.length,
      1,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup removes switched checkouts without deleting the agent-created branch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-switched-cleanup-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const unrelatedBranch = "customer/keep-agent-work";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const worktree = await createWorktreeLive(repo, "switched-cleanup");
    execFileSync("git", ["-C", worktree.cwd, "switch", "-q", "-c", unrelatedBranch], { stdio: "pipe" });
    writeFileSync(join(worktree.cwd, "kept.txt"), "keep this commit\n");
    execFileSync("git", ["-C", worktree.cwd, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", worktree.cwd, "commit", "-q", "-m", "keep agent work"], { stdio: "pipe" });
    const unrelatedOid = execFileSync("git", ["-C", worktree.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    assert.equal(existsSync(worktree.cwd), false);
    assert.equal(
      git("branch", "--list", worktree.branch ?? "")
        .toString()
        .trim(),
      "",
    );
    assert.match(git("branch", "--list", unrelatedBranch).toString(), /keep-agent-work/);
    assert.equal(git("rev-parse", unrelatedBranch).toString().trim(), unrelatedOid);
    assert.equal(git("cat-file", "-t", unrelatedOid).toString().trim(), "commit");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .match(/^worktree /gm)?.length,
      1,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the process-wide cleaned identity cache remains bounded", () => {
  const identities = Array.from({ length: 1100 }, (_, index) => `bounded-cleanup-identity-${index}`);

  const metrics = populateCleanedWorktreeCacheForTesting(identities);
  const repeated = populateCleanedWorktreeCacheForTesting(identities.slice(-20));

  assert.equal(metrics.capacity, 1024);
  assert.equal(metrics.size, metrics.capacity);
  assert.deepEqual(repeated, metrics, "recent repeated identities remain idempotent without growing the cache");
});

test("portable cleanup works when proc descriptors are unavailable", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-no-proc-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const operations = createWorktreeOperationsForTesting({ procDescriptorRoot: join(repo, "unavailable-proc") });
    for (const name of ["ordinary-no-proc", "retained-no-proc"]) {
      const worktree = await operations.createWorktree(repo, name);
      assert.equal(worktree.isolated, true);
      assert.deepEqual(await operations.removeWorktree(worktree), []);
      assert.equal(existsSync(worktree.cwd), false);
    }

    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .match(/^worktree /gm)?.length,
      1,
    );
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("portable sentinel blocks neutralize in place without losing separators, metadata, hardlinks, or external appends", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-sentinel-restore-"));
  const descriptorBaseline = activeCheckoutProofsForTesting();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const initial = "# user excludes\n*.private";
    writeFileSync(excludePath(repo), initial);
    const [one, two] = await Promise.all([
      createWorktreeLive(repo, "sentinel-concurrent-one", { directoryDescriptorMode: "unsupported" } as never),
      createWorktreeLive(repo, "sentinel-concurrent-two", { directoryDescriptorMode: "unsupported" } as never),
    ]);
    assert.equal(one.cleanupMetadata?.version, 4);
    assert.equal(two.cleanupMetadata?.version, 4);
    assert.equal(
      activeCheckoutProofsForTesting().excludeDescriptorCount,
      descriptorBaseline.excludeDescriptorCount + 2,
      "multiple worktrees retain independent handles to the shared exclude inode",
    );
    if (one.cleanupMetadata?.version !== 4 || two.cleanupMetadata?.version !== 4) throw new Error("expected v4");
    if (
      one.cleanupMetadata.checkoutProof.kind !== "sentinel" ||
      two.cleanupMetadata.checkoutProof.kind !== "sentinel"
    ) {
      throw new Error("expected portable sentinel proofs");
    }
    const active = [one, two] as const;
    const first = active.find(
      (worktree) =>
        worktree.cleanupMetadata?.version === 4 &&
        worktree.cleanupMetadata.checkoutProof.kind === "sentinel" &&
        worktree.cleanupMetadata.checkoutProof.excludeLeadingNewline,
    );
    const second = active.find((worktree) => worktree !== first);
    if (
      !first ||
      !second ||
      first.cleanupMetadata?.version !== 4 ||
      second.cleanupMetadata?.version !== 4 ||
      first.cleanupMetadata.checkoutProof.kind !== "sentinel" ||
      second.cleanupMetadata.checkoutProof.kind !== "sentinel"
    ) {
      throw new Error("expected ordered portable sentinel proofs");
    }
    const firstProof = first.cleanupMetadata.checkoutProof;
    const secondProof = second.cleanupMetadata.checkoutProof;
    assert.notEqual(firstProof.fileName, secondProof.fileName);
    assert.equal(firstProof.excludeLeadingNewline, true, "the first block owns the separator after a non-newline file");
    assert.equal(secondProof.excludeLeadingNewline, false);
    const during = readFileSync(excludePath(repo), "utf8");
    assert.match(during, new RegExp(firstProof.fileName));
    assert.match(during, new RegExp(secondProof.fileName));
    assert.equal(during.includes("/.pi-dynamic-workflows-checkout-identity\n"), false, "no static global rule remains");
    assert.equal(isGitIgnored(repo, firstProof.fileName), true);
    assert.equal(isGitIgnored(repo, secondProof.fileName), true);

    const hardlinkPath = join(gitCommonRoot(repo), "info", "exclude-hardlink");
    chmodSync(excludePath(repo), 0o640);
    linkSync(excludePath(repo), hardlinkPath);
    const metadataBefore = statSync(excludePath(repo));
    const externalAppend = "# external append during neutralization\n*.later\n";
    const retrying = createWorktreeOperationsForTesting({
      afterIdentityVerification() {
        throw new Error("retry sentinel cleanup later");
      },
    });
    const retryFailures = await retrying.removeWorktree(first);
    assert.equal(retryFailures.length, 1);
    assert.match(readFileSync(excludePath(repo), "utf8"), new RegExp(firstProof.fileName));

    const beforeNeutralization = readFileSync(excludePath(repo), "utf8");
    const firstBlock = sentinelExcludeBlock(firstProof);
    const firstOffset = beforeNeutralization.indexOf(firstBlock);
    assert.ok(firstOffset >= 0);
    let appended = false;
    const appendDuringNeutralization = createWorktreeOperationsForTesting({
      beforeSentinelExcludeNeutralize() {
        if (appended) return;
        appended = true;
        appendFileSync(excludePath(repo), externalAppend);
      },
    } as never);
    assert.deepEqual(await appendDuringNeutralization.removeWorktree(first), []);
    const afterFirst = readFileSync(excludePath(repo), "utf8");
    assert.equal(afterFirst.slice(0, firstOffset), beforeNeutralization.slice(0, firstOffset));
    assert.equal(
      afterFirst.slice(firstOffset + firstBlock.length, beforeNeutralization.length),
      beforeNeutralization.slice(firstOffset + firstBlock.length),
      "every byte outside the owned range is preserved",
    );
    const neutralized = afterFirst.slice(firstOffset, firstOffset + firstBlock.length);
    assert.equal(neutralized.length, firstBlock.length);
    assert.deepEqual(
      [...neutralized].map((character, index) => (character === "\n" ? index : -1)).filter((index) => index >= 0),
      [...firstBlock].map((character, index) => (character === "\n" ? index : -1)).filter((index) => index >= 0),
      "neutralization preserves every newline and separator",
    );
    assert.match(neutralized, /^\n# *\n# *\n$/);
    assert.equal(afterFirst.includes(firstProof.fileName), false);
    assert.equal(afterFirst.includes(secondProof.fileName), true);
    assert.equal(afterFirst.endsWith(externalAppend), true, "an external append survives byte-for-byte");
    assert.equal(isGitIgnored(repo, firstProof.fileName), false, "released sentinel rule is semantically inactive");
    assert.equal(isGitIgnored(repo, secondProof.fileName), true, "overlapping active sentinel remains ignored");
    assert.equal(isGitIgnored(repo, "probe.private"), true, "the user's preexisting rule keeps its semantics");
    assert.equal(isGitIgnored(repo, "probe.later"), true, "the concurrent append keeps its semantics");
    const metadataAfterFirst = statSync(excludePath(repo));
    const hardlinkAfterFirst = statSync(hardlinkPath);
    assert.equal(metadataAfterFirst.ino, metadataBefore.ino, "cleanup preserves the exclude inode");
    assert.equal(hardlinkAfterFirst.ino, metadataBefore.ino, "cleanup preserves hardlink identity");
    assert.equal(metadataAfterFirst.mode & 0o777, metadataBefore.mode & 0o777, "cleanup preserves mode bits");
    assert.equal(readFileSync(hardlinkPath, "utf8"), afterFirst, "the hardlink observes the same in-place edit");

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(second), []);
    const afterSecond = readFileSync(excludePath(repo), "utf8");
    assert.equal(afterSecond.includes(secondProof.fileName), false);
    assert.equal(afterSecond.endsWith(externalAppend), true);
    assert.equal(isGitIgnored(repo, secondProof.fileName), false);
    assert.equal(isGitIgnored(repo, "probe.private"), true);
    assert.equal(isGitIgnored(repo, "probe.later"), true);
    assert.equal(statSync(excludePath(repo)).ino, metadataBefore.ino);
    assert.equal(statSync(excludePath(repo)).mode & 0o777, metadataBefore.mode & 0o777);
    assert.deepEqual(activeCheckoutProofsForTesting(), descriptorBaseline);

    const branchRetry = await createWorktreeLive(repo, "sentinel-branch-retry", {
      directoryDescriptorMode: "unsupported",
    } as never);
    if (branchRetry.cleanupMetadata?.version !== 4 || branchRetry.cleanupMetadata.checkoutProof.kind !== "sentinel") {
      throw new Error("expected retryable portable sentinel proof");
    }
    let failBranchDelete = true;
    const branchRetryOperations = createWorktreeOperationsForTesting({
      beforeClaimedBranchDelete() {
        if (!failBranchDelete) return;
        failBranchDelete = false;
        throw new Error("retry portable branch cleanup later");
      },
    });
    const branchFailures = await branchRetryOperations.removeWorktree(branchRetry);
    assert.equal(branchFailures[0]?.stage, "branch_delete");
    assert.match(
      readFileSync(excludePath(repo), "utf8"),
      new RegExp(branchRetry.cleanupMetadata.checkoutProof.fileName),
      "retry rollback re-appends an exact active owned block",
    );
    assert.deepEqual(await branchRetryOperations.removeWorktree(branchRetry), []);
    assert.equal(
      readFileSync(excludePath(repo), "utf8").includes(branchRetry.cleanupMetadata.checkoutProof.fileName),
      false,
    );
    assert.deepEqual(activeCheckoutProofsForTesting(), descriptorBaseline);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("portable sentinel cleanup fails bounded on an edited owned block and succeeds after repair", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-sentinel-edited-block-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const worktree = await createWorktreeLive(repo, "sentinel-edited-owned-block", {
      directoryDescriptorMode: "unsupported",
    } as never);
    if (worktree.cleanupMetadata?.version !== 4 || worktree.cleanupMetadata.checkoutProof.kind !== "sentinel") {
      throw new Error("expected portable sentinel proof");
    }
    const proof = worktree.cleanupMetadata.checkoutProof;
    const exactBlock = sentinelExcludeBlock(proof);
    let pristine = "";
    const edited = createWorktreeOperationsForTesting({
      beforeSentinelExcludeNeutralize() {
        pristine = readFileSync(excludePath(repo), "utf8");
        const offset = pristine.indexOf(exactBlock);
        if (offset < 0) throw new Error("owned block missing from fixture");
        writeFileSync(excludePath(repo), `${pristine.slice(0, offset)}!${pristine.slice(offset + 1)}`);
      },
    } as never);

    const failures = await edited.removeWorktree(worktree);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "worktree_remove");
    assert.match(failures[0]?.message ?? "", /portable sentinel restoration failed.*incomplete or changed/i);
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
    assert.match(
      git("for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup/"),
      /refs\/pi-dynamic-workflows\/cleanup\//,
      "the deterministic backup ref retains retry authority",
    );

    writeFileSync(excludePath(repo), pristine);
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    assert.equal(readFileSync(excludePath(repo), "utf8").includes(proof.fileName), false);
    assert.equal(isGitIgnored(repo, proof.fileName), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("portable sentinel state is semantically neutralized after fully rolled-back creation", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-sentinel-rollback-"));
  const descriptorBaseline = activeCheckoutProofsForTesting();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const initial = "# keep exactly\n*.keep\n";
    writeFileSync(excludePath(repo), initial);

    const result = await createWorktreeLive(repo, "sentinel-rollback", {
      directoryDescriptorMode: "unsupported",
      async canonicalizePath(path) {
        if (path.includes("pi-workflow-checkout-")) throw new Error("rollback finalized portable creation");
        return realpathSync(path);
      },
    });

    assert.equal(result.isolated, false);
    assert.match(result.reason ?? "", /identity_finalization/);
    const afterRollback = readFileSync(excludePath(repo), "utf8");
    assert.equal(afterRollback.slice(0, initial.length), initial);
    assert.match(afterRollback.slice(initial.length), /^# *\n# *\n$/);
    assert.equal(afterRollback.includes("pi-dynamic-workflows-owned-sentinel"), false);
    assert.equal(afterRollback.includes(".pi-dynamic-workflows-checkout-identity"), false);
    assert.equal(isGitIgnored(repo, "probe.keep"), true);
    assert.deepEqual(activeCheckoutProofsForTesting(), descriptorBaseline, "full rollback closes all proof fds");
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree supports SHA-256 repositories", {
  skip: !SHA256_REPOSITORIES_SUPPORTED && "git does not support SHA-256 repositories",
}, async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-sha256-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q", "--object-format=sha256");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    assert.equal(git("rev-parse", "HEAD").toString().trim().length, 64);

    const worktree = await createWorktreeLive(repo, "sha256-cleanup");
    assert.equal(worktree.isolated, true);
    assert.equal(join(worktree.cwd, ".."), gitCommonRoot(repo));
    assert.match(worktree.cwd, /pi-workflow-checkout-/);
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    assert.equal(existsSync(worktree.cwd), false);
    assert.equal(
      git("branch", "--list", worktree.branch ?? "")
        .toString()
        .trim(),
      "",
    );
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree ignores a pre-existing symlink at the obsolete shared worktree root", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-symlink-root-"));
  const external = mkdtempSync(join(tmpdir(), "pi-wt-external-root-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    mkdirSync(join(repo, ".pi"));
    symlinkSync(external, join(repo, ".pi", "worktrees"), "dir");

    const worktree = await createWorktreeLive(repo, "symlink-escape");

    assert.equal(worktree.isolated, true, worktree.reason);
    assert.equal(join(worktree.cwd, ".."), gitCommonRoot(repo));
    assert.match(worktree.cwd, /pi-workflow-checkout-/);
    assert.deepEqual(readdirSync(external), [], "the external directory receives no checkout");
    assert.equal(
      git("branch", "--list", worktree.branch ?? "")
        .toString()
        .trim().length > 0,
      true,
    );
    await removeWorktree(worktree);
    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
      "cleanup removes the Git-common-dir registration without resolving the obsolete root",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("swapping the obsolete shared root cannot redirect direct-child worktree creation", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-shared-root-swap-"));
  const external = mkdtempSync(join(tmpdir(), "pi-wt-shared-root-external-"));
  const displaced = join(repo, ".pi", "displaced-worktrees");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let worktree: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    mkdirSync(join(repo, ".pi", "worktrees"), { recursive: true });

    worktree = await createWorktreeLive(repo, "shared-root-swap", {
      afterAtomicDirectoryCreation() {
        renameSync(join(repo, ".pi", "worktrees"), displaced);
        symlinkSync(external, join(repo, ".pi", "worktrees"), "dir");
      },
    });

    assert.equal(worktree.isolated, true, worktree.reason);
    assert.equal(join(worktree.cwd, ".."), gitCommonRoot(repo), "the checkout is a direct Git-common-dir child");
    assert.match(worktree.cwd, /pi-workflow-checkout-/);
    assert.equal(readFileSync(join(worktree.cwd, "file.txt"), "utf8"), "base\n");
    assert.deepEqual(readdirSync(external), [], "Git never resolves the attacker-controlled shared root");

    await removeWorktree(worktree);
    worktree = undefined;
    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
      "the exact Git-common-dir registration is removed",
    );
    assert.deepEqual(readdirSync(external), [], "cleanup never follows the swapped shared root");
  } finally {
    if (worktree?.isolated) await removeWorktree(worktree);
    rmSync(repo, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("rebound allocated checkout paths fail closed before git worktree add", async () => {
  for (const replacement of ["directory", "symlink"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-pre-add-${replacement}-`));
    const external = mkdtempSync(join(tmpdir(), `pi-wt-pre-add-${replacement}-external-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    let checkoutPath = "";
    let gitAddCalled = false;
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      writeFileSync(join(external, "sentinel.txt"), "external survives\n");
      if (replacement === "directory") {
        mkdirSync(join(external, "replacement"));
        writeFileSync(join(external, "replacement", "attacker.txt"), "replacement survives\n");
      }
      const excludeBefore = "# caller-owned exclude\n*.private\n";
      writeFileSync(excludePath(repo), excludeBefore);

      const worktree = await createWorktreeLive(repo, `pre-add-${replacement}`, {
        directoryDescriptorMode: "unsupported",
        async execGit(args) {
          if (args.includes("worktree") && args.includes("add")) gitAddCalled = true;
          return { stdout: execFileSync("git", args, { encoding: "utf8" }) };
        },
        afterBranchCreationBeforeGitAdd(_gitCommonRoot, allocatedPath) {
          checkoutPath = allocatedPath;
          rmdirSync(allocatedPath);
          if (replacement === "directory") {
            renameSync(join(external, "replacement"), allocatedPath);
          } else {
            symlinkSync(external, allocatedPath, "dir");
          }
        },
      } as Parameters<typeof createWorktreeLive>[2] & {
        afterBranchCreationBeforeGitAdd(gitCommonRoot: string, worktreePath: string): void;
      });

      assert.equal(worktree.isolated, false);
      assert.match(worktree.reason ?? "", /pre_add_verification/);
      assert.equal(gitAddCalled, false, "Git never receives the rebound checkout path");
      assert.equal(git("branch", "--list", `pi/wf/pre-add-${replacement}`).trim(), "", "the owned branch is removed");
      assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "external survives\n");
      assert.equal(
        readFileSync(excludePath(repo), "utf8"),
        excludeBefore,
        "identity mismatch performs zero exclude writes",
      );
      if (replacement === "directory") {
        assert.deepEqual(
          readdirSync(checkoutPath),
          ["attacker.txt"],
          "recovery writes nothing into the rebound directory",
        );
        assert.equal(readFileSync(join(checkoutPath, "attacker.txt"), "utf8"), "replacement survives\n");
      } else {
        assert.deepEqual(
          readdirSync(external),
          ["sentinel.txt"],
          "recovery writes nothing through the rebound symlink",
        );
        assert.equal(realpathSync(checkoutPath), external);
      }
      assert.deepEqual(worktree.recoveryFailures, undefined);
    } finally {
      if (checkoutPath) rmSync(checkoutPath, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("pre-add rebound rollback failures return bounded recovery diagnostics", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-pre-add-rollback-failure-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let checkoutPath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const worktree = await createWorktreeLive(repo, "pre-add-rollback-failure", {
      afterBranchCreationBeforeGitAdd(_gitCommonRoot, allocatedPath) {
        checkoutPath = allocatedPath;
        rmdirSync(allocatedPath);
        mkdirSync(allocatedPath);
        writeFileSync(join(allocatedPath, "attacker.txt"), "preserved\n");
      },
      creationCleanupHooks: {
        afterBranchClaim() {
          throw new Error(`injected exact rollback failure ${"x".repeat(5000)}`);
        },
      },
    } as Parameters<typeof createWorktreeLive>[2] & {
      afterBranchCreationBeforeGitAdd(gitCommonRoot: string, worktreePath: string): void;
      creationCleanupHooks: { afterBranchClaim(): void };
    });

    assert.equal(worktree.isolated, false);
    assert.equal(worktree.recoveryFailures?.length, 1);
    assert.equal(worktree.recoveryFailures?.[0]?.stage, "cleanup_dispatch");
    assert.ok((worktree.recoveryFailures?.[0]?.message.length ?? Infinity) <= 1024);
    assert.equal(readFileSync(join(checkoutPath, "attacker.txt"), "utf8"), "preserved\n");
  } finally {
    if (checkoutPath) rmSync(checkoutPath, { recursive: true, force: true });
    try {
      git("update-ref", "-d", "refs/heads/pi/wf/pre-add-rollback-failure");
    } catch {
      // Best-effort fixture cleanup.
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("older Git plumbing creates and cleans ordinary and retained worktrees without path-format", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-old-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const commands: string[][] = [];
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const createWithOldGit = (name: string) =>
      createWorktreeLive(repo, name, {
        async execGit(args) {
          commands.push([...args]);
          if (args.includes("--path-format=absolute")) throw new Error("unknown option: --path-format");
          return { stdout: execFileSync("git", args, { encoding: "utf8" }) };
        },
      });

    const ordinary = await createWithOldGit("old-git-ordinary");
    assert.equal(ordinary.isolated, true, ordinary.reason);
    await removeWorktree(ordinary);

    const retained = await createWithOldGit("old-git-retained");
    assert.equal(retained.isolated, true, retained.reason);
    const registry = new RetainedWorktreeRegistry();
    const handle = registry.register(retained);
    await registry.release(handle);

    assert.equal(
      commands.some((args) => args.includes("--path-format=absolute")),
      false,
    );
    assert.equal(
      readFileSync(new URL("../src/worktree.ts", import.meta.url), "utf8").includes("--path-format=absolute"),
      false,
    );
    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

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

test("removeWorktree cleans the exact stale registration and branch when its checkout is missing", async () => {
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

    await assert.doesNotReject(removeWorktree(wt));
    const registrations = git("worktree", "list", "--porcelain").toString();
    assert.equal(
      registrations.split("\n").filter((line) => line.startsWith("worktree ")).length,
      1,
      "the stale registration is removed",
    );
    assert.equal(
      git("branch", "--list", wt.branch ?? "")
        .toString()
        .trim(),
      "",
      "the temporary branch is removed",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup finds a descriptor-proven checkout renamed within the Git-common parent", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-renamed-within-parent-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const worktree = await createWorktreeLive(repo, "renamed-within-parent");
    const renamed = join(gitCommonRoot(repo), "renamed-runtime-checkout");
    renameSync(worktree.cwd, renamed);
    writeFileSync(join(renamed, "uncommitted.txt"), "descriptor-proven contents\n");

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);

    assert.deepEqual(failures, []);
    assert.equal(existsSync(renamed), false, "the exact linked descriptor inode is removed at its new basename");
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup fails closed when a descriptor-proven checkout is renamed outside its safe parent", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-renamed-outside-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-wt-renamed-outside-target-"));
  const moved = join(outside, "moved-checkout");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let worktree: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    worktree = await createWorktreeLive(repo, "renamed-outside-parent");
    renameSync(worktree.cwd, moved);
    writeFileSync(join(moved, "uncommitted.txt"), "preserve outside contents\n");
    const registrationBefore = readFileSync(
      join(worktree.cleanupMetadata?.gitDir ?? "", "pi-dynamic-workflows-registration"),
      "utf8",
    );

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.equal(readFileSync(join(moved, "uncommitted.txt"), "utf8"), "preserve outside contents\n");
    assert.match(git("branch", "--list", worktree.branch ?? ""), /renamed-outside-parent/);
    assert.equal(
      readFileSync(join(worktree.cleanupMetadata?.gitDir ?? "", "pi-dynamic-workflows-registration"), "utf8"),
      registrationBefore,
    );

    renameSync(moved, worktree.cwd);
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
    worktree = undefined;
  } finally {
    if (worktree?.isolated) {
      if (existsSync(moved) && !existsSync(worktree.cwd)) renameSync(moved, worktree.cwd);
      await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);
    }
    rmSync(outside, { recursive: true, force: true });
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
    assert.match(wt.reason ?? "", /branch_create/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("long retained producer names preserve distinct paths and refs within the length cap", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-unique-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const created: Worktree[] = [];
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const prefix = "managed-workflow-name-that-consumes-the-entire-prefix-";
    created.push(await createWorktreeLive(repo, `${prefix}0-producer-alpha`));
    created.push(await createWorktreeLive(repo, `${prefix}1-producer-beta`));

    assert.equal(
      created.every((worktree) => worktree.isolated),
      true,
    );
    assert.notEqual(created[0]?.cwd, created[1]?.cwd);
    assert.notEqual(created[0]?.branchRef, created[1]?.branchRef);
    for (const worktree of created) {
      assert.ok((worktree.branch?.replace("pi/wf/", "").length ?? Infinity) <= 32);
    }

    await Promise.all(created.map((worktree) => removeWorktree(worktree)));
    const registrations = git("worktree", "list", "--porcelain").toString();
    assert.equal(registrations.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
  } finally {
    await Promise.all(created.filter((worktree) => worktree.isolated).map((worktree) => removeWorktree(worktree)));
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup rejects pre-claim checkout replacement inodes and preserves all unrelated state", async (t) => {
  for (const replacement of ["directory", "symlink", "path-reuse"] as const) {
    await t.test(replacement, async () => {
      const repo = mkdtempSync(join(tmpdir(), `pi-wt-original-inode-${replacement}-`));
      const external = mkdtempSync(join(tmpdir(), `pi-wt-original-inode-${replacement}-external-`));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      try {
        git("init", "-q");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(repo, "file.txt"), "base\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");

        const original = await createWorktreeLive(repo, `original-inode-${replacement}`);
        assert.equal(original.isolated, true);
        const displaced = `${original.cwd}-displaced`;
        const gitPointer = readFileSync(join(original.cwd, ".git"), "utf8");
        const registrationBefore = git("worktree", "list", "--porcelain");
        const markerBefore = readFileSync(
          join(original.cleanupMetadata?.gitDir ?? "", "pi-dynamic-workflows-registration"),
          "utf8",
        );
        renameSync(original.cwd, displaced);

        if (replacement === "symlink") {
          writeFileSync(join(external, ".git"), gitPointer);
          writeFileSync(join(external, "sentinel-private-fragment.txt"), "symlink sentinel survives\n");
          symlinkSync(external, original.cwd, "dir");
        } else {
          const candidate = replacement === "path-reuse" ? join(external, "candidate") : original.cwd;
          mkdirSync(candidate);
          writeFileSync(join(candidate, ".git"), gitPointer);
          writeFileSync(join(candidate, "sentinel-private-fragment.txt"), `${replacement} sentinel survives\n`);
          if (replacement === "path-reuse") renameSync(candidate, original.cwd);
        }

        const roundTripped = JSON.parse(JSON.stringify(structuredClone(original))) as Worktree;
        const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(roundTripped);
        const sentinelRoot = replacement === "symlink" ? external : original.cwd;
        assert.equal(
          readFileSync(join(sentinelRoot, "sentinel-private-fragment.txt"), "utf8"),
          `${replacement === "symlink" ? "symlink" : replacement} sentinel survives\n`,
        );
        assert.equal(git("worktree", "list", "--porcelain"), registrationBefore, "registration remains untouched");
        assert.equal(
          readFileSync(join(original.cleanupMetadata?.gitDir ?? "", "pi-dynamic-workflows-registration"), "utf8"),
          markerBefore,
          "trusted registration marker remains untouched",
        );
        assert.match(git("branch", "--list", original.branch ?? ""), /original-inode/);
        assert.equal(failures.length, 1);
        assert.equal(failures[0]?.stage, "identity_verification");
        const diagnostics = JSON.stringify(failures);
        for (const secret of [
          repo,
          original.cwd,
          external,
          basename(repo),
          basename(external),
          "sentinel-private-fragment",
        ]) {
          assert.equal(diagnostics.includes(secret), false, `diagnostics omit path or path fragment: ${secret}`);
        }
        assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });
  }
});

test("cleanup restores a same-path same-branch replacement raced in after identity verification", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-raced-replacement-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "raced-same-path-same-branch");
    assert.equal(original.isolated, true);
    const operations = createWorktreeOperationsForTesting({
      afterIdentityVerification() {
        git("worktree", "remove", "--force", original.cwd);
        git("branch", "-D", original.branch ?? "");
        git("worktree", "add", "-b", original.branch ?? "", original.cwd, "HEAD");
        writeFileSync(join(original.cwd, "replacement.txt"), "uncommitted replacement must survive\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(readFileSync(join(original.cwd, "replacement.txt"), "utf8"), "uncommitted replacement must survive\n");
    assert.match(git("branch", "--list", original.branch ?? "").toString(), /raced-same-path-same-branch/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /changed|claim|identity/i);

    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", original.branch ?? "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup restores a replacement captured by the atomic claim when the original path remains empty", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-claim-captured-restore-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let original: Worktree | undefined;
  const displacedPath = join(repo, "displaced-original");
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    original = await createWorktreeLive(repo, "captured-replacement-restored");
    assert.equal(original.isolated, true);
    const operations = createWorktreeOperationsForTesting({
      beforeDirectoryClaim(_worktree, kind, sourcePath) {
        if (kind !== "checkout") return;
        renameSync(sourcePath, displacedPath);
        mkdirSync(sourcePath);
        writeFileSync(join(sourcePath, "captured-replacement.txt"), "restore me\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(readFileSync(join(original.cwd, "captured-replacement.txt"), "utf8"), "restore me\n");
    assert.equal(failures.length, 1);
    assert.match(failures[0]?.message ?? "", /cleanup failed.*identity_verification.*recovery ID/i);
  } finally {
    if (original?.isolated) {
      rmSync(original.cwd, { recursive: true, force: true });
      if (existsSync(displacedPath)) renameSync(displacedPath, original.cwd);
      await removeWorktree(original);
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup preserves a captured replacement in quarantine when the original path becomes occupied", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-claim-captured-occupied-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let original: Worktree | undefined;
  const displacedPath = join(repo, "displaced-original");
  let quarantineRoot = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    original = await createWorktreeLive(repo, "captured-replacement-preserved");
    assert.equal(original.isolated, true);
    quarantineRoot = gitCommonRoot(repo);
    const operations = createWorktreeOperationsForTesting({
      beforeDirectoryClaim(_worktree, kind, sourcePath) {
        if (kind !== "checkout") return;
        renameSync(sourcePath, displacedPath);
        mkdirSync(sourcePath);
        writeFileSync(join(sourcePath, "captured-replacement.txt"), "preserve me\n");
      },
      afterDirectoryRename(_worktree, kind, sourcePath) {
        if (kind !== "checkout") return;
        mkdirSync(sourcePath);
        writeFileSync(join(sourcePath, "occupied-original.txt"), "do not replace me\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(readFileSync(join(original.cwd, "occupied-original.txt"), "utf8"), "do not replace me\n");
    const quarantines = directCleanupClaimPaths(repo, "checkout");
    assert.equal(quarantines.length, 1);
    assert.equal(readFileSync(join(quarantines[0] ?? "", "captured-replacement.txt"), "utf8"), "preserve me\n");
    assert.equal(failures.length, 1);
    assert.match(failures[0]?.message ?? "", /cleanup failed.*identity_verification.*recovery ID/i);
    assert.equal((failures[0]?.message ?? "").includes(quarantines[0] ?? ""), false, "nonce path is not diagnosed");
    const serializedFailures = JSON.stringify(failures);
    assert.equal(serializedFailures.includes(original.cleanupMetadata?.registrationMarker ?? "missing-marker"), false);
    assert.equal(serializedFailures.includes("cleanupMetadata"), false);
  } finally {
    if (original?.isolated) {
      rmSync(original.cwd, { recursive: true, force: true });
      for (const claim of directCleanupClaimPaths(repo, "checkout")) rmSync(claim, { recursive: true, force: true });
      for (const record of directCleanupPendingRecords(repo)) rmSync(join(quarantineRoot, record), { force: true });
      if (existsSync(displacedPath)) renameSync(displacedPath, original.cwd);
      await removeWorktree(original);
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup removes only the claimed original when a replacement appears at its former path", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-post-claim-replacement-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const replacementBranch = "pi/wf/post-claim-replacement";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "claimed-original");
    assert.equal(original.isolated, true);
    writeFileSync(join(original.cwd, "original-uncommitted.txt"), "claimed original\n");
    const operations = createWorktreeOperationsForTesting({
      afterWorktreeClaim() {
        git("worktree", "add", "-b", replacementBranch, original.cwd, "HEAD");
        writeFileSync(join(original.cwd, "replacement.txt"), "uncommitted replacement must survive\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.deepEqual(failures, []);
    assert.equal(readFileSync(join(original.cwd, "replacement.txt"), "utf8"), "uncommitted replacement must survive\n");
    assert.match(git("branch", "--list", replacementBranch).toString(), /post-claim-replacement/);
    assert.equal(
      git("branch", "--list", original.branch ?? "")
        .toString()
        .trim(),
      "",
      "only original branch removed",
    );

    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", replacementBranch);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup never deletes a replacement raced into the private quarantine after claim", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-quarantine-replacement-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const replacementBranch = "pi/wf/quarantine-replacement";
  let replacementPath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "quarantine-race-original");
    assert.equal(original.isolated, true);
    const operations = createWorktreeOperationsForTesting({
      afterWorktreeClaim() {
        const candidates = directCleanupClaimPaths(repo, "checkout");
        assert.equal(candidates.length, 1, "the claimed inode is in one private quarantine");
        replacementPath = candidates[0] ?? "";
        const displaced = `${replacementPath}-displaced`;
        renameSync(replacementPath, displaced);
        git("worktree", "add", "-b", replacementBranch, replacementPath, "HEAD");
        writeFileSync(join(replacementPath, "replacement.txt"), "quarantine replacement must survive\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(
      readFileSync(join(replacementPath, "replacement.txt"), "utf8"),
      "quarantine replacement must survive\n",
    );
    assert.match(git("branch", "--list", replacementBranch).toString(), /quarantine-replacement/);
    assert.equal(failures.length, 0);

    git("worktree", "remove", "--force", replacementPath);
    git("branch", "-D", replacementBranch);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup ignores a symlink at the obsolete checkout quarantine root", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-checkout-quarantine-symlink-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "pi-wt-checkout-quarantine-external-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const original = await createWorktreeLive(repo, "checkout-quarantine-symlink");
    writeFileSync(join(externalRoot, "sentinel.txt"), "external contents survive\n");
    const quarantineRoot = checkoutQuarantineRoot(repo);
    symlinkSync(externalRoot, quarantineRoot, "dir");

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(original), []);
    assert.equal(existsSync(original.cwd), false);
    assert.deepEqual(readdirSync(externalRoot), ["sentinel.txt"], "cleanup makes no external writes or deletions");
    assert.equal(readFileSync(join(externalRoot, "sentinel.txt"), "utf8"), "external contents survive\n");
    rmSync(quarantineRoot);
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("cleanup ignores a symlink at the obsolete registration quarantine root", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-registration-quarantine-symlink-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "pi-wt-registration-quarantine-external-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const original = await createWorktreeLive(repo, "registration-quarantine-symlink");
    writeFileSync(join(externalRoot, "sentinel.txt"), "external contents survive\n");
    const quarantineRoot = join(original.cleanupMetadata?.gitCommonRoot ?? "", "pi-dynamic-workflows-cleanup");
    symlinkSync(externalRoot, quarantineRoot, "dir");

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(original), []);
    assert.equal(existsSync(original.cwd), false);
    assert.deepEqual(readdirSync(externalRoot), ["sentinel.txt"], "cleanup makes no external writes or deletions");
    assert.equal(readFileSync(join(externalRoot, "sentinel.txt"), "utf8"), "external contents survive\n");
    rmSync(quarantineRoot);
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("cleanup transaction restores checkout, registration, and branch after each claim stage", async () => {
  const stages = ["checkout", "branch", "registration"] as const;
  for (const stage of stages) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-rollback-${stage}-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      const original = await createWorktreeLive(repo, `rollback-${stage}`);
      assert.equal(original.isolated, true);
      writeFileSync(join(original.cwd, "uncommitted.txt"), `${stage} survives\n`);
      const fail = () => {
        throw new Error(`injected failure after ${stage} claim`);
      };
      const operations = createWorktreeOperationsForTesting({
        ...(stage === "checkout" ? { afterCheckoutClaim: fail } : {}),
        ...(stage === "branch" ? { afterBranchClaim: fail } : {}),
        ...(stage === "registration" ? { afterRegistrationClaim: fail } : {}),
      });

      const failures = await operations.removeWorktree(original);

      assert.equal(failures.length, 1);
      assert.match(failures[0]?.message ?? "", new RegExp(`after ${stage} claim`, "i"));
      assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
      assert.equal(readFileSync(join(original.cwd, "uncommitted.txt"), "utf8"), `${stage} survives\n`);
      assert.equal(realpathSync(original.cwd), original.cwd, "the checkout returns to its exact original cwd");
      assert.equal(realpathSync(original.cleanupMetadata?.gitDir ?? ""), original.cleanupMetadata?.gitDir);
      assert.equal(
        git("rev-parse", "--verify", original.branchRef ?? "")
          .toString()
          .trim().length,
        40,
      );
      assert.equal(
        execFileSync("git", ["-C", original.cwd, "status", "--porcelain"], { encoding: "utf8" }).trim(),
        "?? uncommitted.txt",
      );
      assertCleanupQuarantinesEmpty(repo);

      assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(original), []);
      assertCleanupQuarantinesEmpty(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("registration-content cleanup failure restores every uncommitted checkout file and remains retryable", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-registration-content-failure-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let failRegistrationCleanup = true;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "registration-content-failure");
    assert.equal(original.isolated, true);
    writeFileSync(join(original.cwd, "file.txt"), "tracked modification survives\n");
    mkdirSync(join(original.cwd, "nested"));
    writeFileSync(join(original.cwd, "nested", "first.txt"), "first untracked file\n");
    writeFileSync(join(original.cwd, "nested", "second.txt"), "second untracked file\n");
    const expectedStatus = execFileSync("git", ["-C", original.cwd, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
    });
    const expectedRegistrations = git("worktree", "list", "--porcelain").toString();
    const operations = createWorktreeOperationsForTesting({
      beforeClaimedContentsCleanup(_worktree, kind) {
        if (kind !== "registration" || !failRegistrationCleanup) return;
        failRegistrationCleanup = false;
        throw new Error("injected registration-content cleanup failure");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "worktree_remove");
    assert.match(failures[0]?.message ?? "", /injected registration-content cleanup failure/i);
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
    assert.equal(readFileSync(join(original.cwd, "file.txt"), "utf8"), "tracked modification survives\n");
    assert.equal(readFileSync(join(original.cwd, "nested", "first.txt"), "utf8"), "first untracked file\n");
    assert.equal(readFileSync(join(original.cwd, "nested", "second.txt"), "utf8"), "second untracked file\n");
    assert.equal(
      execFileSync("git", ["-C", original.cwd, "status", "--porcelain", "--untracked-files=all"], {
        encoding: "utf8",
      }),
      expectedStatus,
    );
    assert.equal(git("worktree", "list", "--porcelain").toString(), expectedRegistrations);
    assert.equal(
      git("rev-parse", "--verify", original.branchRef ?? "")
        .toString()
        .trim().length,
      40,
    );
    assert.equal(
      git("for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup").toString().trim(),
      "",
      "rollback removes the deterministic backup ref",
    );
    assertCleanupQuarantinesEmpty(repo);

    assert.deepEqual(await operations.removeWorktree(original), [], "cleanup succeeds on deterministic retry");
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("partial claimed-directory deletion resumes by deterministic identity", async () => {
  for (const failingKind of ["registration", "checkout"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-partial-${failingKind}-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    let injectFailure = true;
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      const original = await createWorktreeLive(repo, `partial-${failingKind}`);
      assert.equal(original.isolated, true);
      writeFileSync(join(original.cwd, "one.txt"), "one\n");
      writeFileSync(join(original.cwd, "two.txt"), "two\n");
      const operations = createWorktreeOperationsForTesting({
        afterClaimedEntryRemoval(_worktree, kind, removedEntries) {
          if (kind !== failingKind || removedEntries !== 1 || !injectFailure) return;
          injectFailure = false;
          throw new Error(`injected partial ${kind} content-deletion failure`);
        },
      });

      const first = await operations.removeWorktree(original);

      assert.equal(first.length, 1);
      assert.equal(first[0]?.stage, "worktree_remove");
      assert.match(first[0]?.message ?? "", new RegExp(`partial ${failingKind} content-deletion failure`, "i"));
      assert.ok((first[0]?.message.length ?? Infinity) <= 1024);
      assert.equal(existsSync(original.cwd), false, "the original mutable checkout pathname is not restored");
      assert.equal(existsSync(original.cleanupMetadata?.gitDir ?? ""), false, "registration stays claimed or is gone");
      assert.equal(
        git("branch", "--list", original.branch ?? "")
          .toString()
          .trim(),
        "",
      );
      assert.notEqual(
        git("for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup").toString().trim(),
        "",
        "the backup ref preserves branch reachability while exact claims are pending",
      );
      assert.equal(
        directCleanupPendingRecords(repo).length > 0,
        true,
        "deterministic pending identity metadata survives the partial deletion",
      );

      assert.deepEqual(await operations.removeWorktree(original), [], "the next release resumes exact pending claims");
      assert.equal(existsSync(original.cwd), false);
      assert.equal(existsSync(original.cleanupMetadata?.gitDir ?? ""), false);
      assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
      assert.equal(
        git("for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup").toString().trim(),
        "",
      );
      assert.equal(
        git("worktree", "list", "--porcelain")
          .toString()
          .split("\n")
          .filter((line) => line.startsWith("worktree ")).length,
        1,
      );
      assertCleanupQuarantinesEmpty(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("permanent partial deletion failure is one bounded attempt per release", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-partial-permanent-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let attempts = 0;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const original = await createWorktreeLive(repo, "partial-permanent");
    const operations = createWorktreeOperationsForTesting({
      afterClaimedEntryRemoval(_worktree, kind, removedEntries) {
        if (kind !== "registration" || removedEntries !== 1) return;
        attempts++;
        throw new Error("permanent partial deletion failure");
      },
    });

    const first = await operations.removeWorktree(original);
    const second = await operations.removeWorktree(original);

    assert.equal(attempts, 2, "each release performs one bounded resume attempt without spinning");
    for (const failures of [first, second]) {
      assert.equal(failures.length, 1);
      assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("final backup-ref deletion failure leaves a retryable private ref after checkout cleanup", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-backup-delete-retry-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let failDeletion = true;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "backup-delete-retry");
    writeFileSync(join(original.cwd, "agent-commit.txt"), "reachable after failed finalization\n");
    execFileSync("git", ["-C", original.cwd, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", original.cwd, "commit", "-q", "-m", "agent commit"], { stdio: "pipe" });
    const claimedOid = execFileSync("git", ["-C", original.cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const operations = createWorktreeOperationsForTesting({
      beforeClaimedBranchDelete() {
        if (!failDeletion) return;
        failDeletion = false;
        throw new Error("injected final backup-ref deletion failure");
      },
    });

    const firstFailures = await operations.removeWorktree(original);
    assert.equal(firstFailures.length, 1);
    assert.equal(firstFailures[0]?.stage, "branch_delete");
    assert.match(firstFailures[0]?.message ?? "", /final backup-ref deletion failure/i);
    assert.match(firstFailures[0]?.message ?? "", /preserved.*internal recovery ref|internal recovery ref.*preserved/i);
    assert.equal((firstFailures[0]?.message ?? "").includes("refs/pi-dynamic-workflows/cleanup"), false);
    assert.equal(existsSync(original.cwd), false, "checkout cleanup completed before final ref deletion");
    assert.equal(existsSync(original.cleanupMetadata?.gitDir ?? ""), false, "registration cleanup completed");
    assert.equal(
      git("branch", "--list", original.branch ?? "")
        .toString()
        .trim(),
      "",
    );
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .match(/^worktree /gm)?.length,
      1,
    );
    const backupRefs = git("for-each-ref", "--format=%(refname) %(objectname)", "refs/pi-dynamic-workflows/cleanup")
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(backupRefs.length, 1);
    assert.equal(backupRefs[0]?.split(" ")[1], claimedOid, "the original commit remains reachable under the backup");
    assert.equal(git("cat-file", "-t", claimedOid).toString().trim(), "commit");

    const roundTripped = JSON.parse(JSON.stringify(original)) as Worktree;
    assert.deepEqual(await operations.removeWorktree(roundTripped), []);
    assert.deepEqual(await operations.removeWorktree(original), [], "successful retry is idempotent");
    assert.equal(
      git("for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup").toString().trim(),
      "",
      "the exact pending backup is removed without leaking refs",
    );
    assertCleanupQuarantinesEmpty(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a competing branch restoration cannot strand the claimed commit without its private backup", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-competing-restore-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "competing-restore");
    writeFileSync(join(original.cwd, "agent-commit.txt"), "original claimed commit\n");
    execFileSync("git", ["-C", original.cwd, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", original.cwd, "commit", "-q", "-m", "agent commit"], { stdio: "pipe" });
    const claimedOid = git("rev-parse", original.branchRef ?? "")
      .toString()
      .trim();
    const competingOid = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "competing commit").toString().trim();
    const operations = createWorktreeOperationsForTesting({
      afterBranchClaim() {
        git("update-ref", original.branchRef ?? "", competingOid);
        throw new Error("injected failure with competing branch restoration");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(failures.length, 1);
    assert.equal(
      git("rev-parse", original.branchRef ?? "")
        .toString()
        .trim(),
      competingOid,
    );
    const backupOids = git("for-each-ref", "--format=%(objectname)", "refs/pi-dynamic-workflows/cleanup")
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(backupOids, [claimedOid]);
    assert.equal(git("cat-file", "-t", claimedOid).toString().trim(), "commit");
    assert.match(failures[0]?.message ?? "", /preserved under an internal recovery ref/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup rollback preserves both claimed and occupying checkout paths with redacted diagnostics", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-rollback-occupied-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "rollback-occupied");
    assert.equal(original.isolated, true);
    writeFileSync(join(original.cwd, "claimed.txt"), "claimed checkout\n");
    const operations = createWorktreeOperationsForTesting({
      afterBranchClaim() {
        mkdirSync(original.cwd);
        writeFileSync(join(original.cwd, "occupant.txt"), "occupying checkout path\n");
        throw new Error("injected occupied rollback");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(readFileSync(join(original.cwd, "occupant.txt"), "utf8"), "occupying checkout path\n");
    const quarantines = directCleanupClaimPaths(repo, "checkout");
    assert.equal(quarantines.length, 1);
    assert.equal(readFileSync(join(quarantines[0] ?? "", "claimed.txt"), "utf8"), "claimed checkout\n");
    assert.equal((failures[0]?.message ?? "").includes(quarantines[0] ?? ""), false);
    assert.match(failures[0]?.message ?? "", /occupied.*preserved|preserved.*occupied/i);
    assert.match(git("branch", "--list", original.branch ?? "").toString(), /rollback-occupied/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch cleanup fails closed when the temporary branch becomes a symbolic ref", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-symref-race-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let original: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const mainBranch = git("branch", "--show-current").toString().trim();
    const mainRef = `refs/heads/${mainBranch}`;
    const mainOid = git("rev-parse", mainRef).toString().trim();
    original = await createWorktreeLive(repo, "symref-race");
    assert.equal(original.isolated, true);
    const operations = createWorktreeOperationsForTesting({
      afterBranchRefRead() {
        git("symbolic-ref", original?.branchRef ?? "", mainRef);
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(git("rev-parse", mainRef).toString().trim(), mainOid, "the symbolic-ref target is untouched");
    assert.equal(
      git("symbolic-ref", original.branchRef ?? "")
        .toString()
        .trim(),
      mainRef,
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /symbolic|direct|branch ref changed/i);
    assert.equal(readFileSync(join(original.cwd, "file.txt"), "utf8"), "base\n", "checkout claim is rolled back");
    assert.equal(realpathSync(original.cleanupMetadata?.gitDir ?? ""), original.cleanupMetadata?.gitDir);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch cleanup refuses a branch already checked out by another registered worktree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-duplicate-branch-before-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const otherPath = join(repo, "other-checkout");
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "duplicate-branch-before");
    assert.equal(original.isolated, true);
    git("worktree", "add", "--force", otherPath, original.branch ?? "");
    writeFileSync(join(otherPath, "other.txt"), "reachable commit\n");
    execFileSync("git", ["-C", otherPath, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", otherPath, "commit", "-q", "-m", "other checkout commit"], { stdio: "pipe" });
    const otherOid = execFileSync("git", ["-C", otherPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(original);

    assert.equal(
      execFileSync("git", ["-C", otherPath, "symbolic-ref", "HEAD"], { encoding: "utf8" }).trim(),
      original.branchRef,
    );
    assert.equal(
      git("rev-parse", original.branchRef ?? "")
        .toString()
        .trim(),
      otherOid,
    );
    assert.equal(git("cat-file", "-t", otherOid).toString().trim(), "commit");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /cleanup failed.*identity_verification.*recovery ID/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch cleanup restores its claim when another checkout races in during the claim", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-duplicate-branch-during-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const otherPath = join(repo, "raced-checkout");
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "duplicate-branch-during");
    assert.equal(original.isolated, true);
    const branchOid = git("rev-parse", original.branchRef ?? "")
      .toString()
      .trim();
    const operations = createWorktreeOperationsForTesting({
      afterBranchRefRead() {
        git("worktree", "add", "--force", otherPath, original.branch ?? "");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(
      execFileSync("git", ["-C", otherPath, "symbolic-ref", "HEAD"], { encoding: "utf8" }).trim(),
      original.branchRef,
    );
    assert.equal(
      git("rev-parse", original.branchRef ?? "")
        .toString()
        .trim(),
      branchOid,
    );
    assert.equal(git("cat-file", "-t", branchOid).toString().trim(), "commit");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /another|other|registered worktree|checked out/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch cleanup compare-and-delete preserves a ref advanced after verification", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-ref-race-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let advancedOid = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "compare-delete-race");
    assert.equal(original.isolated, true);
    const hooks = {
      afterWorktreeClaim() {},
      afterBranchRefRead() {
        advancedOid = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "replacement ref commit").toString().trim();
        git("update-ref", original.branchRef ?? "", advancedOid);
      },
    };
    const operations = createWorktreeOperationsForTesting(hooks);

    const failures = await operations.removeWorktree(original);

    assert.equal(
      git("rev-parse", "--verify", original.branchRef ?? "")
        .toString()
        .trim(),
      advancedOid,
    );
    assert.equal(git("cat-file", "-t", advancedOid).toString().trim(), "commit");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /branch ref changed|claim/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch cleanup preserves the same ref recreated and checked out after the atomic claim", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-ref-recreated-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const replacementPath = join(repo, "replacement-checkout");
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "recreated-ref");
    assert.equal(original.isolated, true);
    const operations = createWorktreeOperationsForTesting({
      afterWorktreeClaim() {
        git("worktree", "add", "-b", original.branch ?? "", replacementPath, "HEAD");
        writeFileSync(join(replacementPath, "replacement.txt"), "recreated branch checkout survives\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.deepEqual(failures, []);
    assert.equal(
      readFileSync(join(replacementPath, "replacement.txt"), "utf8"),
      "recreated branch checkout survives\n",
    );
    assert.match(git("branch", "--list", original.branch ?? "").toString(), /recreated-ref/);

    git("worktree", "remove", "--force", replacementPath);
    git("branch", "-D", original.branch ?? "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree cleans an initialized-submodule checkout without git worktree move", async () => {
  const childRepo = mkdtempSync(join(tmpdir(), "pi-wt-submodule-child-"));
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-submodule-parent-"));
  const childGit = (...args: string[]) => execFileSync("git", ["-C", childRepo, ...args], { stdio: "pipe" });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    childGit("init", "-q");
    childGit("config", "user.email", "t@t.t");
    childGit("config", "user.name", "t");
    writeFileSync(join(childRepo, "child.txt"), "child\n");
    childGit("add", ".");
    childGit("commit", "-q", "-m", "child init");

    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "-C", repo, "submodule", "add", "-q", childRepo, "modules/child"],
      { stdio: "pipe" },
    );
    git("commit", "-q", "-am", "add submodule");

    const worktree = await createWorktreeLive(repo, "initialized-submodule");
    assert.equal(worktree.isolated, true);
    assert.equal(join(worktree.cwd, ".."), gitCommonRoot(repo));
    assert.match(worktree.cwd, /pi-workflow-checkout-/);
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "-C", worktree.cwd, "submodule", "update", "--init", "--recursive"],
      { stdio: "pipe" },
    );
    assert.equal(readFileSync(join(worktree.cwd, "modules", "child", "child.txt"), "utf8"), "child\n");

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree);

    assert.deepEqual(failures, []);
    assert.equal(existsSync(worktree.cwd), false, "the original checkout path is gone");
    assert.equal(
      git("branch", "--list", worktree.branch ?? "")
        .toString()
        .trim(),
      "",
    );
    assert.equal(
      git("worktree", "list", "--porcelain")
        .toString()
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
    assert.equal(
      git("for-each-ref", "--format=%(refname)", "refs/pi-dynamic-workflows/cleanup").toString().trim(),
      "",
      "the private backup ref is removed",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(childRepo, { recursive: true, force: true });
  }
});

test("missing-checkout cleanup preserves a replacement raced in before stale-registration claim", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-missing-raced-replacement-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "missing-raced-replacement");
    assert.equal(original.isolated, true);
    rmSync(original.cwd, { recursive: true, force: true });
    const operations = createWorktreeOperationsForTesting({
      afterIdentityVerification() {
        git("worktree", "remove", "--force", original.cwd);
        git("branch", "-D", original.branch ?? "");
        git("worktree", "add", "-b", original.branch ?? "", original.cwd, "HEAD");
        writeFileSync(join(original.cwd, "replacement.txt"), "missing-path replacement must survive\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(
      readFileSync(join(original.cwd, "replacement.txt"), "utf8"),
      "missing-path replacement must survive\n",
    );
    assert.match(git("branch", "--list", original.branch ?? "").toString(), /missing-raced-replacement/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");

    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", original.branch ?? "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("missing-checkout cleanup never deletes a replacement raced into registration quarantine", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-registration-quarantine-race-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let replacementPath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "registration-quarantine-race");
    assert.equal(original.isolated, true);
    rmSync(original.cwd, { recursive: true, force: true });
    const operations = createWorktreeOperationsForTesting({
      afterRegistrationClaim() {
        const candidates = directCleanupClaimPaths(repo, "registration");
        assert.equal(candidates.length, 1);
        replacementPath = candidates[0] ?? "";
        renameSync(replacementPath, `${replacementPath}-displaced`);
        mkdirSync(replacementPath);
        writeFileSync(join(replacementPath, "replacement.txt"), "registration replacement survives\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.deepEqual(failures, []);
    assert.equal(readFileSync(join(replacementPath, "replacement.txt"), "utf8"), "registration replacement survives\n");
    assert.equal(
      git("branch", "--list", original.branch ?? "")
        .toString()
        .trim(),
      "",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("missing-checkout cleanup fails closed when a replacement appears after registration claim", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-missing-post-claim-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const replacementBranch = "pi/wf/missing-post-claim-replacement";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "missing-post-claim-original");
    assert.equal(original.isolated, true);
    rmSync(original.cwd, { recursive: true, force: true });
    const operations = createWorktreeOperationsForTesting({
      afterRegistrationClaim() {
        git("worktree", "add", "-b", replacementBranch, original.cwd, "HEAD");
        writeFileSync(join(original.cwd, "replacement.txt"), "post-claim replacement must survive\n");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(readFileSync(join(original.cwd, "replacement.txt"), "utf8"), "post-claim replacement must survive\n");
    assert.match(git("branch", "--list", replacementBranch).toString(), /missing-post-claim-replacement/);
    assert.match(git("branch", "--list", original.branch ?? "").toString(), /missing-post-claim-original/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /replacement.*original path/i);

    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", replacementBranch);
    git("branch", "-D", original.branch ?? "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup preserves a replacement worktree whose identity no longer matches", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-replaced-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "replacement-identity-original");
    assert.equal(original.isolated, true);
    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", original.branch ?? "");
    git("worktree", "add", "-b", "pi/wf/unrelated-replacement", original.cwd, "HEAD");
    writeFileSync(join(original.cwd, "unrelated.txt"), "must survive cleanup\n");

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(original);

    assert.equal(existsSync(join(original.cwd, "unrelated.txt")), true, "replacement contents are preserved");
    assert.match(git("branch", "--list", "pi/wf/unrelated-replacement").toString(), /unrelated-replacement/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.match(failures[0]?.message ?? "", /identity|branch ref/i);
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);

    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", "pi/wf/unrelated-replacement");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup preserves a same-path same-branch replacement with a new Git registration", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-same-identity-replaced-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "same-path-same-branch");
    assert.equal(original.isolated, true);
    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", original.branch ?? "");
    git("worktree", "add", "-b", original.branch ?? "", original.cwd, "HEAD");
    writeFileSync(join(original.cwd, "replacement.txt"), "must survive cleanup\n");

    const failures = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(original);

    assert.equal(existsSync(join(original.cwd, "replacement.txt")), true, "replacement contents are preserved");
    assert.match(git("branch", "--list", original.branch ?? "").toString(), /same-path-same-branch/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);

    git("worktree", "remove", "--force", original.cwd);
    git("branch", "-D", original.branch ?? "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("post-create canonicalization failure rolls back the directory, registration, and branch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-finalize-"));
  const baseline = activeCheckoutProofsForTesting().descriptorCount;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  let created: Worktree | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    created = await createWorktreeLive(repo, "canonicalization-failure", {
      async canonicalizePath(path) {
        if (path.includes("pi-workflow-checkout-")) throw new Error("injected canonicalization failure");
        return realpathSync(path);
      },
    });

    assert.equal(created.isolated, false);
    assert.match(created.reason ?? "", /identity_finalization/);
    assert.equal(activeCheckoutProofsForTesting().descriptorCount, baseline, "failed finalization leaks no fd");
    const registrations = git("worktree", "list", "--porcelain").toString();
    assert.equal(registrations.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    assert.equal(git("branch", "--list", "pi/wf/*").toString().trim(), "");
    assert.equal(
      readdirSync(gitCommonRoot(repo)).some((entry) => entry.startsWith("pi-workflow-checkout-")),
      false,
      "the exact Git-common-dir checkout is removed",
    );
  } finally {
    if (created?.isolated) await removeWorktree(created);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("low-level cleanup contains an unexpected failure after atomic claims begin", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-post-claim-failure-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const original = await createWorktreeLive(repo, "post-claim-list-failure");
    assert.equal(original.isolated, true);
    rmSync(original.cwd, { recursive: true, force: true });
    const operations = createWorktreeOperationsForTesting({
      beforePostClaimRegistrationCheck() {
        throw new Error("injected registeredWorktrees failure");
      },
    });

    const failures = await operations.removeWorktree(original);

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "cleanup_dispatch");
    assert.match(failures[0]?.message ?? "", /registeredWorktrees failure/);
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
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

test("current cleanup claims ignore attacker-rebound legacy quarantine roots", async (t) => {
  for (const targetKind of ["checkout", "registration"] as const) {
    await t.test(targetKind, async () => {
      const repo = mkdtempSync(join(tmpdir(), `pi-wt-old-root-swap-${targetKind}-`));
      const external = mkdtempSync(join(tmpdir(), `pi-wt-old-root-swap-${targetKind}-external-`));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      let oldRoot = "";
      let displaced = "";
      let observedExternalClaim = false;
      try {
        git("init", "-q");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(repo, "file.txt"), "base\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");
        writeFileSync(join(external, "probe.txt"), "external must survive\n");

        const worktree = await createWorktreeLive(repo, `old-root-swap-${targetKind}`);
        oldRoot = join(
          gitCommonRoot(repo),
          targetKind === "checkout" ? "pi-dynamic-workflows-checkout-cleanup" : "pi-dynamic-workflows-cleanup",
        );
        displaced = `${oldRoot}-trusted`;
        const operations = createWorktreeOperationsForTesting({
          beforeDirectoryClaim(_worktree, kind) {
            if (kind !== targetKind) return;
            if (!existsSync(oldRoot)) mkdirSync(oldRoot);
            renameSync(oldRoot, displaced);
            symlinkSync(external, oldRoot, "dir");
          },
          afterDirectoryRename(_worktree, kind) {
            if (kind === targetKind)
              observedExternalClaim = readdirSync(external).some((entry) => entry !== "probe.txt");
          },
        });
        assert.deepEqual(await operations.removeWorktree(worktree), []);
        assert.equal(observedExternalClaim, false, "cleanup never moves an owned inode through a rebound old root");
        assert.equal(readFileSync(join(external, "probe.txt"), "utf8"), "external must survive\n");
      } finally {
        if (oldRoot && existsSync(oldRoot)) rmSync(oldRoot, { recursive: true, force: true });
        if (displaced && existsSync(displaced)) renameSync(displaced, oldRoot);
        rmSync(external, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

test("direct-child cleanup claim replacement collisions fail closed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-direct-claim-collision-"));
  const external = mkdtempSync(join(tmpdir(), "pi-wt-direct-claim-collision-external-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let collisionPath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(external, "probe.txt"), "collision target survives\n");

    const worktree = await createWorktreeLive(repo, "direct-claim-collision");
    if (worktree.cleanupMetadata?.version !== 4) throw new Error("expected current cleanup metadata");
    const metadata = worktree.cleanupMetadata;
    const normalized = {
      version: 4,
      registrationMarker: metadata.registrationMarker,
      repoRoot: metadata.repoRoot,
      worktreePath: metadata.worktreePath,
      checkoutIdentity: metadata.checkoutIdentity,
      branch: metadata.branch,
      branchRef: metadata.branchRef,
      baseSha: metadata.baseSha,
      gitCommonRoot: metadata.gitCommonRoot,
      gitDir: metadata.gitDir,
      checkoutProof: metadata.checkoutProof,
      gitDirIdentity: metadata.gitDirIdentity,
      ...(metadata.gitDirProof ? { gitDirProof: metadata.gitDirProof } : {}),
    };
    const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    collisionPath = join(gitCommonRoot(repo), `.pi-dynamic-workflows-checkout-cleanup-${digest}`);
    const failures = await createWorktreeOperationsForTesting({
      beforeDirectoryClaim(_candidate, kind) {
        if (kind === "checkout") symlinkSync(external, collisionPath, "dir");
      },
    }).removeWorktree(worktree);

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, "identity_verification");
    assert.equal(existsSync(worktree.cwd), true, "collision preserves the original checkout");
    assert.equal(realpathSync(collisionPath), external, "collision is not replaced");
    assert.equal(readFileSync(join(external, "probe.txt"), "utf8"), "collision target survives\n");
    rmSync(collisionPath);
    collisionPath = "";
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
  } finally {
    if (collisionPath) rmSync(collisionPath, { force: true });
    rmSync(external, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unsupported Git-directory descriptors use a portable registration-local sentinel", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-portable-gitdir-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const baseline = activeCheckoutProofsForTesting();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    for (const code of ["EISDIR", "ENOTSUP"] as const) {
      const worktree = await createWorktreeLive(repo, `portable-gitdir-${code}`, {
        gitDirectoryDescriptorErrorCode: code,
      } as never);
      assert.equal(worktree.isolated, true, worktree.reason);
      const metadata = worktree.cleanupMetadata as unknown as {
        version: number;
        gitDirProof?: { kind: string; fileName: string; token: string };
      };
      assert.equal(metadata.gitDirProof?.kind, "sentinel");
      assert.match(metadata.gitDirProof?.fileName ?? "", /^\.pi-dynamic-workflows-registration-identity-/);
      if (code === "ENOTSUP") {
        const registry = new RetainedWorktreeRegistry();
        const handle = registry.register(worktree);
        await registry.release(handle);
      } else {
        assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
      }
      assertNoCreationArtifacts(repo);
    }
    assert.deepEqual(activeCheckoutProofsForTesting(), baseline, "portable finalization and cleanup leak no handles");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("registration direct-child replacement collisions fail closed and restore the checkout claim", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-registration-claim-collision-"));
  const external = mkdtempSync(join(tmpdir(), "pi-wt-registration-claim-collision-external-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let collisionPath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(external, "probe.txt"), "registration collision survives\n");
    const worktree = await createWorktreeLive(repo, "registration-claim-collision");
    if (worktree.cleanupMetadata?.version !== 4) throw new Error("expected current cleanup metadata");
    const metadata = worktree.cleanupMetadata;
    const normalized = {
      version: 4,
      registrationMarker: metadata.registrationMarker,
      repoRoot: metadata.repoRoot,
      worktreePath: metadata.worktreePath,
      checkoutIdentity: metadata.checkoutIdentity,
      branch: metadata.branch,
      branchRef: metadata.branchRef,
      baseSha: metadata.baseSha,
      gitCommonRoot: metadata.gitCommonRoot,
      gitDir: metadata.gitDir,
      checkoutProof: metadata.checkoutProof,
      gitDirIdentity: metadata.gitDirIdentity,
      ...(metadata.gitDirProof ? { gitDirProof: metadata.gitDirProof } : {}),
    };
    const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    collisionPath = join(gitCommonRoot(repo), `.pi-dynamic-workflows-registration-cleanup-${digest}`);
    const failures = await createWorktreeOperationsForTesting({
      beforeDirectoryClaim(_candidate, kind) {
        if (kind === "registration") symlinkSync(external, collisionPath, "dir");
      },
    }).removeWorktree(worktree);
    assert.equal(failures.length, 1);
    assert.equal(existsSync(worktree.cwd), true, "the preclaimed checkout is restored without destructive work");
    assert.equal(existsSync(metadata.gitDir), true, "the original registration is untouched");
    assert.equal(realpathSync(collisionPath), external);
    assert.equal(readFileSync(join(external, "probe.txt"), "utf8"), "registration collision survives\n");
    rmSync(collisionPath);
    collisionPath = "";
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
  } finally {
    if (collisionPath) rmSync(collisionPath, { force: true });
    rmSync(external, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("portable Git-registration sentinels reject directory and sentinel inode replacement", async (t) => {
  for (const replacement of ["directory", "sentinel"] as const) {
    await t.test(replacement, async () => {
      const repo = mkdtempSync(join(tmpdir(), `pi-wt-portable-registration-${replacement}-`));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      try {
        git("init", "-q");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(repo, "file.txt"), "base\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");
        const worktree = await createWorktreeLive(repo, `portable-registration-${replacement}`, {
          gitDirectoryDescriptorErrorCode: "EISDIR",
        } as never);
        if (worktree.cleanupMetadata?.version !== 4 || worktree.cleanupMetadata.gitDirProof?.kind !== "sentinel") {
          throw new Error("expected portable Git registration proof");
        }
        const metadata = worktree.cleanupMetadata;
        const displaced = `${metadata.gitDir}-displaced`;
        if (replacement === "directory") {
          renameSync(metadata.gitDir, displaced);
          cpSync(displaced, metadata.gitDir, { recursive: true });
          writeFileSync(join(metadata.gitDir, "replacement.txt"), "replacement survives\n");
        } else {
          const sentinelPath = join(metadata.gitDir, metadata.gitDirProof.fileName);
          renameSync(sentinelPath, displaced);
          cpSync(displaced, sentinelPath);
        }
        const failures = await createWorktreeOperationsForTesting({
          simulateReusedGitDirIdentity: replacement === "directory",
        }).removeWorktree(worktree);
        assert.equal(failures.length, 1);
        assert.equal(failures[0]?.stage, "identity_verification");
        assert.equal(existsSync(worktree.cwd), true);
        if (replacement === "directory") {
          assert.equal(readFileSync(join(metadata.gitDir, "replacement.txt"), "utf8"), "replacement survives\n");
          rmSync(metadata.gitDir, { recursive: true, force: true });
          renameSync(displaced, metadata.gitDir);
        } else {
          rmSync(join(metadata.gitDir, metadata.gitDirProof.fileName));
          renameSync(displaced, join(metadata.gitDir, metadata.gitDirProof.fileName));
        }
        assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree), []);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

test("retained terminal cleanup disposes proofs after its final failed attempt", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-terminal-proof-disposal-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const baseline = activeCheckoutProofsForTesting();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const worktree = await createWorktreeLive(repo, "terminal-proof-disposal");
    const registry = new RetainedWorktreeRegistry(
      createWorktreeOperationsForTesting({
        afterIdentityVerification() {
          throw new Error("permanent cleanup failure");
        },
      }),
    );
    const handle = registry.register(worktree);
    await registry.release(handle);
    assert.notDeepEqual(activeCheckoutProofsForTesting(), baseline, "explicit failure preserves retry proofs");
    await registry.cleanupAll();
    assert.deepEqual(activeCheckoutProofsForTesting(), baseline, "terminal failure disposes every proof handle");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("version-two cleanup captures an agent commit as its cleanup CAS target", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-v2-agent-commit-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const current = await createWorktreeLive(repo, "v2-agent-commit");
    if (current.cleanupMetadata?.version !== 4) throw new Error("expected current metadata");
    const {
      checkoutIdentity: _a,
      checkoutProof: _b,
      gitDirIdentity: _c,
      version: _d,
      ...fields
    } = current.cleanupMetadata;
    const legacy = { ...current, cleanupMetadata: { version: 2 as const, ...fields } };
    writeFileSync(
      join(current.cleanupMetadata.gitDir, "pi-dynamic-workflows-registration"),
      `${JSON.stringify(legacy.cleanupMetadata)}\n`,
    );
    writeFileSync(join(current.cwd, "agent.txt"), "committed by agent\n");
    execFileSync("git", ["-C", current.cwd, "add", "."]);
    execFileSync("git", ["-C", current.cwd, "commit", "-q", "-m", "agent commit"]);

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(JSON.parse(JSON.stringify(legacy))), []);
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("version-three cleanup upgrades exact same-process identities across clone formats and proof modes", async (t) => {
  for (const mode of ["descriptor", "portable"] as const) {
    await t.test(mode, async () => {
      const repo = mkdtempSync(join(tmpdir(), `pi-wt-v3-${mode}-`));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      const baseline = activeCheckoutProofsForTesting();
      try {
        git("init", "-q");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(repo, "file.txt"), "base\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");
        const current = await createWorktreeLive(repo, `v3-${mode}`);
        if (current.cleanupMetadata?.version !== 4) throw new Error("expected current metadata");
        const {
          checkoutProof: _a,
          gitDirIdentity: _b,
          gitDirProof: _c,
          version: _d,
          ...fields
        } = current.cleanupMetadata;
        const original = { ...current, cleanupMetadata: { version: 3 as const, ...fields } };
        const legacy = (
          mode === "descriptor" ? structuredClone(original) : JSON.parse(JSON.stringify(original))
        ) as Worktree;
        const markerPath = join(current.cleanupMetadata.gitDir, "pi-dynamic-workflows-registration");
        writeFileSync(markerPath, `${JSON.stringify(legacy.cleanupMetadata)}\n`);
        writeFileSync(join(current.cwd, "agent.txt"), "mutable branch commit\n");
        execFileSync("git", ["-C", current.cwd, "add", "."]);
        execFileSync("git", ["-C", current.cwd, "commit", "-q", "-m", "agent commit"]);

        let failFirstCleanup = true;
        const operations = createWorktreeOperationsForTesting({
          ...(mode === "portable" ? { gitDirectoryDescriptorErrorCode: "EISDIR" as const } : {}),
          afterIdentityVerification() {
            if (!failFirstCleanup) return;
            failFirstCleanup = false;
            throw new Error("first v3 cleanup fails after upgrade");
          },
        } as never);
        const first = await operations.removeWorktree(legacy);
        assert.equal(first.length, 1);
        const upgradedContents = readFileSync(markerPath, "utf8");
        const upgraded = JSON.parse(upgradedContents) as {
          version: number;
          gitDirProof?: { kind: string };
          baseSha: string;
        };
        assert.equal(upgraded.version, 4);
        assert.equal(upgraded.gitDirProof?.kind, mode === "portable" ? "sentinel" : "descriptor");
        assert.equal(
          upgraded.baseSha,
          execFileSync("git", ["-C", current.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          "upgrade captures the mutable branch tip",
        );

        writeFileSync(
          markerPath,
          `${JSON.stringify({ ...upgraded, registrationMarker: "00000000-0000-4000-8000-000000000000" })}\n`,
        );
        const replacementFailure = await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(legacy);
        assert.equal(replacementFailure.length, 1, "the original v3 value never adopts a replacement marker");
        assert.equal(existsSync(current.cwd), true);

        writeFileSync(markerPath, upgradedContents);
        assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(legacy), []);
        assert.deepEqual(activeCheckoutProofsForTesting(), baseline);
        assertNoCreationArtifacts(repo);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

test("final creation revalidation rejects same-path replacement identities before agent handoff", async () => {
  for (const replacement of ["checkout", "gitdir", "checkout-sentinel", "gitdir-sentinel", "exclude"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-final-revalidation-${replacement}-`));
    const external = mkdtempSync(join(tmpdir(), `pi-wt-final-revalidation-${replacement}-external-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    const baseline = activeCheckoutProofsForTesting();
    let displaced = "";
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      writeFileSync(join(external, "sentinel.txt"), "external survives\n");

      const result = await createWorktreeLive(repo, `final-revalidation-${replacement}`, {
        ...(replacement === "checkout-sentinel" || replacement === "exclude"
          ? { directoryDescriptorMode: "unsupported" as const }
          : {}),
        ...(replacement === "gitdir-sentinel" ? { gitDirectoryDescriptorErrorCode: "EISDIR" as const } : {}),
        afterRegistrationRecordWrite(metadata) {
          if (replacement === "checkout") {
            displaced = `${metadata.worktreePath}-owned`;
            renameSync(metadata.worktreePath, displaced);
            mkdirSync(metadata.worktreePath);
            writeFileSync(join(metadata.worktreePath, "replacement-sentinel.txt"), "replacement survives\n");
          } else if (replacement === "gitdir") {
            displaced = `${metadata.gitDir}-owned`;
            renameSync(metadata.gitDir, displaced);
            mkdirSync(metadata.gitDir);
            writeFileSync(join(metadata.gitDir, "replacement-sentinel.txt"), "replacement survives\n");
          } else if (replacement === "checkout-sentinel") {
            if (metadata.checkoutProof.kind !== "sentinel") throw new Error("expected portable checkout proof");
            const sentinelPath = join(metadata.worktreePath, metadata.checkoutProof.fileName);
            displaced = `${sentinelPath}-owned`;
            renameSync(sentinelPath, displaced);
            writeFileSync(sentinelPath, "replacement survives\n");
          } else if (replacement === "gitdir-sentinel") {
            if (metadata.gitDirProof?.kind !== "sentinel") throw new Error("expected portable Git-directory proof");
            const sentinelPath = join(metadata.gitDir, metadata.gitDirProof.fileName);
            displaced = `${sentinelPath}-owned`;
            renameSync(sentinelPath, displaced);
            writeFileSync(sentinelPath, "replacement survives\n");
          } else {
            displaced = `${excludePath(repo)}-owned`;
            renameSync(excludePath(repo), displaced);
            writeFileSync(excludePath(repo), "replacement survives\n");
          }
        },
      } as never);

      assert.equal(result.isolated, false, `${replacement} replacement is never handed to an agent`);
      assert.match(result.reason ?? "", /identity_finalization/);
      assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "external survives\n");
      const recovery = (result as Worktree & { creationRecoveryWorktree?: Worktree }).creationRecoveryWorktree;
      if (recovery) {
        if (replacement === "gitdir") {
          const metadata = recovery.cleanupMetadata;
          if (metadata?.version !== 4) throw new Error("expected current recovery metadata");
          assert.equal(
            readFileSync(join(metadata.gitDir, "replacement-sentinel.txt"), "utf8"),
            "replacement survives\n",
          );
          rmSync(metadata.gitDir, { recursive: true, force: true });
          renameSync(displaced, metadata.gitDir);
        } else if (replacement === "checkout-sentinel") {
          const metadata = recovery.cleanupMetadata;
          if (metadata?.version !== 4 || metadata.checkoutProof.kind !== "sentinel") {
            throw new Error("expected portable recovery metadata");
          }
          const sentinelPath = join(metadata.worktreePath, metadata.checkoutProof.fileName);
          assert.equal(readFileSync(sentinelPath, "utf8"), "replacement survives\n");
          rmSync(sentinelPath);
          renameSync(displaced, sentinelPath);
        } else if (replacement === "gitdir-sentinel") {
          const metadata = recovery.cleanupMetadata;
          if (metadata?.version !== 4 || metadata.gitDirProof?.kind !== "sentinel") {
            throw new Error("expected portable Git-directory recovery metadata");
          }
          const sentinelPath = join(metadata.gitDir, metadata.gitDirProof.fileName);
          assert.equal(readFileSync(sentinelPath, "utf8"), "replacement survives\n");
          rmSync(sentinelPath);
          renameSync(displaced, sentinelPath);
        } else if (replacement === "exclude") {
          assert.equal(readFileSync(excludePath(repo), "utf8"), "replacement survives\n");
          rmSync(excludePath(repo));
          renameSync(displaced, excludePath(repo));
        }
        assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(recovery), []);
      }
      if (replacement === "checkout") {
        const replacementPath = readdirSync(gitCommonRoot(repo))
          .filter((entry) => entry.startsWith("pi-workflow-checkout-"))
          .map((entry) => join(gitCommonRoot(repo), entry))
          .find((path) => existsSync(join(path, "replacement-sentinel.txt")));
        assert.ok(replacementPath);
        assert.equal(readFileSync(join(replacementPath, "replacement-sentinel.txt"), "utf8"), "replacement survives\n");
        rmSync(replacementPath, { recursive: true, force: true });
      }
      assert.deepEqual(activeCheckoutProofsForTesting(), baseline);
      assertNoCreationArtifacts(repo);
    } finally {
      rmSync(external, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("portable creation rolls back exact sentinel state when initial registration persistence fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-registration-write-rollback-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const baseline = activeCheckoutProofsForTesting();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const initial = "# caller-owned\n*.keep";
    writeFileSync(excludePath(repo), initial);
    chmodSync(excludePath(repo), 0o640);
    const hardlinkPath = join(gitCommonRoot(repo), "info", "exclude-registration-write-hardlink");
    linkSync(excludePath(repo), hardlinkPath);
    const metadataBefore = statSync(excludePath(repo));
    let writes = 0;

    const result = await createWorktreeLive(repo, "registration-write-rollback", {
      directoryDescriptorMode: "unsupported",
      beforeRegistrationRecordWrite() {
        writes += 1;
        if (writes === 1) throw new Error("injected initial registration write failure");
      },
    } as never);

    assert.equal(result.isolated, false);
    assert.match(result.reason ?? "", /identity_finalization/);
    assert.equal(writes, 1, "registration persistence failure rolls back from the complete in-memory identity");
    const after = readFileSync(excludePath(repo), "utf8");
    assert.equal(after.slice(0, initial.length), initial);
    assert.match(after.slice(initial.length), /^\n# *\n# *\n$/);
    assert.equal(after.includes("pi-dynamic-workflows-owned-sentinel"), false);
    assert.equal(readFileSync(hardlinkPath, "utf8"), after);
    assert.equal(statSync(excludePath(repo)).ino, metadataBefore.ino);
    assert.equal(statSync(excludePath(repo)).mode & 0o777, metadataBefore.mode & 0o777);
    assert.equal(isGitIgnored(repo, "probe.keep"), true);
    assert.deepEqual(activeCheckoutProofsForTesting(), baseline);
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("marker-write recovery retries every identity-bound rollback stage", async () => {
  for (const stage of [
    "afterIdentityVerification",
    "afterCheckoutClaim",
    "afterBranchClaim",
    "afterRegistrationClaim",
    "beforeClaimedContentsCleanup",
  ] as const) {
    const repo = mkdtempSync(join(tmpdir(), `pi-wt-marker-stage-${stage}-`));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    const baseline = activeCheckoutProofsForTesting();
    let failStage = true;
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      const hook = () => {
        if (failStage) throw new Error(`injected ${stage} failure`);
      };
      const result = await createWorktreeLive(repo, `marker-stage-${stage}`, {
        beforeRegistrationRecordWrite(metadata) {
          if (stage === "afterIdentityVerification") {
            writeFileSync(join(metadata.gitDir, "pi-dynamic-workflows-registration"), "{partial\n");
          }
          throw new Error("injected marker failure");
        },
        creationCleanupHooks: { [stage]: hook },
      } as never);
      assert.equal(result.isolated, false);
      assert.ok((result.recoveryFailures?.length ?? 0) >= 1);
      const recovery = (result as Worktree & { creationRecoveryWorktree?: Worktree }).creationRecoveryWorktree;
      assert.ok(recovery, `${stage} retains exact root-owned retry authority`);
      failStage = false;
      assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(recovery), []);
      assertNoCreationArtifacts(repo);
      assert.deepEqual(activeCheckoutProofsForTesting(), baseline);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("repeated registration rollback failures retain bounded root-owned recovery and no terminal leaks", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-registration-write-persisted-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const baseline = activeCheckoutProofsForTesting();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const initial = "# retained caller rule\n*.keep\n";
    writeFileSync(excludePath(repo), initial);
    let writes = 0;
    let failRollback = true;
    const failSentinelRollback = () => {
      if (failRollback) throw new Error(`sentinel restore failure ${"y".repeat(5000)}`);
    };

    const result = await createWorktreeLive(repo, "registration-write-persisted", {
      directoryDescriptorMode: "unsupported",
      beforeRegistrationRecordWrite() {
        writes += 1;
        throw new Error(`repeated registration failure ${"x".repeat(5000)}`);
      },
      creationCleanupHooks: { beforeSentinelExcludeNeutralize: failSentinelRollback },
    } as never);

    assert.equal(result.isolated, false);
    assert.equal(writes, 1);
    assert.ok((result.recoveryFailures?.length ?? 0) >= 1);
    for (const failure of result.recoveryFailures ?? []) {
      assert.ok(failure.message.length <= 1024);
      assert.equal(JSON.stringify(failure).includes(repo), false);
    }
    assert.match(result.reason ?? "", /identity_finalization.*cleanup failure/i);
    assert.match(readFileSync(excludePath(repo), "utf8"), /pi-dynamic-workflows-owned-sentinel/);
    const registered = git("worktree", "list", "--porcelain");
    assert.equal(registered.includes("pi-workflow-checkout-"), false, "failed destructive cleanup is retryable");
    assert.equal(git("branch", "--list", "pi/wf/registration-write-persisted").trim(), "");
    const recovery = (result as Worktree & { creationRecoveryWorktree?: Worktree }).creationRecoveryWorktree;
    assert.ok(recovery, "failed immediate rollback returns root-owned retry identity");
    const retrying = createWorktreeOperationsForTesting({
      beforeSentinelExcludeNeutralize: failSentinelRollback,
    } as never);
    const repeated = await retrying.removeWorktree(recovery);
    assert.equal(repeated.length, 1);
    assert.ok((repeated[0]?.message.length ?? Infinity) <= 1024);
    failRollback = false;
    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(recovery), []);
    assert.deepEqual(activeCheckoutProofsForTesting(), baseline, "successful terminal retry disposes every proof fd");
    assertNoCreationArtifacts(repo);
  } finally {
    for (const line of git("worktree", "list", "--porcelain").split("\n")) {
      if (line.startsWith("worktree ") && line.slice("worktree ".length) !== repo) {
        try {
          git("worktree", "remove", "--force", line.slice("worktree ".length));
        } catch {
          // Best-effort fixture cleanup.
        }
      }
    }
    if (git("branch", "--list", "pi/wf/registration-write-persisted").trim()) {
      git("branch", "-D", "pi/wf/registration-write-persisted");
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the original version-two value adopts its exact upgraded marker after a failed first cleanup", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-v2-upgrade-retry-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const baseline = activeCheckoutProofsForTesting();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const current = await createWorktreeLive(repo, "v2-upgrade-retry");
    if (current.cleanupMetadata?.version !== 4) throw new Error("expected current metadata");
    const {
      checkoutIdentity: _a,
      checkoutProof: _b,
      gitDirIdentity: _c,
      version: _d,
      ...fields
    } = current.cleanupMetadata;
    const legacy = JSON.parse(
      JSON.stringify({ ...current, cleanupMetadata: { version: 2 as const, ...fields } }),
    ) as Worktree;
    writeFileSync(
      join(current.cleanupMetadata.gitDir, "pi-dynamic-workflows-registration"),
      `${JSON.stringify(legacy.cleanupMetadata)}\n`,
    );
    const first = await createWorktreeOperationsForTesting({
      afterIdentityVerification() {
        throw new Error("first cleanup fails after upgrade");
      },
    }).removeWorktree(legacy);
    assert.equal(first.length, 1);
    assert.notDeepEqual(activeCheckoutProofsForTesting(), baseline, "the retry still owns its proofs");

    assert.deepEqual(await DEFAULT_WORKTREE_OPERATIONS.removeWorktree(legacy), []);
    assert.deepEqual(activeCheckoutProofsForTesting(), baseline);
    assertNoCreationArtifacts(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
