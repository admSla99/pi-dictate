import assert from "node:assert/strict";
import test from "node:test";
import { createDeepgramSession, deepgramListenUrl, readConfig } from "../index.ts";

const configFor = (overrides: NodeJS.ProcessEnv = {}) =>
  readConfig({
    PI_DICTATE_BACKEND: "deepgram",
    DEEPGRAM_API_KEY: "dg_super_secret_key",
    PI_DICTATE_LANGUAGE: "sk",
    ...overrides,
  });

test("deepgramListenUrl targets the live-transcription endpoint", () => {
  const url = new URL(deepgramListenUrl(configFor()));
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, "wss://api.deepgram.com/v1/listen");
});

test("deepgramListenUrl sends exactly the reviewed streaming parameters", () => {
  const url = new URL(deepgramListenUrl(configFor()));
  assert.deepEqual(Object.fromEntries(url.searchParams.entries()), {
    model: "nova-3",
    language: "sk",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "false",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
  });
});

test("deepgramListenUrl reflects the configured explicit language", () => {
  const url = new URL(deepgramListenUrl(configFor({ PI_DICTATE_LANGUAGE: "en" })));
  assert.equal(url.searchParams.get("language"), "en");
});

test("deepgramListenUrl never includes the API key", () => {
  const url = deepgramListenUrl(configFor());
  assert.doesNotMatch(url, /dg_super_secret_key/);
});

type Listener = (event: any) => void;

/**
 * Fake standing in for Node's native WebSocket, driven manually by tests.
 * Mirrors the WHATWG readyState state machine: `send()` throws while
 * CONNECTING, transmits while OPEN, and silently drops while CLOSING/CLOSED.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  protocols: string[];
  sent: Array<string | Buffer> = [];
  readyState: number = FakeWebSocket.CONNECTING;
  closeCode?: number;
  closeCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  /** Convenience accessor so existing assertions reading `.closed` still work. */
  get closed(): boolean {
    return this.readyState === FakeWebSocket.CLOSED;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string | Buffer): void {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    }
    if (this.readyState !== FakeWebSocket.OPEN) return; // CLOSING/CLOSED: drop silently, like native sockets
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCode = code;
    this.dispatch("close", { code });
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  message(data: string): void {
    this.dispatch("message", { data });
  }

  fail(): void {
    this.dispatch("error", {});
  }
}

interface SessionFixtureOptions {
  finishTimeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

function sessionFixture(overrides: NodeJS.ProcessEnv = {}, options: SessionFixtureOptions = {}) {
  const config = readConfig({
    PI_DICTATE_BACKEND: "deepgram",
    DEEPGRAM_API_KEY: "dg_super_secret_key",
    PI_DICTATE_LANGUAGE: "sk",
    ...overrides,
  });
  let socket!: FakeWebSocket;
  const session = createDeepgramSession(config, {
    webSocketFactory: (url, protocols) => {
      socket = new FakeWebSocket(url, protocols);
      return socket as unknown as WebSocket;
    },
    finishTimeoutMs: options.finishTimeoutMs ?? 3000,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
  });
  return { session, socket: () => socket, config };
}

const finalResult = (transcript: string) =>
  JSON.stringify({
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript }] },
  });

test("createDeepgramSession returns immediately without waiting for the socket to open", () => {
  const { session } = sessionFixture();
  assert.ok(session.ready instanceof Promise);
  assert.equal(typeof session.sendAudio, "function");
  assert.equal(typeof session.finish, "function");
  assert.equal(typeof session.abort, "function");
});

test("createDeepgramSession authenticates with the token subprotocol against the reviewed URL", () => {
  const { socket, config } = sessionFixture();
  assert.equal(socket().url, deepgramListenUrl(config));
  assert.deepEqual(socket().protocols, ["token", "dg_super_secret_key"]);
});

test("ready resolves only after the socket opens", async () => {
  const { session, socket } = sessionFixture();
  let resolved = false;
  session.ready.then(() => (resolved = true));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);

  socket().open();
  await session.ready;
  assert.equal(resolved, true);
});

test("sendAudio forwards the raw buffer as a binary frame", () => {
  const { session, socket } = sessionFixture();
  socket().open();
  const chunk = Buffer.from([1, 2, 3, 4]);

  session.sendAudio(chunk);

  assert.equal(socket().sent.length, 1);
  assert.ok(Buffer.isBuffer(socket().sent[0]));
  assert.deepEqual([...(socket().sent[0] as Buffer)], [1, 2, 3, 4]);
});

test("multiple final Results messages accumulate into the finished transcript", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  socket().message(finalResult("Ahoj"));
  socket().message(finalResult("svet."));
  const finishing = session.finish();
  socket().close(1000);

  assert.equal(await finishing, "Ahoj svet.");
});

test("interim results are ignored and never contribute to the transcript", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  socket().message(JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "interim" }] } }));
  const finishing = session.finish();
  socket().close(1000);

  assert.equal(await finishing, "");
});

test("malformed and unrelated frames are safely ignored", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  socket().message("not json");
  socket().message(JSON.stringify({ type: "Metadata", request_id: "abc" }));
  socket().message(JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "" }] } }));
  socket().message(JSON.stringify(null));
  socket().message(JSON.stringify(42));
  socket().dispatch("message", { data: Buffer.from("binary") });
  socket().message(finalResult("Slovak works."));

  const finishing = session.finish();
  socket().close(1000);

  assert.equal(await finishing, "Slovak works.");
});

test("finish sends exactly one text CloseStream frame", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  const finishing1 = session.finish();
  const finishing2 = session.finish();
  socket().close(1000);
  await finishing1;
  await finishing2;

  const closeFrames = socket().sent.filter((frame) => typeof frame === "string");
  assert.deepEqual(closeFrames, [JSON.stringify({ type: "CloseStream" })]);
  assert.equal(finishing1, finishing2);
});

test("finish rejects with a sanitized error on abnormal socket closure", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  const finishing = session.finish();
  socket().close(1006);

  await assert.rejects(finishing, (error: Error) => {
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
});

test("finish times out when the server never closes the stream", async () => {
  const { session, socket } = sessionFixture({}, { finishTimeoutMs: 20 });
  socket().open();
  await session.ready;

  const finishing = session.finish();

  await assert.rejects(finishing, (error: Error) => {
    assert.match(error.message, /timed out/i);
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
});

test("a socket error rejects readiness and any pending finish with a sanitized message", async () => {
  const { session, socket } = sessionFixture();
  const readyRejection = assert.rejects(session.ready, (error: Error) => {
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });

  socket().fail();

  await readyRejection;
});

test("a socket error rejects an in-flight finish without exposing credentials", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;
  const finishing = session.finish();

  socket().fail();

  await assert.rejects(finishing, (error: Error) => {
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
});

test("abort cancels a connecting session and rejects readiness harmlessly", async () => {
  const { session, socket } = sessionFixture();

  const readyRejection = assert.rejects(session.ready);
  await session.abort();

  assert.equal(socket().closed, true);
  await readyRejection;
});

test("abort closes an open session without throwing", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  await session.abort();

  assert.equal(socket().closed, true);
});

test("finish and abort are idempotent and leave no dangling timeout", async () => {
  const { session, socket } = sessionFixture({}, { finishTimeoutMs: 20 });
  socket().open();
  await session.ready;

  const finishing = session.finish();
  socket().close(1000);
  await finishing;

  await session.finish();
  await session.abort();
  await session.abort();

  assert.equal(socket().closeCalls <= 2, true);
  const closeFrames = socket().sent.filter((frame) => typeof frame === "string");
  assert.equal(closeFrames.length, 1);
});

test("calling abort after a normal finish does not resend CloseStream or reopen the socket", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  const finishing = session.finish();
  socket().close(1000);
  await finishing;
  await session.abort();

  const closeFrames = socket().sent.filter((frame) => typeof frame === "string");
  assert.equal(closeFrames.length, 1);
});

test("a normal close before finish() is called settles a later finish immediately with the collected transcript", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;
  socket().message(finalResult("Skoro hotovo."));
  socket().close(1000);

  const result = await session.finish();

  assert.equal(result, "Skoro hotovo.");
  const closeFrames = socket().sent.filter((frame) => typeof frame === "string");
  assert.equal(closeFrames.length, 0);
});

test("an abnormal close before finish() is called rejects a later finish immediately with the original sanitized error", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;
  socket().close(1011);

  await assert.rejects(session.finish(), (error: Error) => {
    assert.match(error.message, /closed unexpectedly \(code 1011\)/);
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
  const closeFrames = socket().sent.filter((frame) => typeof frame === "string");
  assert.equal(closeFrames.length, 0);
});

test("a socket error before finish() is called rejects a later finish immediately without retrying CloseStream", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;
  socket().fail();

  await assert.rejects(session.finish(), (error: Error) => {
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
  assert.equal(socket().sent.length, 0);
});

test("calling finish before the socket has opened rejects with an actionable message instead of hanging, and best-effort closes the socket", async () => {
  const { session, socket } = sessionFixture();

  const finishing = session.finish();

  await assert.rejects(finishing, (error: Error) => {
    assert.match(error.message, /call finish\(\) only after ready resolves/);
    assert.doesNotMatch(error.message, /failed to send CloseStream/);
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
  assert.equal(socket().sent.length, 0);
  assert.equal(socket().closed, true);
});

test("finish() obtained from an already terminally failed session never surfaces as an unhandled rejection", async (t) => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;
  socket().fail(); // records a terminal failure before finish() is ever called

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  t.after(() => process.removeListener("unhandledRejection", onUnhandledRejection));

  const finishing = session.finish(); // memoized rejected promise; intentionally left unawaited

  // Give Node a full macrotask turn: any unhandled rejection would already have
  // been reported well before this, since Node checks at the end of the
  // microtask queue, long before a setTimeout(0) macrotask fires.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(unhandled, []);

  await assert.rejects(finishing, (error: Error) => {
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
});

test("a socket error best-effort closes the socket and cleans resources", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  socket().fail();

  assert.equal(socket().closed, true);
  await session.abort();
});

test("abort while finalizing rejects finish as aborted, sends exactly one CloseStream, and closes the socket", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  const finishing = session.finish();
  await session.abort();

  await assert.rejects(finishing, (error: Error) => {
    assert.match(error.message, /aborted/);
    assert.doesNotMatch(error.message, /dg_super_secret_key/);
    return true;
  });
  const closeFrames = socket().sent.filter((frame) => typeof frame === "string");
  assert.equal(closeFrames.length, 1);
  assert.equal(socket().closed, true);
});

test("the finalization timer is scheduled and cleared exactly once through injected timer hooks", async () => {
  const scheduled: Array<{ ms: number; id: number }> = [];
  const cleared: number[] = [];
  let nextId = 0;
  const { session, socket } = sessionFixture(
    {},
    {
      finishTimeoutMs: 5000,
      setTimeout: (callback, ms) => {
        const id = ++nextId;
        scheduled.push({ ms, id });
        void callback;
        return id;
      },
      clearTimeout: (handle) => {
        cleared.push(handle as number);
      },
    },
  );
  socket().open();
  await session.ready;

  const finishing = session.finish();
  socket().close(1000);
  await finishing;

  assert.deepEqual(scheduled, [{ ms: 5000, id: 1 }]);
  assert.deepEqual(cleared, [1]);
});

test("an injected timeout callback rejects finish and clears its own timer exactly once", async () => {
  const cleared: number[] = [];
  let capturedCallback: (() => void) | undefined;
  let nextId = 0;
  const { session, socket } = sessionFixture(
    {},
    {
      setTimeout: (callback, _ms) => {
        capturedCallback = callback;
        return ++nextId;
      },
      clearTimeout: (handle) => cleared.push(handle as number),
    },
  );
  socket().open();
  await session.ready;
  const finishing = session.finish();

  capturedCallback?.();

  await assert.rejects(finishing, /timed out/i);
  assert.deepEqual(cleared, [1]);
});

test("whitespace-only final transcripts are ignored", async () => {
  const { session, socket } = sessionFixture();
  socket().open();
  await session.ready;

  socket().message(finalResult("   "));
  socket().message(finalResult("Real content."));
  const finishing = session.finish();
  socket().close(1000);

  assert.equal(await finishing, "Real content.");
});
