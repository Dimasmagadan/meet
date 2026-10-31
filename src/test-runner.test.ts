import { test } from "node:test";
import { strict as assert } from "node:assert";
// Imports the wrapper's pure parser directly (scripts/run-tests.mjs, resolved
// relative to dist/ at runtime — no subprocess spawned).
import { parseTestCount } from "../scripts/run-tests.mjs";

test("parseTestCount extracts the spec-reporter summary line", () => {
  const out = ["ℹ tests 739", "ℹ suites 12", "ℹ pass 730", "ℹ fail 9", "ℹ cancelled 0"].join("\n");
  assert.equal(parseTestCount(out), 739);
});

test("parseTestCount extracts the TAP summary line", () => {
  const out = ["1..42", "# tests 42", "# suites 0", "# pass 42", "# fail 0"].join("\n");
  assert.equal(parseTestCount(out), 42);
});

test("parseTestCount is anchored to whole summary lines", () => {
  // A test named "... tests ..." or a pass count must not be picked up.
  assert.equal(parseTestCount("ok 1 - tests should not match\n"), null);
  assert.equal(parseTestCount("ℹ pass 739\nℹ fail 0\n"), null);
});

test("parseTestCount returns null without a summary line (exit-1 path)", () => {
  // This is the zero-match shape: the wrapper must see null and exit 1
  // instead of reporting an empty suite as success.
  assert.equal(parseTestCount(""), null);
  assert.equal(parseTestCount("Could not find '…/dist/**/*.test.js'\n"), null);
});
