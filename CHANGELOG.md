# Release Notes

This document records all changes to **Vrbow**.

## [v1.2.0] - 2026-08-18

### Search Results Badging & Accessible Tooltips
- **Inline Card Badging**: Injects compact dog policy badges into property cards on Vrbo search pages (`Hotel-Search`, `/search`) with dynamic phrasing (`Max 1 dog allowed`, `Max 2 dogs allowed`, `Dogs allowed`, `Pets not allowed`, `Pet restrictions`).
- **Accessible Hover & Focus Tooltip**: Displays a floating policy summary dialog when you hover over or focus any search card badge. Fully accessible per WCAG 2.1 AA (`role="dialog"`, non-modal semantics, focus trap, and `Escape` dismiss).
- **Search-Page Apollo Fast Path**: Instantly resolves property cards directly from the search page's existing Apollo GraphQL cache (`PropertyInfo:<id>`) synchronously before issuing background requests.
- **Throttled Background Queue**: Enqueues visible search cards in viewport with controlled concurrency (maximum 2 requests, 400 ms safety delay) with 400 ms dwell debouncing.
- **Bot Challenge Protection**: Automatically pauses the fetch queue for 30 seconds if a 429 status or challenge is detected.
- **Persistent Local Cache & 24-Hour Maintenance**: Caches parsed policies in `chrome.storage.local` with strict schema serialization, plus automatic background maintenance sweeps on startup and every 24 hours.

### Policy Extraction & Attributions
- **Tiered Pet Fee Support**: Intelligently parses tiered pricing models (e.g. *"First dog free, each subsequent dog is $25"*), correctly distinguishing allowance from fixed limits and rendering tiered fee structures accurately across search badges, tooltips, and listing panels.
- **Multi-Clause Max Dogs Parsing**: Preserves legitimate maximum dog limits in sentences containing additional/extra pet rules (e.g. *"We allow up to 2 dogs; each additional dog is $25 per night"*).
- **Granular Section Attribution**: Notes and callout sources now identify specific Vrbo listing sections (*House Rules / Policies*, *About this property*, *Property amenities*, *Guest reviews*).
- **Mixed Source Attribution**: Distinguishes listing data, visible text, and guest review signals (e.g., *"Source: listing data + review"*).

### Theme & Design System
- **Unified Semantic Token Architecture**: Shared CSS variables across listing panel, search badge, search tooltip, and toolbar popup with 0 component-level color literals.
- **Automatic Dark Mode & High Contrast**: Follows operating system `prefers-color-scheme` dynamically and supports `@media (forced-colors: active)`. All text meets or exceeds WCAG AA contrast standards.

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
