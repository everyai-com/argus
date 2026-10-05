import type { Flow } from "@argus/shared";

/**
 * Re-home a flow onto another environment without changing its path, query,
 * fragment, anchors, or assertions.
 */
export function rehomeFlow(flow: Flow, baseUrl: string): Flow {
  try {
    const base = new URL(baseUrl);
    const original = new URL(flow.startUrl);
    // Hostname and port separately: assigning `.host` keeps the flow's
    // original port, which transplants e.g. :5199 onto a tunnel URL.
    original.protocol = base.protocol;
    original.hostname = base.hostname;
    original.port = base.port;
    return { ...flow, startUrl: original.toString() };
  } catch {
    return flow;
  }
}
