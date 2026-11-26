/**
 * The slice of a Playwright page this package touches, written structurally.
 *
 * Two Playwright builds drive Argus: `@cloudflare/playwright` inside the Worker
 * and `playwright-core` in the local runner. Their `Page`/`Locator` types are
 * nominally unrelated, so the shared logic is typed against the few members it
 * actually calls. Both builds satisfy these shapes; neither is imported here,
 * which is what keeps this package loadable from a Worker and from Node alike.
 */

/* Members are declared as methods so parameters stay bivariant: Playwright
 * narrows `role` to a union and overloads `evaluate`, and both must assign. */
export interface LocatorLike {
  count(): Promise<number>;
  first(): LocatorLike;
  nth(index: number): LocatorLike;
  isVisible(): Promise<boolean>;
  innerText(options?: { timeout?: number }): Promise<string>;
  evaluateAll(fn: any, arg?: any): Promise<any>;
}

/** Anything anchors resolve against — a page (or, later, a scoped region). */
export interface AnchorRoot<L> {
  getByTestId(testId: string): L;
  getByRole(role: any, options?: { name?: string }): L;
  getByLabel(text: string): L;
  getByPlaceholder(text: string): L;
  getByText(text: string): L;
  locator(selector: string): L;
}

export interface PageLike<L extends LocatorLike = LocatorLike> extends AnchorRoot<L> {
  url(): string;
  evaluate(fn: any, arg?: any): Promise<any>;
}

/** Just enough of an event emitter to bind the observation buffers. */
export interface EventSourceLike {
  on(event: any, listener: (payload: any) => any): unknown;
}
