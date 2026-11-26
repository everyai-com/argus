import { createServer, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenerOn, startApp, type RunningApp } from "./app-server.ts";

const log = () => join(mkdtempSync(join(tmpdir(), "argus-app-")), "app.log");
const spec = (port: number, command?: string) => ({
  url: `http://127.0.0.1:${port}`,
  command,
  cwd: process.cwd(),
  startupTimeout: 15_000,
});
/** An HTTP server, started through a shell and a child of that shell — like `pnpm exec vite`. */
const serve = (port: number) =>
  `node -e "require('node:child_process').spawn(process.execPath, ['-e', 'require(\\'node:http\\').createServer((q,s)=>s.end(\\'ok\\')).listen(${port},\\'127.0.0.1\\')'], {stdio:'inherit'})"`;

let app: RunningApp | undefined;
let squatter: Server | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
  await new Promise<void>((done) => (squatter ? squatter.close(() => done()) : done()));
  squatter = undefined;
});

describe("app under test", () => {
  it("refuses to start when the port is already taken", async () => {
    squatter = createServer().listen(5391, "127.0.0.1");
    await new Promise((r) => squatter!.once("listening", r));
    await expect(startApp(spec(5391, serve(5391)), log())).rejects.toMatchObject({
      code: "port_in_use",
      message: expect.stringContaining("port 5391 is already in use"),
    });
  });

  it("starts the app, waits until it answers, and frees the port on stop — grandchild included", async () => {
    app = await startApp(spec(5392, serve(5392)), log());
    expect(app.started).toBe(true);
    expect(await (await fetch("http://127.0.0.1:5392/")).text()).toBe("ok");
    await app.stop();
    expect(await listenerOn("http://127.0.0.1:5392")).toBeUndefined();
  });

  it("reports an app that exits before answering, with its output", async () => {
    await expect(
      startApp(spec(5393, `node -e "console.error('cannot bind'); process.exit(3)"`), log())
    ).rejects.toMatchObject({ code: "app_exited", message: expect.stringContaining("cannot bind") });
  });

  it("without a command, only requires that something answers", async () => {
    await expect(startApp({ ...spec(5394), startupTimeout: 600 }, log())).rejects.toMatchObject({
      code: "app_unreachable",
    });
  });
});
