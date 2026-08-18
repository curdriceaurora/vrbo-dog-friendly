# Release Notes

This document records all changes to **Vrbow**.

## [v1.1.0] - 2026-08-18

### Search Page Badges and Tooltips
- **Search Card Badges**: Shows pet policy badges on Vrbo search result cards. Examples: `Max 1 dog allowed`, `Max 2 dogs allowed`, `Dogs allowed`, `Pets not allowed`, and `Pet restrictions`.
- **Accessible Tooltip Dialog**: Opens a floating summary dialog when you hover over or focus a badge. Follows WCAG 2.1 AA rules with a focus trap and `Escape` key close.
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
