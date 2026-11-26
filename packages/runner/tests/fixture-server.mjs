// A tiny app for the runner's own tests: one static page with every shape the
// runner has to handle (unique and duplicate anchors, a password field, a
// disabled button, a late element, a wide element, a failing request).
// Usage: node fixture-server.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 5298);

const page = (query) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Runner fixture</title>
<style>.shout { text-transform: uppercase } body { font-family: sans-serif; margin: 24px }</style></head>
<body>
  <h1>Runner fixture</h1>

  <section aria-label="Profile">
    <label for="name">Display name</label>
    <input id="name" data-testid="display-name" placeholder="Your name" value="Ada">
    <label for="secret">Password</label>
    <input id="secret" type="password" value="hunter2-do-not-leak">
    <label for="otp">One-time code</label>
    <input id="otp" type="text" autocomplete="one-time-code" value="424242">
    <select aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    <p data-testid="plan-note">plan: free</p>
  </section>

  <section aria-label="Duplicates">
    <button>Save</button>
    <button>Save</button>
    <ul><li>alpha</li><li>beta</li><li>gamma</li></ul>
  </section>

  <section aria-label="States">
    <button data-testid="submit-order" disabled>Submit order</button>
    <p class="shout" data-testid="shout">token rejected</p>
    <p data-testid="spaced">  many
       spaces   here </p>
    <button data-testid="ping">Ping</button>
    <button data-testid="ping-fail">Ping (fails)</button>
    <p data-testid="ping-status">idle</p>
    <button data-testid="reveal">Reveal later</button>
    <button data-testid="boom">Log an error</button>
  </section>

  ${query.get("wide") ? '<div data-testid="too-wide" style="width:3000px;height:8px;background:#eee"></div>' : ""}

  <script>
    const $ = (id) => document.querySelector('[data-testid="' + id + '"]');
    document.querySelector("select").addEventListener("change", (e) => {
      $("plan-note").textContent = "plan: " + e.target.value;
    });
    const ping = (path) => async () => {
      const res = await fetch(path, { method: "POST" });
      $("ping-status").textContent = "status " + res.status;
    };
    $("ping").addEventListener("click", ping("/api/ping"));
    $("ping-fail").addEventListener("click", ping("/api/ping?fail=1"));
    $("reveal").addEventListener("click", () => {
      setTimeout(() => {
        const p = document.createElement("p");
        p.setAttribute("data-testid", "late");
        p.textContent = "here now";
        document.body.appendChild(p);
      }, 400);
    });
    $("boom").addEventListener("click", () => console.error("fixture: boom"));
    ${query.get("throw") ? 'setTimeout(() => { throw new Error("fixture: thrown on load"); }, 50);' : ""}
  </script>
</body>
</html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/ping") {
    const fail = url.searchParams.get("fail") === "1";
    res.writeHead(fail ? 500 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: !fail }));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/second") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(url.searchParams));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(port, "127.0.0.1");
