# Testing

Two layers: offline fixture tests for the parser, and a live harness that
drives real listings in Chrome.

## Offline tests

```
node --check content.js extract.js page-bridge.js popup.js && node --test
```

No dependencies, no build step, no Chrome and no network — JavaScript syntax
validation plus Node's built-in test runner against `extract.js`. Enforced in CI
under the `offline-tests` job. Safe to run anywhere.

The fixtures are phrased the way hosts actually write these rules, and
exist mainly to pin down the ambiguous cases: conditional restrictions
that read like bans ("no pets over 30 lbs"), "no pet fee" (dog-friendly)
versus "no pets" (not), and the same weight limit restated in a second
unit, which must not be reported as the listing contradicting itself.

The live harness deliberately lives in `tools/`, not `test/`, because
`node --test` treats *every* `.js` file under a `test/` directory as a
test file.

## Live harness

```
node tools/live-check.js
```

Samples 5 URLs from `tools/live-listings.txt` (`--all`, `--sample N`, or
specific listing ids also work), drives them in Chrome, and prints the
panel each one produced. Needs Node 22+ and Chrome, and opens a visible
window — Vrbo serves less to headless.

A listing passes only if the panel rendered **and** `page-bridge.js`
produced a non-empty Apollo payload in the MAIN world **and**
isolated-world state stayed out of the MAIN world. A rendered panel alone
proves little: the DOM fallback can paint a convincing one while the
bridge is entirely broken.

| exit | meaning |
|---|---|
| 0 | every listing passed |
| 1 | a genuine extension failure, including a manifest that would not load |
| 2 | inconclusive — a bot challenge, or a URL that served no listing data |

The two inconclusive causes are reported separately (`BLOCKED` vs
`NO DATA`) because they call for different responses: wait and retry
versus check whether the URL is still good.

### Two modes, and why it matters which one you got

The harness always passes `--load-extension`, then probes the page to see
whether it took. It reports which mode ran, and they are not equivalent.

**Real load** — the extension loads from `manifest.json` and nothing is
injected. This is the only mode that exercises the manifest itself:
content-script order, `"world": "MAIN"`, host matching. A canary
extension rides along so that a broken manifest cannot masquerade as
"this browser won't load extensions" and quietly downgrade to emulation.

**Emulated fallback** — the scripts are injected by hand:
`page-bridge.js` into the MAIN world at document_start, `extract.js` and
`content.js` into a real isolated world. Still covers the scripts, the
cross-world bridge and real listing data, but a manifest typo **cannot**
fail this mode.

Branded Google Chrome stopped honouring `--load-extension` in 137
(measured on Chrome 151, where `--enable-unsafe-extension-debugging` does
not restore it). That removal is specific to branded Chrome — Chromium
and Chrome for Testing still support it:

```
npx @puppeteer/browsers install chrome@stable --path "$HOME/.cache/puppeteer"
```

`--path` is required. Without it the CLI installs into the *current
directory*, which is not where the harness looks, so the new browser goes
undiscovered and runs silently fall back to the emulated path. Set
`CHROME_BIN` to override.

### Rate limiting

Vrbo starts serving an interstitial bot challenge ("Bot or Not?") after
roughly twenty listings in quick succession, and the block then persists
for a while across the whole IP, not just the offending browser profile.
That page has no `PropertyInfo` in its Apollo state, so the bridge
legitimately produces nothing — which looks exactly like a regression if
you aren't told. The harness detects it and reports `BLOCKED …
inconclusive`.

Runs are paced `--delay` ms apart (default 4000). Work in small batches
and re-run blocked listings later rather than retrying immediately.
