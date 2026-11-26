/**
 * Test collection. Importing a test file runs its top level, which calls
 * `describe`/`test`; those calls land here. The registry hangs off
 * `globalThis` so a second copy of this module (two installs, a symlink)
 * still registers into the run that is collecting.
 */
import type { Fixtures, TestOptions } from "./api.ts";

export type TestFn = (fixtures: Fixtures) => Promise<void> | void;
type Mode = "run" | "skip" | "only";

export interface Suite {
  title: string;
  parent?: Suite;
  mode: Mode;
  beforeEach: TestFn[];
  afterEach: TestFn[];
}

export interface TestCase {
  file: string;
  title: string;
  /** Enclosing `describe` titles, outermost first. */
  path: string[];
  fn: TestFn;
  options: TestOptions;
  mode: Mode;
  suite: Suite;
}

interface Registry {
  file?: string;
  suite?: Suite;
  tests: TestCase[];
}

const KEY = Symbol.for("argus.runner.registry");
const registry: Registry = ((globalThis as Record<symbol, unknown>)[KEY] ??= { tests: [] }) as Registry;

function current(): { file: string; suite: Suite } {
  if (!registry.file || !registry.suite)
    throw new Error("test() and describe() only work in a file run by `argus run`");
  return { file: registry.file, suite: registry.suite };
}

/** Import one test file and return the tests it declared. */
export async function collect(file: string, load: () => Promise<unknown>): Promise<TestCase[]> {
  const before = registry.tests.length;
  registry.file = file;
  registry.suite = { title: "", mode: "run", beforeEach: [], afterEach: [] };
  try {
    await load();
  } finally {
    registry.file = undefined;
    registry.suite = undefined;
  }
  return registry.tests.slice(before);
}

function suitePath(suite: Suite): string[] {
  const path: string[] = [];
  for (let s: Suite | undefined = suite; s; s = s.parent) if (s.title) path.unshift(s.title);
  return path;
}

/** A test inherits skip/only from the nearest enclosing describe that sets one. */
function inherited(mode: Mode, suite: Suite): Mode {
  for (let s: Suite | undefined = suite; s; s = s.parent) {
    if (s.mode === "skip") return "skip";
    if (s.mode === "only" && mode === "run") mode = "only";
  }
  return mode;
}

function addTest(mode: Mode, title: string, a: TestOptions | TestFn, b?: TestFn): void {
  const { file, suite } = current();
  const fn = typeof a === "function" ? a : b;
  const options = typeof a === "function" ? {} : a;
  if (typeof fn !== "function") throw new Error(`test("${title}") needs a function`);
  registry.tests.push({ file, title, path: suitePath(suite), fn, options, mode: inherited(mode, suite), suite });
}

function addSuite(mode: Mode, title: string, body: () => void): void {
  const { suite: parent } = current();
  const suite: Suite = { title, parent, mode, beforeEach: [], afterEach: [] };
  registry.suite = suite;
  try {
    const out: unknown = body();
    if (out && typeof (out as Promise<unknown>).then === "function")
      throw new Error(`describe("${title}") must declare its tests synchronously`);
  } finally {
    registry.suite = parent;
  }
}

export interface TestApi {
  (title: string, fn: TestFn): void;
  (title: string, options: TestOptions, fn: TestFn): void;
  /** Declared but not run; reported as skipped. */
  skip: TestApi;
  /** Run only the tests marked so. Refused when `CI` is set. */
  only: TestApi;
}

function makeTest(mode: Mode): TestApi {
  const t = ((title: string, a: TestOptions | TestFn, b?: TestFn) => addTest(mode, title, a, b)) as TestApi;
  return t;
}

export const test: TestApi = makeTest("run");
test.skip = makeTest("skip");
test.only = makeTest("only");

export interface DescribeApi {
  (title: string, body: () => void): void;
  skip: (title: string, body: () => void) => void;
  only: (title: string, body: () => void) => void;
}

export const describe: DescribeApi = Object.assign(
  (title: string, body: () => void) => addSuite("run", title, body),
  {
    skip: (title: string, body: () => void) => addSuite("skip", title, body),
    only: (title: string, body: () => void) => addSuite("only", title, body),
  }
);

/** Runs before each test in the enclosing describe (or file), outermost first. */
export function beforeEach(fn: TestFn): void {
  current().suite.beforeEach.push(fn);
}

/** Runs after each test in the enclosing describe (or file), innermost first — even when the test failed. */
export function afterEach(fn: TestFn): void {
  current().suite.afterEach.push(fn);
}

export function hooksFor(test: TestCase): { before: TestFn[]; after: TestFn[] } {
  const chain: Suite[] = [];
  for (let s: Suite | undefined = test.suite; s; s = s.parent) chain.unshift(s);
  return {
    before: chain.flatMap((s) => s.beforeEach),
    after: chain.reverse().flatMap((s) => s.afterEach),
  };
}
