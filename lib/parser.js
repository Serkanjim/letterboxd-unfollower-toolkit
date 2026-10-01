// Pure parsing helpers shared by the service worker, the popup and the tests.
// Nothing in here touches the DOM or the chrome.* APIs.

const USERNAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Top-level Letterboxd paths that can never be a member's profile.
// Only used to reject pasted URLs such as letterboxd.com/film/heat/.
const RESERVED_PATHS = new Set([
    'film', 'films', 'list', 'lists', 'members', 'journal', 'search', 'settings',
    'activity', 'reviews', 'actor', 'director', 'writer', 'studio', 'genre',
    'year', 'decade', 'pro', 'about', 'apps', 'api', 'welcome', 'sign-in'
]);

export function isValidUsername(name) {
    return typeof name === 'string' && USERNAME_RE.test(name);
}

// Accepts "name", "@name", "letterboxd.com/name" and full profile URLs
// (including /name/following/ etc.). Returns null if nothing usable is found.
export function normalizeUsername(input) {
    if (typeof input !== 'string') return null;

    let name = input.trim();
    const urlMatch = name.match(/^(?:https?:\/\/)?(?:www\.)?letterboxd\.com\/([^/?#\s]+)/i);
    if (urlMatch) {
        name = urlMatch[1];
        if (RESERVED_PATHS.has(name.toLowerCase())) return null;
    }
    name = name.replace(/^@/, '');

    return isValidUsername(name) ? name : null;
}

// Extracts the username from "/name/" or "https://letterboxd.com/name/".
// Anything else (extra path segments, other hosts, markup) is rejected.
export function usernameFromHref(href) {
    if (typeof href !== 'string') return null;
    const path = href.replace(/^https?:\/\/(?:www\.)?letterboxd\.com(?=\/)/i, '');
    const match = path.match(/^\/([^/]+)\/?$/);
    return match && isValidUsername(match[1]) ? match[1] : null;
}

// <a ...> start tags. Quoted attribute values may contain ">".
const A_TAG_RE = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttributes(source) {
    const attrs = {};
    let match;
    ATTR_RE.lastIndex = 0;
    while ((match = ATTR_RE.exec(source)) !== null) {
        attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return attrs;
}

// Usernames listed on a followers/following page, in page order, without duplicates.
// Matches <a class="... name ..." href="/user/"> regardless of attribute order or extra classes.
export function parseMembers(html) {
    const users = [];
    const seen = new Set();
    const tagRe = new RegExp(A_TAG_RE.source, 'gi');

    let match;
    while ((match = tagRe.exec(html)) !== null) {
        const attrs = parseAttributes(match[1]);
        if (!(attrs.class || '').split(/\s+/).includes('name')) continue;

        const username = usernameFromHref(attrs.href);
        if (!username || seen.has(username.toLowerCase())) continue;

        seen.add(username.toLowerCase());
        users.push(username);
    }
    return users;
}

// "1,234" -> exact 1234, "12k" / "1.2M" -> approximate. Returns null if there is no number.
function parseCount(text) {
    const match = text.match(/(\d[\d,.\s ]*)\s*([kKmM])?(?![\w])/);
    if (!match) return null;

    const raw = match[1].trim();
    const suffix = match[2] ? match[2].toLowerCase() : null;
    const grouped = /^\d{1,3}(?:[,.\s ]\d{3})+$/.test(raw);

    if (suffix) {
        const value = parseFloat(raw.replace(/,/g, '.').replace(/\s/g, ''));
        if (Number.isNaN(value)) return null;
        return { value: Math.round(value * (suffix === 'k' ? 1e3 : 1e6)), exact: false };
    }

    const digits = grouped ? raw.replace(/[,.\s ]/g, '') : raw.match(/^\d+/)[0];
    return { value: parseInt(digits, 10), exact: true };
}

// Follower / following totals shown on a profile page.
// Each entry is { value, exact } or null when it could not be read.
// Only the anchor pointing at /<username>/followers/ (or /following/) is inspected,
// so digits elsewhere in the markup cannot be mistaken for the count.
export function parseProfileCounts(html, username) {
    const wanted = {
        followers: `/${username}/followers/`.toLowerCase(),
        following: `/${username}/following/`.toLowerCase()
    };
    const counts = { followers: null, following: null };
    const anchorRe = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = anchorRe.exec(html)) !== null) {
        const href = (parseAttributes(match[1]).href || '')
            .replace(/^https?:\/\/(?:www\.)?letterboxd\.com(?=\/)/i, '')
            .toLowerCase();

        for (const type of ['followers', 'following']) {
            if (counts[type] || href !== wanted[type]) continue;
            const text = match[2].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
            counts[type] = parseCount(text);
        }
    }
    return counts;
}

// A 200 response that is really a bot-protection interstitial, not Letterboxd content.
export function looksBlocked(html) {
    return /<title>\s*(?:Just a moment|Attention Required|Access denied)/i.test(html)
        || /cf-browser-verification|challenge-platform/i.test(html);
}
