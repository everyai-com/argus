/**
 * Shared verification logic: anchor resolution ladder + predicate evaluation.
 *
 * The implementation lives in `@argus/core` so the local runner executes the
 * very same ladder and predicates as the BrowserSession DO and the flow-replay
 * engine. This module stays as the Worker's import point.
 */
export {
  evalPredicate,
  levenshtein,
  nearestMatch,
  resolveAnchor,
  weakestTier,
  type EventBuffers,
} from "@argus/core";
