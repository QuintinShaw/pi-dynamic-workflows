import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acceptWorkflowGuidance } from "../src/accept-workflow-guidance.js";
import { WORKFLOW_AUTHORING_FROZEN_FILES } from "../src/workflow-authoring-coverage.js";

const ROOT = join(import.meta.dirname, "..");
const MANIFEST_PATH = "src/workflow-authoring-coverage.ts";
const REVIEWED_GUIDANCE = "reviewed guidance\n";
const REVIEWED_GUIDANCE_SHA256 = "9cfddc2c9df03bc3982e49cf7c29b91901e55473716626333a7ca9c6d9ea036e";

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "workflow-guidance-accept-"));
  const manifest = join(root, MANIFEST_PATH);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, readFileSync(join(ROOT, MANIFEST_PATH), "utf8"));
  return root;
}

function writeGuidance(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

test("accepts only explicitly named frozen workflow guidance", () => {
  const root = createFixture();
  const accepted = WORKFLOW_AUTHORING_FROZEN_FILES[0];
  const untouched = WORKFLOW_AUTHORING_FROZEN_FILES[1];
  try {
    writeGuidance(root, accepted.path, REVIEWED_GUIDANCE);
    writeGuidance(root, untouched.path, "also changed but not accepted\n");

    const result = acceptWorkflowGuidance(root, [accepted.path]);

    assert.deepEqual(result, [
      {
        path: accepted.path,
        previousSha256: accepted.sha256,
        sha256: REVIEWED_GUIDANCE_SHA256,
        changed: true,
      },
    ]);
    const manifest = readFileSync(join(root, MANIFEST_PATH), "utf8");
    assert.match(manifest, new RegExp(`path: "${accepted.path}"[\\s\\S]*?sha256: "${REVIEWED_GUIDANCE_SHA256}"`));
    assert.match(manifest, new RegExp(`path: "${untouched.path}"[\\s\\S]*?sha256: "${untouched.sha256}"`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an unknown guidance path without changing the manifest", () => {
  const root = createFixture();
  const before = readFileSync(join(root, MANIFEST_PATH), "utf8");
  try {
    assert.throws(
      () => acceptWorkflowGuidance(root, ["skills/workflow-authoring/references/not-frozen.md"]),
      /not a frozen workflow-authoring guidance file/i,
    );
    assert.equal(readFileSync(join(root, MANIFEST_PATH), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires at least one explicit guidance path", () => {
  const root = createFixture();
  try {
    assert.throws(() => acceptWorkflowGuidance(root, []), /pass at least one frozen workflow-authoring path/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
