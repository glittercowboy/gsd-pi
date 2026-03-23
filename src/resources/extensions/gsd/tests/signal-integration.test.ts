import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Integration tests for SignalAdapter using mock HTTP + WebSocket servers.
 * Tests the full sendPrompt → pollAnswer → acknowledgeAnswer flow
 * without a real signal-cli-rest-api instance.
 */

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockSignalServer {
  httpServer: Server;
  wss: WebSocketServer;
  port: number;
  url: string;
  /** Messages received via POST /v2/send */
  sentMessages: Array<{ message: string; number: string; recipients: string[] }>;
  /** Contacts to return from GET /v1/contacts/{number} */
  contacts: any[];
  /** Inject a message into the WebSocket stream (simulates incoming Signal message) */
  injectMessage: (envelope: any) => void;
  close: () => Promise<void>;
}

async function startMockSignalServer(): Promise<MockSignalServer> {
  const sentMessages: MockSignalServer["sentMessages"] = [];
  let contacts: any[] = [];
  const wsClients: Set<WebSocket> = new Set();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    // GET /v1/about
    if (req.method === "GET" && url.pathname === "/v1/about") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ versions: ["v1", "v2"], build: 2, mode: "json-rpc", version: "0.98" }));
      return;
    }

    // GET /v1/accounts
    if (req.method === "GET" && url.pathname === "/v1/accounts") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(["+15550001111"]));
      return;
    }

    // GET /v1/contacts/{number}
    if (req.method === "GET" && url.pathname.startsWith("/v1/contacts/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(contacts));
      return;
    }

    // POST /v2/send
    if (req.method === "POST" && url.pathname === "/v2/send") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      sentMessages.push(body);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ timestamp: String(Date.now()) }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address() as { port: number };
      resolve({
        httpServer,
        wss,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        sentMessages,
        contacts,
        injectMessage: (envelope: any) => {
          const data = JSON.stringify(envelope);
          for (const ws of wsClients) ws.send(data);
        },
        close: () => new Promise((r) => {
          wss.close(() => httpServer.close(() => r()));
        }),
      });
    });
  });
}

function makePrompt(id = "test-prompt-1") {
  return {
    id,
    channel: "signal" as const,
    createdAt: Date.now(),
    timeoutAt: Date.now() + 300_000,
    pollIntervalMs: 5000,
    questions: [{
      id: "choice",
      header: "Approach",
      question: "Which approach?",
      options: [
        { label: "Option A", description: "First" },
        { label: "Option B", description: "Second" },
      ],
      allowMultiple: false,
    }],
  };
}

function makeEnvelope(sender: string, message: string, senderUuid?: string) {
  return {
    envelope: {
      source: sender,
      sourceUuid: senderUuid ?? "uuid-" + sender.replace(/\+/g, ""),
      dataMessage: {
        message,
        timestamp: Date.now(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

test("SignalAdapter.validate succeeds against mock server", async () => {
  const server = await startMockSignalServer();
  try {
    const original = process.env.SIGNAL_PHONE_NUMBER;
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15552223333");
    await adapter.validate();  // should not throw

    if (original !== undefined) process.env.SIGNAL_PHONE_NUMBER = original;
    else delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
});

test("SignalAdapter.sendPrompt sends formatted message to mock server", async () => {
  const server = await startMockSignalServer();
  try {
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15552223333");
    await adapter.validate();

    const prompt = makePrompt();
    const result = await adapter.sendPrompt(prompt);

    // Check the message was sent
    assert.equal(server.sentMessages.length, 1);
    assert.equal(server.sentMessages[0].number, "+15550001111");
    assert.deepEqual(server.sentMessages[0].recipients, ["+15552223333"]);
    assert.ok(server.sentMessages[0].message.includes("GSD needs your input"));
    assert.ok(server.sentMessages[0].message.includes("Option A"));

    // Check the returned ref
    assert.equal(result.ref.channel, "signal");
    assert.equal(result.ref.channelId, "+15552223333");
    assert.ok(result.ref.messageId);

    delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
});

test("SignalAdapter.pollAnswer receives reply via WebSocket", async () => {
  const server = await startMockSignalServer();
  try {
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15552223333");
    await adapter.validate();

    const prompt = makePrompt();
    const sendResult = await adapter.sendPrompt(prompt);

    // Start polling, then inject a reply after a short delay
    const pollPromise = adapter.pollAnswer(prompt, sendResult.ref);

    // Wait for WebSocket to connect, then inject reply
    await new Promise((r) => setTimeout(r, 500));
    server.injectMessage(makeEnvelope("+15552223333", "2"));

    const answer = await pollPromise;

    assert.ok(answer, "Expected an answer from pollAnswer");
    assert.deepEqual(answer!.answers.choice.answers, ["Option B"]);

    delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
});

test("SignalAdapter.pollAnswer ignores messages from wrong sender", async () => {
  const server = await startMockSignalServer();
  try {
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15552223333");
    await adapter.validate();

    const prompt = makePrompt();
    const sendResult = await adapter.sendPrompt(prompt);

    const pollPromise = adapter.pollAnswer(prompt, sendResult.ref);

    await new Promise((r) => setTimeout(r, 500));
    // Inject message from wrong sender — should be ignored
    server.injectMessage(makeEnvelope("+15559999999", "1"));

    const answer = await pollPromise;
    assert.equal(answer, null, "Should return null when no matching reply");

    delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
}, { timeout: 15_000 });

test("SignalAdapter.acknowledgeAnswer sends confirmation", async () => {
  const server = await startMockSignalServer();
  try {
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15552223333");
    await adapter.validate();

    const ref = {
      id: "test-ack",
      channel: "signal" as const,
      messageId: "123",
      channelId: "+15552223333",
    };

    await adapter.acknowledgeAnswer(ref);

    // Find the ack message (sendPrompt may have also sent one)
    const ackMsg = server.sentMessages.find((m) => m.message.includes("Got it"));
    assert.ok(ackMsg, "Expected acknowledgement message");
    assert.ok(ackMsg!.message.includes("✅"));

    delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
});

test("SignalAdapter resolves UUID from contacts list", async () => {
  const server = await startMockSignalServer();
  // Set up contacts with UUID mapping
  server.contacts.push(
    { number: "+15552223333", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", profile: {} },
  );
  // Need to reassign since contacts is a separate array
  const origHandler = server.httpServer.listeners("request")[0] as any;

  try {
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15552223333");
    await adapter.validate();

    const prompt = makePrompt();
    await adapter.sendPrompt(prompt);

    // The send should use the UUID, not the phone number
    const sent = server.sentMessages[0];
    assert.ok(sent, "Expected a sent message");
    // UUID resolution: recipient should be the UUID
    assert.deepEqual(sent.recipients, ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]);

    delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
});

test("SignalAdapter falls back to phone number when contacts lookup fails", async () => {
  const server = await startMockSignalServer();
  // Empty contacts — no UUID match
  try {
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15554445555");
    await adapter.validate();

    const prompt = makePrompt();
    await adapter.sendPrompt(prompt);

    const sent = server.sentMessages[0];
    assert.ok(sent);
    assert.deepEqual(sent.recipients, ["+15554445555"]);

    delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
});

test("SignalAdapter handles free text reply as user_note", async () => {
  const server = await startMockSignalServer();
  try {
    process.env.SIGNAL_PHONE_NUMBER = "+15550001111";

    const { SignalAdapter } = await import("../../remote-questions/signal-adapter.ts");
    const adapter = new SignalAdapter(server.url, "+15552223333");
    await adapter.validate();

    const prompt = makePrompt();
    const sendResult = await adapter.sendPrompt(prompt);

    const pollPromise = adapter.pollAnswer(prompt, sendResult.ref);

    await new Promise((r) => setTimeout(r, 500));
    server.injectMessage(makeEnvelope("+15552223333", "I want something custom"));

    const answer = await pollPromise;

    assert.ok(answer);
    assert.deepEqual(answer!.answers.choice.answers, []);
    assert.equal(answer!.answers.choice.user_note, "I want something custom");

    delete process.env.SIGNAL_PHONE_NUMBER;
  } finally {
    await server.close();
  }
});
