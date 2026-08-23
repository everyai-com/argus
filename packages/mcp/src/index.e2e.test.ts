import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connect(cwd: string) {
  const server = resolve(process.cwd(), "packages/mcp/dist/index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "argus-e2e", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("MCP executable", () => {
  it("registers the complete browser and verification tool surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "argus-mcp-"));
    roots.push(root);
    const { client, transport } = await connect(root);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "argus_lease",
          "argus_act",
          "argus_act_batch",
          "argus_observe",
          "argus_assert",
          "argus_screenshot",
          "argus_record",
          "argus_flow_replay",
          "argus_flow_verify",
          "argus_flow_heal",
          "argus_flow_import_reticle",
          "argus_audit",
        ])
      );
    } finally {
      await client.close();
      await transport.close().catch(() => {});
    }
  });

  it("imports a current Reticle v1 flow through the real MCP process", async () => {
    const root = mkdtempSync(join(tmpdir(), "argus-reticle-"));
    roots.push(root);
    const source = join(root, ".reticle", "flows", "checkout.json");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(
      source,
      JSON.stringify({
        version: 1,
        name: "checkout",
        startPath: "/cart",
        createdAt: 1,
        steps: [
          {
            tool: "reticle_act_and_wait",
            anchor: { kind: "testid", value: "checkout" },
            action: "click",
            expect: { net: { method: "POST", urlContains: "/orders", status: 201, count: 1 } },
          },
        ],
        success: { element: { testid: "receipt" } },
      })
    );
    const { client, transport } = await connect(root);
    try {
      const result = await client.callTool({
        name: "argus_flow_import_reticle",
        arguments: { startUrl: "https://shop.example" },
      });
      expect(result.isError).not.toBe(true);
      const imported = JSON.parse(readFileSync(join(root, ".argus", "flows", "checkout.json"), "utf8"));
      expect(imported.startUrl).toBe("https://shop.example/cart");
      expect(imported.steps[0]).toMatchObject({
        action: { action: "click" },
        anchor: { testid: "checkout" },
        expect: [
          {
            kind: "network",
            method: "POST",
            urlIncludes: "/orders",
            status: 201,
            minCount: 1,
            maxCount: 1,
          },
        ],
      });
      expect(imported.success).toEqual([
        { kind: "visible", anchor: { testid: "receipt" } },
      ]);
    } finally {
      await client.close();
      await transport.close().catch(() => {});
    }
  });
});
