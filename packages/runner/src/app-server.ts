/**
 * The app under test: started from config, stopped when the run ends.
 *
 * Two rules keep a local run honest:
 *  - With a `command`, the port must be free first. A server already listening
 *    there is somebody else's process (often yesterday's build); testing it
 *    would report on code that is not the code in the tree. That is an error.
 *  - Stop means the whole process tree, and the port released — `pnpm exec vite`
 *    and `wrangler dev` both hand the socket to a grandchild.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { RunnerError } from "./errors.ts";

export interface AppSpec {
  url: string;
  command?: string;
  cwd: string;
  env?: Record<string, string>;
  readyUrl?: string;
  startupTimeout: number;
}

export interface RunningApp {
  url: string;
  /** Whether this run started the app (false: it was already running). */
  started: boolean;
  /** How long the app took to answer, ms. */
  readyMs: number;
  logFile?: string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function endpoint(url: string): { host: string; port: number } {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port };
}

function canConnect(address: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: address, port });
    const finish = (open: boolean) => {
      socket.destroy();
      done(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Every address the host name can mean — `localhost` is both 127.0.0.1 and ::1. */
async function addressesOf(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true })
    .then((list) => list.map((a) => a.address))
    .catch(() => [host]);
  if (host === "localhost") found.push("127.0.0.1", "::1");
  return [...new Set(found)];
}

/** The address something is listening on for this URL's port, if anything is. */
export async function listenerOn(url: string): Promise<string | undefined> {
  const { host, port } = endpoint(url);
  for (const address of await addressesOf(host)) {
    if (await canConnect(address, port)) return `${address.includes(":") ? `[${address}]` : address}:${port}`;
  }
  return undefined;
}

/**
 * One probe. The budget is generous on purpose: a Worker's first request can
 * take many seconds to compile, and cutting it short only queues another.
 */
async function answers(url: string, budgetMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, budgetMs)), redirect: "manual" });
    await res.body?.cancel().catch(() => {});
    return res.status < 500;
  } catch {
    return false;
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal); // the whole process group (spawned detached)
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * PATH with every `node_modules/.bin` from `cwd` upward in front — what a
 * package script gets — so a config can say `vite preview` instead of paying
 * for a package manager to find it.
 */
function pathWithLocalBins(cwd: string, path: string | undefined): string {
  const bins: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    const bin = join(dir, "node_modules", ".bin");
    if (existsSync(bin)) bins.push(bin);
    if (dirname(dir) === dir) break;
  }
  return [...bins, ...(path ? [path] : [])].join(delimiter);
}

export async function startApp(spec: AppSpec, logFile: string): Promise<RunningApp> {
  const readyUrl = spec.readyUrl ?? spec.url;
  const { port } = endpoint(spec.url);
  const t0 = Date.now();

  if (!spec.command) {
    // No command: the app is the caller's to run. It only has to be there.
    const deadline = t0 + Math.min(spec.startupTimeout, 10_000);
    while (!(await answers(readyUrl))) {
      if (Date.now() >= deadline)
        throw new RunnerError(
          "app_unreachable",
          `nothing answers at ${readyUrl}`,
          "start the app first, or set app.command in the config so `argus run` starts and stops it"
        );
      await sleep(200);
    }
    return { url: spec.url, started: false, readyMs: Date.now() - t0, stop: async () => {} };
  }

  const taken = await listenerOn(spec.url);
  if (taken)
    throw new RunnerError(
      "port_in_use",
      `port ${port} is already in use — something is listening on ${taken}`,
      `\`argus run\` starts the app itself (app.command), so it will not test whatever that is. ` +
        `Stop it (lsof -i :${port}) and re-run, or remove app.command to test an app you run yourself.`
    );

  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile);
  const tail: string[] = [];
  const child = spawn(spec.command, {
    cwd: spec.cwd,
    env: { ...process.env, PATH: pathWithLocalBins(spec.cwd, process.env.PATH), ...spec.env },
    shell: true,
    detached: process.platform !== "win32", // own process group, so stop() can take the tree
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  child.once("exit", (code, signal) => (exited = { code, signal }));
  child.once("error", (err) => {
    spawnError = err;
    exited ??= { code: null, signal: null };
  });
  const onOutput = (chunk: Buffer) => {
    log.write(chunk);
    tail.push(...chunk.toString("utf8").split("\n").filter(Boolean));
    if (tail.length > 30) tail.splice(0, tail.length - 30);
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!exited) {
      killTree(child, "SIGTERM");
      await Promise.race([closed, sleep(5_000)]);
      if (!exited) killTree(child, "SIGKILL");
      await Promise.race([closed, sleep(2_000)]);
    } else {
      killTree(child, "SIGKILL"); // the shell is gone; make sure nothing it started lingers
    }
    // Stopped means the port is free again, so the next run can start cleanly.
    for (let i = 0; i < 50 && (await listenerOn(spec.url)); i++) await sleep(100);
    await new Promise<void>((done) => log.end(done));
  };

  const lastOutput = () => (tail.length ? `\n  last output:\n${tail.slice(-12).map((l) => `    ${l}`).join("\n")}` : "");
  const deadline = t0 + spec.startupTimeout;
  for (;;) {
    if (exited) {
      // `exit` can arrive before the last of its output: let the pipes drain.
      await Promise.race([closed, sleep(1_000)]);
      await stop();
      throw new RunnerError(
        "app_exited",
        `the app exited before it answered at ${readyUrl} (${
          spawnError ? spawnError.message : `exit code ${exited.code ?? exited.signal}`
        }): ${spec.command}${lastOutput()}`,
        `full log: ${logFile}`
      );
    }
    // Race the probe against the child dying, so a crash is reported at once.
    const up = await Promise.race([
      answers(readyUrl, Math.min(10_000, deadline - Date.now())),
      closed.then(() => false),
    ]);
    if (up) break;
    if (exited) continue;
    if (Date.now() >= deadline) {
      await stop();
      throw new RunnerError(
        "app_start_timeout",
        `the app did not answer at ${readyUrl} within ${Math.round(spec.startupTimeout / 1000)}s: ${spec.command}${lastOutput()}`,
        `full log: ${logFile} — raise app.startupTimeout if it is just slow to boot`
      );
    }
    await sleep(100);
  }
  return { url: spec.url, started: true, readyMs: Date.now() - t0, logFile, stop };
}
