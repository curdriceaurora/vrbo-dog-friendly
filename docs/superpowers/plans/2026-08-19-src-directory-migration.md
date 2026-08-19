# src/ Directory Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the extension's runtime payload out of repo root into `src/` (with `content/`, `popup/`, `shared/`, `icons/` subdirectories), update every path reference across the manifest, popup HTML, package scripts, unit tests, and e2e specs so the tree is green again, deduplicate `escapeHtml` (and relocate `popup.js`'s currency formatter) into a new `src/shared/formatters.js`, and add packaging tooling that builds a versioned zip into `dist/`.

**Architecture:** This is a single, mostly-sequential migration — physically move files first (Task 1), then fix every reference to those files in dependency order (manifest → popup.html → shared formatters → package.json → unit tests → e2e specs → dev tooling scripts), then add new packaging tooling, then do one full end-to-end verification pass. Unlike issues #30/#31, this cannot be cleanly parallelized: moving `content.js` breaks its manifest entry, its test `require()`, and its e2e coverage read simultaneously, so partial states are expected to be red until the reference-update tasks land. Each task still ends with the narrowest verification available at that point (syntax checks, targeted greps) rather than a full green suite, and the full suite only goes green at Task 10. Reference-hunting for this plan went through three review passes, each verifying the prior pass's claims against the actual files rather than accepting them on trust: the first drafted Tasks 1-7 and 8-10; a second, more exhaustive grep-every-runtime-filename pass across the whole repo (not just the files an obvious first guess would touch) found two more test-suite gaps (folded into Task 6) and a materially larger set of affected `tools/` scripts than initially assumed (13, not the handful first spotted — now Task 7b); a third pass, prompted by a fresh review that itself found one more gap and was independently re-verified rather than taken at face value, closed `e2e/js-coverage.spec.js`'s missing `formatters.js` wiring (Task 7 Steps 2-4) and swept the rest of the repo for sibling instances of that same "new file, not a renamed one" gap class (none found beyond it). All three passes are reflected directly in the tasks below, not left as follow-up work.

**Tech Stack:** Vanilla JS Chrome MV3 extension, `node --test` (built-in Node test runner + coverage), Playwright for e2e.

## Global Constraints

- Zero runtime logic changes outside the `formatters.js` consolidation — this is otherwise a pure move/rename. Do not "fix" unrelated things you notice along the way.
- Every file move MUST be `git mv` (not `mv` + `git add`), so history is preserved.
- `test/` and `e2e/` directories themselves do NOT move — only the runtime payload they reference moves.
- `tools/check-coverage.js` needs NO changes. This was verified empirically before writing this plan: Node's `--experimental-test-coverage` reporter prints a directory header row (blank metrics, filtered out by the existing regex's `[\d.]+` requirement) followed by an indented row showing the bare filename (e.g. `mod.js`, not `sub/mod.js`), so `TARGET_NODE_MODULES = new Set(["extract.js", "search-fetcher.js"])` and the existing parsing regex keep matching correctly regardless of which subdirectory the file physically lives in. Do not "fix" this file — touching it is out of scope and risks breaking something that already works.
- `*.zip` files at repo root are already gitignored and untracked (confirmed via `git ls-files "*.zip"` — empty). No `.mov` files are currently present in the repo. Moving the zips is pure local housekeeping with zero git/test impact — do not treat it as a risk-bearing step.
- The issue's premise that `formatMoney`/`CURRENCY_SYMBOLS` are duplicated between `content.js` and `popup.js` is not accurate — verified by direct inspection. `content.js` has no `formatMoney`/`CURRENCY_SYMBOLS`/`CURRENCY_DISPLAY` at all. The real overlap is between `popup.js`'s `formatMoney(amount, currency)`/`CURRENCY_SYMBOLS` (operates on already-numeric canonical values) and `extract.js`'s separate `formatMoney(cur, amt)`/`CURRENCY_DISPLAY` (operates on raw regex-captured strings, and was just hardened for thousands-separator parsing in PR #32). These are different signatures serving different purposes, not a copy-paste duplicate. **Decision:** only relocate `popup.js`'s `formatMoney`/`CURRENCY_SYMBOLS` into `formatters.js` verbatim (no signature change, no merge with `extract.js`'s version) — merging them is real design work with real regression risk to code we just hardened, and is out of scope for a "pure, behavior-neutral refactor." The one *genuine* duplicate — `escapeHtml`, byte-identical in both `content.js:436-438` and `popup.js:96-98` — is the one that actually gets deduplicated.

---

### Task 1: Physically move all runtime files into `src/`

**Files:**
- Move: `content.js` → `src/content/content.js`
- Move: `content.css` → `src/content/content.css`
- Move: `page-bridge.js` → `src/content/page-bridge.js`
- Move: `tokens.css` → `src/content/tokens.css`
- Move: `popup.html` → `src/popup/popup.html`
- Move: `popup.css` → `src/popup/popup.css`
- Move: `popup.js` → `src/popup/popup.js`
- Move: `extract.js` → `src/shared/extract.js`
- Move: `search-fetcher.js` → `src/shared/search-fetcher.js`
- Move: `manifest.json` → `src/manifest.json`
- Move: `icons/` → `src/icons/`

**Interfaces:** N/A (pure filesystem move, no code changes in this task).

- [ ] **Step 1: Create the new directories and move every file with `git mv`**

```bash
mkdir -p src/content src/popup src/shared
git mv content.js src/content/content.js
git mv content.css src/content/content.css
git mv page-bridge.js src/content/page-bridge.js
git mv tokens.css src/content/tokens.css
git mv popup.html src/popup/popup.html
git mv popup.css src/popup/popup.css
git mv popup.js src/popup/popup.js
git mv extract.js src/shared/extract.js
git mv search-fetcher.js src/shared/search-fetcher.js
git mv manifest.json src/manifest.json
git mv icons src/icons
```

- [ ] **Step 2: Verify the moves and confirm nothing was left behind**

```bash
git status --short
ls *.js *.css *.html *.json 2>/dev/null   # expect: only package.json, package-lock.json, playwright.config.js
ls src/content src/popup src/shared src/icons
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(repo): move runtime payload into src/ (content/, popup/, shared/, icons/)"
```

Everything downstream is now broken (manifest paths, popup.html paths, package.json, every test `require()`, every e2e path) — that's expected. The rest of this plan fixes each reference in turn.

---

### Task 2: Fix `src/manifest.json`'s internal paths

**Files:**
- Modify: `src/manifest.json`

**Interfaces:** N/A.

- [ ] **Step 1: Update the paths**

All paths in `manifest.json` are relative to the manifest's own location. The `icons` and `action.default_icon` blocks are unchanged (icons/ is a direct child of manifest.json's new location, same as before). Everything else needs its new subdirectory prefix.

Edit `src/manifest.json` so it reads exactly:

```json
{
  "manifest_version": 3,
  "name": "Vrbow: Vrbo Dog Policy Callout",
  "version": "1.2.0",
  "description": "Surfaces dog-friendliness details (dog limit, weight limit, pre-registration, fees) directly on Vrbo listing pages.",
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "action": {
    "default_title": "Vrbow – Vrbo Dog Policy Callout",
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "permissions": ["storage", "activeTab"],
  "host_permissions": [
    "*://*.vrbo.com/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "*://*.vrbo.com/*"
      ],
      "js": ["content/page-bridge.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    {
      "matches": [
        "*://*.vrbo.com/*"
      ],
      "js": ["shared/extract.js", "shared/search-fetcher.js", "shared/formatters.js", "content/content.js"],
      "css": ["content/tokens.css", "content/content.css"],
      "run_at": "document_idle"
    }
  ],
  "minimum_chrome_version": "111"
}
```

Note `shared/formatters.js` is added to the `js` array here even though it doesn't exist yet — it's created in Task 4. `content.js` reads `globalThis.VdpFormatters` at load time, so `formatters.js` must be listed before `content/content.js` in this array (same reasoning as `extract.js`/`search-fetcher.js` already being listed before it).

- [ ] **Step 2: Validate the JSON is well-formed**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/manifest.json', 'utf8')); console.log('valid JSON')"
```

Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add src/manifest.json
git commit -m "refactor(repo): update manifest.json paths for src/ layout"
```

---

### Task 3: Fix `src/popup/popup.html`'s stylesheet path

**Files:**
- Modify: `src/popup/popup.html`

**Interfaces:** N/A.

- [ ] **Step 1: Update the `tokens.css` link**

`popup.css` and `popup.js` are in the same directory as `popup.html` after the move, so those two `href`/`src` attributes are unchanged. Only `tokens.css` moved to a different directory (`src/content/`), so its relative path needs to cross into that sibling directory.

In `src/popup/popup.html`, change:
```html
  <link rel="stylesheet" href="tokens.css" />
```
to:
```html
  <link rel="stylesheet" href="../content/tokens.css" />
```

Also add the `formatters.js` script tag before `popup.js` (created in Task 4), since `popup.js` will read `globalThis.VdpFormatters`. Change:
```html
  <script src="popup.js"></script>
```
to:
```html
  <script src="../shared/formatters.js"></script>
  <script src="popup.js"></script>
```

- [ ] **Step 2: Sanity-check the file's structure is still valid HTML**

```bash
node -e "
const html = require('fs').readFileSync('src/popup/popup.html', 'utf8');
if (!html.includes('../content/tokens.css')) throw new Error('tokens.css path not updated');
if (!html.includes('../shared/formatters.js')) throw new Error('formatters.js script tag missing');
console.log('popup.html OK');
"
```

Expected: `popup.html OK`

- [ ] **Step 3: Commit**

```bash
git add src/popup/popup.html
git commit -m "refactor(repo): update popup.html paths for src/ layout"
```

---

### Task 4: Create `src/shared/formatters.js`, deduplicate `escapeHtml`, relocate `popup.js`'s currency formatter

**Files:**
- Create: `src/shared/formatters.js`
- Modify: `src/content/content.js` (remove local `escapeHtml`, consume from `globalThis.VdpFormatters`)
- Modify: `src/popup/popup.js` (remove local `escapeHtml`/`formatMoney`/`CURRENCY_SYMBOLS`, consume from `globalThis.VdpFormatters`)

**Interfaces:**
- Produces: `globalThis.VdpFormatters = { escapeHtml(s: string): string, formatMoney(amount: number, currency?: string): string, CURRENCY_SYMBOLS: Record<string,string> }`, and (for Node) `module.exports` of the same shape.

- [ ] **Step 1: Create `src/shared/formatters.js`**

Mirrors the exact UMD-style wrapper `src/shared/extract.js` already uses (see its header comment and lines 1-12), so it's loadable both as a plain `<script>` in the browser (assigns `globalThis.VdpFormatters`) and via `require()` in Node tests.

```js
// Shared, pure formatting helpers with no DOM/chrome.* dependencies.
//
// Loaded before content.js and popup.js in their respective contexts, where
// it assigns itself to globalThis; both scripts then call it as
// `VdpFormatters.*`. escapeHtml was previously duplicated verbatim in both
// content.js and popup.js; formatMoney/CURRENCY_SYMBOLS here is popup.js's
// formatter for already-numeric canonical policy values — it is NOT the
// same thing as extract.js's separate formatMoney(cur, amt), which formats
// raw regex-captured strings and has its own currency table. The two were
// deliberately kept separate rather than merged (see the plan's Global
// Constraints for why).

(function (root, factory) {
  const api = factory();
  root.VdpFormatters = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const CURRENCY_SYMBOLS = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    JPY: "¥",
    AUD: "A$",
    CAD: "CA$",
    NZD: "NZ$",
  };

  function formatMoney(amount, currency = "USD") {
    if (typeof amount !== "number") return "";
    const code = String(currency || "USD").trim().toUpperCase();
    const sym = CURRENCY_SYMBOLS[code] || `${code} `;
    return `${sym}${amount}`;
  }

  return { escapeHtml, formatMoney, CURRENCY_SYMBOLS };
});
```

- [ ] **Step 2: Remove the duplicate `escapeHtml` from `src/content/content.js` and consume the shared one**

In `src/content/content.js`, change line 40 from:
```js
  const { getSentences, isPetRelated, buildCorpus, extractPolicy } = globalThis.VDPExtract;
```
to:
```js
  const { getSentences, isPetRelated, buildCorpus, extractPolicy } = globalThis.VDPExtract;
  const { escapeHtml } = globalThis.VdpFormatters;
```

Then delete the local definition at (former) lines 436-438:
```js
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

```
(delete the whole block, including the blank line after it — leave the surrounding code otherwise untouched).

- [ ] **Step 3: Remove the duplicate `escapeHtml`/`formatMoney`/`CURRENCY_SYMBOLS` from `src/popup/popup.js` and consume the shared ones**

In `src/popup/popup.js`, delete the `CURRENCY_SYMBOLS` object (lines 15-23) and the `formatMoney` function (lines 25-30) and the `escapeHtml` function (lines 96-98) entirely. Then add a destructure near the top of the file, right after the existing `el()` helper (after line 5), so it reads:

```js
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

const { escapeHtml, formatMoney } = globalThis.VdpFormatters;

function renderNotVrbo() {
```

Every other call site in `popup.js` that references `formatMoney(...)` or `escapeHtml(...)` needs no change — they're calling the same function names, just sourced from the destructure instead of a local definition.

- [ ] **Step 4: Verify no leftover references and syntax is valid**

```bash
node --check src/shared/formatters.js
node --check src/content/content.js
grep -n "function escapeHtml\|function formatMoney\|CURRENCY_SYMBOLS = {" src/content/content.js src/popup/popup.js
```

Expected: both `node --check` commands print nothing (success); the `grep` finds **zero** matches (all three were removed from both files — `formatters.js` itself is not part of this grep so its own definitions don't trigger a false positive).

- [ ] **Step 5: Commit**

```bash
git add src/shared/formatters.js src/content/content.js src/popup/popup.js
git commit -m "refactor(shared): extract formatters.js, deduplicate escapeHtml, relocate popup's formatMoney"
```

---

### Task 5: Fix `package.json`'s `test:all` script paths

**Files:**
- Modify: `package.json`

**Interfaces:** N/A.

- [ ] **Step 1: Update the path-bearing script**

`test`, `test:coverage`, and `test:theme` don't hardcode any runtime file paths (they invoke `node --test`, `node tools/check-coverage.js`, and `playwright test` respectively, none of which need to change). Only `test:all` lists explicit file paths. Change:

```json
    "test:all": "node --check content.js && node --check extract.js && node --check page-bridge.js && node --check popup.js && node --check search-fetcher.js && node tools/check-coverage.js && playwright test"
```
to:
```json
    "test:all": "node --check src/content/content.js && node --check src/shared/extract.js && node --check src/content/page-bridge.js && node --check src/popup/popup.js && node --check src/shared/search-fetcher.js && node --check src/shared/formatters.js && node tools/check-coverage.js && playwright test"
```

- [ ] **Step 2: Verify the JSON is well-formed and the script runs its check commands cleanly**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('valid JSON')"
node --check src/content/content.js && node --check src/shared/extract.js && node --check src/content/page-bridge.js && node --check src/popup/popup.js && node --check src/shared/search-fetcher.js && node --check src/shared/formatters.js && echo "all syntax OK"
```

Expected: `valid JSON` then `all syntax OK`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "refactor(repo): update package.json test:all paths for src/ layout"
```

---

### Task 6: Fix every unit test's `require()`/`readFileSync` path

**Files:**
- Modify: `test/extract.test.js`
- Modify: `test/search-fetcher.test.js`
- Modify: `test/search-apollo-fast-path.test.js`
- Modify: `test/search-integration.test.js`
- Modify: `test/search-ui.test.js`
- Modify: `test/theme-contract.test.js`

**Interfaces:**
- Consumes: `globalThis.VdpFormatters` (produced by Task 4) — `test/search-ui.test.js`'s `installHarness()` must set this global before requiring `content.js`, exactly like it already does for `globalThis.VDPExtract`.

> **Two gaps found reviewing this task before execution, both folded in below:** `test/theme-contract.test.js` was missing from the original draft of this task entirely — it has its own `ROOT`-relative `read()` helper and 11 call sites reading `manifest.json`/`popup.html`/`tokens.css`/`content.css`/`popup.css`/`popup.js`/`content.js` by bare name, all of which would ENOENT after Task 1's move. And `test/search-ui.test.js` has a second, separate `content.css` `readFileSync` (not a `require()`) that Step 3 below didn't originally cover.

- [ ] **Step 1: Update `require("../extract.js")` → `require("../src/shared/extract.js")` everywhere it appears**

Files and line numbers (confirmed by grep before writing this plan — re-grep first in case line numbers shifted):
- `test/extract.test.js:12` and `:543`
- `test/search-fetcher.test.js:1282` and `:1293`
- `test/search-integration.test.js:7`
- `test/search-ui.test.js:177`, `:213`, `:602`

```bash
grep -rn 'require("\.\./extract\.js")' test/*.test.js
```
For each match, change `require("../extract.js")` to `require("../src/shared/extract.js")`.

- [ ] **Step 2: Update `require("../search-fetcher.js")` → `require("../src/shared/search-fetcher.js")` everywhere it appears**

Files: `test/search-fetcher.test.js` (lines `4`, `1292`, `1333`, `1413`, `1446`), `test/search-apollo-fast-path.test.js:22`, `test/search-integration.test.js:8` and `:689`, `test/search-ui.test.js:6` and `:542`.

```bash
grep -rn 'require("\.\./search-fetcher\.js")' test/*.test.js
```
For each match, change `require("../search-fetcher.js")` to `require("../src/shared/search-fetcher.js")`.

- [ ] **Step 3: Update `require("../content.js")` → `require("../src/content/content.js")`**

`test/search-ui.test.js:641` — the only occurrence.

```bash
grep -n 'require("\.\./content\.js")' test/search-ui.test.js
```
Change `require("../content.js")` to `require("../src/content/content.js")`.

- [ ] **Step 4: Update the `page-bridge.js` `readFileSync` path**

`test/search-apollo-fast-path.test.js:24`:
```js
readFileSync(path.join(__dirname, "..", "page-bridge.js"), "utf8")
```
Change to:
```js
readFileSync(path.join(__dirname, "..", "src", "content", "page-bridge.js"), "utf8")
```

- [ ] **Step 5: Add `VdpFormatters` to `test/search-ui.test.js`'s `installHarness()`**

Find the line in `installHarness()` (around line 590 of `test/search-ui.test.js`) that reads:
```js
  globalThis.VDPExtract = require("../src/shared/extract.js");
```
(this line is already being changed by Step 1 above — do this edit as a continuation of that same line, not a separate pass) and add, immediately after it:
```js
  globalThis.VdpFormatters = require("../src/shared/formatters.js");
```
This must come before the line that does `require("../src/content/content.js")` (from Step 3), since `content.js` reads `globalThis.VdpFormatters` at module-load time.

- [ ] **Step 6: Fix the second, separate `content.css` `readFileSync` in `test/search-ui.test.js`**

This is a plain `readFileSync`, not a `require()` — it's a different call site than Steps 1-3 and was missed in the original draft of this task. Find (currently around line 1109 of `test/search-ui.test.js`, inside the badge-slot elevation test):
```js
    const css = require("node:fs")
      .readFileSync(require("node:path").join(__dirname, "..", "content.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
```
Change to:
```js
    const css = require("node:fs")
      .readFileSync(require("node:path").join(__dirname, "..", "src", "content", "content.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
```

- [ ] **Step 7: Fix `test/theme-contract.test.js`'s `read()` helper and its 3 content-dependent assertions**

Every call site in this file (`read("manifest.json")`, `read("popup.html")`, `read("tokens.css")`, `read("content.css")`, `read("popup.css")`, `read("popup.js")`, and the two `for (const file of [...])` loops that call `read(file)` with `"content.css"`/`"popup.css"`/`"content.js"`/`"popup.js"`) passes a bare logical filename, not a path. Rather than touching all 11 call sites individually, fix it at the source: change the `read` helper itself (currently line 7) from:
```js
const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
```
to:
```js
const ROOT = path.join(__dirname, "..");
const FILE_PATHS = {
  "manifest.json": path.join(ROOT, "src", "manifest.json"),
  "popup.html": path.join(ROOT, "src", "popup", "popup.html"),
  "popup.css": path.join(ROOT, "src", "popup", "popup.css"),
  "popup.js": path.join(ROOT, "src", "popup", "popup.js"),
  "tokens.css": path.join(ROOT, "src", "content", "tokens.css"),
  "content.css": path.join(ROOT, "src", "content", "content.css"),
  "content.js": path.join(ROOT, "src", "content", "content.js"),
};
const read = (file) => fs.readFileSync(FILE_PATHS[file] || path.join(ROOT, file), "utf8");
```
Every existing call site keeps working unchanged, since they all pass one of these seven bare names.

That fixes the file *reads*, but 3 assertions in this file check the literal *content* of the manifest/popup.html, which genuinely changes after Tasks 2 and 3 — these need updating regardless of the read-path fix:

In the `"theme assets load in the required order and remain scoped"` test (around line 93-97), change:
```js
  const isolatedScript = manifest.content_scripts.find((entry) => entry.js?.includes("content.js"));
  assert.deepEqual(isolatedScript.css, ["tokens.css", "content.css"]);

  const popup = read("popup.html");
  assert.ok(popup.indexOf('href="tokens.css"') < popup.indexOf('href="popup.css"'));
```
to:
```js
  const isolatedScript = manifest.content_scripts.find((entry) => entry.js?.includes("content/content.js"));
  assert.deepEqual(isolatedScript.css, ["content/tokens.css", "content/content.css"]);

  const popup = read("popup.html");
  assert.ok(popup.indexOf('href="../content/tokens.css"') < popup.indexOf('href="popup.css"'));
```
(`entry.js?.includes(...)` checks array membership by exact string equality — after Task 2, the manifest's `js` array for that content-script entry contains `"content/content.js"`, not `"content.js"`, so the old `.includes("content.js")` would return `false` and `isolatedScript` would be `undefined`, throwing on the next line. `popup.css`'s href is unchanged since it stays in the same directory as `popup.html` — only the `tokens.css` href crosses into `../content/`.)

- [ ] **Step 8: Run the full unit suite**

```bash
node --test 2>&1 | tail -20
```

Expected: `tests 185`, `pass 185`, `fail 0` (same 185 as before this migration — this task changes no behavior, only paths).

- [ ] **Step 9: Commit**

```bash
git add test/*.test.js
git commit -m "test: update require()/readFileSync paths for src/ layout"
```

---

### Task 7: Fix every e2e spec's path reference

**Files:**
- Modify: `e2e/dialog-accessibility.spec.js`
- Modify: `e2e/extension-theme.spec.js`
- Modify: `e2e/hit-testing.spec.js`
- Modify: `e2e/virtualization.spec.js`
- Modify: `e2e/js-coverage.spec.js`
- Modify: `test/fixtures/panel-theme.html`
- Modify: `test/fixtures/popup-theme.html`

**Interfaces:** N/A.

- [ ] **Step 1: Point `EXTENSION_ROOT` at `src/` in the four specs that load the unpacked extension**

In each of `e2e/dialog-accessibility.spec.js`, `e2e/extension-theme.spec.js`, `e2e/hit-testing.spec.js`, `e2e/virtualization.spec.js`, change:
```js
const EXTENSION_ROOT = path.join(__dirname, "..");
```
to:
```js
const EXTENSION_ROOT = path.join(__dirname, "..", "src");
```
(one line, one occurrence, per file — verify with `grep -n "EXTENSION_ROOT = path.join" e2e/*.spec.js` before and after).

- [ ] **Step 2: Fix `e2e/js-coverage.spec.js`'s per-file reads, AND wire in `formatters.js` as a new dependency**

This file uses a bare `ROOT = path.join(__dirname, "..")` and then joins it directly with bare filenames for 8 separate `readFileSync` calls. `ROOT` itself stays as-is (it's also used elsewhere as the repo root); only the individual joins change. Change:
```js
  const extractJs = fs.readFileSync(path.join(ROOT, "extract.js"), "utf8");
  const searchFetcherJs = fs.readFileSync(path.join(ROOT, "search-fetcher.js"), "utf8");
  const pageBridgeJs = fs.readFileSync(path.join(ROOT, "page-bridge.js"), "utf8");
  const contentJs = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const popupJs = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
  const tokensCss = fs.readFileSync(path.join(ROOT, "tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(ROOT, "content.css"), "utf8");
  const popupCss = fs.readFileSync(path.join(ROOT, "popup.css"), "utf8");
```
to:
```js
  const extractJs = fs.readFileSync(path.join(ROOT, "src", "shared", "extract.js"), "utf8");
  const searchFetcherJs = fs.readFileSync(path.join(ROOT, "src", "shared", "search-fetcher.js"), "utf8");
  const pageBridgeJs = fs.readFileSync(path.join(ROOT, "src", "content", "page-bridge.js"), "utf8");
  const formattersJs = fs.readFileSync(path.join(ROOT, "src", "shared", "formatters.js"), "utf8");
  const contentJs = fs.readFileSync(path.join(ROOT, "src", "content", "content.js"), "utf8");
  const popupJs = fs.readFileSync(path.join(ROOT, "src", "popup", "popup.js"), "utf8");
  const tokensCss = fs.readFileSync(path.join(ROOT, "src", "content", "tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(ROOT, "src", "content", "content.css"), "utf8");
  const popupCss = fs.readFileSync(path.join(ROOT, "src", "popup", "popup.css"), "utf8");
```
The subsequent `context.route(...)` calls in this file route by URL string (e.g. `"https://www.vrbo.com/extract.js"`), not filesystem path — the *existing* ones are unaffected and must NOT be changed. But `formatters.js` is not a path rename of something that already existed here — it's a brand-new file Task 4 created, and this spec constructs its own miniature "page" by hand (inline HTML strings + routed URLs, not the real `manifest.json`), so nothing here knows about it yet unless it's added explicitly, the same way it had to be added explicitly to the manifest (Task 2), `popup.html` (Task 3), the unit-test harness (Task 6 Step 5), and the CDP injection loops (Task 7b Step 4). This is that same "new dependency, not a rename" class of gap, in its last remaining location. Add a route for it, immediately after the existing `popup.js` route:
```js
  await context.route("https://www.vrbo.com/extract.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: extractJs }));
  await context.route("https://www.vrbo.com/search-fetcher.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: searchFetcherJs }));
  await context.route("https://www.vrbo.com/page-bridge.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: pageBridgeJs }));
  await context.route("https://www.vrbo.com/content.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: contentJs }));
  await context.route("https://www.vrbo.com/popup.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: popupJs }));
  await context.route("https://www.vrbo.com/formatters.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: formattersJs }));
```

- [ ] **Step 3: Add a `<script>` tag for `formatters.js` to all 3 inline HTML templates in `e2e/js-coverage.spec.js`, before `content.js`/`popup.js`**

Three separate inline HTML template literals in this file each load the production scripts via `<script src="/...">` tags pointing at the routes from Step 2. All three currently omit `formatters.js`, and since `content.js`/`popup.js` now read `globalThis.VdpFormatters` at load time (Task 4), every one of these templates would throw a `TypeError` without it — this is the actual bug this task exists to fix, not just a coverage-completeness nicety.

**Search scenario template** — change:
```html
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/page-bridge.js"></script>
      <script src="/content.js"></script>
```
to:
```html
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/page-bridge.js"></script>
      <script src="/formatters.js"></script>
      <script src="/content.js"></script>
```
(Note: this exact 4-line block appears **twice** in the file — once for the search scenario, once for the listing scenario. Apply this same change both times; a plain string-replace tool will need `replace_all` or two passes, not just the first match.)

**Popup scenario template** — change:
```html
        <script src="/extract.js"></script>
        <script src="/popup.js"></script>
```
to:
```html
        <script src="/extract.js"></script>
        <script src="/formatters.js"></script>
        <script src="/popup.js"></script>
```

- [ ] **Step 4: Add `formatters.js` to `TARGET_SCRIPTS` so its browser-path coverage is actually tracked**

`formatters.js` is a genuine new production file that now runs in the browser alongside `content.js`/`popup.js`/`page-bridge.js` — leaving it out of `TARGET_SCRIPTS` wouldn't fail this spec (the aggregation is purely filename-driven and just skips anything not in the set), but it would silently make `formatters.js` the one production file with zero coverage tracking anywhere in the whole suite (`tools/check-coverage.js` only tracks `extract.js`/`search-fetcher.js`; this spec is what tracks `content.js`/`popup.js`/`page-bridge.js`'s browser-path coverage). Change (currently line 7):
```js
const TARGET_SCRIPTS = new Set(["content.js", "popup.js", "page-bridge.js", "search-fetcher.js", "extract.js"]);
```
to:
```js
const TARGET_SCRIPTS = new Set(["content.js", "popup.js", "page-bridge.js", "search-fetcher.js", "extract.js", "formatters.js"]);
```

- [ ] **Step 5: Fix the two theme fixture HTML files' stylesheet links**

`test/fixtures/panel-theme.html` currently has:
```html
    <link rel="stylesheet" href="../../tokens.css">
    <link rel="stylesheet" href="../../content.css">
```
Change to:
```html
    <link rel="stylesheet" href="../../src/content/tokens.css">
    <link rel="stylesheet" href="../../src/content/content.css">
```

`test/fixtures/popup-theme.html` currently has:
```html
    <link rel="stylesheet" href="../../tokens.css">
    <link rel="stylesheet" href="../../popup.css">
```
Change to:
```html
    <link rel="stylesheet" href="../../src/content/tokens.css">
    <link rel="stylesheet" href="../../src/popup/popup.css">
```

- [ ] **Step 6: Run the full e2e suite**

```bash
npx playwright test 2>&1 | tail -20
```

Expected: `17 passed`. If `js-coverage.spec.js` throws a `TypeError` referencing `VdpFormatters`/`escapeHtml`/`formatMoney` from any of its 3 scenarios, Step 3's `<script>` tag additions were missed or misplaced (must come before `content.js`/`popup.js`, not after).

- [ ] **Step 7: Commit**

```bash
git add e2e/*.spec.js test/fixtures/panel-theme.html test/fixtures/popup-theme.html
git commit -m "test(e2e): update extension/fixture paths for src/ layout, wire formatters.js into js-coverage.spec.js"
```

---

### Task 7b: Fix every `tools/` script's runtime-file references

**Files:**
- Modify: `tools/demonstrate-mouse-hover.js`
- Modify: `tools/generate-search-gif.js`
- Modify: `tools/render-badge-images.js`
- Modify: `tools/render-hover-target-diagram.js`
- Modify: `tools/render-listing-popup-image.js`
- Modify: `tools/capture-live-search-demo.js`
- Modify: `tools/capture-live-vrbo-demo.js`
- Modify: `tools/hit-testing-probe.js`
- Modify: `tools/live-search-hover-probe.js`
- Modify: `tools/inspect-5-listings.js`
- Modify: `tools/stress-test-listings.js`
- Modify: `tools/live-check.js`
- Modify: `tools/live-search-check.js`

**Interfaces:** N/A.

> **Not just the CSS-reading scripts.** A first pass of this task only found the 5 scripts that read `tokens.css`/`content.css`. A second, more exhaustive pass — grepping every `tools/*.js` file for *any* mention of a runtime filename, not just the specific patterns already found — turned up 8 more: every script that shells out to Chrome with `--load-extension=<root>` breaks too, since the manifest is no longer at repo root. `tools/check-coverage.js` is excluded (Global Constraints) and `tools/live-listings.txt` isn't code. None of these 13 scripts run as part of `npm test`/`npm run test:all`/e2e, so this task doesn't change what Task 10's automated verification reports — but leaving them broken is a silent trap for the next time someone actually runs one, per the issue's own "clean root" intent. Per this session's standing guidance, do not execute any of the live-traffic scripts (`live-check.js`, `live-search-check.js`, `inspect-5-listings.js`, `stress-test-listings.js`, `capture-live-*.js`, `*-probe.js`) against real Vrbo pages as part of verifying this task — `node --check` syntax validation is sufficient and is what Step 4 below uses.

- [ ] **Step 1: Fix the 5 CSS-reading render/demo scripts**

`tools/demonstrate-mouse-hover.js`, `tools/generate-search-gif.js`, `tools/render-badge-images.js`, `tools/render-hover-target-diagram.js`, and `tools/render-listing-popup-image.js` each have this identical pair of lines (line numbers 13-15 or 14-15 depending on the file — confirm with `grep -n 'tokens.css\|content.css' tools/*.js` before editing):
```js
  const tokensCss = fs.readFileSync(path.join(__dirname, "../tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(__dirname, "../content.css"), "utf8");
```
In each of the 5 files, change to:
```js
  const tokensCss = fs.readFileSync(path.join(__dirname, "../src/content/tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(__dirname, "../src/content/content.css"), "utf8");
```

- [ ] **Step 2: Fix the 4 scripts using an `extensionPath` variable for `--load-extension`**

`tools/capture-live-search-demo.js`, `tools/capture-live-vrbo-demo.js`, `tools/hit-testing-probe.js`, and `tools/live-search-hover-probe.js` each define, near the top of the file:
```js
  const extensionPath = path.join(__dirname, "..");
```
Change to, in each of the 4 files:
```js
  const extensionPath = path.join(__dirname, "..", "src");
```
This single change fixes both that file's `--load-extension=${extensionPath}` and `--disable-extensions-except=${extensionPath}` lines, since both read from the same variable.

- [ ] **Step 3: Fix `tools/inspect-5-listings.js` and `tools/stress-test-listings.js`'s `ROOT`-based extension load**

In both files, `ROOT` is used *only* for the extension-loading flags (confirmed by grepping every `ROOT` usage in each file before writing this step — nothing else in either file depends on `ROOT` meaning "repo root"), so it's safe to redefine `ROOT` itself rather than touch each call site. Change, in both files:
```js
const ROOT = path.join(__dirname, "..");
```
to:
```js
const ROOT = path.join(__dirname, "..", "src");
```
This fixes both that file's `--load-extension=${ROOT}` and `--disable-extensions-except=${ROOT}` lines.

- [ ] **Step 4: Fix `tools/live-check.js` and `tools/live-search-check.js`**

These two are more involved: `ROOT` here is used for *both* the extension-load flag *and* a `readScript()` helper that reads several different runtime files living in *different* new subdirectories (`page-bridge.js` → `src/content/`, `extract.js`/`search-fetcher.js` → `src/shared/`, `content.js` → `src/content/`) — so, unlike Step 3, `ROOT` itself must stay meaning "repo root" here, and the fix has to happen at each specific use site instead.

**In `tools/live-check.js`:**

Change the `readScript` helper (currently line 320) from:
```js
const readScript = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
```
to:
```js
const SCRIPT_PATHS = {
  "page-bridge.js": path.join(ROOT, "src", "content", "page-bridge.js"),
  "extract.js": path.join(ROOT, "src", "shared", "extract.js"),
  "search-fetcher.js": path.join(ROOT, "src", "shared", "search-fetcher.js"),
  "formatters.js": path.join(ROOT, "src", "shared", "formatters.js"),
  "content.js": path.join(ROOT, "src", "content", "content.js"),
};
const readScript = (f) => fs.readFileSync(SCRIPT_PATHS[f] || path.join(ROOT, f), "utf8");
```
Change the extension-load line (currently line 237) from:
```js
      `--load-extension=${ROOT},${writeCanaryExtension()}`,
```
to:
```js
      `--load-extension=${path.join(ROOT, "src")},${writeCanaryExtension()}`,
```
Change the emulated-mode injection loop (currently line 481) from:
```js
      for (const file of ["extract.js", "search-fetcher.js", "content.js"]) {
```
to:
```js
      for (const file of ["extract.js", "search-fetcher.js", "formatters.js", "content.js"]) {
```
(`formatters.js` must be injected before `content.js` since `content.js` reads `globalThis.VdpFormatters` at load time — same ordering reasoning as manifest.json's `content_scripts` array in Task 2.)

**In `tools/live-search-check.js`:**

Change the `readScript` function (currently lines 72-74) from:
```js
function readScript(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}
```
to:
```js
const SCRIPT_PATHS = {
  "page-bridge.js": path.join(ROOT, "src", "content", "page-bridge.js"),
  "extract.js": path.join(ROOT, "src", "shared", "extract.js"),
  "search-fetcher.js": path.join(ROOT, "src", "shared", "search-fetcher.js"),
  "formatters.js": path.join(ROOT, "src", "shared", "formatters.js"),
  "content.js": path.join(ROOT, "src", "content", "content.js"),
};
function readScript(rel) {
  return fs.readFileSync(SCRIPT_PATHS[rel] || path.join(ROOT, rel), "utf8");
}
```
Change the `startChrome` call site (currently line 185) from:
```js
  const { proc, userDataDir, mode } = await startChrome(port, ROOT, rawSearchUrl);
```
to:
```js
  const { proc, userDataDir, mode } = await startChrome(port, path.join(ROOT, "src"), rawSearchUrl);
```
Change the emulated-mode injection loop (currently line 261) from:
```js
      for (const file of ["extract.js", "search-fetcher.js", "content.js"]) {
```
to:
```js
      for (const file of ["extract.js", "search-fetcher.js", "formatters.js", "content.js"]) {
```

- [ ] **Step 5: Syntax-check every modified file**

Do NOT execute any of these scripts (see the note above this task's step list) — `node --check` is sufficient to confirm the edits are syntactically valid and is what CI-equivalent verification for this task means:
```bash
for f in tools/demonstrate-mouse-hover.js tools/generate-search-gif.js tools/render-badge-images.js \
         tools/render-hover-target-diagram.js tools/render-listing-popup-image.js \
         tools/capture-live-search-demo.js tools/capture-live-vrbo-demo.js tools/hit-testing-probe.js \
         tools/live-search-hover-probe.js tools/inspect-5-listings.js tools/stress-test-listings.js \
         tools/live-check.js tools/live-search-check.js; do
  node --check "$f" || echo "FAILED: $f"
done
echo "done"
```
Expected: no `FAILED:` lines printed, just `done`.

- [ ] **Step 6: Commit**

```bash
git add tools/demonstrate-mouse-hover.js tools/generate-search-gif.js tools/render-badge-images.js \
        tools/render-hover-target-diagram.js tools/render-listing-popup-image.js \
        tools/capture-live-search-demo.js tools/capture-live-vrbo-demo.js tools/hit-testing-probe.js \
        tools/live-search-hover-probe.js tools/inspect-5-listings.js tools/stress-test-listings.js \
        tools/live-check.js tools/live-search-check.js
git commit -m "chore(tools): update runtime-file paths for src/ layout"
```

---

### Task 8: Housekeeping — gitignore `dist/`, move local zip artifacts

**Files:**
- Modify: `.gitignore`

**Interfaces:** N/A.

- [ ] **Step 1: Add an explicit `dist/` entry to `.gitignore`**

`*.zip` is already ignored (confirmed via `git status --short --ignored` before writing this plan — none of the zip files at repo root are tracked), so this step is about making the convention explicit for the new directory, not fixing a gap. Add a line to `.gitignore`:
```
dist/
```
(anywhere in the file; grouping it near the existing `*.zip` line is reasonable but not required).

- [ ] **Step 2: Move the local zip artifacts out of repo root**

```bash
mkdir -p dist
mv vrbow-extension.zip vrbow-v1.0.1.zip vrbow-v1.1.0.zip vrbow-v1.1.1.zip vrbow-v1.1.2.zip vrbow-v1.2.0.zip dist/ 2>/dev/null || true
```
(`|| true` because these are untracked local files that may not exist in every checkout — this is not a failure condition. If the repo root has no `.mov` files at plan-execution time, per the pre-plan audit, there is nothing to relocate for that part of the original issue — skip it rather than inventing files to move.)

- [ ] **Step 3: Verify root is clean**

```bash
git status --short --ignored
ls *.zip *.mov 2>/dev/null   # expect: no such file or directory
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(repo): gitignore dist/, relocate local zip artifacts out of root"
```

---

### Task 9: Add `tools/build-zip.js` packaging script

**Files:**
- Create: `tools/build-zip.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `dist/vrbow-vX.Y.Z.zip` (version read from `src/manifest.json`).

- [ ] **Step 1: Write `tools/build-zip.js`**

Uses only Node built-ins (no new dependency) — shells out to the system `zip` command, which is what the existing zip artifacts' naming convention (`vrbow-vX.Y.Z.zip`) implies was used to build them originally, and keeps this script dependency-free.

```js
#!/usr/bin/env node
// tools/build-zip.js
// Packages src/ into dist/vrbow-vX.Y.Z.zip for Chrome Web Store submission.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");
const DIST_DIR = path.join(ROOT, "dist");

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "manifest.json"), "utf8"));
  const version = manifest.version;
  if (!version) {
    console.error("❌ src/manifest.json has no \"version\" field.");
    process.exit(1);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const zipName = `vrbow-v${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);

  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath);
  }

  // Zip the CONTENTS of src/ (not a wrapping src/ directory), so the
  // archive root is exactly what Chrome expects to unpack an extension from.
  const entries = fs.readdirSync(SRC_DIR);
  execFileSync("zip", ["-r", "-X", zipPath, ...entries], { cwd: SRC_DIR, stdio: "inherit" });

  console.log(`✅ Built ${path.relative(ROOT, zipPath)}`);
}

main();
```

- [ ] **Step 2: Add the `build`/`package` script to `package.json`**

Add a new entry to the `scripts` block (after `test:all`):
```json
    "build": "node tools/build-zip.js",
    "package": "node tools/build-zip.js"
```

- [ ] **Step 3: Run it and verify the output**

```bash
npm run build
unzip -l dist/vrbow-v*.zip | head -20
```

Expected: the build script prints `✅ Built dist/vrbow-v1.2.0.zip` (version matches `src/manifest.json`'s current `"version"` field), and `unzip -l` shows `manifest.json`, `content/`, `popup/`, `shared/`, `icons/` at the archive root (not nested under a `src/` prefix).

- [ ] **Step 4: Commit**

```bash
git add tools/build-zip.js package.json
git commit -m "feat(tools): add build-zip.js packaging script"
```

---

### Task 10: Full verification pass

**Files:** None (verification only).

**Interfaces:** N/A.

- [ ] **Step 1: Run the full unit suite**

```bash
npm test
```
Expected: `tests 185`, `pass 185`, `fail 0`.

- [ ] **Step 2: Run the coverage gate**

```bash
npm run test:coverage
```
Expected: `✅ PASS [extract.js]` and `✅ PASS [search-fetcher.js]`, same thresholds as before (line≥90%, branch≥75%, funcs≥85%) — this is the check that confirms the Global Constraints note about `tools/check-coverage.js` needing no changes actually held in practice, not just in the standalone experiment run before writing this plan.

- [ ] **Step 3: Run the full e2e suite**

```bash
npx playwright test
```
Expected: `17 passed`.

- [ ] **Step 4: Run `test:all` end to end**

```bash
npm run test:all
```
Expected: no errors from any of the `node --check` calls, coverage gate passes, `playwright test` passes.

- [ ] **Step 5: Manually verify the unpacked extension loads from `./src`**

This step cannot be scripted — it requires a human with Chrome. Report the exact instructions rather than skipping this:
1. Open `chrome://extensions`, enable Developer Mode.
2. Click "Load unpacked", select the repo's `src/` directory (not the repo root).
3. Confirm the extension loads with no errors shown on the extensions page.
4. Open the popup (toolbar icon) on any page — confirm it renders without a console error (check DevTools console for the popup).
5. Navigate to a real or mocked Vrbo listing page — confirm the on-page panel still mounts (this can be done against the existing e2e fixtures manually in a real Chrome window if no live Vrbo access is available/desired).

- [ ] **Step 6: Verify the packaged zip**

```bash
npm run build
```
Then repeat step 5's "Load unpacked" check, but this time unzip `dist/vrbow-v*.zip` into a scratch directory first and load unpacked from *that* directory, to confirm the packaged archive is itself a valid, loadable extension (not just that `src/` in-place is valid).

- [ ] **Step 7: Final commit (if any cleanup was needed) and summary**

If steps 1-6 all pass with no further changes needed, there's nothing left to commit — this task is verification-only. If any step surfaced a real gap, fix it as a small follow-up commit and re-run the relevant verification step before considering the migration complete.

---

## Self-Review Notes (from the plan author)

- **Spec coverage**: every migration step and acceptance criterion from the issue body maps to a task above — directory migration (Task 1), formatter extraction (Task 4), path/import updates (Tasks 2, 3, 5, 6, 7, 7b), packaging tooling (Task 9), zip/`.gitignore` cleanup (Task 8), and full verification including manual Chrome load (Task 10).
- **Two corrections made to the issue's stated premise**, both called out explicitly in Global Constraints rather than silently implemented: (1) the claimed `content.js`/`popup.js` `formatMoney` duplication doesn't exist — only `escapeHtml` is a true duplicate, and `popup.js`'s formatter is relocated as-is rather than merged with `extract.js`'s unrelated one; (2) `tools/check-coverage.js` was verified empirically to need zero changes, which is itself a finding worth recording so nobody "fixes" it into breakage later.
- **Type/name consistency check**: `globalThis.VdpFormatters` is the single name used everywhere it's introduced (Task 4's factory), consumed (Task 4's content.js/popup.js edits), and injected in tests (Task 6 Step 5) — matches the existing `VDPExtract`/`VdpSearchFetcher` naming precedent in this codebase (each shared module gets its own `Vdp*`-prefixed global). The same `formatters.js` file is also added to the CDP-injection loops in Task 7b's `live-check.js`/`live-search-check.js` fixes, using the identical name and identical "before content.js" ordering — no drift between the automated-test path and the dev-tooling path.
- **Three review passes found and closed 4 real gaps** before execution, each verified independently against the actual files rather than taken on trust: (1) `test/theme-contract.test.js` was entirely absent from the original Task 6 — it has its own root-relative `read()` helper with 11 call sites and 3 assertions that check literal manifest/popup.html content, all of which needed fixing (now Task 6 Steps 6-7); (2) `test/search-ui.test.js` has a second, separate `content.css` `readFileSync` outside its `require()` calls (now Task 6 Step 6, distinct from Step 7's `theme-contract.test.js` fix — don't conflate the two); (3) the `tools/` directory has 13 scripts referencing runtime files, not the handful an initial grep for `tokens.css`/`content.css` alone would find — every script that shells out to Chrome with `--load-extension` also breaks, since the manifest moved (now Task 7b, all 13 enumerated explicitly with per-file before/after snippets, no file left as a "TODO" placeholder); (4) `e2e/js-coverage.spec.js` builds its own miniature page by hand (inline HTML + routed URLs, not the real manifest), so it doesn't automatically pick up `formatters.js` the way the `--load-extension`-based specs do once the manifest is fixed — needed a new route, a new `<script>` tag in all 3 of its inline HTML templates (search/listing/popup scenarios), and an addition to `TARGET_SCRIPTS` for coverage tracking (now Task 7 Steps 2-4).
- **The class of gap behind findings (3) and (4) is the same one**: `formatters.js` is a *new* file, not a renamed one, so every place that executes the extension's own scripts outside the real manifest — dev tooling that manually injects script content, and this one e2e spec that hand-builds pages instead of loading the unpacked extension — had to be found and updated explicitly rather than assumed to "just work" from the directory move alone. All five consumption sites for `globalThis.VdpFormatters` are now enumerated in one place: manifest.json (Task 2), popup.html (Task 3), the unit-test harness (Task 6 Step 5), the CDP injection loops in `live-check.js`/`live-search-check.js` (Task 7b Step 4), and `js-coverage.spec.js`'s inline templates (Task 7 Step 3) — if a sixth site turns up during execution, it belongs to this same list, not a one-off patch.
