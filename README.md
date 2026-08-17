# Vrbo Dog Policy Callout

A Chrome extension that pulls the dog rules out of a Vrbo listing and puts
them in one always-visible card — instead of leaving them scattered across
House Rules, Amenities and "About this property".

<img src="docs/panel-dog-friendly.png" alt="Callout showing max dogs 2, weight limit 50 lbs, pre-registration required" width="420">

Every value has a **source** link that jumps to and highlights the exact
sentence it came from, so you can check anything before booking.

## What it shows

- Whether pets are allowed
- Max number of dogs, and the per-dog weight limit
- Whether the host needs advance notice or pre-registration
- Pet fee, and any refundable deposit shown separately
- **Other pet notes** — breed limits, crate and leash rules, anything that
  doesn't fit a field above, so nothing is silently dropped

When a listing contradicts itself — and hosts do this more than you'd
expect — the card flags it rather than quietly picking one number:

> ⚠ Listing also states elsewhere: **75 lbs** (About this property)

<img src="docs/panel-not-allowed.png" alt="Callout reading: Pets are not allowed" width="420">

Conditional wording is handled: *"no pets over 30 lbs"* and *"no pets
without prior approval"* mean pets **are** allowed with a condition, and
are not reported as a ban. Neither is *"no pet fee"*.

## In use

It appears on its own, a second or two after the listing loads — no
clicking, no scrolling down to House Rules.

![The callout appearing automatically as a Vrbo listing loads](docs/demo.gif)

It sits out of the way in the corner, over the listing you were reading:

<img src="docs/listing-context.jpg" alt="The callout in the corner of a Vrbo listing page" width="820">

## Installation

Load the extension directly into Chrome (Chrome 111+ or any Chromium-based browser like Brave, Edge, Arc):

### Option 1: From GitHub Release (Quickest)
1. Download `vrbo-dog-friendly-v1.0.0.zip` from [Releases](https://github.com/curdriceaurora/vrbo-dog-friendly/releases).
2. Unzip the file into a folder on your computer.
3. Open `chrome://extensions` in your browser.
4. Enable **Developer mode** using the toggle in the top-right corner.
5. Click **Load unpacked** (top-left) and select the unzipped folder.

### Option 2: From Source / Git
1. Clone or download this repository:
   ```bash
   git clone https://github.com/curdriceaurora/vrbo-dog-friendly.git
   ```
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository directory.

---

## How to Use

### 1. Automatic On-Page Card
Whenever you visit a listing page on `vrbo.com` (or regional sites like `stayz.com.au`, `fewo-direkt.de`, `abritel.fr`, `bookabach.co.nz`), the policy card automatically loads in the bottom-right corner:

- **Source verification**: Click the **source** link next to any extracted value (dog limit, weight, fee, deposit) to automatically jump to and highlight the exact sentence in the listing where that value was found.
- **Other pet notes**: Click **Other pet notes** to expand raw sentences containing extra guidelines (such as leash rules, crate requirements, or breed restrictions).
- **Contradiction alerts (⚠️)**: If the host wrote conflicting rules in different sections (e.g. 50 lbs in House Rules vs 75 lbs in About this property), the card alerts you and shows both sources.
- **Collapse / Minimize**: Click the card header to collapse it to a compact bar, or click **×** to dismiss it.
- **↻ Rescan**: Click the refresh icon to re-run extraction if a listing was slow to load.
- **Source indicator**: The footer displays whether the data came from the listing's structured data (`__APOLLO_STATE__`) or visible page text fallback.

### 2. Browser Toolbar Popup
- Pin the extension icon to your Chrome toolbar.
- Clicking the extension icon on any active Vrbo listing opens a quick popup summary with the same dog policy details.

## How it reads the page

Vrbo lazy-mounts House Rules and clamps the description behind "See more",
but the full text is already in the page's `__APOLLO_STATE__` when the
listing loads. The extension reads that directly, so it doesn't depend on
you scrolling or expanding anything, and it walks the *whole* listing
object rather than just the Pets row — which is how it catches a weight
limit in Amenities disagreeing with one in House Rules. If that data ever
disappears, it falls back to scanning visible page text.

Nothing is sent anywhere. It reads only what the page already loaded.

## Known limitations

- Extraction is regex-based. Unusual phrasing lands in "Other pet notes"
  rather than a structured field — deliberately, since showing you the raw
  sentence beats guessing wrong.
- **English only.** `kg` weights and `€`/`£`/`A$`/`NZ$` fees parse, so
  Stayz and Bookabach work, but every phrase it keys off ("up to", "pet
  fee", "prior approval") is English. German and French prose on
  FeWo-direkt and Abritel will mostly land in the notes.
- Only Vrbo.com is tested against live listings; the sister sites are
  best-effort.

## Ideas for later

- Pet policy badges directly on search-results cards.
- A way to flag a wrong extraction, to improve pattern coverage.

## Development

`extract.js` holds the parsing layer, deliberately free of DOM and
`chrome.*` calls so it can be unit-tested under Node. `page-bridge.js`
runs in the page's own JS world to reach `__APOLLO_STATE__`;
`content.js` merges that with visible text and renders the card.

```
node --check content.js && node --check extract.js && node --check page-bridge.js && node --check popup.js && node --test
```

34 offline tests and JavaScript syntax checks with zero dependencies, no Chrome, and no network. Enforced automatically in CI via the `offline-tests` GitHub Actions workflow. See [docs/testing.md](docs/testing.md) for the live harness that drives real listings.
