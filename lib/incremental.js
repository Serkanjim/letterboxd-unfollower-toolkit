// Incremental ("quick") scans.
//
// Letterboxd lists followers and following ordered by "When Followed", so people you gained since the
// last scan sit at the head of the list while the rest keeps its order. If the last scan saved the list
// and the profile count, a rescan only has to prove that
//
//     new list == (D new names)  +  (old list)        where D = new profile count - old profile count
//
// by reading the head of the list and its last page, instead of every page. The proof is strict:
//   - D < 0 means somebody left. We cannot tell who without reading everything, so: full scan.
//   - the 25 names right after the D new ones must equal the first 25 names of the old list, and
//   - the last page must equal the tail of the old list.
// Any mismatch (a removal, an add+remove that cancel out in the count, a different sort order ...)
// falls back to the normal full scan, so a quick scan is never less correct than a full one.
// Because a tiny undetected drift is still conceivable, quick scans are limited in age and number.

import { nameKey } from './lists.js';
import { PAGE_SIZE } from './scan.js';

export const QUICK_MIN_OLD_PAGES = 4;               // smaller lists are cheap to read in full
export const QUICK_MAX_NEW = 150;                   // more new names than this: just read everything
export const QUICK_MAX_AGE_MS = 14 * 24 * 3600_000; // force a full read at least every two weeks ...
export const QUICK_MAX_RUNS = 10;                   // ... or after this many quick scans in a row

export function sameNames(a, b) {
    return a.length === b.length && a.every((name, i) => nameKey(name) === nameKey(b[i]));
}

// Decides whether one list (type = 'followers' | 'following') can be updated incrementally and, if so,
// returns everything the scan needs to know. `baseline` is the saved snapshot of the account,
// `expected` the profile count read at the start of this scan ({ value, exact } or null).
export function planQuick({ baseline, type, expected, now, full = false }) {
    if (full) return null;

    const list = baseline?.[type];
    const meta = baseline?.streams?.[type];
    if (!Array.isArray(list) || !meta || meta.profileCount == null) return null;
    if (!expected?.exact) return null;
    if (list.length < QUICK_MIN_OLD_PAGES * PAGE_SIZE) return null;
    if (now - meta.fullAt > QUICK_MAX_AGE_MS || meta.quickRuns >= QUICK_MAX_RUNS) return null;

    const delta = expected.value - meta.profileCount;
    if (delta < 0 || delta > QUICK_MAX_NEW) return null;

    // Where the last page of the new list falls inside the old list.
    const total = delta + list.length;
    const tailPage = Math.ceil(total / PAGE_SIZE);
    const tailStart = (tailPage - 1) * PAGE_SIZE - delta;

    return {
        delta,
        head: list.slice(0, PAGE_SIZE),
        tail: { page: tailPage, names: list.slice(tailStart) }
    };
}

// `names` are all members read so far, in page order.
//   'more' - not enough read yet to compare
//   'ok'   - the first `delta` names are new and the old list follows; `gained` are those names
//   'fail' - the old list does not follow, so something other than new follows happened
export function headCheck(plan, names) {
    if (names.length < plan.delta + plan.head.length) return { status: 'more' };
    const overlap = names.slice(plan.delta, plan.delta + plan.head.length);
    return sameNames(overlap, plan.head)
        ? { status: 'ok', gained: names.slice(0, plan.delta) }
        : { status: 'fail' };
}

// The list as it is now: the new names followed by everything we already knew.
export function mergeQuick(gained, oldList) {
    return [...gained, ...oldList];
}
