# Platforms

| Platform | Where it runs | How | Status |
|---|---|---|---|
| Web | Argus cloud (Browser Rendering) | `argus_lease { url }` | shipped |
| Web on a phone | Argus cloud | `viewport: "phone"` (touch, mobile UA, meta-viewport) + `network: "slow3g"` | shipped |
| Desktop (Electron) | your machine, via the stdio MCP server | `argus_lease { url, electron: { app } }` | shipped |
| iOS / Android (native) | your machine (simulator/emulator) | see below | designed, not built |

## Desktop (Electron)

The stdio MCP server launches the app with Playwright's Electron driver and
runs the **same engine** the cloud does — `pageState`/`actEffects`
(detectors), `waitForQuiet`/`slowRequest`/`pendingFeedback` (settle and
mid-request capture), `resolveAnchor`/`evalPredicate` (anchors and
predicates) — imported straight from `packages/cloud/src`. Session ids start
with `local-`; the server's `api()` routes them locally, so `argus_query`,
`argus_act`, `argus_act_batch`, `argus_observe`, `argus_assert`,
`argus_screenshot` and `argus_release` behave identically on a desktop app
and a cloud page.

```jsonc
// argus_lease
{ "url": "https://app.example.com/", "electron": { "app": "./apps/desktop", "executablePath": "<optional Electron binary>" } }
```

Not yet on local sessions: recording/flow replay, auth profiles, email links
(they live in the cloud). `playwright-core` is a dependency of `@argus/mcp`;
Electron itself comes from the app's own `electron` package.

## iOS / Android (design)

Native apps have no DOM, so the engine's DOM reads don't transfer; the
contract does.

- **Driver.** Maestro (one tool for both platforms, runs on a simulator or
  emulator) behind the same `local-` session routing. iOS can also use the
  simulator's XCTest accessibility snapshot directly.
- **Anchors.** `testid` → accessibility identifier; `role`+`name` →
  accessibility trait + label (the ladder is unchanged); `text` → visible
  label; `css` has no equivalent and is refused (verify-or-refuse).
- **Effects.** `domNodeDelta`/`domMutations` become a diff of the
  accessibility tree before/after; `silentAction` keeps its meaning (an
  interaction that changed nothing on screen and sent nothing).
  Network truth comes from a local proxy the simulator is pointed at, so
  `network` predicates and `failureShownAsSuccess` keep the consequence tier.
- **Tiers.** Accessibility-tree reads are `dom` tier; screenshots stay
  `visual`. No upgrade.
- **Personas.** The mobile persona moves from `viewport: "phone"` to a real
  simulator; the rest of the protocol (friction log, merge, red flows, fix,
  rerun) is unchanged.
