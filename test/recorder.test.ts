import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readConfig, recordAudio } from "../index.ts";

const fakeArecordFixture = join(import.meta.dirname, "fixtures", "fake-arecord.sh");
const config = () => readConfig({ PI_DICTATE_AUDIO_DEVICE: "hw:1,0" });

async function setupFakeArecord(fail = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-dictate-fake-arecord-"));
  const bin = join(dir, "arecord");
  await copyFile(fakeArecordFixture, bin);
  await chmod(bin, 0o755);
  if (fail) await writeFile(`${bin}.fail`, "");
  return { dir, bin };
}

test("recordAudio writes metered PCM as a finalized WAV and forwards raw chunks to onAudio", async (t) => {
  const fake = await setupFakeArecord();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  let heardAudio!: () => void;
  const audio = new Promise<void>((resolve) => (heardAudio = resolve));
  let level = 0;
  const audioChunks: Buffer[] = [];
  const recorder = await recordAudio(config(), {
    onLevel: (value) => {
      level = value;
      heardAudio();
    },
    onAudio: (chunk) => {
      audioChunks.push(chunk);
    },
    arecordBin: fake.bin,
  });
  t.after(() => recorder.discard());

  await audio;
  const recording = await recorder.stop();
  const wav = await readFile(recording.path);
  const args = (await readFile(`${fake.bin}.args`, "utf8")).trim().split("\n");

  assert.deepEqual(args, ["-q", "-D", "hw:1,0", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"]);
  assert.equal(wav.length, 48);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 40);
  assert.equal(wav.readUInt32LE(40), 4);
  assert.deepEqual([...wav.subarray(44)], [0, 64, 0, 192]);
  assert.equal(recording.duration, 4 / 32_000);
  assert.equal(level, 0.5);
  assert.equal((await stat(dirname(recording.path))).mode & 0o777, 0o700);
  assert.equal((await stat(recording.path)).mode & 0o777, 0o600);

  // Every PCM chunk reaches onAudio exactly once, and the concatenated bytes
  // match the WAV payload byte-for-byte.
  assert.deepEqual(Buffer.concat(audioChunks), wav.subarray(44));
});

test("recordAudio discard kills arecord and removes its temporary directory", async (t) => {
  const fake = await setupFakeArecord();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  const recorder = await recordAudio(config(), { arecordBin: fake.bin });
  const directory = dirname(recorder.path);

  await recorder.discard();
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("recordAudio exposes an unexpected arecord exit", async (t) => {
  const fake = await setupFakeArecord(true);
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  const recorder = await recordAudio(config(), { arecordBin: fake.bin });
  t.after(() => recorder.discard());

  const error = await Promise.race([
    recorder.failure,
    new Promise<Error>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out")), 500).unref();
    }),
  ]);

  assert.ok(error);
  assert.match(error.message, /arecord exited unexpectedly \(code 9\)/);
  await recorder.discard();
});

test("recordAudio names alsa-utils when arecord is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dictate-missing-arecord-"));
  try {
    await assert.rejects(recordAudio(config(), { arecordBin: join(dir, "missing-arecord") }), /alsa-utils/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a synchronous onAudio throw becomes a reported recorder failure instead of an uncaught exception", async (t) => {
  const fake = await setupFakeArecord();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  const thrown = new Error("boom from onAudio");
  const recorder = await recordAudio(config(), {
    onAudio: () => {
      throw thrown;
    },
    arecordBin: fake.bin,
  });
  t.after(() => recorder.discard());

  const error = await Promise.race([
    recorder.failure,
    new Promise<Error>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out")), 500).unref();
    }),
  ]);

  assert.equal(error, thrown);
});

test("discard after an onAudio failure kills arecord and removes the temporary directory", async (t) => {
  const fake = await setupFakeArecord();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  const recorder = await recordAudio(config(), {
    onAudio: () => {
      throw new Error("boom from onAudio");
    },
    arecordBin: fake.bin,
  });
  const directory = dirname(recorder.path);

  await recorder.failure;
  await recorder.discard();

  await assert.rejects(access(directory), { code: "ENOENT" });
});
