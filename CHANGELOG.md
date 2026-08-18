# Release Notes

This document records all changes to **Vrbow**.

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
