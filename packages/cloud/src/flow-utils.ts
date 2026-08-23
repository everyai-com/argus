import type { Flow } from "@argus/shared";

/**
 * Re-home a flow onto another environment without changing its path, query,
 * fragment, anchors, or assertions.
 */
export function rehomeFlow(flow: Flow, baseUrl: string): Flow {
  try {
    const base = new URL(baseUrl);
    const original = new URL(flow.startUrl);
    original.protocol = base.protocol;
    original.host = base.host;
    return { ...flow, startUrl: original.toString() };
  } catch {
    return flow;
  }
}
