import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

test("AI Code Flow compatibility public API compiles for consumers", () => {
  const tsc = join(process.cwd(), "node_modules", ".bin", "tsc");
  const result = spawnSync(
    tsc,
    [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "tests/fixtures/public-api-compat.ts",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
