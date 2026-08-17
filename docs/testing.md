# Testing Guide

This document describes how to test the extension.
Testing has two parts: offline unit tests and a live browser test harness.

---

## 1. Offline Tests

Run this command in your terminal:

```bash
node --check content.js && node --check extract.js && node --check page-bridge.js && node --check popup.js && node --test
```

### Details
- Requires no external dependencies or network connection.
- Validates JavaScript syntax for all extension files.
- Executes 34 unit tests against `extract.js` using Node's test runner.
- Verifies rule extraction, weight limits, fees, deposits, and contradiction detection.

---

## 2. Live Browser Test Harness

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
