import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readConfig, recordAudio } from "../index.ts";

const fakeArecordFixture = join(import.meta.dirname, "fixtures", "fake-arecord.sh");
const config = () => readConfig({ PI_DICTATE_AUDIO_DEVICE: "hw:1,0" });

async function setupFakeArecord() {
  const dir = await mkdtemp(join(tmpdir(), "pi-dictate-fake-arecord-"));
  const bin = join(dir, "arecord");
  await copyFile(fakeArecordFixture, bin);
  await chmod(bin, 0o755);
  return { dir, bin };
}

test("recordAudio writes metered PCM as a finalized WAV", async (t) => {
  const fake = await setupFakeArecord();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  let heardAudio!: () => void;
  const audio = new Promise<void>((resolve) => (heardAudio = resolve));
  let level = 0;
  const recorder = await recordAudio(
    config(),
    (value) => {
      level = value;
      heardAudio();
    },
    fake.bin,
  );
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
});

test("recordAudio discard kills arecord and removes its temporary directory", async (t) => {
  const fake = await setupFakeArecord();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  const recorder = await recordAudio(config(), undefined, fake.bin);
  const directory = dirname(recorder.path);

  await recorder.discard();
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("recordAudio names alsa-utils when arecord is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dictate-missing-arecord-"));
  try {
    await assert.rejects(recordAudio(config(), undefined, join(dir, "missing-arecord")), /alsa-utils/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
