import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COOLDOWN_MS, estimateSeconds, formatDuration, likelyDone, parseRetryAfter, planRetry, progressInfo,
    randomDelay, verificationWarning, verifyScan
} from '../lib/scan.js';

const exact = value => ({ value, exact: true });

test('parseRetryAfter handles seconds, dates and garbage', () => {
    assert.equal(parseRetryAfter('120'), 120_000);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter('soon'), null);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000);
});

test('planRetry honours Retry-After, escalates, and gives up', () => {
    assert.deepEqual(planRetry('ratelimit', 1, 30_000), { reason: 'ratelimit', waitMs: 30_000 });
    assert.equal(planRetry('ratelimit', 1).waitMs, COOLDOWN_MS);
    assert.equal(planRetry('ratelimit', 2, 30_000).waitMs, 45_000);
    assert.equal(planRetry('ratelimit', 1, 0).waitMs, 5_000);
    assert.equal(planRetry('ratelimit', 3, 600_000).waitMs, 900_000);   // capped at 15 min
    assert.equal(planRetry('ratelimit', 4), null);
    assert.equal(planRetry('blocked', 1).reason, 'ratelimit');
    assert.deepEqual(planRetry('network', 1), { reason: 'network', waitMs: 5_000 });
    assert.equal(planRetry('network', 5), null);
    assert.deepEqual(planRetry('server', 2), { reason: 'server', waitMs: 30_000 });
    assert.equal(planRetry('server', 4), null);
});

test('randomDelay stays within the polite window', () => {
    assert.equal(randomDelay(() => 0), 550);
    assert.ok(randomDelay(() => 0.999999) < 850);
});

test('verifyScan flags a shortfall but tolerates small drift', () => {
    const expected = { followers: exact(1000), following: exact(400) };
    assert.equal(verifyScan(expected, 1000, 400).ok, true);
    assert.equal(verifyScan(expected, 985, 400).ok, true);      // 1.5% drift
    assert.equal(verifyScan(expected, 1100, 400).ok, true);     // extra followers are fine
    assert.equal(verifyScan(expected, 750, 400).ok, false);     // one page of 25 x 10 missing
    assert.equal(verifyScan(expected, 1000, 400, true).ok, false);
});

test('verifyScan is inconclusive without readable profile counts', () => {
    assert.equal(verifyScan(null, 10, 10).ok, null);
    assert.equal(verifyScan({ followers: null, following: null }, 10, 10).ok, null);
});

test('verifyScan uses a wider tolerance for approximate counts', () => {
    const expected = { followers: { value: 12000, exact: false }, following: exact(10) };
    assert.equal(verifyScan(expected, 11500, 10).ok, true);
    assert.equal(verifyScan(expected, 9000, 10).ok, false);
});

test('verificationWarning only speaks when something is wrong', () => {
    assert.equal(verificationWarning(null), '');
    assert.equal(verificationWarning({ ok: true }), '');
    assert.equal(verificationWarning({ ok: null }), '');
    const warning = verificationWarning(verifyScan({ followers: exact(1000), following: exact(5) }, 750, 5));
    assert.match(warning, /followers: read 750 of 1,000/);
});

const scanState = (overrides = {}) => ({
    phase: 'pages',
    expected: { followers: exact(100), following: exact(50) },
    streams: {
        followers: { next: 1, done: false, count: 0, last: null },
        following: { next: 1, done: false, count: 0, last: null }
    },
    windowRounds: 0,
    resumeAt: 0,
    ...overrides
});

test('progressInfo reports percent from pages fetched', () => {
    const scan = scanState();
    assert.equal(progressInfo(scan).percent, 0);

    scan.streams.followers.next = 3;     // 2 pages fetched of 4
    scan.streams.following.next = 2;     // 1 page fetched of 2
    assert.deepEqual(progressInfo(scan), { percent: 50, pagesDone: 3, pagesTotal: 6 });
});

test('progressInfo never reaches 100 before the scan finishes and copes with unknown totals', () => {
    const scan = scanState();
    scan.streams.followers.next = 5;
    scan.streams.following.next = 3;
    assert.equal(progressInfo(scan).percent, 99);

    assert.equal(progressInfo(scanState({ expected: null })).percent, null);
    assert.equal(progressInfo(scanState({ phase: 'profile' })).percent, 0);
});

test('likelyDone avoids a pointless break when every promised page was fetched', () => {
    const scan = scanState();
    scan.streams.followers.next = 5;                 // 4 pages promised, 4 fetched
    assert.equal(likelyDone(scan, 'followers'), true);
    assert.equal(likelyDone(scan, 'following'), false);

    scan.expected.followers = { value: 100, exact: false };
    assert.equal(likelyDone(scan, 'followers'), false);
});

test('estimateSeconds adds the breaks that are still ahead', () => {
    // 100 pages left per list: 100 rounds, 3 breaks (after rounds 30, 60, 90)
    const scan = scanState({ expected: { followers: exact(2500), following: exact(2500) } });
    assert.equal(estimateSeconds(scan, 0), 100 + 3 * 301);

    assert.equal(estimateSeconds(scanState({ phase: 'profile' }), 0), null);
    assert.equal(estimateSeconds(scanState({ expected: null }), 0), null);
});

test('formatDuration', () => {
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(301), '5m 1s');
    assert.equal(formatDuration(0.2), '1s');
});

test('progress and ETA of a quick update count only the pages it plans to read', () => {
    const head = Array.from({ length: 25 }, (_, i) => `n${i}`);
    const scan = scanState({
        expected: { followers: exact(5000), following: exact(5000) },     // a full read would be 200 pages each
        plans: { followers: { delta: 0, head }, following: { delta: 3, head } }
    });
    scan.streams.followers.mode = 'quick';
    scan.streams.following.mode = 'quick';

    // followers: head page + probe = 2; following: 28 names need 2 head pages + probe = 3
    assert.deepEqual(progressInfo(scan), { percent: 0, pagesDone: 0, pagesTotal: 5 });
    assert.equal(estimateSeconds(scan, 0), 3);                           // the slower list sets the pace, no breaks

    scan.streams.followers.requests = 2;
    scan.streams.followers.done = true;
    scan.streams.following.requests = 1;
    assert.deepEqual(progressInfo(scan), { percent: 60, pagesDone: 3, pagesTotal: 5 });

    // Falling back to a full read puts the real size back.
    scan.streams.following.mode = 'full';
    assert.equal(progressInfo(scan).pagesTotal, 2 + 200);
});
