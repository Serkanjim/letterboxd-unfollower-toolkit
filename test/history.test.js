import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HISTORY_ENTRIES, MAX_NAMES_PER_ENTRY, MAX_TRACKED_ACCOUNTS, trackScan } from '../lib/history.js';

const scan = (overrides = {}) => ({
    owner: 'Me',
    followers: ['a', 'b', 'c'],
    following: ['a', 'b', 'x'],
    verified: true,
    now: 1000,
    ...overrides
});

test('the first verified scan becomes the baseline without any history', () => {
    const out = trackScan(scan());
    assert.deepEqual(out.tracking, { status: 'first', previousAt: null, gained: 0, lost: 0 });
    assert.deepEqual(out.snapshots.me, { username: 'Me', at: 1000, followers: ['a', 'b', 'c'], following: ['a', 'b', 'x'] });
    assert.deepEqual(out.history, {});
    assert.equal(out.changed, true);
});

test('a later scan records who left and who arrived, and flags the ones you follow', () => {
    const first = trackScan(scan());
    const out = trackScan(scan({
        followers: ['a', 'c', 'new1'],        // b left, new1 arrived
        following: ['a', 'b', 'x'],           // you still follow b
        now: 2000,
        snapshots: first.snapshots,
        history: first.history
    }));

    assert.deepEqual(out.tracking, { status: 'ok', previousAt: 1000, gained: 1, lost: 1 });
    assert.deepEqual(out.history.me, [{
        at: 2000, previousAt: 1000, gainedCount: 1, lostCount: 1,
        gained: ['new1'], lost: ['b'], lostYouFollow: ['b']
    }]);
    assert.equal(out.snapshots.me.at, 2000);
    assert.deepEqual(out.snapshots.me.followers, ['a', 'c', 'new1']);
});

test('lostYouFollow only contains people you actually follow', () => {
    const first = trackScan(scan({ followers: ['a', 'b'], following: ['a'] }));
    const out = trackScan(scan({ followers: ['a'], following: ['a'], now: 2000, snapshots: first.snapshots }));
    assert.deepEqual(out.history.me[0].lost, ['b']);
    assert.deepEqual(out.history.me[0].lostYouFollow, []);
});

test('an unchanged scan refreshes the baseline but adds no history entry', () => {
    const first = trackScan(scan());
    const out = trackScan(scan({ now: 2000, snapshots: first.snapshots, history: first.history }));
    assert.deepEqual(out.tracking, { status: 'ok', previousAt: 1000, gained: 0, lost: 0 });
    assert.deepEqual(out.history, {});
    assert.equal(out.snapshots.me.at, 2000);
});

test('an unverified scan is neither compared nor saved', () => {
    const first = trackScan(scan());
    const truncated = scan({ followers: ['a'], verified: false, now: 2000, snapshots: first.snapshots, history: first.history });
    const out = trackScan(truncated);

    assert.deepEqual(out.tracking, { status: 'skipped', previousAt: 1000, gained: 0, lost: 0 });
    assert.equal(out.changed, false);
    assert.equal(out.snapshots, first.snapshots);       // untouched, same object
    assert.equal(out.history, first.history);
});

test('an unverified first scan saves nothing', () => {
    const out = trackScan(scan({ verified: false }));
    assert.equal(out.tracking.status, 'skipped');
    assert.equal(out.tracking.previousAt, null);
    assert.deepEqual(out.snapshots, {});
});

test('names per entry are capped but the counts stay exact', () => {
    const many = Array.from({ length: MAX_NAMES_PER_ENTRY + 50 }, (_, i) => `u${i}`);
    const first = trackScan(scan({ followers: many, following: many }));
    const out = trackScan(scan({ followers: [], following: many, now: 2000, snapshots: first.snapshots }));

    const entry = out.history.me[0];
    assert.equal(entry.lostCount, many.length);
    assert.equal(entry.lost.length, MAX_NAMES_PER_ENTRY);
    assert.equal(entry.lostYouFollow.length, MAX_NAMES_PER_ENTRY);
});

test('the change log keeps only the most recent entries', () => {
    let state = trackScan(scan({ followers: [], following: [] }));
    for (let i = 1; i <= MAX_HISTORY_ENTRIES + 5; i++) {
        state = trackScan(scan({
            followers: [`f${i}`], following: [], now: 1000 + i, snapshots: state.snapshots, history: state.history
        }));
    }
    assert.equal(state.history.me.length, MAX_HISTORY_ENTRIES);
    assert.equal(state.history.me[0].at, 1000 + MAX_HISTORY_ENTRIES + 5);     // newest first
});

test('only the most recently scanned accounts are tracked', () => {
    let state = { snapshots: {}, history: {} };
    for (let i = 0; i < MAX_TRACKED_ACCOUNTS + 2; i++) {
        state = trackScan(scan({ owner: `acc${i}`, now: 1000 + i, ...state }));
        // give every account a history entry so we can see it get evicted too
        state = trackScan(scan({ owner: `acc${i}`, followers: ['z'], now: 5000 + i, ...state }));
    }

    const kept = Object.keys(state.snapshots).sort();
    assert.equal(kept.length, MAX_TRACKED_ACCOUNTS);
    assert.deepEqual(kept, ['acc2', 'acc3', 'acc4', 'acc5', 'acc6']);
    assert.deepEqual(Object.keys(state.history).sort(), kept);
});

test('trackScan does not mutate its inputs', () => {
    const first = trackScan(scan());
    const frozen = structuredClone(first);
    trackScan(scan({ followers: ['z'], now: 2000, snapshots: first.snapshots, history: first.history }));
    assert.deepEqual(first, frozen);
});
