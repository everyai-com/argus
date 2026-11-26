/**
 * @argus/core — verification logic with no runtime of its own.
 *
 * The anchor ladder, the ambiguity refusal, predicate evaluation and the audit
 * signals, typed structurally (see ./page.ts) so the cloud Worker
 * (`@cloudflare/playwright`) and the local runner (`playwright-core`) execute
 * the same code. Nothing here imports a browser driver, Node or Workers APIs.
 */
export * from "./anchors.ts";
export * from "./buffers.ts";
export * from "./page.ts";
export * from "./predicates.ts";
export * from "./signals.ts";
