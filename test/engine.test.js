import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, fakeLetterboxd, fakeSchedule, fakeStorage, makeEngine, memberRow, names, wake } from './helpers.js';
import { verificationWarning } from '../lib/scan.js';

// Lets every pending promise settle: enough for a loop that is blocked on a gate or a hung sleep.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const pageKeys = storage => Object.keys(storage.data).filter(key => key.startsWith('pg:'));

test('finds who does not follow back and leaves nothing behind', async () => {
    const followers = [...names('f', 60), 'alice'];
    const following = [...names('f', 60), 'Alice', ...names('u', 7), 'me'];
    const ctx = makeEngine({ site: fakeLetterboxd({ followers, following }) });

    assert.deepEqual(await ctx.engine.start('me'), { ok: true });
    await ctx.engine.whenIdle();

    const { scanResult } = ctx.storage.data;
    assert.deepEqual(scanResult.unfollowers, names('u', 7));        // "Alice"/"alice" match, own name ignored
    assert.equal(scanResult.followersCount, 61);
    assert.equal(scanResult.followingCount, 69);
    assert.equal(scanResult.verification.ok, true);
    assert.equal(ctx.storage.data.scan, undefined);
    assert.deepEqual(pageKeys(ctx.storage), []);
    assert.equal(ctx.schedule.watchdogOn, false);
    assert.deepEqual(ctx.schedule.wakes, []);
});

test('an account where everyone follows back yields an empty, verified result', async () => {
    const all = names('user', 30);
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: all, following: all }) });
    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
    assert.equal(ctx.storage.data.scanResult.verification.ok, true);
});

// Regression: the previous version swallowed any non-200 page and reported everyone on it as
// "not following back". One transient 429 turned a perfect account into 25 false positives.
test('a transient 429 mid-scan is retried instead of producing false positives', async () => {
    const all = names('user', 100);
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page, call }) => (type === 'followers' && page === 3 && call === 1 ? { status: 429 } : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    // The engine backs off and hands control to chrome.alarms instead of finishing early.
    assert.equal(ctx.storage.data.scanResult, undefined);
    assert.equal(ctx.storage.data.scan.wait.reason, 'ratelimit');
    assert.equal(ctx.schedule.wakes.length, 1);
    assert.equal(ctx.schedule.wakes[0], ctx.storage.data.scan.resumeAt);

    await wake(ctx, 301_000);

    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
    assert.equal(ctx.storage.data.scanResult.verification.ok, true);
    assert.equal(site.calls['followers:3'], 2);
});

test('Retry-After is honoured and short waits do not need an alarm', async () => {
    const all = names('user', 60);
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page, call }) => (type === 'following' && page === 2 && call === 1
            ? { status: 429, headers: { 'retry-after': '10' } }
            : null)
    });
    const ctx = makeEngine({ site });
    const before = ctx.clock.now();

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
    assert.deepEqual(ctx.schedule.wakes, []);
    assert.ok(ctx.clock.now() - before >= 10_000);
});

test('network errors back off and recover', async () => {
    const all = names('user', 40);
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page, call }) => (type === 'followers' && page === 1 && call <= 2 ? { throw: true } : null)
    });
    const ctx = makeEngine({ site });
    const before = ctx.clock.now();

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
    assert.ok(ctx.clock.now() - before >= 5_000 + 15_000);
});

test('a bot-protection page served with 200 is treated like a rate limit', async () => {
    const all = names('user', 60);
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page, call }) => (type === 'followers' && page === 2 && call === 1
            ? { status: 200, body: '<title>Just a moment...</title>' }
            : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();
    assert.equal(ctx.storage.data.scan.wait.reason, 'ratelimit');

    await wake(ctx, 301_000);
    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
});

test('gives up after repeated failures, keeps its progress and can be resumed', async () => {
    const all = names('user', 100);
    let broken = true;
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page }) => (broken && type === 'followers' && page === 2
            ? { status: 429, headers: { 'retry-after': '30' } }
            : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();
    for (let i = 0; i < 10 && ctx.storage.data.scan?.status === 'running'; i++) await wake(ctx, 15 * 60_000);

    const { scan } = ctx.storage.data;
    assert.equal(scan.status, 'error');
    assert.equal(scan.error.retryable, true);
    assert.match(scan.error.message, /rate limiting/);
    assert.equal(ctx.storage.data.scanResult, undefined);
    assert.equal(ctx.schedule.watchdogOn, false);
    assert.equal(scan.streams.followers.next, 2);      // page 1 is kept

    broken = false;
    assert.deepEqual(await ctx.engine.resume(), { ok: true });
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
    assert.equal(site.calls['followers:1'], 1);        // nothing was re-fetched
});

test('inserts a break after 30 rounds and carries on afterwards', async () => {
    const all = names('user', 1000);                   // 40 pages each
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: all, following: all }) });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.equal(ctx.storage.data.scan.wait.reason, 'cooldown');
    assert.equal(ctx.storage.data.scan.streams.followers.next, 31);
    assert.equal(ctx.schedule.wakes.length, 1);

    await wake(ctx, 301_000);

    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
    assert.equal(ctx.schedule.wakes.length, 1);
    for (let page = 1; page <= 40; page++) assert.equal(ctx.site.calls[`followers:${page}`], 1);
});

test('does not take a break when the last promised page was just fetched', async () => {
    const all = names('user', 750);                    // exactly 30 pages each
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: all, following: all }) });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.schedule.wakes, []);
    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
});

test('resumes from its checkpoint after the service worker was killed mid-scan', async () => {
    const followers = names('f', 200);
    const following = [...names('f', 200), ...names('u', 3)];
    const storage = fakeStorage();
    const clock = fakeClock();

    // First worker dies (its sleep never returns) a few rounds in.
    let sleeps = 0;
    const first = makeEngine({
        storage,
        clock,
        site: fakeLetterboxd({ followers, following }),
        sleep: ms => (++sleeps > 4 ? new Promise(() => { }) : clock.sleep(ms))
    });
    await first.engine.start('me');
    await settle();
    const checkpoint = storage.data.scan;
    assert.equal(checkpoint.phase, 'pages');
    assert.ok(checkpoint.streams.followers.next > 1 && checkpoint.streams.followers.next < 9);
    assert.equal(storage.data.scanResult, undefined);

    // A fresh worker starts (alarm, popup message, browser restart ...) and calls init().
    const second = makeEngine({ storage, clock, site: fakeLetterboxd({ followers, following }) });
    await second.engine.init();
    await second.engine.whenIdle();

    assert.deepEqual(storage.data.scanResult.unfollowers, names('u', 3));
    assert.equal(storage.data.scanResult.verification.ok, true);
    assert.equal(second.site.calls['profile:0'], undefined);                         // profile not re-read
    assert.equal(second.site.calls['followers:1'], undefined);                       // finished pages not re-read
});

test('fails loudly instead of guessing when the page layout is not recognised', async () => {
    const all = names('user', 60);
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page }) => (type === 'followers' && page === 1
            ? { status: 200, body: '<div class="new-layout">members</div>' }
            : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.equal(ctx.storage.data.scan.status, 'error');
    assert.equal(ctx.storage.data.scan.error.retryable, false);
    assert.match(ctx.storage.data.scan.error.message, /layout/);
    assert.equal(ctx.storage.data.scanResult, undefined);
    assert.equal((await ctx.engine.resume()).ok, false);
});

test('flags a result whose lists are shorter than the profile promised', async () => {
    const all = names('user', 100);
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        // The server quietly stops serving followers after page 2.
        intercept: ({ type, page }) => (type === 'followers' && page >= 3 ? { status: 404 } : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    const { verification } = ctx.storage.data.scanResult;
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.followers, { expected: 100, got: 50, ok: false });
    assert.match(verificationWarning(verification), /followers: read 50 of 100/);
});

test('stops when the server keeps repeating the last page', async () => {
    const all = names('user', 75);
    const lastPage = all.slice(50).map(memberRow).join('');
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page }) => (type === 'followers' && page >= 4 ? { status: 200, body: lastPage } : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.equal(ctx.storage.data.scanResult.followersCount, 75);
    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, []);
});

test('reports an unknown user without retrying', async () => {
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: [], following: [] }) });
    await ctx.engine.start('ghost');
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.storage.data.scan.error, { message: 'User not found.', retryable: false });
    assert.equal(ctx.site.calls['profile:0'], 1);
});

test('rejects invalid usernames and accepts pasted profile URLs', async () => {
    const all = names('user', 5);
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: all, following: all }) });

    for (const bad of ['', 'me/following', '../film/heat', 'me?x=']) {
        assert.equal((await ctx.engine.start(bad)).ok, false, bad);
    }
    assert.deepEqual(ctx.storage.data, {});
    assert.deepEqual(ctx.site.log, []);

    assert.equal((await ctx.engine.start('https://letterboxd.com/me/')).ok, true);
    await ctx.engine.whenIdle();
    assert.equal(ctx.storage.data.scanResult.username, 'me');
});

test('cancel stops an in-flight scan without leaving anything behind', async () => {
    const all = names('user', 100);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const site = fakeLetterboxd({
        followers: all,
        following: all,
        intercept: ({ type, page }) => (type === 'followers' && page === 2 ? { gate } : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await settle();
    assert.ok(ctx.storage.data.scan);

    await ctx.engine.cancel();
    release();
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.storage.data, { lastUsername: 'me' });     // no scan, no result, no stray pages
    assert.equal(ctx.schedule.watchdogOn, false);
});

test('starting a new scan discards late results from the previous one', async () => {
    const all = names('user', 60);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const site = fakeLetterboxd({
        followers: all,
        following: [...all, 'only-new'],
        intercept: ({ type, page, call }) => (type === 'followers' && page === 2 && call === 1 ? { gate } : null)
    });
    const ctx = makeEngine({ site });

    await ctx.engine.start('me');
    await settle();
    await ctx.engine.start('me');                       // user hits "Check" again
    release();
    await ctx.engine.whenIdle();

    assert.deepEqual(ctx.storage.data.scanResult.unfollowers, ['only-new']);
    assert.deepEqual(pageKeys(ctx.storage), []);
});

test('an unexpected exception becomes a resumable error, not a silent hang', async () => {
    const ctx = makeEngine({ site: { fetchImpl: async () => undefined, calls: {}, log: [] } });
    await ctx.engine.start('me');
    await ctx.engine.whenIdle();

    assert.equal(ctx.storage.data.scan.status, 'error');
    assert.equal(ctx.storage.data.scan.error.kind, 'unexpected');
    assert.equal(ctx.storage.data.scan.error.retryable, true);
    assert.equal(ctx.schedule.watchdogOn, false);
});

test('init carries a v2.0 saved result forward and drops unreadable scan state', async () => {
    const storage = fakeStorage({ savedUnfollowers: ['/a/', '/b/', '/<bad>/'], savedUsername: 'me' });
    const ctx = makeEngine({ storage, site: fakeLetterboxd({ followers: [], following: [] }) });
    await ctx.engine.init();

    assert.deepEqual(storage.data.scanResult.unfollowers, ['a', 'b']);
    assert.equal(storage.data.savedUnfollowers, undefined);
    assert.equal(storage.data.savedUsername, undefined);

    const stale = fakeStorage({ scan: { v: 0, id: 'old', status: 'running' }, 'pg:followers:1': ['x'] });
    const ctx2 = makeEngine({ storage: stale, site: fakeLetterboxd({ followers: [], following: [] }) });
    await ctx2.engine.init();
    assert.equal(stale.data.scan, undefined);
    assert.deepEqual(pageKeys(stale), []);
});

// ---- Fans, mutuals and change tracking ----

const scanOnce = async ctx => {
    await ctx.engine.start('me');
    await ctx.engine.whenIdle();
    return ctx.storage.data.scanResult;
};

test('splits the lists into not-following-back, fans and mutuals', async () => {
    const followers = [...names('m', 5), ...names('fan', 3), 'Alice'];
    const following = [...names('m', 5), 'alice', ...names('u', 2)];
    const ctx = makeEngine({ site: fakeLetterboxd({ followers, following }) });

    const result = await scanOnce(ctx);

    assert.deepEqual(result.unfollowers, names('u', 2));
    assert.deepEqual(result.fans, names('fan', 3));
    assert.deepEqual(result.mutuals, [...names('m', 5), 'alice']);
    assert.equal(result.tracking.status, 'first');
    assert.equal(ctx.storage.data.lastUsername, 'me');
});

test('the first scan becomes the baseline and the next one reports who left and who arrived', async () => {
    const followers = names('f', 40);
    const following = [...names('f', 40), 'x1'];
    const site = fakeLetterboxd({ followers, following });
    const ctx = makeEngine({ site });

    const first = await scanOnce(ctx);
    assert.equal(first.tracking.status, 'first');
    assert.equal(ctx.storage.data.snapshots.me.followers.length, 40);
    assert.deepEqual(ctx.storage.data.history ?? {}, {});

    // f1 and f2 unfollow; f1 is someone I follow back. A newcomer follows.
    followers.splice(1, 2);
    followers.push('newbie');
    ctx.clock.advance(86_400_000);

    const second = await scanOnce(ctx);
    assert.deepEqual(second.tracking, { status: 'ok', previousAt: first.completedAt, gained: 1, lost: 2 });
    assert.deepEqual(second.fans, ['newbie']);

    const [entry] = ctx.storage.data.history.me;
    assert.deepEqual(entry.lost, ['f1', 'f2']);
    assert.deepEqual(entry.gained, ['newbie']);
    assert.equal(entry.previousAt, first.completedAt);
    assert.equal(ctx.storage.data.snapshots.me.at, second.completedAt);
});

test('an incomplete scan neither reports bogus changes nor replaces the baseline', async () => {
    const followers = names('f', 100);
    const following = names('f', 100);
    let truncate = false;
    const site = fakeLetterboxd({
        followers,
        following,
        intercept: ({ type, page }) => (truncate && type === 'followers' && page >= 3 ? { status: 404 } : null)
    });
    const ctx = makeEngine({ site });

    const first = await scanOnce(ctx);
    const baseline = structuredClone(ctx.storage.data.snapshots);

    truncate = true;                                    // half of the followers silently vanish
    ctx.clock.advance(3_600_000);
    const broken = await scanOnce(ctx);

    assert.equal(broken.verification.ok, false);
    assert.equal(broken.tracking.status, 'skipped');
    assert.deepEqual(ctx.storage.data.snapshots, baseline);           // baseline untouched
    assert.deepEqual(ctx.storage.data.history ?? {}, {});             // 50 "lost followers" were NOT logged

    truncate = false;
    followers.splice(10, 1);                            // one genuine unfollow
    const healthy = await scanOnce(ctx);
    assert.deepEqual(healthy.tracking, { status: 'ok', previousAt: first.completedAt, gained: 0, lost: 1 });
});

test('a crash while finishing does not lose the detected changes', async () => {
    const followers = names('f', 30);
    const site = fakeLetterboxd({ followers, following: [...followers] });
    const storage = fakeStorage();
    const ctx = makeEngine({ storage, site });
    await scanOnce(ctx);

    followers.pop();                                    // f29 leaves

    // The worker dies after the result was written but before the scan state was cleaned up.
    const realRemove = storage.remove;
    let crashed = false;
    storage.remove = async keys => {
        if (!crashed && [].concat(keys).some(key => key.startsWith('pg:'))) {
            crashed = true;
            throw new Error('worker killed');
        }
        return realRemove(keys);
    };

    await ctx.engine.start('me');
    await ctx.engine.whenIdle();
    assert.equal(crashed, true);
    assert.equal(storage.data.scan.status, 'error');
    assert.equal(storage.data.scanResult.tracking.lost, 1);

    assert.equal((await ctx.engine.resume()).ok, true);
    await ctx.engine.whenIdle();

    assert.equal(storage.data.scan, undefined);
    assert.deepEqual(storage.data.scanResult.tracking.lost, 1);       // not recomputed against the new baseline
    assert.equal(storage.data.history.me.length, 1);
});

test('when the history cannot be stored the result is still delivered', async () => {
    const all = names('f', 30);
    const storage = fakeStorage();
    const realSet = storage.set;
    storage.set = async values => {
        if ('snapshots' in values) throw new Error('QUOTA_BYTES quota exceeded');
        return realSet(values);
    };
    const ctx = makeEngine({ storage, site: fakeLetterboxd({ followers: all, following: [...all, 'x'] }) });

    const result = await scanOnce(ctx);

    assert.deepEqual(result.unfollowers, ['x']);
    assert.equal(result.tracking.status, 'unavailable');
    assert.equal(storage.data.snapshots, undefined);
    assert.equal(storage.data.scan, undefined);
});

test('cancel keeps the saved history; clearHistory removes it', async () => {
    const all = names('f', 30);
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: all, following: all }) });
    await scanOnce(ctx);
    ctx.storage.data.ignored = { me: ['x'] };
    ctx.storage.data.history = { me: [{ at: 1 }] };

    await ctx.engine.cancel();
    assert.ok(ctx.storage.data.snapshots.me);
    assert.ok(ctx.storage.data.history.me);
    assert.deepEqual(ctx.storage.data.ignored, { me: ['x'] });
    assert.equal(ctx.storage.data.scanResult, undefined);

    await scanOnce(ctx);
    await ctx.engine.clearHistory();
    assert.equal(ctx.storage.data.snapshots, undefined);
    assert.equal(ctx.storage.data.history, undefined);
    assert.equal(ctx.storage.data.ignored, undefined);
    assert.ok(ctx.storage.data.scanResult);                           // the visible result stays
});

// ---- Incremental (quick) scans ----
// Letterboxd lists newest follows first, so a world is an array with new people unshifted onto the front.

const resetLog = site => {
    for (const key of Object.keys(site.calls)) delete site.calls[key];
    site.log.length = 0;
};
const requested = (site, type) => site.log.filter(key => key.startsWith(`${type}:`)).map(key => Number(key.split(':')[1]));
const lists = result => ({
    unfollowers: result.unfollowers, fans: result.fans, mutuals: result.mutuals,
    followersCount: result.followersCount, followingCount: result.followingCount
});

async function baselineScan(followers, following) {
    const site = fakeLetterboxd({ followers, following });
    const ctx = makeEngine({ site });
    const first = await scanOnce(ctx);
    assert.equal(first.scanInfo.mode, 'full');
    resetLog(site);
    ctx.clock.advance(3_600_000);
    return { ctx, site, first };
}

// What a forced full scan of the current world reports, for comparison.
async function fullScanOf(followers, following) {
    const ctx = makeEngine({ site: fakeLetterboxd({ followers, following }) });
    await ctx.engine.start('me', { full: true });
    await ctx.engine.whenIdle();
    return ctx.storage.data.scanResult;
}

test('first scan is full and stores what the next one needs to go quick', async () => {
    const { ctx, first } = await baselineScan(names('f', 300), names('f', 300));
    assert.equal(first.scanInfo.pages, 24);             // 12 pages per list (the empty page that ends a list is not counted)
    const meta = ctx.storage.data.snapshots.me.streams;
    assert.equal(meta.followers.profileCount, 300);
    assert.equal(meta.followers.quickRuns, 0);
    assert.equal(meta.followers.fullAt, first.completedAt);
});

test('a rescan with nothing new reads only the head and the last page of each list', async () => {
    const followers = names('f', 300);
    const following = names('f', 300);
    const { ctx, site, first } = await baselineScan(followers, following);

    const result = await scanOnce(ctx);

    assert.deepEqual(result.scanInfo, { mode: 'quick', pages: 4 });
    assert.deepEqual(requested(site, 'followers'), [1, 12]);
    assert.deepEqual(requested(site, 'following'), [1, 12]);
    assert.deepEqual(lists(result), lists(first));
    assert.equal(result.verification.ok, true);
    assert.deepEqual(result.tracking, { status: 'ok', previousAt: first.completedAt, gained: 0, lost: 0 });

    const meta = ctx.storage.data.snapshots.me.streams;
    assert.equal(meta.followers.quickRuns, 1);
    assert.equal(meta.followers.fullAt, first.completedAt);          // the last full read is remembered
});

test('new followers and new follows are found by reading just the first pages', async () => {
    const followers = names('f', 300);
    const following = names('f', 300);
    const { ctx, site } = await baselineScan(followers, following);

    followers.unshift('new3', 'new2', 'new1');          // three people followed me
    following.unshift('iFollowed');                     // and I followed one person

    const result = await scanOnce(ctx);

    assert.equal(result.scanInfo.mode, 'quick');
    assert.deepEqual(requested(site, 'followers'), [1, 2, 13]);      // 3 new + 25 old head -> 2 pages, then the last page
    assert.deepEqual(requested(site, 'following'), [1, 2, 13]);
    assert.deepEqual(result.fans, ['new3', 'new2', 'new1']);
    assert.deepEqual(result.unfollowers, ['iFollowed']);
    assert.equal(result.followersCount, 303);
    assert.deepEqual(result.tracking.gained, 3);
    assert.deepEqual(ctx.storage.data.history.me[0].gained, ['new3', 'new2', 'new1']);
    assert.deepEqual(lists(result), lists(await fullScanOf(followers, following)));
});

test('somebody leaving forces a full read, which then names them', async () => {
    const followers = names('f', 300);
    const following = names('f', 300);
    const { ctx, site } = await baselineScan(followers, following);

    followers.splice(150, 1);                           // f150 unfollows me, deep in the list
    const result = await scanOnce(ctx);

    assert.equal(result.scanInfo.mode, 'mixed');         // followers: full (count went down); following: still quick
    assert.equal(requested(site, 'followers').length, 13);
    assert.deepEqual(requested(site, 'following'), [1, 12]);
    assert.deepEqual(ctx.storage.data.history.me[0].lost, ['f150']);
    assert.deepEqual(result.unfollowers, ['f150']);      // I still follow them
    assert.equal(result.verification.ok, true);
});

test('a gain and a loss that cancel out in the count are still caught', async () => {
    const followers = names('f', 300);
    const following = names('f', 300);
    const { ctx, site } = await baselineScan(followers, following);

    followers.splice(200, 1);                           // one leaves ...
    followers.unshift('newbie');                        // ... one arrives: the profile count is unchanged
    const result = await scanOnce(ctx);

    assert.equal(result.scanInfo.mode, 'mixed');
    assert.equal(requested(site, 'followers')[0], 1);
    assert.equal(requested(site, 'followers').length, 13);     // fell back to the full read
    const entry = ctx.storage.data.history.me[0];
    assert.deepEqual([entry.lost, entry.gained], [['f200'], ['newbie']]);
    assert.deepEqual(lists(result), lists(await fullScanOf(followers, following)));
});

test('a change that only shows at the end of the list is caught by the last-page probe', async () => {
    const followers = names('f', 300);
    const following = names('f', 300);
    const { ctx, site } = await baselineScan(followers, following);

    // Not how Letterboxd orders things, but if it ever did: head and counts look unchanged.
    followers.splice(120, 1);
    followers.push('tailnew');
    const result = await scanOnce(ctx);

    assert.equal(result.scanInfo.mode, 'mixed');
    assert.deepEqual(requested(site, 'followers').slice(0, 2), [1, 12]);       // head, then the probe, then everything
    assert.equal(requested(site, 'followers').length, 2 + 11 + 1);
    const entry = ctx.storage.data.history.me[0];
    assert.deepEqual([entry.lost, entry.gained], [['f120'], ['tailnew']]);
});

test('"full scan" forces a complete read', async () => {
    const all = names('f', 300);
    const { ctx, site, first } = await baselineScan(all, [...all]);

    await ctx.engine.start('me', { full: true });
    await ctx.engine.whenIdle();

    assert.equal(ctx.storage.data.scanResult.scanInfo.mode, 'full');
    assert.equal(requested(site, 'followers').length, 13);
    assert.deepEqual(lists(ctx.storage.data.scanResult), lists(first));
    assert.equal(ctx.storage.data.snapshots.me.streams.followers.quickRuns, 0);
});

test('small lists, old baselines and too many quick runs all go back to a full read', async () => {
    const small = await baselineScan(names('s', 60), names('s', 60));
    assert.equal((await scanOnce(small.ctx)).scanInfo.mode, 'full');                 // 60 people: not worth it

    const old = await baselineScan(names('f', 300), names('f', 300));
    old.ctx.clock.advance(15 * 24 * 3600_000);                                       // baseline is 15 days old
    assert.equal((await scanOnce(old.ctx)).scanInfo.mode, 'full');
    assert.equal((await scanOnce(old.ctx)).scanInfo.mode, 'quick');                  // fresh baseline again

    const busy = await baselineScan(names('f', 300), names('f', 300));
    busy.ctx.storage.data.snapshots.me.streams.followers.quickRuns = 10;
    busy.ctx.storage.data.snapshots.me.streams.following.quickRuns = 10;
    const refreshed = await scanOnce(busy.ctx);
    assert.equal(refreshed.scanInfo.mode, 'full');
    assert.equal(busy.ctx.storage.data.snapshots.me.streams.followers.quickRuns, 0);
});

test('an unreadable profile count means no quick scan', async () => {
    const all = names('f', 300);
    let blind = false;
    const site = fakeLetterboxd({
        followers: all, following: all,
        intercept: ({ type }) => (blind && type === 'profile' ? { status: 200, body: '<div>no counts here</div>' } : null)
    });
    const ctx = makeEngine({ site });
    await scanOnce(ctx);

    blind = true;
    ctx.clock.advance(1000);
    const result = await scanOnce(ctx);
    assert.equal(result.scanInfo.mode, 'full');
    assert.equal(result.verification.ok, null);          // nothing to verify against, so no baseline either
});

// The property that matters: whatever happens between two scans, a quick scan reports exactly what a
// full scan would, as long as Letterboxd keeps listing newest follows first.
test('quick scans agree with full scans across random changes', async () => {
    let seed = 20260101;
    const rand = () => {                                // mulberry32
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
    let quickScans = 0;
    let fallbacks = 0;

    for (let round = 0; round < 40; round++) {
        const followers = names(`f${round}_`, int(100, 400));
        const following = names(`g${round}_`, int(100, 400));
        for (const name of following.slice(0, int(20, 80))) followers.push(name);     // some mutuals
        const { ctx } = await baselineScan(followers, following);

        for (let step = 0; step < 3; step++) {
            for (const list of [followers, following]) {
                for (let i = int(0, 4); i > 0; i--) list.unshift(`n${round}_${step}_${list === followers ? 'f' : 'g'}${i}`);
                for (let i = rand() < 0.4 ? int(1, 3) : 0; i > 0; i--) list.splice(int(0, list.length - 1), 1);
            }
            ctx.clock.advance(60_000);
            const result = await scanOnce(ctx);
            const expected = await fullScanOf(followers, following);

            assert.deepEqual(lists(result), lists(expected), `round ${round} step ${step}`);
            assert.equal(result.verification.ok, true);
            if (result.scanInfo.mode === 'quick') quickScans++;
            else fallbacks++;
        }
    }
    // Both paths must actually have been exercised.
    assert.ok(quickScans >= 20, `quick scans: ${quickScans}`);
    assert.ok(fallbacks >= 10, `fallbacks: ${fallbacks}`);
});

test('a quick scan survives the worker being killed halfway', async () => {
    const followers = names('f', 300);
    const following = names('f', 300);
    const { ctx, site, first } = await baselineScan(followers, following);
    followers.unshift('new1');

    // The next worker dies after its first pause (its sleep never returns).
    let sleeps = 0;
    const clock = ctx.clock;
    const dying = makeEngine({
        storage: ctx.storage, clock, site,
        sleep: ms => (++sleeps > 1 ? new Promise(() => { }) : clock.sleep(ms))
    });
    await dying.engine.start('me');
    await settle();
    assert.ok(ctx.storage.data.scan, 'scan is still in flight');
    assert.equal(ctx.storage.data.scanResult, undefined);

    const revived = makeEngine({ storage: ctx.storage, clock, site });
    await revived.engine.init();
    await revived.engine.whenIdle();

    const result = ctx.storage.data.scanResult;
    assert.equal(result.scanInfo.mode, 'quick');
    assert.deepEqual(result.fans, ['new1']);
    assert.deepEqual(lists({ ...result, fans: [] }).unfollowers, first.unfollowers);
});

test('the saved baseline cannot be wiped while a scan is running', async () => {
    const all = names('f', 300);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const site = fakeLetterboxd({
        followers: all, following: all,
        intercept: ({ type, page, call }) => (type === 'followers' && page === 1 && call === 2 ? { gate } : null)
    });
    const ctx = makeEngine({ site });
    await scanOnce(ctx);

    await ctx.engine.start('me');
    await settle();
    const refused = await ctx.engine.clearHistory();
    assert.equal(refused.ok, false);
    assert.ok(ctx.storage.data.snapshots.me);

    release();
    await ctx.engine.whenIdle();
    assert.equal(ctx.storage.data.scanResult.scanInfo.mode, 'quick');
    assert.equal((await ctx.engine.clearHistory()).ok, true);
});

test('a quick update whose baseline vanished fails clearly instead of guessing', async () => {
    const all = names('f', 300);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const site = fakeLetterboxd({
        followers: all, following: all,
        intercept: ({ type, page, call }) => (type === 'following' && page === 12 && call === 2 ? { gate } : null)
    });
    const ctx = makeEngine({ site });
    await scanOnce(ctx);

    await ctx.engine.start('me');
    await settle();
    delete ctx.storage.data.snapshots;                  // bypasses clearHistory on purpose
    release();
    await ctx.engine.whenIdle();

    assert.equal(ctx.storage.data.scan.status, 'error');
    assert.equal(ctx.storage.data.scan.error.retryable, false);
    assert.match(ctx.storage.data.scan.error.message, /quick update/);
    assert.equal(ctx.storage.data.scanResult, undefined);
});

// ---- Faces (display names, avatars), page badges data ----

const AVATAR = id => `https://a.ltrbxd.com/resized/avatar/${id}.jpg`;

test('display names and avatars are kept, merged across scans, and never block a scan', async () => {
    const followers = names('f', 300);
    const following = names('f', 300);
    const faces = { f0: { name: 'Zero Fan', avatar: AVATAR('f0') }, f1: { name: 'f1' }, f2: { avatar: 'https://evil.example/x.gif' } };
    const site = fakeLetterboxd({ followers, following, faces });
    const ctx = makeEngine({ site });

    await scanOnce(ctx);
    assert.deepEqual(ctx.storage.data.profiles, { '@f0': ['Zero Fan', AVATAR('f0')] });   // f1: same name, f2: hostile host

    // A quick rescan only reads the head, yet earlier faces survive and new ones are added.
    followers.unshift('newbie');
    faces.newbie = { name: 'New Person', avatar: AVATAR('new') };
    ctx.clock.advance(3_600_000);
    const result = await scanOnce(ctx);

    assert.equal(result.scanInfo.mode, 'quick');
    assert.deepEqual(ctx.storage.data.profiles, { '@f0': ['Zero Fan', AVATAR('f0')], '@newbie': ['New Person', AVATAR('new')] });
    assert.equal(Object.keys(ctx.storage.data).filter(key => key.startsWith('pg:')).length, 0);
});

test('a scan still completes when the faces cannot be stored', async () => {
    const all = names('f', 30);
    const storage = fakeStorage();
    const realSet = storage.set;
    storage.set = async values => {
        if ('profiles' in values) throw new Error('QUOTA_BYTES quota exceeded');
        return realSet(values);
    };
    const site = fakeLetterboxd({ followers: all, following: [...all, 'x'], faces: { f0: { name: 'Zero', avatar: AVATAR('f0') } } });
    const ctx = makeEngine({ storage, site });

    const result = await scanOnce(ctx);
    assert.deepEqual(result.unfollowers, ['x']);
    assert.equal(storage.data.profiles, undefined);
    assert.equal(storage.data.scan, undefined);
});

test('checkpoints written by the previous version (plain arrays) are still understood', async () => {
    const followers = names('f', 200);
    const following = [...names('f', 200), 'x'];
    const storage = fakeStorage();
    const clock = fakeClock();
    let sleeps = 0;
    const dying = makeEngine({
        storage, clock, site: fakeLetterboxd({ followers, following }),
        sleep: ms => (++sleeps > 3 ? new Promise(() => { }) : clock.sleep(ms))
    });
    await dying.engine.start('me');
    await settle();

    for (const key of Object.keys(storage.data).filter(k => k.startsWith('pg:'))) storage.data[key] = storage.data[key].u;   // downgrade

    const revived = makeEngine({ storage, clock, site: fakeLetterboxd({ followers, following }) });
    await revived.engine.init();
    await revived.engine.whenIdle();
    assert.deepEqual(storage.data.scanResult.unfollowers, ['x']);
});

test('the page-badge list holds lowercase names of everyone who does not follow back', async () => {
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: ['a'], following: ['a', 'Bob', 'CY'] }) });
    const result = await scanOnce(ctx);
    assert.deepEqual(ctx.storage.data.badgeData, { owner: 'me', at: result.completedAt, unfollowers: ['bob', 'cy'] });
});

// ---- Background (daily) checks ----

async function dailyWorld({ lose = [], gain = [], following = null } = {}) {
    const followers = names('f', 300);
    const follows = following ?? names('f', 300);
    const site = fakeLetterboxd({ followers, following: follows });
    const alerts = [];
    const storage = fakeStorage();
    const clock = fakeClock();
    const schedule = fakeSchedule();
    const ctx = makeEngine({ storage, clock, schedule, site });
    ctx.alerts = alerts;
    const withNotify = () => makeEngine({
        storage, clock, schedule, site,
        notify: async summary => { alerts.push(summary); }
    });
    return { followers, follows, site, storage, clock, ctx, withNotify, alerts };
}

test('a background check needs a baseline and never interrupts a running scan', async () => {
    const world = await dailyWorld();
    const checker = world.withNotify();

    assert.deepEqual(await checker.engine.runAuto('me'), { ok: false, skipped: 'no-baseline' });
    assert.equal(world.storage.data.scan, undefined);
    assert.deepEqual(world.site.log, []);

    await scanOnce(world.ctx);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const busy = makeEngine({
        storage: world.storage, clock: world.clock,
        site: fakeLetterboxd({ followers: world.followers, following: world.follows, intercept: ({ type, page, call }) => (type === 'followers' && page === 1 && call === 1 ? { gate } : null) })
    });
    await busy.engine.start('me');
    await settle();
    assert.deepEqual(await checker.engine.runAuto('me'), { ok: false, skipped: 'busy' });
    release();
    await busy.engine.whenIdle();
});

test('a background check keeps the visible result until it has a new one, then alerts once', async () => {
    const world = await dailyWorld();
    const first = await scanOnce(world.ctx);
    world.storage.data.lastUsername = 'someone-else';        // a background check must not touch this

    world.followers.splice(40, 1);                           // f40 unfollows: I follow them back
    world.followers.splice(80, 1);                           // f81 too (index shifted by the first removal)
    world.followers.unshift('newbie');

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let held = true;
    const site = fakeLetterboxd({
        followers: world.followers, following: world.follows,
        intercept: ({ type, page }) => (held && type === 'following' && page === 1 ? { gate } : null)
    });
    const alerts = [];
    const checker = makeEngine({ storage: world.storage, clock: world.clock, site, notify: async s => { alerts.push(s); } });

    world.clock.advance(86_400_000);
    assert.deepEqual(await checker.engine.runAuto('me'), { ok: true });
    await settle();
    assert.equal(world.storage.data.scan.auto, true);
    assert.equal(world.storage.data.scanResult.scanId, first.scanId, 'the old result stays visible while the check runs');
    assert.equal(world.storage.data.lastUsername, 'someone-else');

    held = false;
    release();
    await checker.engine.whenIdle();

    const result = world.storage.data.scanResult;
    assert.notEqual(result.scanId, first.scanId);
    assert.equal(world.storage.data.scan, undefined);
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].lostNames.sort(), ['f40', 'f81']);
    assert.deepEqual({ username: alerts[0].username, lost: alerts[0].lost, gained: alerts[0].gained, lostYouFollow: alerts[0].lostYouFollow }, { username: 'me', lost: 2, gained: 1, lostYouFollow: 2 });
    assert.deepEqual(world.storage.data.autoCheck, { at: result.completedAt, username: 'me', ok: true, mode: 'mixed', tracking: 'ok', lost: 2, gained: 1 });
});

test('a background check that finds only new followers or nothing stays quiet', async () => {
    const world = await dailyWorld();
    await scanOnce(world.ctx);
    const checker = world.withNotify();

    world.followers.unshift('newbie');
    world.clock.advance(86_400_000);
    await checker.engine.runAuto('me');
    await checker.engine.whenIdle();
    assert.equal(world.storage.data.autoCheck.gained, 1);
    assert.deepEqual(world.alerts, []);

    world.clock.advance(86_400_000);
    await checker.engine.runAuto('me');
    await checker.engine.whenIdle();
    assert.deepEqual(world.storage.data.autoCheck, { ...world.storage.data.autoCheck, ok: true, lost: 0, gained: 0 });
    assert.deepEqual(world.alerts, []);
});

test('a failing background check disappears quietly and leaves the result alone', async () => {
    const world = await dailyWorld();
    const first = await scanOnce(world.ctx);
    const down = fakeLetterboxd({ followers: world.followers, following: world.follows, intercept: () => ({ status: 503 }) });
    const alerts = [];
    const checker = makeEngine({ storage: world.storage, clock: world.clock, site: down, notify: async s => { alerts.push(s); } });

    world.clock.advance(86_400_000);
    await checker.engine.runAuto('me');
    await checker.engine.whenIdle();
    for (let i = 0; i < 6 && world.storage.data.scan; i++) await wake(checker, 5 * 60_000);

    assert.equal(world.storage.data.scan, undefined);
    assert.equal(world.storage.data.scanResult.scanId, first.scanId);
    assert.equal(world.storage.data.autoCheck.ok, false);
    assert.match(world.storage.data.autoCheck.error, /not responding/);
    assert.deepEqual(alerts, []);
    assert.deepEqual(pageKeys(world.storage), []);
    assert.equal(world.ctx.schedule.watchdogOn, false);
});

test('a crash while a background check finishes does not alert twice or leave a scan behind', async () => {
    const world = await dailyWorld();
    await scanOnce(world.ctx);
    world.followers.splice(10, 1);
    const alerts = [];
    const checker = makeEngine({ storage: world.storage, clock: world.clock, site: world.site, notify: async s => { alerts.push(s); } });

    const realRemove = world.storage.remove;
    let crashed = false;
    world.storage.remove = async keys => {
        if (!crashed && [].concat(keys).some(key => key.startsWith('pg:'))) { crashed = true; throw new Error('worker killed'); }
        return realRemove(keys);
    };

    world.clock.advance(86_400_000);
    await checker.engine.runAuto('me');
    await checker.engine.whenIdle();

    assert.equal(crashed, true);
    assert.equal(world.storage.data.scan, undefined);                     // cleaned up, not stuck in "error"
    assert.equal(world.storage.data.scanResult.tracking.lost, 1);          // the result was already stored
    assert.ok(alerts.length <= 1);
});

test('clearing the history also forgets faces, page badges and background-check notes', async () => {
    const all = names('f', 30);
    const ctx = makeEngine({ site: fakeLetterboxd({ followers: all, following: all, faces: { f0: { name: 'Zero' } } }) });
    await scanOnce(ctx);
    ctx.storage.data.autoCheck = { ok: true };
    assert.ok(ctx.storage.data.profiles && ctx.storage.data.badgeData);

    await ctx.engine.clearHistory();
    for (const key of ['snapshots', 'history', 'ignored', 'profiles', 'badgeData', 'autoCheck']) assert.equal(ctx.storage.data[key], undefined, key);
    assert.ok(ctx.storage.data.scanResult);
});
