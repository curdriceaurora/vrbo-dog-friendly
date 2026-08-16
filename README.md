# Vrbo Dog Policy Callout

A Chrome extension that pulls dog-friendliness details out of a Vrbo
listing and shows them as a clear, always-visible callout — no more
hunting through House Rules, About this property, and amenities
separately.

It surfaces:

- **Pets allowed / not allowed**
- **Max number of dogs**
- **Per-dog weight limit**
- **Pre-registration / advance-notice requirement**
- **Pet fee amount** (or confirms none is mentioned)
- **Refundable pet deposit**, shown separately from the (usually
  non-refundable) fee when a listing has both
- **Other pet notes** — anything pet-related that doesn't fit a
  structured field above (breed restrictions, "must be crated when
  unattended," leash rules, etc.), so nothing gets silently dropped

Each field includes a "source" link that jumps to and highlights the
sentence it came from, and if different parts of the listing disagree
with each other (hosts do this more than you'd expect — see below), the
callout flags the primary value with a "listing also states elsewhere…"
warning instead of quietly picking one number.

## How it reads the page (and why)

Vrbo's House Rules/Policies section is lazy-mounted — it's an empty
placeholder in the DOM until you scroll to it — and "About this
property" text is visually clamped behind a "See more" toggle. Both of
those are just rendering behavior, though: the full text was already
fetched via GraphQL and cached in the page's `window.__APOLLO_STATE__`
object as soon as the listing loaded.

So instead of only scanning what's currently visible on screen, the
extension:

1. **Reads the page's Apollo cache directly** (`page-bridge.js`, running
   in the page's own JS context so it can see `window.__APOLLO_STATE__`)
   and walks the *entire* listing data object — not just the "Pets" row
   under House Rules, but Amenities, "About this property," "Important
   information," and anything else — tagging every string it finds with
   whatever heading it was nested under. This is what let it catch, on a
   real test listing, three *different* pet mentions in three different
   places (Amenities said "up to 50 lbs," a House Rules note said "up to
   75 lbs," and About-this-property said "one dog") — which is exactly
   the kind of inconsistency that's easy to miss when skimming, and
   exactly why the callout shows alternates instead of hiding them.
2. **Also expands whatever it can find on the page itself** — clicking
   any visible "show more / read more / expand" toggle and briefly
   scrolling empty lazy-load placeholders into view — as a second,
   independent pass, in case some content genuinely isn't in the Apollo
   cache (a different rendering path, a Vrbo schema change, etc.).
3. **Falls back to scanning visible page text** for pet/dog mentions if
   neither of the above finds anything, so the extension still does
   *something* useful even if Vrbo's internal data shape changes
   entirely.

A small badge at the bottom of the callout tells you which mode
produced the result ("listing data" vs. "visible page text only").

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome (111+ — needed for the
   `"world": "MAIN"` content script API this relies on).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this `vrbo-dog-friendly` folder.
5. Visit any listing on `vrbo.com` — the callout appears automatically.
   Click the extension icon in the toolbar for the same summary in a
   popup.

## Files

- `manifest.json` — MV3 manifest (two content scripts: one in the page's
  own JS world to read Apollo data, one isolated for the UI/DOM logic)
- `page-bridge.js` — reads `window.__APOLLO_STATE__`, walks it for
  pet-relevant text, dispatches it to the content script
- `extract.js` — the parsing layer (sentence splitting, corpus assembly,
  all the pet-policy regexes). Deliberately free of DOM and `chrome.*`
  calls so it can be unit-tested under Node; loaded as the first content
  script in the isolated world, where it exposes itself as `VDPExtract`
- `content.js` — merges Apollo data + expanded/visible DOM text, calls
  into `extract.js`, renders the floating panel
- `content.css` — panel styles
- `popup.html` / `popup.js` / `popup.css` — toolbar popup summary
  (falls back to the last cached result in `chrome.storage.local` if the
  content script hasn't responded yet)
- `icons/` — extension icons
- `test/extract.test.js` — fixture tests for the parsing layer
- `tools/live-listings.txt` — real listing URLs for manual verification
- `tools/live-check.js` — drives those listings in Chrome over the
  DevTools protocol and reports the panel each one renders

## Tests

```
node --test
```

No dependencies and no build step — Node's built-in runner against
`extract.js`. Offline, deterministic, and safe to run anywhere: it needs
neither Chrome nor a network. (The live harness deliberately lives in
`tools/`, not `test/`, because `node --test` treats *every* `.js` file
under a `test/` directory as a test file.)

The fixtures are phrased the way hosts actually write these rules, and
exist mainly to pin down the ambiguous cases: conditional restrictions
that read like bans ("no pets over 30 lbs"), "no pet fee" (dog-friendly)
versus "no pets" (not), and the same weight limit restated in a second
unit, which must not be reported as the listing contradicting itself.

## Checking against real listings

```
node tools/live-check.js
```

Samples 5 URLs from `tools/live-listings.txt` (`--all`, `--sample N`, or
specific listing ids also work), drives them in Chrome, and prints the
panel each one produced. Needs Node 22+ and Chrome, and opens a visible
window — Vrbo serves less to headless.

A listing only passes if the panel rendered *and* `page-bridge.js` ran in
the MAIN world with a non-empty Apollo payload *and* isolated-world state
stayed out of the MAIN world. A rendered panel on its own proves little:
the DOM fallback can paint a convincing one while the bridge is entirely
broken.

**It is not a real extension load.** Branded Google Chrome stopped
honouring `--load-extension` in 137 (measured here on Chrome 151, where
`--enable-unsafe-extension-debugging` does not restore it). That removal
is specific to branded Chrome — Chromium and Chrome for Testing still
support the switch for exactly this purpose — so a real unpacked load is
achievable on those binaries; this script just doesn't do it yet.
What it does instead is reproduce by hand what the manifest declares:
`page-bridge.js` into the MAIN world at document_start, `extract.js` and
`content.js` into a real isolated world. That covers the scripts, the
cross-world bridge and real listing data, but *not* `manifest.json`
itself — script order, `"world": "MAIN"`, host matching. Verify those by
loading unpacked at `chrome://extensions`.

## Known limitations

- Regex-based extraction still isn't perfect. Unusual phrasing can land
  in "Other pet notes" instead of a structured field — which is by
  design (better to show you the raw sentence than guess wrong), but it
  means it's still worth a glance at those notes.
- "No pets over 30 lbs" / "no pets without prior approval" style
  conditional wording is specifically handled so it isn't misread as "no
  pets allowed at all," but very unusual phrasing could still slip past
  that check either direction — the source links are there so you can
  verify anything that matters for booking.
- Best-effort support for Vrbo's sister sites (Abritel, FeWo-direkt,
  Bookabach, Stayz) is included via matching host permissions, but only
  Vrbo.com itself has been tested against live listings — if those
  sites use a different internal data shape, the extension will still
  fall back to visible-text scanning there.
- **The parser is English-only, even where it's unit-aware.** Weights in
  `kg` and fees in `€`/`£`/`A$`/`NZ$` are recognized, so the
  English-language sister sites (Stayz, Bookabach) parse correctly. But
  every surrounding phrase it keys off — "up to", "weight limit of",
  "pet fee", "prior approval" — is still English, so German or French
  prose on FeWo-direkt/Abritel will mostly land in "Other pet notes"
  rather than the structured fields. Localizing those lead-ins is the
  remaining work for real international support.
- No dedicated background script watches for SPA navigation; instead
  `page-bridge.js` patches `history.pushState`/`replaceState` in the
  page's own JS world (patching it from the content script would be a
  no-op — isolated worlds don't share object mutations with the page, so
  it would only ever catch our own calls) and signals the content script
  by event, which combines it with `popstate`, a cheap 1-second
  `location.href` poll, and DOM mutation observation. Navigating between
  listings without a full page reload is covered by several overlapping,
  low-cost checks rather than one that could silently fail.
- Doesn't call any Vrbo API beyond what the page itself already loaded —
  nothing is sent anywhere.

## Ideas for later

- Badge pet policy summaries directly on Vrbo search-results cards, so
  you don't have to open each listing individually.
- A lightweight way to flag/correct a wrong extraction, to improve
  pattern coverage over time.
