# Privacy Policy for Vrbow

**Last updated:** August 17, 2026

**Vrbow** protects your privacy. This policy describes how the extension handles user data.

---

### 1. Data Collection and Transmission
- **No Remote Data Transmission**: Vrbow does not transmit any browsing activity, personal data, user credentials, booking details, or analytics to the developer or any third-party server.
- **Local Storage Cache**: To avoid repeated network requests when you browse search results, the extension caches parsed pet-policy records locally in your browser (`chrome.storage.local`), keyed by property ID, for up to 24 hours. This data remains strictly local on your device.
- **Direct First-Party Network Requests**: When search badging is active, the extension fetches public property pages directly from `vrbo.com` using your browser's session.

---

### 2. Browser Permissions
The extension requests three permissions to perform its core functions:
- **`host_permissions` (`*://*.vrbo.com/*`)**: Reads public listing content on `vrbo.com` to extract pet policy rules on listing pages and search result cards.
- **`storage`**: Stores parsed listing pet policy summaries locally on your device for up to 24 hours. The extension never transmits or shares this cached data.
- **`activeTab`**: Connects the toolbar popup to the active Vrbo tab when you click the extension icon or trigger a rescan.

---

### 3. Third-Party Data Sharing
Vrbow does not sell, transfer, or share data with third parties.

---

### 4. Open Source and Support
Vrbow is an open-source project. You can inspect the source code at:  
[https://github.com/curdriceaurora/vrbow](https://github.com/curdriceaurora/vrbow)

If you have questions about this policy, open an issue on the GitHub repository.
