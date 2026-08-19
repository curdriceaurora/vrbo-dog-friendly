# Release Notes

This document records all changes to **Vrbow**.

## [v1.2.0] - 2026-08-18

### Search Request Pacing & Queue Engine
- **Adaptive Backoff Ladder**: Implements a dynamic backoff ladder (`800ms` base $\rightarrow$ `1600ms` $\rightarrow$ `3200ms`, saturating at step 2) for background search requests. A 429 status code or bot challenge triggers an immediate 30-second pause and advances the ladder. Error clusters (3 timeouts or 5xx responses within 60s) advance the ladder, while 404s and non-rate-limit 4xx responses remain fully inert.
- **One-Sided Pacing Jitter**: Adds single-sided jitter (`+[0, 30%]`) to resolved dispatch intervals, preventing synchronized request bursts while strictly enforcing the lower rate floor.
- **Asymmetric Recovery**: Recovery requires a continuous 60-second clean window following a concrete success before stepping down the ladder.
- **Global & High-Priority Dispatch Floors**: Enforces a 250 ms global dispatch floor across all requests (capping throughput at 4 req/sec) while allowing explicit hover interactions to bypass background queues with a dedicated 250 ms delay floor.
- **Queue Item Removal API**: Adds `queue.remove(propertyId)` to withdraw queued or pending items cleanly when cards scroll out of view without locking properties out of future requests.

### Search Card Orchestration & Viewport Virtualization
- **Viewport Dwell Gating**: Delays card fetch enqueuing until a property card remains in view for a jittered dwell window (`[400, 600) ms`), eliminating wasteful requests during rapid scrolling.
- **Off-Screen Recycling Gate**: Recycled search cards located outside the viewport update DOM bindings silently without issuing network requests until scrolled into view.
- **Leading-Edge Scan Throttling**: Throttles DOM `MutationObserver` scan bursts with a 250 ms leading-edge gate to ensure instant initial card binding without compounding UI lag.
- **Navigation & Viewport Pruning**: Automatically cancels queued fetch requests when cards exit the viewport or during SPA search-to-search transitions, preserving session budgets.
- **Subscription Teardown**: Cleans up active card subscriptions during recycling and pruning so late-arriving responses cannot repaint stale or detached cards.

### Search Badge Layout & Sizing (#18)
- **Deterministic Container Resolution**: Evaluates mount containers in prioritized order (`.uitk-card-content`, `[data-stid*="content"]`, `[data-stid*="price"]`, fallback to `card`), preventing document-order mounting anomalies on price-first card templates.
- **Layout Decoupling with `.vdp-badge-slot`**: Wraps the badge in a dedicated `.vdp-badge-slot` container styled with `flex-basis: 100%` and `grid-column: 1 / -1`, enabling the badge to span block parents, wrapping flex rows, and multi-column CSS grids identically while preventing overflow on non-wrapping flex rows.
- **Border-Box Sizing**: Configures `box-sizing: border-box` on search badges, eliminating 18px horizontal padding/border overflow against parent containers.
- **Synchronized Stacking Context**: Updates CSS container elevation selector to `:has(> .vdp-badge-slot)` to match inline style elevation on the container and guarantee reliable hit-testing over `.uitk-card-link` overlays.

### Queue Instrumentation & Metric Precision (#23)
- **Disambiguated Counters**: Separates `enqueued` attempts from true `networkRequests` (`getSessionCount()`) to accurately assess pruning efficacy against cache hits.
- **Staged Queue Depth Accounting**: Includes in-flight items staging behind async cache checks (`getPendingCount()`) in queue depth sampling.
- **Sample Eviction Tracking**: Counts ring buffer evictions in `depthSamplesDropped`.

### E2E Test Safety & Guardrails (#19)
- **Catch-All Network Guardrail**: Installs automated `**/*` request interception across all E2E suites to detect and abort accidental unrouted external traffic during tests.
- **Playwright Worker Cap**: Limits Playwright test runs to 2 concurrent workers for test stability.

---

## [v1.1.2] - 2026-08-18

### Search Card Hit-Testing & Interaction
- **Search Badge Hit-Testing**: Elevated search badge stacking context (`z-index: 100 !important`) and set `pointer-events: auto !important` to ensure physical mouse hovers win hit-testing over host-page full-card overlay links (`.uitk-card-link`).
- **Badge Click Navigation Interception**: Added explicit click handling with `stopPropagation()` and `preventDefault()` on search badges to open the details tooltip dialog directly without triggering card navigation.

### Documentation and Visual Assets
- **Expanded Search Badge Previews**: Added high-resolution visual previews for all operational badge states (loading, allowed with flat/tiered fees, pet restrictions, pets prohibited, and fallback verification).
- **Listing Summary Pop-Up**: Embedded high-resolution on-page summary card graphic into documentation.
- **Streamlined Documentation**: Reorganized README structure to eliminate duplicate feature descriptions while maintaining all visual assets.

---

## [v1.1.1] - 2026-08-18

### Policy Extraction and Edge Case Fixes
- **Active Verb Phrasing**: Parses active pet statements (such as "This property allows 1 dog" and "We permit up to 2 pets").
- **Modifier Fee Phrasing**: Parses fee descriptions with modifiers (such as "additional fee of $500" and "extra fee of $250").
- **Compound Pet Phrasings**: Supports compound phrases (such as "Dogs and cats allowed", "Dogs & cats welcome", and "Cats and dogs welcome").
- **Weight Unit Abbreviations**: Recognizes "pds" and "pd" as pounds and normalizes values to "lb".
- **Numeric Fees Without Symbols**: Parses pet fees written without currency symbols (such as "Pet fee 100.00", "200 pet fee for the whole trip", and "Dog fee: 75").
- **Dog Count and Fee Disambiguation**: Prevents pet fee descriptions (such as "200 pet fee") from being misidentified as dog counts.
- **Trip and Stay Normalization**: Maps "whole trip" and "entire stay" to "stay" fee periods.

### Network Reliability and Architecture
- **Apollo Node Lookup**: Resolves root property data across `propertyId`, `vrboPropertyId`, `expediaPropertyId`, and `id` when Apollo keys use internal IDs.
- **Redirect Resolution**: Detects URL redirects in background requests and caches policies under both requested and canonical IDs.
- **English Locale Forcing**: Requests listings with `locale=en_US&siteid=1` and English language headers to ensure reliable extraction.
- **Multi-Unit Hierarchy Pruning**: Ignores child rental unit rules to protect property-level badges from incorrect restrictions.
- **Default Search Badging**: Enables search result badges by default on extension installation.

---

## [v1.1.0] - 2026-08-18

### Search Page Badges and Tooltips
- **Search Card Badges**: Shows pet policy badges on Vrbo search result cards. Examples: `Max 1 dog allowed`, `Max 2 dogs allowed`, `Dogs allowed`, `Pets not allowed`, and `Pet restrictions`.
- **Accessible Tooltip Dialog**: Opens a floating summary dialog when you focus a badge. Follows WCAG 2.1 AA rules with a focus trap and `Escape` key close.
- **Fast Apollo Data Search**: Reads existing property data from the search page cache before starting network requests.
- **Controlled Request Queue**: Limits background requests to 2 parallel tasks with a 400 ms delay. Starts requests only after a card stays visible for 400 ms.
- **Rate-Limit Protection**: Pauses requests for 30 seconds if Vrbo returns a 429 status code or a bot challenge.
- **Local Storage Cache**: Saves extracted policies in local browser storage for 24 hours. Cleans expired and corrupt data on startup and every 24 hours.

### Policy Extraction and Sources
- **Tiered Pet Fee Support**: Reads tiered pricing rules (for example, "First dog free, each next dog is $25"). Shows correct fees on search badges, tooltips, and listing cards.
- **Dog Limit Extraction**: Correctly finds dog limits in sentences that also describe extra fees.
- **Section Sources**: Identifies the exact page section for each rule (*House Rules*, *About this property*, *Amenities*, or *Reviews*).
- **Combined Source Label**: Shows combined labels (such as `Source: listing data + review`) when rules come from multiple areas.

### Theme and Colors
- **Semantic CSS Tokens**: Uses shared design tokens across the listing card, search badge, search tooltip, and popup.
- **Dark Mode and High Contrast**: Follows operating system theme settings and supports Windows high contrast mode. All text meets WCAG AA contrast rules.

---

## [v1.0.1] - 2026-08-17

### Rebranding
- Changed the extension name to **Vrbow**.
- Added new custom icons in three sizes (`16x16`, `48x48`, and `128x128`).
- Updated the toolbar popup title and header to **🐾 Vrbow**.

### Permissions and Scope
- Restricted `host_permissions` and `content_scripts` to `*://*.vrbo.com/*`.
- Removed unsupported regional domains to keep the extension small and focused.

### Bug Fixes and Stability
- **Listing URL Verification**: The extension now runs only on valid property listing pages. It suppresses UI injection on the homepage, search pages, and account pages.
- **SPA Stale Data Fix**: Locked Apollo GraphQL extraction to the active property ID (`PropertyInfo:<currentListingId>`). This prevents showing data from a previous listing after page navigation.
- **Fast Polling on Navigation**: Starts fast polling when URL navigation occurs to capture new GraphQL payloads quickly.
- **Observer Isolation**: Attached the `MutationObserver` to `document.body`. This survives SPA `<main>` element replacements and prevents feedback loops from the summary card.

### Documentation
- Added the [MIT License](LICENSE).
- Applied ASD-STE100 rules to all documentation files.
- Published a clear [`PRIVACY.md`](PRIVACY.md) file.

---

## [v1.0.0] - 2026-08-17

### Initial Release
- **Automatic Summary Card**: Shows dog limits, weight limits, pet fees, deposits, and approval requirements on Vrbo listings.
- **Dual Data Extraction**: Reads structured GraphQL data from the page with fallback to visible page text.
- **Source Links**: Clickable links jump to and highlight original text on the page.
- **Contradiction Alerts**: Flags conflicting rules written in different sections of the same listing.
- **Extra Notes Drawer**: Collects additional pet sentences (such as breed limits or leash rules).
- **Local Operation**: Operates 100% locally with zero tracking and zero external network requests.
