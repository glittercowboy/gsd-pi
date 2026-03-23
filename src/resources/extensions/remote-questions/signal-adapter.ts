/**
 * Remote Questions — Signal adapter
 *
 * Uses signal-cli-rest-api (https://github.com/bbernhard/signal-cli-rest-api)
 * to send questions and poll for replies.
 *
 * Configuration:
 *   - SIGNAL_SERVICE_URL: base URL of signal-cli-rest-api (e.g. http://localhost:8080)
 *   - SIGNAL_PHONE_NUMBER: the bot's registered phone number
 *   - channel_id: recipient phone number or UUID
 *
 * Sending uses the /v2/send REST endpoint.
 * Receiving uses a WebSocket connection to /v1/receive/{number} — this is
 * required when signal-cli-rest-api runs in json-rpc mode (the default for
 * Docker deployments). The REST /v1/receive endpoint only works in normal mode.
 *
 * The adapter resolves the recipient's UUID from the contacts list on first
 * use, since signal-cli may index contacts by UUID rather than phone number.
 */

import type {
  ChannelAdapter,
  RemotePrompt,
  RemoteDispatchResult,
  RemoteAnswer,
  RemotePromptRef,
} from "./types.js";
import { formatForSignal, parseSignalResponse } from "./format.js";
import { sanitizeError } from "../shared/sanitize.js";

export class SignalAdapter implements ChannelAdapter {
  readonly name = "signal" as const;
  private readonly serviceUrl: string;
  private readonly phoneNumber: string;
  private readonly recipientNumber: string;
  private resolvedRecipient: string | null = null;
  private lastSentTimestamp = 0;

  constructor(serviceUrl: string, recipientNumber: string) {
    // serviceUrl is user-configured (SIGNAL_SERVICE_URL env var), unlike other adapters
    // which hit fixed public APIs. This is intentional — signal-cli-rest-api is always
    // a local/trusted service managed by the user. The value is set during onboarding
    // or via env var, never from untrusted preferences.
    this.serviceUrl = serviceUrl.replace(/\/+$/, "");
    this.recipientNumber = recipientNumber;
    this.phoneNumber = process.env.SIGNAL_PHONE_NUMBER ?? "";
  }

  async validate(): Promise<void> {
    if (!this.phoneNumber) {
      throw new Error("Signal auth failed: SIGNAL_PHONE_NUMBER not set");
    }
    if (!this.serviceUrl) {
      throw new Error("Signal auth failed: SIGNAL_SERVICE_URL not set");
    }

    const resp = await fetch(`${this.serviceUrl}/v1/about`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`Signal service unreachable: HTTP ${resp.status}`);
    }

    // Pre-resolve the recipient to UUID if needed
    await this.resolveRecipient();
  }

  async sendPrompt(prompt: RemotePrompt): Promise<RemoteDispatchResult> {
    const text = formatForSignal(prompt);
    const recipient = await this.resolveRecipient();

    const resp = await fetch(`${this.serviceUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        number: this.phoneNumber,
        recipients: [recipient],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Signal send failed: HTTP ${resp.status}: ${sanitizeError(body.slice(0, 200))}`);
    }

    const result = await resp.json().catch(() => ({})) as Record<string, unknown>;
    this.lastSentTimestamp = typeof result.timestamp === "string"
      ? parseInt(result.timestamp, 10)
      : Date.now();

    return {
      ref: {
        id: prompt.id,
        channel: "signal",
        messageId: String(this.lastSentTimestamp),
        channelId: this.recipientNumber,
      },
    };
  }

  async pollAnswer(
    prompt: RemotePrompt,
    ref: RemotePromptRef,
  ): Promise<RemoteAnswer | null> {
    // Use WebSocket for a single poll cycle. signal-cli-rest-api in json-rpc
    // mode (the Docker default) only delivers messages via WebSocket.
    const wsUrl = `${this.serviceUrl.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(this.phoneNumber)}`;
    const recipient = this.resolvedRecipient ?? this.recipientNumber;

    // Resolve WebSocket implementation before opening the connection
    let WebSocketImpl: any;
    try {
      // Prefer global WebSocket (Bun, Deno), fall back to 'ws' package (Node).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      WebSocketImpl = globalThis.WebSocket ?? ((await import("ws" as string)) as any).default;
    } catch {
      return null;
    }

    return new Promise<RemoteAnswer | null>((resolve) => {
      let settled = false;
      const finish = (result: RemoteAnswer | null) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        resolve(result);
      };

      // Timeout: don't hold the WebSocket open longer than one poll interval
      const timer = setTimeout(() => finish(null), 8_000);

      let ws: any;
      try {
        ws = new WebSocketImpl(wsUrl);
      } catch {
        clearTimeout(timer);
        resolve(null);
        return;
      }

      ws.onmessage = (event: any) => {
        try {
          const data = typeof event.data === "string" ? event.data : event.data.toString();
          const envelope = JSON.parse(data);
          const msg = envelope.envelope?.dataMessage;
          if (!msg?.message) return;

          const sender = envelope.envelope?.source;
          const senderUuid = envelope.envelope?.sourceUuid;

          // Match by phone number or UUID
          const isRecipient =
            sender === this.recipientNumber ||
            senderUuid === recipient ||
            sender === recipient;
          if (!isRecipient) return;

          const msgTimestamp = msg.timestamp ?? 0;
          if (msgTimestamp < this.lastSentTimestamp) return;

          clearTimeout(timer);
          finish(parseSignalResponse(msg.message.trim(), prompt.questions, prompt.id));
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };

      ws.onclose = () => {
        clearTimeout(timer);
        finish(null);
      };
    });
  }

  async acknowledgeAnswer(ref: RemotePromptRef): Promise<void> {
    const recipient = this.resolvedRecipient ?? this.recipientNumber;
    try {
      await fetch(`${this.serviceUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "✅ Got it — continuing.",
          number: this.phoneNumber,
          recipients: [recipient],
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best-effort
    }
  }

  /**
   * Resolve the recipient to a UUID if signal-cli has them indexed by UUID
   * rather than phone number. Falls back to the phone number if no match.
   */
  private async resolveRecipient(): Promise<string> {
    if (this.resolvedRecipient) return this.resolvedRecipient;

    // If it already looks like a UUID, use it directly
    if (/^[0-9a-f]{8}-/.test(this.recipientNumber)) {
      this.resolvedRecipient = this.recipientNumber;
      return this.resolvedRecipient;
    }

    // Try the contacts list to find the UUID for this phone number
    try {
      const resp = await fetch(
        `${this.serviceUrl}/v1/contacts/${encodeURIComponent(this.phoneNumber)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (resp.ok) {
        const contacts: any[] = await resp.json();
        if (Array.isArray(contacts)) {
          // Match by phone number
          const match = contacts.find((c: any) => c.number === this.recipientNumber);
          if (match?.uuid) {
            this.resolvedRecipient = match.uuid as string;
            return this.resolvedRecipient;
          }
        }
      }
    } catch {
      // Best-effort — fall through to phone number
    }

    // Fall back to phone number (works if signal-cli has the mapping)
    this.resolvedRecipient = this.recipientNumber;
    return this.resolvedRecipient;
  }
}
