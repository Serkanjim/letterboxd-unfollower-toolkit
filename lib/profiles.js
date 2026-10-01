// Display names and avatars of the members we have seen, kept in one bounded map so lists can be
// shown with faces. Purely cosmetic: everything here may be missing without affecting a scan.
//
//   profiles['@' + lowercase username] = [displayName, avatarUrl]     ('' when unknown)
//
// The "@" prefix keeps member-chosen names such as "__proto__" away from special object keys and
// stops all-digit names from being reordered by JavaScript's integer-key rule.

export const MAX_PROFILES = 20_000;

export const profileKey = username => `@${username.toLowerCase()}`;

// Compact entries for the members on one page; members with nothing to show are left out.
export function profilesFromRows(rows) {
    const profiles = {};
    for (const { username, name, avatar } of rows) {
        const shownName = name && name.toLowerCase() !== username.toLowerCase() ? name : '';
        if (shownName || avatar) profiles[profileKey(username)] = [shownName, avatar ?? ''];
    }
    return profiles;
}

// Newest entries win and are moved to the end; the oldest are dropped beyond `max`.
export function mergeProfiles(existing = {}, incoming = {}, max = MAX_PROFILES) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
        delete merged[key];
        merged[key] = value;
    }
    const keys = Object.keys(merged);
    for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete merged[key];
    return merged;
}

export function profileOf(profiles, username) {
    const entry = profiles?.[profileKey(username)];
    return { name: entry?.[0] || null, avatar: entry?.[1] || null };
}
