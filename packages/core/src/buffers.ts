/**
 * Observation buffers — every console line, response and stream frame a page
 * produces, stamped with one shared sequence number. Predicates window over
 * `seq` ("since this step started"), which is what lets a test assert on a
 * consequence without racing the action that caused it.
 */
import type { ConsoleEvent, NetworkEvent, StreamEvent } from "@argus/shared";
import type { EventSourceLike } from "./page.ts";

export interface Buffers {
  network: NetworkEvent[];
  console: ConsoleEvent[];
  stream: StreamEvent[];
  seq: number;
}

/** A Playwright WebSocket frame payload, stringified and capped. */
function framePayload(frame: unknown): string {
  const payload = (frame as { payload?: unknown })?.payload;
  if (payload === undefined || payload === null) return "";
  return (typeof payload === "string" ? payload : String(payload)).slice(0, 500);
}

export function bindBuffers(page: EventSourceLike): Buffers {
  const buf: Buffers = { network: [], console: [], stream: [], seq: 0 };
  page.on("console", (msg) => {
    const level = (["log", "info", "warn", "error"] as const).includes(msg.type() as never)
      ? (msg.type() as "log" | "info" | "warn" | "error")
      : "log";
    buf.console.push({
      seq: ++buf.seq,
      level,
      text: msg.text().slice(0, 500),
      sourceUrl: msg.location()?.url || undefined,
    });
  });
  page.on("pageerror", (err) => {
    buf.console.push({ seq: ++buf.seq, level: "error", text: `Uncaught: ${String(err).slice(0, 500)}` });
  });
  page.on("response", (res) => {
    const req = res.request();
    buf.network.push({
      seq: ++buf.seq,
      method: req.method(),
      url: req.url().slice(0, 300),
      status: res.status(),
      failed: res.status() >= 400,
      resourceType: req.resourceType(),
    });
    if ((res.headers()["content-type"] ?? "").includes("text/event-stream")) {
      buf.stream.push({
        seq: ++buf.seq,
        stream: "sse",
        url: req.url().slice(0, 300),
        direction: "open",
        at: Date.now(),
      });
    }
  });
  page.on("requestfailed", (req) => {
    buf.network.push({
      seq: ++buf.seq,
      method: req.method(),
      url: req.url().slice(0, 300),
      failed: true,
      resourceType: req.resourceType(),
    });
  });
  page.on("websocket", (ws) => {
    const url = ws.url().slice(0, 300);
    buf.stream.push({ seq: ++buf.seq, stream: "websocket", url, direction: "open", at: Date.now() });
    ws.on("framesent", (frame: unknown) =>
      buf.stream.push({
        seq: ++buf.seq,
        stream: "websocket",
        url,
        direction: "sent",
        data: framePayload(frame),
        at: Date.now(),
      })
    );
    ws.on("framereceived", (frame: unknown) =>
      buf.stream.push({
        seq: ++buf.seq,
        stream: "websocket",
        url,
        direction: "received",
        data: framePayload(frame),
        at: Date.now(),
      })
    );
    ws.on("close", () =>
      buf.stream.push({ seq: ++buf.seq, stream: "websocket", url, direction: "close", at: Date.now() })
    );
  });
  return buf;
}
