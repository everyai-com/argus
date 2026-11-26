import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connect(cwd: string, env?: Record<string, string>) {
  const server = resolve(process.cwd(), "packages/mcp/dist/index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd,
    stderr: "pipe",
    ...(env ? { env: { ...(process.env as Record<string, string>), ...env } } : {}),
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
          "argus_flow_draft",
          "argus_flow_replay",
          "argus_flow_verify",
          "argus_flow_heal",
          "argus_flow_import_reticle",
          "argus_audit",
          "argus_tools",
        ])
      );
      // Any MCP client — not just Claude Code — gets the lifecycle guidance
      // from initialize, with no per-harness instruction file required.
      expect(client.getInstructions()).toContain("argus_lease");
      expect(client.getInstructions()).toContain("argus_flow_verify");
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

  it("hands the step and screen diff through, and saves a session's draft as a flow", async () => {
    // A stand-in Argus API (no token, no cloud): it answers what the session DO
    // answers, so this pins the stdio server's side of the contract.
    const actResult = {
      ok: true,
      resolution: { via: "testid", matched: 1 },
      effects: {
        urlBefore: "https://shop.example/",
        urlAfter: "https://shop.example/",
        navigated: false,
        domNodeDelta: 1,
        newConsoleErrors: 0,
        newNetworkFailures: 0,
      },
      step: { action: { action: "click" }, anchor: { testid: "add-task" }, expect: [] },
      diff: { added: ['li "Buy milk"'], removed: [], changed: ['p[testid=task-count]: text "2 task(s)" → "3 task(s)"'] },
    };
    const draft = {
      flow: {
        name: "add-task",
        startUrl: "https://shop.example/",
        viewport: "desktop",
        steps: [
          { action: { action: "fill", value: "${LOGIN_PASSWORD}" }, anchor: { testid: "login-password" }, expect: [] },
          actResult.step,
        ],
        success: [{ kind: "route", includes: "/board" }],
      },
      ready: true,
      suggested: [],
      placeholders: ["LOGIN_PASSWORD"],
      dropped: 0,
      notes: [],
    };
    const requests: Array<{ path: string; body: unknown }> = [];
    const apiServer: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url?.endsWith("/flow-draft") ? draft : actResult));
      });
    });
    await new Promise<void>((done) => apiServer.listen(0, "127.0.0.1", done));
    const root = mkdtempSync(join(tmpdir(), "argus-draft-"));
    roots.push(root);
    const { client, transport } = await connect(root, {
      ARGUS_API: `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`,
      ARGUS_TOKEN: "",
    });
    const text = (result: unknown) =>
      JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
    try {
      const acted = await client.callTool({
        name: "argus_act",
        arguments: { sessionId: "s1", step: { action: "click", ref: "e3" } },
      });
      expect(acted.isError).not.toBe(true);
      expect(text(acted)).toEqual(actResult);
      expect(requests[0]).toEqual({ path: "/v1/session/s1/act", body: { action: "click", ref: "e3" } });

      const drafted = await client.callTool({
        name: "argus_flow_draft",
        arguments: { sessionId: "s1", name: "add-task" },
      });
      expect(drafted.isError).not.toBe(true);
      expect(requests[1]).toEqual({ path: "/v1/session/s1/flow-draft", body: { name: "add-task" } });

      // The draft's `flow` is argus_flow_save's arguments, verbatim.
      const saved = await client.callTool({ name: "argus_flow_save", arguments: text(drafted).flow });
      expect(saved.isError).not.toBe(true);
      const file = JSON.parse(readFileSync(join(root, ".argus", "flows", "add-task.json"), "utf8"));
      expect(file.steps).toEqual(draft.flow.steps);
      expect(file.steps[0].action.value).toBe("${LOGIN_PASSWORD}"); // the placeholder, not a secret, is committed
    } finally {
      await client.close();
      await transport.close().catch(() => {});
      await new Promise((done) => apiServer.close(done));
    }
  });
});
