import assert from "node:assert/strict";
import test from "node:test";
import { audioContext, wavHeader } from "../index.ts";

test("wavHeader describes 16 kHz mono S16_LE PCM", () => {
  const pcmBytes = 32_000;
  const header = wavHeader(pcmBytes);

  assert.equal(header.length, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.readUInt32LE(4), 36 + pcmBytes);
  assert.equal(header.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(header.readUInt32LE(16), 16);
  assert.equal(header.readUInt16LE(20), 1);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16_000);
  assert.equal(header.readUInt32LE(28), 32_000);
  assert.equal(header.readUInt16LE(32), 2);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.toString("ascii", 36, 40), "data");
  assert.equal(header.readUInt32LE(40), pcmBytes);
});

test("audioContext scales with recording length and clamps both ends", () => {
  assert.equal(audioContext(0), 256);
  assert.equal(audioContext(5), 400);
  assert.equal(audioContext(30), 1500);
  assert.equal(audioContext(120), 1500);
});

test("audioContext uses the configured override", () => {
  assert.equal(audioContext(5, 512), 512);
});
