import assert from "node:assert/strict";
import test from "node:test";
import { appendText, parseTranscript } from "../index.ts";

test("parseTranscript joins timestamped segments into one line", () => {
  const stdout = `
[00:00:00.000 --> 00:00:30.000]   First segment.

[00:00:30.000 --> 00:00:50.000]   Second   segment.
`;

  assert.equal(parseTranscript(stdout), "First segment. Second segment.");
});

test("parseTranscript handles a single segment", () => {
  assert.equal(
    parseTranscript("[00:00:00.000 --> 00:00:05.000]   A single segment.\n"),
    "A single segment.",
  );
});

test("parseTranscript returns an empty string for blank output", () => {
  assert.equal(parseTranscript(" \n\t\n"), "");
});

test("appendText normalizes text appended to an empty target", () => {
  assert.equal(appendText("", "  New\n  words.  "), "New words.");
});

test("appendText reuses trailing whitespace in the target", () => {
  assert.equal(appendText("Existing ", "  new   words.  "), "Existing new words.");
});

test("appendText separates a word-terminated target", () => {
  assert.equal(appendText("Existing", "  new   words.  "), "Existing new words.");
});
