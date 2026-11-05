import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_WINDOW_OVERFLOW_MARKER,
  buildAncestorChains,
  classify2013Run,
  measurePrompt,
  renderAncestorLabels,
  assertPlatformShape,
} from "./audit-prompt-budget.mjs";

test("ancestor labels render one line each and carry no description", () => {
  const labels = renderAncestorLabels([
    { id: "a", identifier: "TON-1", title: "Parent card", status: "in_progress", priority: "medium", description: "x".repeat(5000) },
    { id: "b", identifier: "TON-2", title: "Grandparent", status: "done", priority: "low", description: "y".repeat(5000) },
  ]);
  assert.equal(labels.length, 2);
  assert.equal(labels[0], "- Parent: TON-1 Parent card (in_progress) [medium]");
  assert.equal(labels[1], "- Ancestor 2: TON-2 Grandparent (done) [low]");
  for (const label of labels) {
    assert.ok(!label.includes("x".repeat(100)));
    assert.ok(!label.includes("y".repeat(100)));
  }
});

test("ancestor descriptions do not count toward the prompt total", () => {
  const ancestors = [
    { id: "a", identifier: "TON-1", title: "Parent", status: "todo", priority: "medium", description: "z".repeat(4000) },
  ];
  const measured = measurePrompt({
    description: "leaf",
    summary: "",
    ancestors,
  });
  assert.equal(measured.ancestorChars < 100, true);
  assert.equal(measured.totalChars, measured.descriptionChars + measured.ancestorChars);
  // The legacy formula TON-827 was written against would have counted 4000.
  assert.equal(measured.legacyDescPlusAncestorDescriptions, 4 + 4000);
});

test("prompt total is description + summary + wake comment + ancestor labels", () => {
  const measured = measurePrompt({
    description: "12345",
    summary: "1234567890",
    wakeComment: "123",
    ancestors: [{ id: "a", identifier: "TON-9", title: "T", status: "todo", priority: null }],
  });
  assert.equal(measured.descriptionChars, 5);
  assert.equal(measured.summaryChars, 10);
  assert.equal(measured.wakeCommentChars, 3);
  assert.equal(measured.ancestorCount, 1);
  assert.equal(measured.totalChars, 5 + 10 + 3 + measured.ancestorChars);
});

test("missing summary is measured as empty, not as a failure", () => {
  const measured = measurePrompt({ description: "abc", summary: undefined, ancestors: [] });
  assert.equal(measured.summaryChars, 0);
  assert.equal(measured.totalChars, 3);
});

test("a 2013 death is detected from any error-bearing field", () => {
  const verdict = classify2013Run({
    errorCode: "acpx_turn_failed",
    error: `400 invalid params, ${CONTEXT_WINDOW_OVERFLOW_MARKER}`,
  });
  assert.equal(verdict.carriesMarker, true);
  assert.equal(verdict.kind, "hard");
});

test("a classified transient is not counted as a hard death", () => {
  const verdict = classify2013Run({
    errorCode: "acpx_transient_upsert",
    stderrExcerpt: CONTEXT_WINDOW_OVERFLOW_MARKER,
  });
  assert.equal(verdict.carriesMarker, true);
  assert.equal(verdict.kind, "classified");
});

test("a run with no 2013 marker is not flagged", () => {
  const verdict = classify2013Run({
    errorCode: "provider_quota",
    error: "Request rejected (429)",
  });
  assert.equal(verdict.carriesMarker, false);
  assert.equal(verdict.kind, null);
});

test("ancestor chains resolve parent-first and terminate on a cycle", () => {
  const issues = [
    { id: "c", parentId: "b", identifier: "TON-3" },
    { id: "b", parentId: "a", identifier: "TON-2" },
    { id: "a", parentId: null, identifier: "TON-1" },
    { id: "loop1", parentId: "loop2", identifier: "TON-4" },
    { id: "loop2", parentId: "loop1", identifier: "TON-5" },
  ];
  const chains = buildAncestorChains(issues);
  assert.deepEqual(chains.get("c").map((i) => i.identifier), ["TON-2", "TON-1"]);
  assert.deepEqual(chains.get("a"), []);
  // A cycle terminates instead of looping forever: loop1 -> loop2 -> loop1.
  assert.deepEqual(chains.get("loop1").map((i) => i.identifier), ["TON-5"]);
  assert.deepEqual(chains.get("loop2").map((i) => i.identifier), ["TON-4"]);
});

test("the platform source still renders ancestors without their descriptions", () => {
  assert.equal(assertPlatformShape(), true);
});
