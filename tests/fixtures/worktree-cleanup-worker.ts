import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWorktree, createWorktreeOperationsForTesting } from "../../src/worktree.js";

const [repo, name, probeRoot, mode] = process.argv.slice(2);
if (!repo || !name || !probeRoot || (mode !== "same-repo" && mode !== "different-repo" && mode !== "stale-race")) {
  throw new Error("expected repository, worktree name, probe root, and worker mode");
}

const worktree = await createWorktree(repo, name);
if (!worktree.isolated) throw new Error(`worker worktree creation failed: ${worktree.reason}`);
const ready = join(probeRoot, `ready-${process.pid}`);
writeFileSync(ready, "ready\n", { flag: "wx" });
for (let attempt = 0; attempt < 500; attempt++) {
  if (readdirSync(probeRoot).filter((entry) => entry.startsWith("ready-")).length >= 2) break;
  await delay(10);
  if (attempt === 499) throw new Error("cleanup workers did not become ready together");
}

const active = join(probeRoot, "active");
const holderEntered = join(probeRoot, "holder-entered");
const entered = join(probeRoot, `entered-${process.pid}`);
const events = join(probeRoot, "events.log");
let ownsActive = false;

const operations = createWorktreeOperationsForTesting({
  async beforePostClaimRegistrationCheck() {
    appendFileSync(events, `enter ${process.pid}\n`);
    if (mode !== "different-repo") {
      mkdirSync(active);
      ownsActive = true;
      if (name.endsWith("one")) {
        writeFileSync(holderEntered, "entered\n", { flag: "wx" });
        await delay(1_200);
      }
      return;
    }

    writeFileSync(entered, "entered\n", { flag: "wx" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (readdirSync(probeRoot).filter((entry) => entry.startsWith("entered-")).length >= 2) return;
      await delay(10);
    }
    throw new Error("unrelated repository cleanup did not overlap");
  },
  afterRegistrationClaim() {
    appendFileSync(events, `exit ${process.pid}\n`);
    if (ownsActive && existsSync(active)) rmSync(active, { recursive: true });
  },
});

try {
  if (mode === "stale-race") {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (existsSync(join(probeRoot, "go"))) break;
      await delay(10);
      if (attempt === 499) throw new Error("stale-reclaim workers were not released");
    }
  }
  if (mode !== "different-repo" && name.endsWith("two")) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (existsSync(holderEntered)) break;
      await delay(10);
      if (attempt === 499) throw new Error("the first cleanup never acquired the repository lock");
    }
  }
  const failures = await operations.removeWorktree(worktree);
  if (ownsActive && existsSync(active)) rmSync(active, { recursive: true });
  process.stdout.write(`${JSON.stringify(failures)}\n`);
  process.exitCode = failures.length === 0 ? 0 : 2;
} catch (error) {
  if (ownsActive && existsSync(active)) rmSync(active, { recursive: true });
  throw error;
}
