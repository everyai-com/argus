# Argus Demo — Task Board

A one-page task board used to dogfood Argus (a cloud browser-testing platform).
It shows a task list loaded from `/api/tasks`, a text field to type a new task,
an "Add" button, and a task counter ("N tasks"). There is no sign-in.

## Important flows
- Wait for the list to load (it shows "Loading…" briefly), then check the
  counter matches the number of tasks shown.
- Add a task: type a title in the field and press the Add button; then add one
  with the Enter key. The counter and list should both update, and the POST to
  `/api/tasks` should succeed.
- Try an empty title and a whitespace-only title — nothing should be added.
- Try a very long title and special characters (emoji, `<b>html</b>`), and
  check they render as plain text and don't break the layout.
- Check the page at a narrow (phone) width: nothing should overflow sideways.

## Bug switchboard (for comparison)
The URL parameter `?bug=<name>` injects a known bug: `silent500`, `deadbutton`,
`wrongstate`, `overflow`, `consoleerror`, `slowreq`. Explore the normal page
(no `?bug=`) first; you may open a `?bug=` variant to confirm a suspicion, but
report bugs found on the NORMAL page as real bugs.

## Never do these things
- Do not open any URL outside https://argus-demo.everyai-com.workers.dev.
- Do not send requests in a tight loop (more than ~20 tasks) — it is a shared demo.
