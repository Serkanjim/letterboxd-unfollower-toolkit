// Scan-to-scan change tracking ("who unfollowed me since last time").
//
// Per scanned account we keep one baseline snapshot (the follower and following lists of the last
// *verified* scan) plus a short log of what changed between consecutive scans. A scan that could not
// be verified never becomes a baseline and is never compared: missing pages would otherwise show up
// as people who "unfollowed" you.
//
//   snapshots[lowercase username] = { username, at, followers: [...], following: [...],
//                                     streams: { followers|following: { profileCount, fullAt, quickRuns } } }
//   (the lists keep Letterboxd's own order; see lib/incremental.js)
//   history[lowercase username]   = [ { at, previousAt, gainedCount, lostCount, gained, lost, lostYouFollow }, ... ]

import { diffFollowers, nameKey } from './lists.js';

export const MAX_TRACKED_ACCOUNTS = 5;
export const MAX_HISTORY_ENTRIES = 30;
export const MAX_NAMES_PER_ENTRY = 200;

// tracking.status
//   'first'    no earlier baseline: this scan became the baseline
//   'ok'       compared with the previous baseline (gained / lost are the counts)
//   'skipped'  scan not verified, so nothing was compared and nothing was saved
//   'unavailable'  set by the engine when the browser refused to store the history
export function trackScan({ owner, followers, following, verified, streamsMeta = null, snapshots = {}, history = {}, now }) {
    const key = nameKey(owner);
    const previous = snapshots[key] ?? null;
    const tracking = { status: 'skipped', previousAt: previous?.at ?? null, gained: 0, lost: 0 };

    if (!verified) return { tracking, snapshots, history, changed: false };

    const snapshot = { username: owner, at: now, followers, following };
    if (streamsMeta) snapshot.streams = streamsMeta;       // lets the next scan be incremental
    const nextSnapshots = { ...snapshots, [key]: snapshot };
    let nextHistory = history;

    if (!previous) {
        tracking.status = 'first';
    } else {
        const { gained, lost } = diffFollowers(previous.followers, followers);
        const followingKeys = new Set(following.map(nameKey));

        tracking.status = 'ok';
        tracking.gained = gained.length;
        tracking.lost = lost.length;

        if (gained.length > 0 || lost.length > 0) {
            const entry = {
                at: now,
                previousAt: previous.at,
                gainedCount: gained.length,
                lostCount: lost.length,
                gained: gained.slice(0, MAX_NAMES_PER_ENTRY),
                lost: lost.slice(0, MAX_NAMES_PER_ENTRY),
                lostYouFollow: lost.filter(name => followingKeys.has(nameKey(name))).slice(0, MAX_NAMES_PER_ENTRY)
            };
            nextHistory = { ...history, [key]: [entry, ...(history[key] ?? [])].slice(0, MAX_HISTORY_ENTRIES) };
        }
    }

    // Bound the storage use: keep the most recently scanned accounts only.
    const keys = Object.keys(nextSnapshots);
    if (keys.length > MAX_TRACKED_ACCOUNTS) {
        const evict = keys
            .filter(other => other !== key)
            .sort((a, b) => nextSnapshots[a].at - nextSnapshots[b].at)
            .slice(0, keys.length - MAX_TRACKED_ACCOUNTS);
        if (nextHistory === history) nextHistory = { ...history };
        for (const other of evict) {
            delete nextSnapshots[other];
            delete nextHistory[other];
        }
    }

    return { tracking, snapshots: nextSnapshots, history: nextHistory, changed: true };
}
