import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseTarget, scanLocalPorts } from "./target";

describe("parseTarget", () => {
  it("passes URLs through", () => {
    expect(parseTarget("https://my-app.com")).toEqual({ kind: "url", url: "https://my-app.com" });
    expect(parseTarget("http://localhost:5199/x?y=1")).toEqual({
      kind: "url",
      url: "http://localhost:5199/x?y=1",
    });
  });

  it("reads bare 2–5 digit numbers as localhost ports", () => {
    expect(parseTarget("3000")).toEqual({ kind: "port", port: 3000 });
    expect(parseTarget("80")).toEqual({ kind: "port", port: 80 });
  });

  it("reports missing args as none", () => {
    expect(parseTarget(undefined)).toEqual({ kind: "none" });
    expect(parseTarget("")).toEqual({ kind: "none" });
  });
});

describe("scanLocalPorts", () => {
  it("finds a listening server and skips closed ports", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("hi");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const live = (server.address() as { port: number }).port;
    try {
      const hits = await scanLocalPorts([live, 1], 2000);
      expect(hits).toEqual([live]);
    } finally {
      server.close();
    }
  });

  it("returns [] when nothing listens", async () => {
    await expect(scanLocalPorts([1], 500)).resolves.toEqual([]);
  });
});
