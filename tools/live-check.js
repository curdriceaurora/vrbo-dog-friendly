#!/usr/bin/env node
//
// End-to-end check against real Vrbo listings.
//
//   node tools/live-check.js                 # 5 random listings
//   node tools/live-check.js --all           # every URL in live-listings.txt
//   node tools/live-check.js --sample 3
//   node tools/live-check.js 3550839 5316114 # specific ids (or full URLs)
//   node tools/live-check.js --attach        # use a Chrome already on --port
//   node tools/live-check.js --json          # machine-readable output
//
// This lives in tools/ rather than test/ on purpose: `node --test` treats
// EVERY .js file under a directory named test/ as a test file, so parking
// it there silently enrolled a slow, network-dependent, Chrome-dependent
// script into the offline suite.
//
// WHAT THIS IS NOT: a real extension load. Branded Google Chrome stopped
// honouring --load-extension in 137 (measured here on Chrome 151, where
// --enable-unsafe-extension-debugging does not bring it back). That
// removal is specific to branded Chrome: Chromium and Chrome for Testing
// still support the switch precisely so automation can use it, so a real
// unpacked load IS achievable on those binaries — it just isn't what this
// script does today. Instead this reproduces what the manifest declares,
// by hand, over the DevTools protocol:
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

// Chrome for Testing and Chromium first: they still honour
// --load-extension, which lets this actually load the extension from
// manifest.json instead of emulating it. Branded Chrome is the fallback.
// Get one with:  npx @puppeteer/browsers install chrome@stable
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  ...(function cftFromPuppeteerCache() {
    const base = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
    try {
      return fs
        .readdirSync(base)
        .sort()
        .reverse()
        .map((v) => path.join(base, v, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
    } catch {
      return [];
    }
  })(),
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);

// ---------- args ----------

function positiveInt(raw, flag) {
  // parseInt("nope") is NaN and parseInt("0"|"-2") is falsy/negative; any
  // of those used to yield an empty selection, which then "passed".
  if (!/^\d+$/.test(String(raw ?? "").trim())) throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < 1) throw new Error(`${flag} needs a positive integer, got ${n}`);
  return n;
}

function parseArgs(argv) {
  const opts = { sample: DEFAULT_SAMPLE, all: false, attach: false, port: 9222, json: false, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--attach") opts.attach = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--sample") opts.sample = positiveInt(argv[++i], "--sample");
    else if (a === "--port") opts.port = positiveInt(argv[++i], "--port");
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
  // An empty corpus must be an error, not a vacuous pass: every downstream
  // check is an .every() over the results, which is true for zero results.
  if (!all.length) throw new Error(`${path.basename(LISTINGS)} contains no listing URLs.`);
  if (opts.targets.length) {
    return opts.targets.map((t) => {
      if (/^https?:\/\//.test(t)) return t;
      // Match a whole path segment, tolerating a trailing slash or query.
      // Note this is deliberately NOT a substring test: `includes("/123")`
      // would happily match ".../1234" and check the wrong listing.
      const re = new RegExp(`/${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[/?#]|$)`);
      const hit = all.find((u) => re.test(u));
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

async function portIsLive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsLive(port)) return true;
    await sleep(300);
  }
  throw new Error(`Chrome did not open a debugging port on ${port}`);
}

function launchChrome(port) {
  // Keyed to the port so two runs on different ports don't fight over one
  // profile lock. Deliberately NOT unique-per-run: that strands a fresh
  // multi-megabyte profile in tmpdir on every invocation, and reusing one
  // keeps the cache warm. Stale locks come from Chrome being left running,
  // which stopChrome() below is what actually fixes.
  const profile = path.join(os.tmpdir(), `vdp-live-check-profile-${port}`);
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    findChrome(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      // Honoured by Chromium and Chrome for Testing, silently ignored by
      // branded Chrome 137+. We don't guess which we got — each listing
      // probes for the extension and falls back to injection if absent.
      `--load-extension=${ROOT}`,
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

// Chrome is spawned detached and outlives a crashed or interrupted run, so
// teardown has to be reachable from the signal handlers and the error path,
// not just the happy path at the end of main().
let chromeProc = null;

function stopChrome() {
  if (!chromeProc) return;
  const proc = chromeProc;
  chromeProc = null;
  try {
    process.kill(-proc.pid, "SIGTERM"); // detached: kill the whole group
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopChrome();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
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
  // Open blank, arm the document_start script, THEN navigate. Creating the
  // tab on the listing directly would load it once, and the reload needed
  // to pick up addScriptToEvaluateOnNewDocument would load it again —
  // twice the bandwidth and twice the bot-detection surface per listing.
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const tab = await res.json();
  const cdp = connect(tab.webSocketDebuggerUrl);
  await cdp.ready;

  try {
    await cdp.send("Page.enable", {});
    await cdp.send("Runtime.enable", {});

    // Navigate with nothing injected. If --load-extension took, the real
    // content scripts are already running and anything we observe came
    // from manifest.json — which is the only way to exercise script
    // order, "world": "MAIN" and host matching.
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url });
    await loaded;
    await sleep(3000); // Apollo cache populates asynchronously after mount

    const probe = await cdp.send("Runtime.evaluate", {
      expression: `typeof window.__vdpBridgeData !== "undefined"`,
      returnByValue: true,
    });
    let mode = probe.result.value ? "extension" : "emulated";

    if (mode === "emulated") {
      // Branded Chrome ignored --load-extension. Reproduce by hand what
      // the manifest declares, and say so in the report — this path does
      // NOT verify manifest.json itself.
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: readScript("page-bridge.js") });
      const reloaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.reload", {});
      await reloaded;
      await sleep(3000);

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
          return { url, ok: false, mode, failures: [`${file} threw: ${out.exceptionDetails.exception?.description?.split("\n")[0]}`] };
        }
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

    // A rendered panel alone is far too weak. The DOM fallback can paint a
    // perfectly good panel from visible page text while the MAIN-world
    // bridge is completely broken — which is the single property this
    // harness exists to cover, so it must be asserted, not merely printed.
    const failures = [];
    if (!panel.rendered) failures.push("panel did not render");
    if (!main.bridgeRan) failures.push("page-bridge produced no payload in the MAIN world (no __APOLLO_STATE__, or it never ran)");
    else if (main.bridgeItems === 0) failures.push("page-bridge produced a payload but extracted 0 Apollo items");
    if (main.policyLeaked) failures.push("isolated-world state leaked into MAIN (world boundary broken)");

    return { url, ok: failures.length === 0, mode, failures, panel, main };
  } catch (e) {
    return { url, ok: false, failures: [String(e.message || e)] };
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
      for (const f of r.failures || [r.error || "unknown failure"]) console.log(`   FAIL  ${f}`);
      if (r.panel?.rendered) console.log(`   (a panel did render: ${r.panel.headline})`);
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

  const modes = new Set(results.map((r) => r.mode).filter(Boolean));
  if (modes.has("extension")) {
    console.log(`\nLoaded from manifest.json (real unpacked load) — script order, "world": "MAIN" and host matching all exercised.`);
  }
  if (modes.has("emulated")) {
    console.log(
      `\nThis browser ignored --load-extension, so the content scripts were injected by hand.\n` +
        `manifest.json itself is NOT covered by that path. For a real load:\n` +
        `  npx @puppeteer/browsers install chrome@stable   (then re-run, or set CHROME_BIN)`
    );
  }

  const failed = results.filter((r) => !r.ok);
  // "passed" not "rendered": passing also requires a live bridge and an
  // intact world boundary, not just a panel on screen.
  console.log(`\n${results.length - failed.length}/${results.length} listings passed.`);
  if (failed.length) console.log(`Failed: ${failed.map((f) => f.url).join(", ")}`);
  return failed.length === 0;
}

// ---------- main ----------

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const urls = chooseUrls(opts);

  if (opts.attach) {
    if (!(await portIsLive(opts.port))) {
      throw new Error(`--attach was given but nothing is listening on ${opts.port}.`);
    }
  } else {
    // Refuse to reuse a debugging endpoint we did not start. Chrome cannot
    // bind a port twice, so launching here would silently leave us driving
    // whatever is already on it — quite possibly the user's own browser,
    // in which case this would open tabs in it and close them again.
    if (await portIsLive(opts.port)) {
      throw new Error(
        `Port ${opts.port} already has a Chrome debugging endpoint, which this run did not start.\n` +
          `Pass --attach to target it deliberately, or --port <n> to use a different one.`
      );
    }
    chromeProc = launchChrome(opts.port);
    await waitForPort(opts.port, 20000);
  }

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

  stopChrome();
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  stopChrome();
  console.error("live-check failed:", e.message || e);
  process.exit(1);
});
