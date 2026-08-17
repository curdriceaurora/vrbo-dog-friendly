# Release Notes (Changelog)

All notable changes to **Vrbow** are documented in this file.

---

## [v1.0.1] - 2026-08-17

### 🐾 Rebranding & UI
- Rebranded extension to **Vrbow**.
- Integrated new custom high-resolution icon set (`16x16`, `48x48`, `128x128`).
- Updated popup toolbar title and header to **🐾 Vrbow**.

### 🔒 Permissions & Scope
- Narrowed `host_permissions` and `content_scripts` strictly to `*://*.vrbo.com/*` for minimal privilege and fast review.
- Removed non-core regional domains to maintain a clean, single-purpose footprint.

### 🐛 Bug Fixes & Reliability
- **Strict Listing Filtering**: Enforced route-level regex matching so the extension executes only on actual listing pages (`/<id>`, `/pdp/lo/<id>`, `/vacation-rentals/p/<id>`). Suppresses panel injection and popup queries on the homepage, search pages, and account pages.
- **SPA Cross-Listing Bleed Prevention**: In `page-bridge.js`, Apollo GraphQL extraction is now locked to `PropertyInfo:<currentListingId>`. If listing B is loading in the same tab, stale cached data from listing A is never displayed.
- **Client-Side Fast Polling**: Automatically resets and starts fast polling whenever SPA navigation occurs so slow-mounting GraphQL payloads are captured immediately.
- **Permanent Observer Attachment**: Attached `MutationObserver` directly to `document.documentElement` so it survives client-side router `<main>` DOM swaps without detachment.

### 📄 Documentation & Licensing
- Added standard permissive [MIT License](LICENSE).
- Formatted `README.md` in Simplified Technical English (ASD-STE100).
- Published transparent [`PRIVACY.md`](PRIVACY.md) detailing local storage usage.

---

## [v1.0.0] - 2026-08-17

### 🚀 Initial Release
- **Automatic Dog Policy Callout**: Surfaces dog limits, per-dog weight caps, pet fees, refundable deposits, and pre-registration requirements on Vrbo listing pages in an always-visible card.
- **Dual-Layer Extraction**: Reads structured `__APOLLO_STATE__` GraphQL data from the page world on load, falling back to visible DOM text when necessary.
- **One-Click Source Highlighting**: Clickable `source` links that scroll directly to and highlight the originating sentence in House Rules or property description.
- **Contradiction Alerts (⚠️)**: Detects and flags conflicting host rules stated in different sections (e.g. 50 lbs in House Rules vs 75 lbs in About this property).
- **Expandable Notes Drawer**: Collects extra guidelines (leash rules, crate requirements, breed restrictions) so no details are missed.
- **Zero Tracking**: 100% local operation with zero telemetry, zero analytics, and zero external network requests.
