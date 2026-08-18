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
// TWO MODES, and the run tells you which one you got:
//
//   "extension" — --load-extension took, so the extension is loaded from
//     manifest.json and NOTHING is injected. Only this mode exercises the
//     manifest itself: content-script order, "world": "MAIN", host
//     matching. Branded Chrome stopped honouring the switch in 137
//     (measured on Chrome 151; --enable-unsafe-extension-debugging does
//     not restore it), but Chromium and Chrome for Testing still do, and
//     those are preferred when present.
//
//   "emulated" — the browser ignored the switch, so the scripts are
//     injected by hand over CDP: page-bridge.js into MAIN at
//     document_start, extract.js and content.js into a real isolated
//     world. Exercises the scripts, the cross-world bridge and real
//     listing data, but a manifest typo CANNOT fail this mode.
//
// Exit codes:
//   0  every listing passed
//   1  a genuine extension failure (including a manifest that would not load)
//   2  inconclusive — a bot challenge, or a URL that served no listing
//      data within the Apollo budget. Neither is a code regression and
//      neither may be reported as one.
//
// Requires Node 22+ (global fetch and WebSocket) and a Chrome binary.
// Chrome opens a visible window: Vrbo serves fewer listings to headless.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LISTINGS = path.join(__dirname, "live-listings.txt");
const DEFAULT_SAMPLE = 5;
let DELAY_MS = 4000; // pause between listings; Vrbo challenges rapid sequential loads

// Chrome for Testing and Chromium first: they still honour
// --load-extension, which lets this actually load the extension from
// manifest.json instead of emulating it. Branded Chrome is the fallback.
// Get one with:
//   npx @puppeteer/browsers install chrome@stable --path "$HOME/.cache/puppeteer"
// The --path matters: without it the CLI installs into the CURRENT
// directory, which is not searched here.
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  ...(function cftFromPuppeteerCache() {
    // Layout is <cache>/chrome/<channel-version>/<platform>/<exe>, and the
    // platform directory varies. Hardcoding one of them meant silent
    // fallback to branded Chrome — and therefore silent loss of
    // manifest.json coverage — on every machine but an Apple Silicon Mac.
    const EXE_BY_PLATFORM = {
      "chrome-mac-arm64": ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
      "chrome-mac-x64": ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
      "chrome-linux64": ["chrome"],
      "chrome-win64": ["chrome.exe"],
      "chrome-win32": ["chrome.exe"],
    };
    const base = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
    const found = [];
    let versions;
    try {
      versions = fs.readdirSync(base).sort().reverse(); // newest first
    } catch {
      return [];
    }
    for (const version of versions) {
      let platforms;
      try {
        platforms = fs.readdirSync(path.join(base, version));
      } catch {
        continue;
      }
      for (const platform of platforms) {
        const tail = EXE_BY_PLATFORM[platform];
        if (tail) found.push(path.join(base, version, platform, ...tail));
      }
    }
    return found;
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
  const opts = { sample: DEFAULT_SAMPLE, all: false, attach: false, port: 9222, json: false, delay: DELAY_MS, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--attach") opts.attach = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--sample") opts.sample = positiveInt(argv[++i], "--sample");
    else if (a === "--port") opts.port = positiveInt(argv[++i], "--port");
    else if (a === "--delay") opts.delay = positiveInt(argv[++i], "--delay");
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

// A minimal control extension, loaded alongside the real one. It is the
// only way to tell two very different situations apart, because both make
// window.__vdpBridgeData absent:
//
//   the browser ignores --load-extension  -> emulate, manifest uncovered
//   OUR manifest is broken (host match,   -> a real regression, and
//   "world", file list, syntax)              exactly what real-load mode
//                                            exists to catch
//
// Without the canary the second case silently took the first case's path
// and could exit 0 — masking the defect the mode was added to detect.
function writeCanaryExtension() {
  const dir = path.join(os.tmpdir(), "vdp-live-check-canary");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 3,
        name: "live-check canary",
        version: "1.0.0",
        content_scripts: [{ matches: ["<all_urls>"], js: ["canary.js"], world: "MAIN", run_at: "document_start" }],
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, "canary.js"), `window.__vdpCanary = true;\n`);
  return dir;
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
      // branded Chrome 137+. The canary rides along so we can tell
      // "browser won't load extensions" from "our manifest is broken".
      `--load-extension=${ROOT},${writeCanaryExtension()}`,
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

// What did the server actually give us? Three outcomes, and conflating
// them produces false reports in both directions.
//
// A previous version treated "no PropertyInfo and under 400 characters"
// as a bot challenge, which labelled every 404, redirect and sparse error
// page a challenge. Only explicit challenge wording counts now; a page
// that simply has no listing data is its own outcome, because that means
// the URL is stale or erroring, not that we were blocked and not that the
// extension is broken.
const CHALLENGE_RE = /bot or not|human side|are you a human|unusual traffic|access denied|captcha|verify (you|that you)/i;

// page-bridge.js gives Apollo 31 × 350ms ≈ 10.9s to populate before it
// stops polling. Anything less here means the harness gives up while the
// extension under test is still legitimately waiting, and reports a slow
// listing as though it served no data.
const APOLLO_BUDGET_MS = 12000;

async function classifyPage(cdp) {
  const res = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `JSON.stringify({
      url: location.href,
      title: (document.title || "").slice(0, 120),
      bodyText: (document.body ? document.body.innerText : "").slice(0, 600),
      bodyLen: document.body ? document.body.innerText.length : 0,
      hasPropertyInfo: !!(window.__APOLLO_STATE__ && Object.keys(window.__APOLLO_STATE__).some((k) => k.startsWith("PropertyInfo:")))
    })`,
  });
  const s = JSON.parse(res.result.value);
  // Listing data settles it. Checking the challenge wording first meant a
  // host writing "please verify that you comply with the house rules" got
  // their perfectly valid listing reported as a bot challenge. A challenge
  // page has no PropertyInfo, so this ordering costs nothing and stops the
  // weak body-text markers from overriding hard evidence.
  if (s.hasPropertyInfo) return { kind: "listing", ...s };
  if (CHALLENGE_RE.test(s.title) || CHALLENGE_RE.test(s.bodyText)) return { kind: "challenge", ...s };
  return { kind: "no-listing-data", ...s };
}

// Keep asking until listing data shows up, the page turns out to be a
// challenge, or we run past what page-bridge itself would wait for. A flat
// sleep declared slow-but-valid listings dead.
async function waitForListingData(cdp, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let state = await classifyPage(cdp);
  while (state.kind === "no-listing-data" && Date.now() < deadline) {
    await sleep(500);
    state = await classifyPage(cdp);
  }
  return state;
}

function pageStateResult(url, state) {
  if (state.kind === "challenge") return { url, ok: false, blocked: true, state };
  return { url, ok: false, unavailable: true, state };
}

async function checkListing(port, url, settleMs) {
  // Open blank, arm the document_start script, THEN navigate. Creating the
  // tab on the listing directly would load it once, and the reload needed
  // to pick up addScriptToEvaluateOnNewDocument would load it again —
  // twice the bandwidth and twice the bot-detection surface per listing.
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const tab = await res.json();
  const cdp = connect(tab.webSocketDebuggerUrl);
  await cdp.ready;

  // Declared out here so the catch below can still report it.
  let mode = null;

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
    // Apollo populates asynchronously; poll rather than guess a duration.
    let state = await waitForListingData(cdp, APOLLO_BUDGET_MS);
    if (state.kind !== "listing") return pageStateResult(url, state);

    // Two independent signals. The canary is a throwaway extension loaded
    // alongside ours, so it answers "can this browser load extensions at
    // all" without depending on OUR manifest being correct.
    const probe = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({ canary: !!window.__vdpCanary, bridge: typeof window.__vdpBridgeData !== "undefined" })`,
      returnByValue: true,
    });
    const { canary, bridge } = JSON.parse(probe.result.value);

    if (canary && !bridge) {
      // The browser demonstrably loads extensions — the canary is running
      // on this very page — but ours did not start. That is a manifest
      // defect: host match, "world", the js file list, or a syntax error
      // in a content script. Falling back to injection here would hide
      // precisely the regression this mode exists to catch, so it is a
      // hard failure and emulation is NOT attempted.
      return {
        url,
        ok: false,
        mode: "manifest-failure",
        failures: [
          "extension did not load from manifest.json, though the canary extension loaded on the same page — " +
            "check host matches, \"world\": \"MAIN\", the content_scripts file list, and each script for syntax errors",
        ],
      };
    }

    mode = bridge ? "extension" : "emulated";

    if (mode === "emulated") {
      // Browser ignored --load-extension (no canary either). Reproduce by
      // hand what the manifest declares, and say so in the report — this
      // path does NOT verify manifest.json itself.
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: readScript("page-bridge.js") });
      const reloaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.reload", {});
      await reloaded;
      // Re-classify: the reload is a second request, and it can be the one
      // that gets challenged. Checking only before the reload turned that
      // into a bogus hard failure complete with bridge and panel errors.
      state = await waitForListingData(cdp, APOLLO_BUDGET_MS);
      if (state.kind !== "listing") return pageStateResult(url, state);

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
        expression: `globalThis.chrome = { storage: { local: { set(o, cb) { cb && cb(); }, get(k, cb) { cb && cb({}); }, remove(k, cb) { cb && cb(); } } }, runtime: { onMessage: { addListener() {} } } };`,
      });

      for (const file of ["extract.js", "search-fetcher.js", "content.js"]) {
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
    // Carry the mode out with the exception. A CDP timeout, navigation
    // race or evaluation error after mode detection is still a result
    // whose interpretation depends on how the run was performed, and
    // scoping `mode` inside the try silently dropped that context.
    // Stays null when we failed before detection — unknown, not assumed.
    return { url, ok: false, mode, failures: [String(e.message || e)] };
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
    if (r.blocked) {
      console.log(`   BLOCKED  bot challenge ("${r.state.title}") — inconclusive, not an extension failure`);
      continue;
    }
    if (r.unavailable) {
      console.log(`   NO DATA  page served no listing data — title "${r.state.title}", ${r.state.bodyLen} chars`);
      if (r.state.url !== r.url) console.log(`            redirected to ${r.state.url}`);
      console.log(`            delisted, redirected or an error page; says nothing about the extension`);
      continue;
    }
    if (!r.ok) {
      for (const f of r.failures || [r.error || "unknown failure"]) console.log(`   FAIL  ${f}`);
      if (r.panel?.rendered) console.log(`   (a panel did render: ${r.panel.headline})`);
      // A failure has to say how it was run: "emulated" means the scripts
      // were hand-injected and manifest.json was never exercised, which
      // changes what the failure can and cannot be evidence of.
      if (r.mode) {
        console.log(`   mode: ${r.mode}${r.mode === "emulated" ? " — scripts hand-injected, manifest.json NOT covered" : ""}`);
      }
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

  // Two different questions, and conflating them broke reporting in both
  // directions.
  //
  // The success banner is a CLAIM about what was verified, so only a
  // passing run may earn it — deriving it from every result printed
  // "all exercised" directly beneath a manifest failure.
  //
  // The emulated caveat is a LIMITATION of how the run was performed, and
  // it holds whether the run passed or failed. Restricting it to passing
  // results too meant a FAILED emulated run disclosed no mode at all,
  // concealing that the scripts were hand-injected and that manifest.json
  // went untested — exactly when that context matters most.
  const passedModes = new Set(results.filter((r) => r.ok).map((r) => r.mode).filter(Boolean));
  const allModes = new Set(results.map((r) => r.mode).filter(Boolean));
  if (passedModes.has("extension")) {
    console.log(`\nLoaded from manifest.json (real unpacked load) — script order, "world": "MAIN" and host matching all exercised.`);
  }
  if (allModes.has("emulated")) {
    console.log(
      `\nThis browser ignored --load-extension, so the content scripts were injected by hand.\n` +
        `manifest.json itself is NOT covered by that path. For a real load:\n` +
        `  npx @puppeteer/browsers install chrome@stable --path "$HOME/.cache/puppeteer"\n` +
        `  (--path is required; without it the browser lands in the current directory and is not found)`
    );
  }

  const blocked = results.filter((r) => r.blocked);
  const unavailable = results.filter((r) => r.unavailable);
  const failed = results.filter((r) => !r.ok && !r.blocked && !r.unavailable);
  const passed = results.filter((r) => r.ok);

  // "passed" not "rendered": passing also requires a live bridge and an
  // intact world boundary, not just a panel on screen.
  console.log(`\n${passed.length}/${results.length} listings passed.`);
  if (failed.length) console.log(`Failed: ${failed.map((f) => f.url).join(", ")}`);
  if (blocked.length) {
    console.log(
      `Blocked by bot challenge (inconclusive, says nothing about the extension): ${blocked.length}\n` +
        `  ${blocked.map((b) => b.url).join("\n  ")}\n` +
        `Vrbo starts challenging after roughly twenty listings in quick succession, and the\n` +
        `block persists for a while. Re-run the blocked ones later, in smaller batches, or\n` +
        `raise --delay (currently ${DELAY_MS}ms between listings).`
    );
  }
  if (unavailable.length) {
    console.log(
      `Served no listing data (stale URL, redirect or error page — not an extension failure): ${unavailable.length}\n` +
        `  ${unavailable.map((u) => u.url).join("\n  ")}`
    );
  }
  return {
    allOk: failed.length === 0 && blocked.length === 0 && unavailable.length === 0,
    hardFailure: failed.length > 0,
  };
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

  DELAY_MS = opts.delay;
  const results = [];
  for (const [i, url] of urls.entries()) {
    if (i > 0) await sleep(opts.delay); // pace, so we don't provoke the challenge
    if (!opts.json) process.stderr.write(`checking ${url} …\n`);
    results.push(await checkListing(opts.port, url, 8000));
  }

  let verdict;
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    verdict = {
      allOk: results.every((r) => r.ok),
      hardFailure: results.some((r) => !r.ok && !r.blocked && !r.unavailable),
    };
  } else {
    verdict = report(results);
  }

  stopChrome();
  // 0 = all good, 1 = a genuine extension failure (a manifest that would
  // not load counts), 2 = inconclusive: either a bot challenge or a URL
  // that served no listing data within the Apollo budget. Neither
  // inconclusive case may read as a code regression.
  process.exit(verdict.allOk ? 0 : verdict.hardFailure ? 1 : 2);
})().catch((e) => {
  stopChrome();
  console.error("live-check failed:", e.message || e);
  process.exit(1);
});
