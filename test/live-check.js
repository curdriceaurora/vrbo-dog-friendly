#!/usr/bin/env node
//
// End-to-end check against real Vrbo listings.
//
//   node test/live-check.js                 # 5 random listings
//   node test/live-check.js --all           # every URL in live-listings.txt
//   node test/live-check.js --sample 3
//   node test/live-check.js 3550839 5316114 # specific ids (or full URLs)
//   node test/live-check.js --attach        # use a Chrome already on --port
//   node test/live-check.js --json          # machine-readable output
//
// WHAT THIS IS NOT: a real extension load. Chrome 137+ ignores the
// --load-extension switch, and --enable-unsafe-extension-debugging does
// not bring it back (verified on Chrome 151), so there is no supported
// way to script an unpacked install. Instead this reproduces what the
// manifest declares, by hand, over the DevTools protocol:
//
//   page-bridge.js  -> MAIN world, document_start   (addScriptToEvaluateOnNewDocument + reload)
//   extract.js      -> isolated world               (Page.createIsolatedWorld)
//   content.js      -> isolated world, after load
//
// So it exercises the real scripts, the real cross-world event bridge and
// real listing data, but it does NOT verify manifest.json itself — script
// order, "world": "MAIN", or host matching. A green run here does not
// prove the extension loads correctly in Chrome; check that by hand at
// chrome://extensions.
//
// Requires Node 22+ (global fetch and WebSocket) and Google Chrome.
// Chrome opens a visible window: Vrbo serves fewer listings to headless.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LISTINGS = path.join(__dirname, "live-listings.txt");
const DEFAULT_SAMPLE = 5;

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

// ---------- args ----------

function parseArgs(argv) {
  const opts = { sample: DEFAULT_SAMPLE, all: false, attach: false, port: 9222, json: false, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--attach") opts.attach = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--sample") opts.sample = parseInt(argv[++i], 10);
    else if (a === "--port") opts.port = parseInt(argv[++i], 10);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else opts.targets.push(a);
  }
  return opts;
}

function readListings() {
  return fs
    .readFileSync(LISTINGS, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function chooseUrls(opts) {
  const all = readListings();
  if (opts.targets.length) {
    return opts.targets.map((t) => {
      if (/^https?:\/\//.test(t)) return t;
      const hit = all.find((u) => u.endsWith("/" + t));
      return hit || `https://www.vrbo.com/${t}`;
    });
  }
  if (opts.all) return all;
  const pool = [...all];
  const picked = [];
  while (picked.length < Math.min(opts.sample, all.length)) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

// ---------- chrome ----------

function findChrome() {
  const bin = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) throw new Error("Chrome not found. Set CHROME_BIN to the executable.");
  return bin;
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`Chrome did not open a debugging port on ${port}`);
}

function launchChrome(port) {
  const profile = path.join(os.tmpdir(), "vdp-live-check-profile");
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    findChrome(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore", detached: true }
  );
  child.unref();
  return child;
}

// ---------- cdp ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
  });

  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 45000);
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const once = (eventName, timeoutMs = 45000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method !== eventName) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(msg.params);
      };
      ws.addEventListener("message", onMsg);
    });

  return { ws, ready, send, once, close: () => ws.close() };
}

const readScript = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// Read the rendered panel out of the shared DOM.
const PANEL_EXPR = `(() => {
  const p = document.getElementById("vdp-panel");
  if (!p) return JSON.stringify({ rendered: false });
  return JSON.stringify({
    rendered: true,
    headline: p.querySelector(".vdp-title")?.textContent?.trim() || null,
    rows: Array.from(p.querySelectorAll(".vdp-row-wrap")).map((w) => ({
      label: w.querySelector(".vdp-label")?.textContent?.trim(),
      value: w.querySelector(".vdp-value")?.textContent?.trim(),
      hasSource: !!w.querySelector(".vdp-jump"),
      alternates: w.querySelector(".vdp-alt")?.textContent?.trim() || null,
    })),
    notes: Array.from(p.querySelectorAll(".vdp-other-item")).map((n) => n.textContent.trim()),
    badge: p.querySelector(".vdp-source-badge")?.textContent?.trim() || null,
  });
})()`;

async function checkListing(port, url, settleMs) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const tab = await res.json();
  const cdp = connect(tab.webSocketDebuggerUrl);
  await cdp.ready;

  try {
    await cdp.send("Page.enable", {});
    await cdp.send("Runtime.enable", {});

    // MAIN world at document_start, as "world": "MAIN" would give us.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: readScript("page-bridge.js") });
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.reload", {});
    await loaded;
    await sleep(3000); // Apollo cache populates asynchronously after mount

    const { frameTree } = await cdp.send("Page.getFrameTree", {});
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "vdp-isolated",
    });

    // A CDP isolated world has no chrome.* APIs; a real content script
    // does. Stub only what content.js touches so the script under test
    // runs unmodified.
    await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `globalThis.chrome = { storage: { local: { set() {} } }, runtime: { onMessage: { addListener() {} } } };`,
    });

    for (const file of ["extract.js", "content.js"]) {
      const out = await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: readScript(file) });
      if (out.exceptionDetails) {
        return { url, ok: false, error: `${file} threw: ${out.exceptionDetails.exception?.description?.split("\n")[0]}` };
      }
    }

    await sleep(settleMs);

    const panelRes = await cdp.send("Runtime.evaluate", { expression: PANEL_EXPR, returnByValue: true });
    const panel = JSON.parse(panelRes.result.value);

    const mainRes = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({ bridgeRan: !!window.__vdpBridgeData, bridgeItems: window.__vdpBridgeData?.items?.length ?? 0, policyLeaked: !!window.__vdpLastPolicy })`,
      returnByValue: true,
    });
    const main = JSON.parse(mainRes.result.value);

    return { url, ok: panel.rendered, panel, main };
  } catch (e) {
    return { url, ok: false, error: String(e.message || e) };
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`).catch(() => {});
  }
}

// ---------- reporting ----------

function report(results) {
  for (const r of results) {
    const id = r.url.replace(/^https:\/\/www\.vrbo\.com\//, "");
    console.log(`\n── ${id} ${"─".repeat(Math.max(0, 40 - id.length))}`);
    if (!r.ok) {
      console.log(`   FAIL  ${r.error || "panel did not render"}`);
      if (r.main) console.log(`         bridge ran: ${r.main.bridgeRan} (${r.main.bridgeItems} items)`);
      continue;
    }
    console.log(`   ${r.panel.headline}`);
    for (const row of r.panel.rows) {
      console.log(`     ${row.label}: ${row.value}${row.hasSource ? "  [source]" : ""}`);
      if (row.alternates) console.log(`       ${row.alternates}`);
    }
    if (r.panel.notes.length) {
      console.log(`     notes (${r.panel.notes.length}):`);
      for (const n of r.panel.notes) console.log(`       - ${n.slice(0, 100)}`);
    }
    console.log(`     ${r.panel.badge}`);
    console.log(`     bridge: ${r.main.bridgeItems} items | isolation intact: ${!r.main.policyLeaked}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} listings rendered a panel.`);
  if (failed.length) console.log(`Failed: ${failed.map((f) => f.url).join(", ")}`);
  return failed.length === 0;
}

// ---------- main ----------

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const urls = chooseUrls(opts);
  let chrome = null;

  if (!opts.attach) {
    chrome = launchChrome(opts.port);
  }
  await waitForPort(opts.port, 20000);

  const results = [];
  for (const url of urls) {
    if (!opts.json) process.stderr.write(`checking ${url} …\n`);
    results.push(await checkListing(opts.port, url, 8000));
  }

  let allOk;
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    allOk = results.every((r) => r.ok);
  } else {
    allOk = report(results);
  }

  if (chrome) {
    try {
      process.kill(-chrome.pid, "SIGTERM");
    } catch {
      try {
        chrome.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  console.error("live-check failed:", e.message || e);
  process.exit(1);
});
