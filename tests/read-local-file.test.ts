import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const RUNNER = {
  async run(_prompt: string) {
    return "mech never reads state";
  },
};

/** runWorkflow returns either the script value or the run envelope — unwrap both shapes. */
function unwrap(run: unknown): unknown {
  return run !== null && typeof run === "object" && "result" in run ? (run as { result: unknown }).result : run;
}

test("readLocalFile returns the file's raw utf-8 bytes into the vm realm", async () => {
  const root = mkdtempSync(join(tmpdir(), "read-local-file-"));
  const target = join(root, "capture.txt");
  const want = 'epoch=1791234567\nWROTE=12\nline "three" — unicode ✓\n';
  try {
    writeFileSync(target, want);
    const run = await runWorkflow(
      `export const meta = { name: 'read_local_file', description: 'raw round-trip' }
return readLocalFile(${JSON.stringify(target)}, { maxBytes: 1024 * 1024 })`,
      { agent: RUNNER, persistLogs: false, maxAgents: 0 },
    );
    assert.equal(unwrap(run), want, "bytes arrive untrimmed and unre-encoded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readLocalFile maxBytes: byte-size boundary passes, one byte over throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "read-local-file-"));
  try {
    const target = join(root, "sized.txt");
    const content = "a".repeat(100) + "é";
    writeFileSync(target, content);
    const bytes = Buffer.byteLength(content, "utf8");

    const ok = await runWorkflow(
      `export const meta = { name: 'read_local_file', description: 'boundary ok' }
return readLocalFile(${JSON.stringify(target)}, { maxBytes: ${bytes} })`,
      { agent: RUNNER, persistLogs: false, maxAgents: 0 },
    );
    assert.equal(unwrap(ok), content);

    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'read_local_file', description: 'oversized' }
return readLocalFile(${JSON.stringify(target)}, { maxBytes: ${bytes - 1} })`,
          { agent: RUNNER, persistLogs: false },
        ),
      /exceeds maxBytes/,
      "an oversized read throws instead of returning bytes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readLocalFile rejects an empty path and is optional on maxBytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "read-local-file-"));
  const target = join(root, "capture.txt");
  try {
    writeFileSync(target, "x");
    const run = await runWorkflow(
      `export const meta = { name: 'read_local_file', description: 'no maxBytes' }
return readLocalFile(${JSON.stringify(target)})`,
      { agent: RUNNER, persistLogs: false, maxAgents: 0 },
    );
    assert.equal(unwrap(run), "x");

    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'read_local_file', description: 'empty path' }
return readLocalFile('')`,
          { agent: RUNNER, persistLogs: false },
        ),
      /path must be a non-empty string/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
