# Vrbow: Vrbo Dog Policy Callout

A Chrome extension that extracts pet policies from Vrbo listings and shows them in an always-visible summary card.

<img src="docs/panel-dog-friendly.png" alt="Callout showing max dogs 2, weight limit 50 lbs, pre-registration required" width="420">

## Problem

Vrbo property listings do not display dog rules in one standard location.
Hosts write pet rules across different sections:
- House Rules
- Amenities
- "About this property" description

Important pet policy details are frequently hidden behind collapsed sections or "See more" buttons.
Hosts also write conflicting pet rules across different sections of the same listing.

## Need

Travelers with dogs must verify pet policies before they book a property.
Users need to quickly identify:
- If pets are permitted
- Maximum number of allowed dogs
- Weight limits per dog
- Required pet fees and refundable deposits
- Pre-registration or prior approval requirements

Manual review of every section on multiple listings takes time and causes missed restrictions.

## How This Extension Helps

This extension automatically reads listing data when the page loads.
It displays a single summary card with all extracted pet policy details.

- **Immediate Visibility**: Shows the complete pet policy instantly without manual scrolling or menu expansion.
- **Structured Fields**: Converts raw text into clear fields for dog count, weight limit, fees, and approval requirements.
- **Source Verification**: Provides a clickable **source** link next to each value that scrolls to and highlights the exact sentence on the page.
- **Contradiction Alerts**: Flags discrepancies when rules in one section disagree with rules in another section.
- **Comprehensive Notes**: Collects all remaining pet-related sentences (such as breed restrictions or leash rules) into an expandable notes section.
- **Local Operation**: Operates locally in your browser with zero external network requests.

<img src="docs/panel-not-allowed.png" alt="Callout showing pets not allowed policy" width="420">

---

## Installation

1. Download **`vrbow-v1.0.1.zip`** from [Releases](https://github.com/curdriceaurora/vrbo-dog-friendly/releases).
2. Unzip the file into a folder on your computer.
3. Open `chrome://extensions` in your browser (Chrome 111+, Brave, Edge, or Arc).
4. Turn on **Developer mode** using the toggle in the top-right corner.
5. Click **Load unpacked** (top-left) and select the unzipped folder.

---

## How to Use

### 1. Automatic On-Page Card
Whenever you visit a listing page on `vrbo.com`, the policy card automatically loads in the bottom-right corner:

![The callout appearing automatically as a Vrbo listing loads](docs/demo.gif)

- **Source verification**: Click the **source** link next to any extracted value (dog limit, weight, fee, deposit) to automatically jump to and highlight the exact sentence in the listing where that value was found.
- **Other pet notes**: Click **Other pet notes** to expand raw sentences containing extra guidelines (such as leash rules, crate requirements, or breed restrictions).
- **Contradiction alerts (⚠️)**: If the host wrote conflicting rules in different sections (e.g. 50 lbs in House Rules vs 75 lbs in About this property), the card alerts you and shows both sources.
- **Collapse / Minimize**: Click the card header to collapse it to a compact bar, or click **×** to dismiss it.
- **↻ Rescan**: Click the refresh icon to re-run extraction if a listing was slow to load.
- **Source indicator**: The footer displays whether the data came from the listing's structured data or visible page text fallback.

### 2. Browser Toolbar Popup
- Pin the extension icon to your Chrome toolbar.
- Clicking the extension icon on any active Vrbo listing opens a quick popup summary with the same dog policy details.
