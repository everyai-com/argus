/**
 * The remote MCP endpoint and the stdio server are two doors onto the same tool
 * surface — an agent may connect through either. This test pins them together:
 * for every tool both expose, the required inputs and the JSON shape of every
 * shared input must be identical, and a param only one side offers must be
 * optional.
 *
 * Wrapping a shared schema (e.g. ActionSchema) in another object on one side
 * passes that server's own tests while making every real call fail — the drift
 * this test refuses.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import app from "./index";

interface SchemaNode {
  required?: string[];
  properties?: Record<string, unknown>;
}

/** Descriptions and the root $schema are allowed to differ (the remote surface is terser). */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([key]) => key !== "description" && key !== "$schema")
        .map(([key, value]) => [key, normalize(value)])
    );
  }
  return node;
}

async function remoteTools(): Promise<Map<string, SchemaNode>> {
  const env = {
    ARGUS_TOKEN: "admin-secret",
    COORDINATOR: {
      idFromName: () => "main",
      get: () => ({ fetch: async () => ({ json: async () => ({}) }) }),
    },
    BROWSER_SESSION: { idFromName: (id: string) => id, get: () => ({ fetch: async () => ({}) }) },
    ARTIFACTS: {},
  } as never;
  const res = await app.request(
    "https://argus.test/mcp",
    {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    },
    env
  );
  const body = (await res.json()) as {
    result: { tools: Array<{ name: string; inputSchema: SchemaNode }> };
  };
  return new Map(body.result.tools.map((t) => [t.name, t.inputSchema]));
}

async function stdioTools(): Promise<Map<string, SchemaNode>> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(process.cwd(), "packages/mcp/dist/index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "argus-parity", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    return new Map(listed.tools.map((t) => [t.name, t.inputSchema as SchemaNode]));
  } finally {
    await transport.close();
  }
}

describe("MCP surface parity (remote endpoint vs stdio server)", () => {
  it("exposes the same shape for every shared tool", async () => {
    const remote = await remoteTools();
    const stdio = await stdioTools();
    const shared = [...remote.keys()].filter((name) => stdio.has(name));
    expect(shared.length).toBeGreaterThan(15);

    for (const name of shared) {
      const r = remote.get(name)!;
      const s = stdio.get(name)!;
      const required = (schema: SchemaNode) => [...(schema.required ?? [])].sort();
      expect(required(r), name + ": required inputs").toEqual(required(s));

      const rProps = r.properties ?? {};
      const sProps = s.properties ?? {};
      for (const [p, schema] of Object.entries(rProps)) {
        if (!(p in sProps)) {
          expect(r.required ?? [], name + "." + p + " is remote-only, so it must be optional").not.toContain(p);
          continue;
        }
        expect(normalize(schema), name + "." + p + " shape").toEqual(normalize(sProps[p]));
      }
      for (const p of Object.keys(sProps)) {
        if (!(p in rProps)) {
          expect(s.required ?? [], name + "." + p + " is stdio-only, so it must be optional").not.toContain(p);
        }
      }
    }
  }, 30_000);
});
