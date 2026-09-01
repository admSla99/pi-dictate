import assert from "node:assert/strict";
import test from "node:test";
import dictate, { rmsFromPcm16 } from "../index.ts";

test("helpers import without starting an extension session", () => {
  assert.equal(typeof dictate, "function");
  assert.equal(rmsFromPcm16(Buffer.alloc(2)), 0);
});
