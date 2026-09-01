import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readConfig, transcribeLiteLLM } from "../index.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-dictate-litellm-test-"));
  const wavPath = join(directory, "recording.wav");
  await writeFile(wavPath, "fake wav");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return wavPath;
}

async function listen(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return { server, url: `http://127.0.0.1:${address.port}/v1/audio/transcriptions` };
}

const configFor = (url: string, key?: string) => readConfig({
  PI_DICTATE_BACKEND: "litellm",
  PI_DICTATE_LITELLM_URL: url,
  PI_DICTATE_LITELLM_API_KEY: key,
  PI_DICTATE_LITELLM_MODEL: "test-whisper",
  PI_DICTATE_LANGUAGE: "sk",
});

test("transcribeLiteLLM posts the OpenAI-compatible multipart request without optional auth", async (t) => {
  const wavPath = await fixture(t);
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => (received = resolve));
  const { url } = await listen(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.match(request.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
    assert.equal(request.headers.authorization, undefined);
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    for (const field of ["file", "model", "language", "response_format"]) {
      assert.match(body, new RegExp(`name="${field}"`));
    }
    assert.match(body, /name="model"\r\n\r\ntest-whisper/);
    assert.match(body, /name="language"\r\n\r\nsk/);
    assert.match(body, /name="response_format"\r\n\r\njson/);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: "Ahoj svet." }));
    received();
  });

  assert.equal(await transcribeLiteLLM(wavPath, configFor(url)), "Ahoj svet.");
  await requestReceived;
});

test("transcribeLiteLLM lets the server detect the language when configured as auto", async (t) => {
  const wavPath = await fixture(t);
  let body = "";
  const { url } = await listen(t, async (request, response) => {
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    response.end(JSON.stringify({ text: "ok" }));
  });
  const config = readConfig({
    PI_DICTATE_BACKEND: "litellm",
    PI_DICTATE_LITELLM_URL: url,
  });

  assert.equal(await transcribeLiteLLM(wavPath, config), "ok");
  assert.doesNotMatch(body, /name="language"/);
});

test("transcribeLiteLLM sends bearer auth only when configured", async (t) => {
  const wavPath = await fixture(t);
  const { url } = await listen(t, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer secret-key");
    for await (const _chunk of request) {}
    response.end(JSON.stringify({ text: "ok" }));
  });

  assert.equal(await transcribeLiteLLM(wavPath, configFor(url, "secret-key")), "ok");
});

for (const status of [401, 500]) {
  test(`transcribeLiteLLM surfaces HTTP ${status} with a truncated body`, async (t) => {
    const wavPath = await fixture(t);
    const body = `failure-${status}-` + "x".repeat(600) + "hidden-tail";
    const { url } = await listen(t, async (request, response) => {
      for await (const _chunk of request) {}
      response.writeHead(status);
      response.end(body);
    });

    await assert.rejects(transcribeLiteLLM(wavPath, configFor(url)), (error: Error) => {
      assert.match(error.message, new RegExp(`LiteLLM returned ${status}: failure-${status}`));
      assert.doesNotMatch(error.message, /hidden-tail/);
      return true;
    });
  });
}

test("transcribeLiteLLM rejects malformed JSON", async (t) => {
  const wavPath = await fixture(t);
  const { url } = await listen(t, async (request, response) => {
    for await (const _chunk of request) {}
    response.end("not json");
  });

  await assert.rejects(
    transcribeLiteLLM(wavPath, configFor(url)),
    /LiteLLM returned invalid JSON: not json/,
  );
});

test("transcribeLiteLLM honours AbortSignal", async (t) => {
  const wavPath = await fixture(t);
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => (received = resolve));
  const { server, url } = await listen(t, async (request) => {
    for await (const _chunk of request) {}
    received();
  });
  const controller = new AbortController();
  const transcription = transcribeLiteLLM(wavPath, configFor(url), controller.signal);
  await requestReceived;
  controller.abort();

  await assert.rejects(transcription, { name: "AbortError" });
  server.closeAllConnections();
});

test("transcribeLiteLLM refuses redirects so HTTPS cannot downgrade to plaintext", async (t) => {
  const wavPath = await fixture(t);
  const { url } = await listen(t, async (request, response) => {
    for await (const _chunk of request) {}
    if (request.url === "/redirect") {
      response.writeHead(307, { location: "/target" });
      response.end();
    } else {
      response.end(JSON.stringify({ text: "redirected" }));
    }
  });

  await assert.rejects(transcribeLiteLLM(wavPath, configFor(new URL("/redirect", url).href)));
});

test("transcribeLiteLLM refuses plaintext HTTP to a non-loopback host", async () => {
  await assert.rejects(
    transcribeLiteLLM("/unused.wav", configFor("http://example.com/v1/audio/transcriptions")),
    /plaintext HTTP.*loopback/,
  );
});
