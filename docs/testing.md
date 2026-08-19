# Testing Guide

This document describes how to test the extension.
Testing has two parts: offline unit tests and a live browser test harness.

Install the development dependencies once:

```bash
npm install
npx playwright install chromium
```

---

## 1. Offline Tests

Run this command in your terminal:

```bash
npm run test:all
```

### Details
- Requires no external dependencies or network connection.
- Validates JavaScript syntax for all extension files (`content.js`, `search-fetcher.js`, `extract.js`, `page-bridge.js`, and `popup.js`).
- Executes 185 unit and integration tests against `extract.js`, `search-fetcher.js`, state-transition lifecycles, and request managers using Node's test runner.
- Verifies rule extraction, weight limits, fees, deposits, Apollo GraphQL schema parsing, request throttling, concurrency caps, abort signals, card virtualization, focus trapping, canonical policy normalization, and local cache eviction.

## 2. Automated Theme Tests

Run the complete light and dark browser matrix:

```bash
npm run test:theme
```

The theme suite covers the listing panel and toolbar popup. It verifies every policy tone, shared-token loading, host-page isolation, keyboard focus indicators, viewport containment, and WCAG AA text and non-text contrast in both color schemes. A Chromium CSS coverage gate fails if any production rule in `tokens.css`, `content.css`, or `popup.css` is not exercised; required theme-rule coverage is 100%.

---

## 3. Live Browser Test Harness

Run this command to test live Vrbo listings in Chrome:

```bash
node tools/live-check.js
```

### Options
- Test a specific listing: `node tools/live-check.js 2688106`
- Test multiple listings: `node tools/live-check.js --sample 5`
- Test all listings: `node tools/live-check.js --all`

### Verification Criteria
A listing passes only when:
1. The extension renders the summary card.
2. `page-bridge.js` extracts structured Apollo data from the page world.
3. Isolated-world script variables remain separate from the page world.

### Exit Codes
| Exit Code | Meaning | Description |
|---|---|---|
| `0` | Pass | All listings passed verification. |
| `1` | Failure | The extension or manifest failed to execute. |
| `2` | Inconclusive | The page showed a bot challenge or served no data. |

---

## Rate Limiting

Vrbo can show bot verification pages after many rapid requests.
The harness waits 4000 ms between listings by default.
To change the delay:

```bash
node tools/live-check.js --sample 5 --delay 5000
```
