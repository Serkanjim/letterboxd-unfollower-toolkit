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
