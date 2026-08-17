# Release Notes

This document records all changes to **Vrbow**.

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
