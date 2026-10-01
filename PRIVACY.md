Privacy Policy for Letterboxd Unfollower Toolkit
Effective Date: December 18, 2025

1. Introduction
Letterboxd Unfollower Toolkit ("we," "our," or "the extension") is committed to protecting your privacy. This Privacy Policy explains how we handle information when you use our browser extension.

2. Information Collection and Use
We believe in absolute privacy. The extension functions as follows:

No Personal Data Collection: We do not collect, store, or transmit any personally identifiable information (PII) to external servers.

Local Processing: All analysis (comparing followers and following lists) is performed locally on your device within your browser.

Authentication: The extension does not require your Letterboxd password. It only accesses publicly available profile information to perform its core function. Requests to Letterboxd are sent without your cookies.

Avatars: If "Show avatars" is on (the default), the popup loads member avatar images directly from Letterboxd's own image servers (letterboxd.com and ltrbxd.com addresses only), without sending a referrer. This is the only traffic that is not a page request, it goes to the same company as everything else, and it can be switched off in Settings.

Active tab: When the popup opens, the address of the active tab is read once to pre-fill the username box if you are on a Letterboxd profile. It is not stored or sent anywhere.

3. Permissions Justification
To provide its functionality, the extension requires the following permissions:

storage: Used to store, locally, the results of your last scan, your username, the progress of a scan that is still running, a saved copy of the follower and following lists of up to five scanned accounts (to show who followed or unfollowed you between scans), the resulting change log, and the names you chose to hide from a list.

alarms: Used to wake the extension's background worker when a scan has to pause (for example to stay within Letterboxd's rate limits) so that the scan can continue without keeping the popup open, and, only if you turn it on, to run the optional once-a-day background check.

notifications (optional, requested only when you tick "Also show a notification when someone unfollows" in Settings): Used to show a local notification when the background check finds people who unfollowed you. Without it only the number on the toolbar icon is shown.

Host Permissions (https://letterboxd.com/*): Necessary to fetch follower/following data directly from the Letterboxd website, to read the address of an active Letterboxd tab, and to run the optional page badges below.

Letterboxd pages (content script): A small script is loaded on letterboxd.com pages. It does nothing unless you turn on "Mark people who don't follow me back on Letterboxd pages" in Settings. When on, it reads only the extension's own local storage (your settings and the list of people who don't follow you back) and adds a label next to those members. To find the right members it looks at the profile links of the member lists on the page and compares them with that local list. It sends nothing anywhere.

Optional features (all off by default): the once-a-day background check, notifications and the page badges. The background check makes the same kind of requests to Letterboxd as a manual scan (usually only a few, because it only reads what changed) and only runs while the browser is open.

4. Data Storage
Any data saved by the extension (such as the lists from your last scan, the partial progress of a running scan, the saved snapshots and change log, the display names and avatar addresses of members you have scanned, the list used for the page badges, the outcome of the last background check, your hidden names and your settings) is stored using chrome.storage.local. This data stays on your machine and is never uploaded to any cloud service or third party.

"New Search" and "Cancel Scan" discard the current result or running scan. The saved snapshots, change log, hidden names, member display names/avatar addresses and page-badge list are kept so that later scans can be compared with earlier ones; you can delete them at any time with the "Clear saved history" button (your settings are kept), and removing the extension deletes everything. Files you export (.txt, .csv, .json) are created in your browser and saved by you; the extension does not upload them.

5. Third-Party Disclosure
We do not sell, trade, or otherwise transfer your information to outside parties. Since we do not collect any data, there is no data to share.

6. Changes to This Policy
We may update our Privacy Policy from time to time. Any changes will be posted on this page with an updated effective date.

7. Contact Us
If you have any questions about this Privacy Policy, you can reach out via our official support channels or the GitHub repository.