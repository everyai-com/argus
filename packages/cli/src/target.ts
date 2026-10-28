/**
 * Test-target resolution — the "just point it at my app" layer.
 *
 * Every testing command accepts the same three target forms:
 *   - a URL (`https://my-app.com`) — tested as-is;
 *   - a bare port (`3000`) — localhost is tunnelled to the cloud and tested;
 *   - nothing — common dev-server ports are scanned and a lone hit is used.
 */

export type TargetInput =
  | { kind: "url"; url: string }
  | { kind: "port"; port: number }
  | { kind: "none" };

/** Split a raw CLI target arg. A 2–5 digit number is a localhost port. */
export function parseTarget(arg: string | undefined): TargetInput {
  if (!arg) return { kind: "none" };
  if (/^\d{2,5}$/.test(arg)) return { kind: "port", port: Number(arg) };
  return { kind: "url", url: arg };
}

/**
 * Dev-server ports, most common first. 5000 is deliberately absent: macOS
 * parks AirPlay there, so scanning it false-positives on every Mac —
 * `argus test 5000` still works explicitly.
 */
export const LOCAL_PORTS = [3000, 5173, 5174, 8080, 8000, 4200, 4321, 8787, 9000];

/**
 * Probe localhost ports in parallel; return the ones serving HTTP, in
 * LOCAL_PORTS order. Any response (even an error page) counts — something is
 * listening. Never throws: unreachable ports resolve to misses.
 */
export async function scanLocalPorts(
  ports: number[] = LOCAL_PORTS,
  timeoutMs = 1200
): Promise<number[]> {
  const hits = await Promise.all(
    ports.map(async (port) => {
      try {
        await fetch(`http://localhost:${port}/`, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return port;
      } catch {
        return undefined;
      }
    })
  );
  return hits.filter((p): p is number => p !== undefined);
}
