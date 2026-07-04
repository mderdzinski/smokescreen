import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourcePath = fileURLToPath(new URL("../src/lib/needs-attention.ts", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
  },
});
const helpers = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("needs-attention view state covers empty and error states", () => {
  assert.equal(
    helpers.getAttentionViewState({
      hasError: false,
      isLoading: false,
      recordCount: 0,
    }),
    "empty",
  );
  assert.equal(
    helpers.getAttentionViewState({
      hasError: true,
      isLoading: false,
      recordCount: 1,
    }),
    "error",
  );
});

test("pending-review guidance explains the broker reply and next step", () => {
  const record = {
    broker_name: "Spokeo",
    notes: "Please send a signed form before we can continue.",
    status: "NEEDS_MANUAL",
    thread_id: "abc123",
  };

  const guidance = helpers.getAttentionGuidance(record);

  assert.equal(guidance.title, "Review the broker reply");
  assert.equal(
    guidance.recommendedStep,
    "Open the source email. Resolve it yourself and mark handled, or retry the request.",
  );
  assert.equal(helpers.getBrokerReplyText(record), "Please send a signed form before we can continue.");
});

test("needs-manual summary prefers structured summary and falls back to notes", () => {
  assert.equal(
    helpers.getNeedsManualSummary({
      needs_manual_reason: {
        short_summary: "Broker asked for a missing phone number.",
      },
      notes: "Legacy note",
    }),
    "Broker asked for a missing phone number.",
  );
  assert.equal(
    helpers.getNeedsManualSummary({
      needs_manual_reason: null,
      notes: "Legacy note",
    }),
    "Legacy note",
  );
});

test("attention actions use user-intent labels while pending", () => {
  assert.deepEqual(
    helpers.getAttentionActionLabels({
      isMarkingHandled: true,
      isRetrying: false,
    }),
    {
      markHandled: "Marking handled",
      retry: "Retry",
      sourceEmail: "Source email",
    },
  );
});

test("source email links preserve thread context when available", () => {
  assert.equal(helpers.getSourceEmailHref(null), null);
  assert.equal(helpers.getSourceEmailHref(" thread/123 "), "https://mail.google.com/mail/u/0/#all/thread%2F123");
});
