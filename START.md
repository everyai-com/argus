# Start here

**The whole thing is one link. Paste this to your coding agent and answer its one
question:**

```
Read https://raw.githubusercontent.com/everyai-com/argus/main/START.md and do exactly what it says.
```

That's it. No config to copy, no flags to learn.

---

## If you are the agent reading this

Your job: take this project from nothing to a **verdict**, then keep it green. Argus runs real
Chromium on Cloudflare; you drive it and read back what actually happened.

**Ask the human exactly one question, once:** their Argus API URL and token. Everything else you can
find yourself. If they don't have one, see "Deploy an Argus once" below.

### Do this

1. **Get the Argus tooling** (once per machine):
   ```bash
   git clone https://github.com/everyai-com/argus.git ~/.argus-src
   cd ~/.argus-src && pnpm install && pnpm check
   ```
2. **Find the app and how it runs.** Read `package.json` scripts and the framework. If the app is
   already deployed, use its URL; if it runs locally, note the dev port.
3. **One command to a verdict:**
   ```bash
   node ~/.argus-src/packages/cli/dist/index.js onboard <API_URL> <TOKEN> --url <app-url>
   # or, for a local app:
   node ~/.argus-src/packages/cli/dist/index.js onboard <API_URL> <TOKEN> --local <dev-port>
   ```
   It wires the MCP server into every harness it finds, runs smoke, and replays every saved flow.
4. **Read the last line.**
   - `READY — nothing to fix` → you are done. Tell the human, in one sentence, what was verified.
   - `NOT YET` → fix the findings above (each prints `→ next action`), then run the same command
     again. Repeat until `READY`.
   - `no flows yet` → the app has no test suite. Generate one (`argus preset cf-saas <url>`) or
     explore and record flows (see `SKILL.md`), then run it again.

### The loop — this is the whole product

```
verify  →  read the failures + their next action  →  fix  →  verify again  →  …  →  READY
```

Two rules you may never break:
- **Never weaken a check to make it pass.** If an anchor, flow, or assertion is wrong, fix the flow
  or the app — not the expectation.
- **Missing evidence is reported, not guessed.** `coverage: partial` is not a pass; say so.

### When it fights you

The full symptom → cause → fix table is in
[docs/agent-setup-prompt.md](docs/agent-setup-prompt.md). The ones you'll hit first:

| You see | Do this |
|---|---|
| `401 Unauthorized` | the token is wrong — ask the human for it again |
| `argus_*` tools missing | restart the client; the MCP list is read at startup |
| `Blocked request … host not allowed` | add `server.allowedHosts: [".trycloudflare.com"]` to Vite |
| `missing environment values: FOO` | export `FOO` (or ask the human) — never hard-code a secret |
| `auth profile … not found` | run the login flow (the one with `saveAuthAs`) first |
| `@argus/sdk is not loaded` | you asserted on a signal/state without the SDK — see step 3 of the setup prompt |
| `no .argus/flows` | generate or record flows, then re-run |

### Deploy an Argus once (only if the human has none)

Needs a paid Cloudflare Workers plan (Browser Rendering):

```bash
cd ~/.argus-src/packages/cloud
wrangler secret put ARGUS_TOKEN     # the API fails closed without it
wrangler deploy                     # prints the API URL
```

### Definition of done

You have driven a real flow and returned a verdict: `READY`, or a precise statement of what is still
failing and why. A pile of config files is not "done".
