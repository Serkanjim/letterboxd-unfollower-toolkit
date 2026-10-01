// User settings, stored under "prefs" in chrome.storage.local by the popup and read by the background
// worker (daily check) and the content script (page badges). Anything missing or malformed falls back to
// the default, and everything that touches a third party or runs without the popup open is OFF by default.

import { isValidUsername } from './parser.js';

export const SORTS = ['site', 'name'];

export const DEFAULT_PREFS = {
    sort: 'site',               // list order: Letterboxd's own order, or by name
    avatars: true,              // show avatars next to names (loaded from Letterboxd's image hosts)
    pageBadges: false,          // mark people who do not follow back on Letterboxd pages
    daily: {
        enabled: false,         // check once a day in the background
        username: null,         // the account to check
        notify: false           // also show a notification (needs the optional "notifications" permission)
    }
};

export function normalizePrefs(raw) {
    const prefs = raw && typeof raw === 'object' ? raw : {};
    const daily = prefs.daily && typeof prefs.daily === 'object' ? prefs.daily : {};
    const username = isValidUsername(daily.username) ? daily.username : null;

    return {
        sort: SORTS.includes(prefs.sort) ? prefs.sort : DEFAULT_PREFS.sort,
        avatars: typeof prefs.avatars === 'boolean' ? prefs.avatars : DEFAULT_PREFS.avatars,
        pageBadges: prefs.pageBadges === true,
        daily: {
            enabled: daily.enabled === true && username !== null,
            username,
            notify: daily.notify === true
        }
    };
}
