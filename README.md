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
- `content.js` — merges Apollo data + expanded/visible DOM text,
  extracts the structured fields, renders the floating panel
- `content.css` — panel styles
- `popup.html` / `popup.js` / `popup.css` — toolbar popup summary
  (falls back to the last cached result in `chrome.storage.local` if the
  content script hasn't responded yet)
- `icons/` — extension icons

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
- No dedicated background script watches for SPA navigation; instead
  the content script combines a `history.pushState`/`replaceState`
  patch, `popstate`, a cheap 1-second `location.href` poll, and DOM
  mutation observation, so navigating between listings without a full
  page reload is covered by several overlapping, low-cost checks rather
  than one that could silently fail.
- Doesn't call any Vrbo API beyond what the page itself already loaded —
  nothing is sent anywhere.

## Ideas for later

- Badge pet policy summaries directly on Vrbo search-results cards, so
  you don't have to open each listing individually.
- A lightweight way to flag/correct a wrong extraction, to improve
  pattern coverage over time.
