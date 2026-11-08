# Argus console (dashboard)

Argus is a cloud browser-testing platform for AI agents. This console is where a
team watches its verification results. The left rail groups the tabs:

- **Observe:** Fleet (latest verdict per project), Runs (every run, newest first —
  click one for its findings, screenshots, visual diffs and flow results),
  Sessions (live cloud browsers and their lease clocks).
- **Operate:** Capacity (fleet saturation, launch queue, tenants), GitHub
  (verification posted onto pull requests).
- **Account:** create an account / mint a token.

## Sign in
Do not use the account sign-up or sign-in forms. Instead, paste the token
{{ARGUS_TEST_TOKEN}} into the token field in the left rail (placeholder
`argus_…`) and confirm it. The console then opens on Fleet. This is a test
tenant: it has two projects, `demo-app` and `demo-buggy`, with a passing smoke
run, a failing audit, and a flow suite where one flow (`add-task-wrongstate`)
failed.

## Important flows
- Fleet: each project tile shows its latest verdict; open a project.
- Runs: open each run. Check the findings list (severity, triage tags such as
  "new", fingerprints), the screenshots, the visual diff panel, the flow suite
  (a failed flow shows "confirmed by a second replay" and a "repro saved" line),
  and the "copy fix prompt" buttons. Go back to the list.
- Sessions: an empty list should explain how sessions appear.
- Capacity: read the gauges; this tenant is not an admin, so admin-only parts
  may be refused — check that the refusal is explained, not a blank or broken page.
- GitHub: read the status of the GitHub integration.
- Try each tab at a phone width too, and use the browser back button between a
  run detail and the list.

## Never do these things
- Do not create an account, sign up, or sign in with an email or password.
- Do not press "Create MCP token" or "Rotate token".
- Do not release, delete or end anything (sessions, tenants, runs).
- Do not open any site other than https://argus-cloud.everyai-com.workers.dev.
- Do not paste the token anywhere except the token field in the left rail.
