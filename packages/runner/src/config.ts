/**
 * argus.config.ts — what to run, against what, and how strict to be.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VIEWPORTS, type ViewportName } from "@argus/shared";
import type { AuditGates } from "./api.ts";
import { RunnerError } from "./errors.ts";

export interface AppConfig {
  /** Where the app answers. Relative `page.goto` targets resolve against it. */
  url: string;
  /**
   * Shell command that starts the app. The runner starts it, waits until it
   * answers, runs the tests, then stops it and everything it spawned. With a
   * command, the URL's port must be free: a server already listening there is
   * an error, never a silent reuse. Leave it out to test an app that is
   * already running.
   */
  command?: string;
  /** Working directory for `command`, relative to the config file. */
  cwd?: string;
  env?: Record<string, string>;
  /** Poll this instead of `url` to decide the app is up (e.g. a /health route). */
  readyUrl?: string;
  /** How long the app may take to answer, ms. Default 60000. */
  startupTimeout?: number;
}

export interface BrowserConfig {
  /** Default true. `--headed` on the command line turns it off. */
  headless?: boolean;
  /** A branded browser channel, e.g. "chrome". Default: Playwright's Chromium. */
  channel?: string;
  /** An exact browser binary. Also settable as ARGUS_BROWSER_PATH. */
  executablePath?: string;
}

export interface ArgusConfig {
  /** Test file globs, relative to the config file. Default "**\/*.argus.ts". */
  tests?: string | string[];
  app?: AppConfig;
  browser?: BrowserConfig;
  /** A named Argus viewport (mobile | tablet | desktop) or an exact size. Default "desktop". */
  viewport?: ViewportName | { width: number; height: number };
  /** Budget per test, ms. Default 30000. */
  timeout?: number;
  /** Budget per `expect`, ms. Default 5000. */
  expectTimeout?: number;
  /** Budget per action (click, fill, …), ms. Default 5000. */
  actionTimeout?: number;
  /** Audit gates applied to every test. Both default on. */
  audit?: Partial<AuditGates>;
  /** Test files run side by side. Default 1. */
  workers?: number;
  /** Failure screenshots and the app log land here. Default ".argus/runs/local". */
  outputDir?: string;
}

/** Identity function that gives a config file its types. */
export function defineConfig(config: ArgusConfig): ArgusConfig {
  return config;
}

export interface ResolvedConfig {
  /** Directory every relative path in the config is resolved against. */
  rootDir: string;
  configFile?: string;
  tests: string[];
  app?: AppConfig & { cwd: string; startupTimeout: number };
  browser: BrowserConfig;
  viewport: { width: number; height: number };
  timeout: number;
  expectTimeout: number;
  actionTimeout: number;
  audit: AuditGates;
  workers: number;
  outputDir: string;
}

const CONFIG_NAMES = ["argus.config.ts", "argus.config.mts", "argus.config.mjs", "argus.config.js"];

export function resolveViewport(v: ViewportName | { width: number; height: number } | undefined): {
  width: number;
  height: number;
} {
  if (v === undefined) return { ...VIEWPORTS.desktop };
  if (typeof v === "string") {
    const named = VIEWPORTS[v];
    if (!named) throw new RunnerError("bad_config", `unknown viewport "${v}" — use mobile, tablet, desktop or { width, height }`);
    return { ...named };
  }
  return { width: v.width, height: v.height };
}

function positive(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new RunnerError("bad_config", `config.${name} must be a positive number, got ${JSON.stringify(value)}`);
  return value;
}

export async function loadConfig(cwd: string, explicit?: string): Promise<ResolvedConfig> {
  let file: string | undefined;
  if (explicit) {
    file = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(file)) throw new RunnerError("no_config", `config file not found: ${file}`);
  } else {
    file = CONFIG_NAMES.map((n) => resolve(cwd, n)).find((f) => existsSync(f));
  }

  let raw: ArgusConfig = {};
  if (file) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: ArgusConfig };
    if (!mod.default || typeof mod.default !== "object")
      throw new RunnerError("bad_config", `${file} must \`export default defineConfig({ ... })\``);
    raw = mod.default;
  }
  return resolveConfig(raw, file ? dirname(file) : cwd, file);
}

export function resolveConfig(raw: ArgusConfig, rootDir: string, configFile?: string): ResolvedConfig {
  let app: ResolvedConfig["app"];
  if (raw.app) {
    try {
      const u = new URL(raw.app.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http(s)");
      if (raw.app.readyUrl) new URL(raw.app.readyUrl);
    } catch {
      throw new RunnerError("bad_config", `config.app.url must be an absolute http(s) URL, got ${JSON.stringify(raw.app.url)}`);
    }
    app = {
      ...raw.app,
      cwd: resolve(rootDir, raw.app.cwd ?? "."),
      startupTimeout: positive("app.startupTimeout", raw.app.startupTimeout, 60_000),
    };
  }
  const tests = raw.tests === undefined ? ["**/*.argus.ts"] : Array.isArray(raw.tests) ? raw.tests : [raw.tests];
  return {
    rootDir,
    configFile,
    tests,
    app,
    browser: raw.browser ?? {},
    viewport: resolveViewport(raw.viewport),
    timeout: positive("timeout", raw.timeout, 30_000),
    expectTimeout: positive("expectTimeout", raw.expectTimeout, 5_000),
    actionTimeout: positive("actionTimeout", raw.actionTimeout, 5_000),
    audit: {
      consoleErrors: raw.audit?.consoleErrors ?? true,
      horizontalOverflow: raw.audit?.horizontalOverflow ?? true,
      includeThirdParty: raw.audit?.includeThirdParty ?? false,
    },
    workers: Math.max(1, Math.floor(positive("workers", raw.workers, 1))),
    outputDir: resolve(rootDir, raw.outputDir ?? ".argus/runs/local"),
  };
}
