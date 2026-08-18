<p align="center">
  <img src="icons/icon128.png" alt="Vrbow Icon" width="96" height="96">
</p>

# <p align="center">Vrbow: Vrbo Dog Policy Callout</p>

<p align="center">
  <strong>A Chrome extension that extracts pet rules from Vrbo listings and shows them in a summary card.</strong>
</p>

<p align="center">
  <img src="docs/panel-dog-friendly.png" alt="Callout showing max dogs 2, weight limit 50 lbs, pre-registration required" width="420">
</p>

## Problem

Vrbo property listings do not show dog rules in one standard location.
Hosts write pet rules across different sections:
- House Rules
- Amenities
- Property description ("About this property")

Important pet rules are often hidden behind collapsed menus or "See more" buttons.
Hosts can also write conflicting pet rules in different sections of the same listing.

## Need

Travelers with dogs must verify pet rules before they book a property.
Users need to quickly find:
- If pets are allowed
- Maximum number of allowed dogs
- Weight limits per dog
- Required pet fees and deposits
- Pre-registration or prior approval requirements

Reading every section on multiple listings takes time and causes missed restrictions.

## Solution

This extension automatically reads listing data when the page loads.
It shows a single summary card with all extracted pet policy details.

- **Immediate Visibility**: Shows the pet policy without manual scrolling or menu clicks.
- **Structured Fields**: Converts text into clear fields for dog count, weight limit, fees, and approval rules.
- **Source Verification**: Provides a clickable **source** link that jumps to and highlights the text on the page.
- **Contradiction Alerts**: Alerts you when rules in one section disagree with rules in another section.
- **Extra Notes**: Collects all other pet sentences (such as leash rules or breed limits) in an expandable drawer.
- **Automatic Theme**: Uses a light or dark theme that follows your operating system preference.
- **Local Operation**: Runs directly inside your browser. The extension does not send personal data or telemetry to external services.
- **Search Badges & Tooltips**: Shows pet policy badges and hover summary dialogs directly on search result cards.

<p align="center">
  <img src="docs/panel-not-allowed.png" alt="Callout showing pets not allowed policy" width="420">
</p>

---

## Installation

1. Download **`vrbow-v1.1.0.zip`** from [Releases](https://github.com/curdriceaurora/vrbow/releases).
2. Unzip the file into a folder on your computer.
3. Open `chrome://extensions` in your browser.
4. Turn on **Developer mode** in the top-right corner.
5. Click **Load unpacked** in the top-left corner.
6. Select the unzipped folder.

---

## How to Use

### 1. Search Results Badging & Hover Tooltips
When you browse search results on `vrbo.com`:
- **Inline Badges**: The extension shows a compact badge on each search card (such as `🐾 Max 2 dogs allowed · 50 lbs · $150/stay`, `🐾 Dogs allowed · 1st free · $25/add'l/stay`, or `🚫 Pets not allowed`).
- **Hover Tooltip**: Hover over any badge or focus it with your keyboard to open a floating summary dialog with detailed pet rules.
- **Controlled Retrieval**: The extension fetches listing details with a controlled queue (maximum 2 requests, 400 ms safety delay) to prevent rate limits.
- **Fast Path & 24-Hour Cache**: Reads search-page data immediately when available and saves extracted policies in browser storage for 24 hours.

### 2. Automatic On-Page Card
When you visit a listing on `vrbo.com`, the policy card opens in the bottom-right corner:

![The callout appearing automatically as a Vrbo listing loads](docs/demo.gif)

- **Source verification**: Click the **source** link next to any value to highlight the original text on the page.
- **Other pet notes**: Click **Other pet notes** to read extra guidelines (such as leash rules or crate requirements).
- **Contradiction alerts (⚠️)**: The card alerts you if the host wrote conflicting rules in different sections.
- **Minimize / Close**: Click the header to collapse the card, or click **×** to remove it.
- **Rescan (↻)**: Click the refresh icon to re-run extraction if a listing loads slowly.
- **Data Source**: The footer shows if data came from structured listing data or visible page text.

### 3. Browser Toolbar Popup
- Pin the extension icon to your Chrome toolbar.
- Click the extension icon on any active Vrbo listing to view the dog policy summary.

---

## Scope and Alternatives

- **Vrbo Only**: This extension operates only on `vrbo.com` property listings. It does not run on Airbnb, Expedia, or other booking websites.
- **Search Alternative**: To search across properties with custom pet filters (such as dog weight, pet count, or fee limits), use [BringFido](https://www.bringfido.com).

## Development and Support

- **AI Vibecoded**: This project was built and vibecoded with AI.
- **As-Is Software**: The extension works as intended. The author provides no guarantee of ongoing support, updates, or maintenance.

---

- [Release Notes & Changelog](CHANGELOG.md)
- [Privacy Policy](PRIVACY.md)
- [License](LICENSE)

> **Note**: Vrbow is an independent open-source tool. It is not affiliated with or endorsed by Vrbo or Expedia Group. No support is guaranteed. Always verify the host's original house rules before you book a property.
