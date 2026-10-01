// Resumable scan engine.
//
// The whole scan lives in chrome.storage.local, so a service worker that gets stopped (or a browser
// that gets restarted) can pick up where it left off. The engine never talks to the popup: it only
// writes `scan` (progress) and `scanResult` (finished result) and the popup renders from storage.
//
// Storage layout
//   scan        current scan state (see newScan), removed when the scan finishes or is cancelled
//   scanResult  result of the last finished scan (lists, counts, verification, tracking)
//   snapshots / history  baseline lists and change log per scanned account (see lib/history.js)
//   ignored     names the user hid from the "not following back" list (written by the popup only)
//   lastUsername  last username that was scanned
//   pg:<type>:<n>  usernames found on page n of followers/following, kept until the scan finishes
//
// Scans are "quick" when the previous scan of the account left a usable baseline: only the head and the
// last page of each list are read and checked against it (lib/incremental.js). If that proof fails the
// list silently falls back to the normal full read.
//
// Everything that touches chrome.* or the network is injected, so the engine runs in Node tests.

import { trackScan } from './history.js';
import { headCheck, mergeQuick, planQuick, sameNames } from './incremental.js';
import { compareLists, nameKey, uniqueNames } from './lists.js';
import { isValidUsername, looksBlocked, normalizeUsername, parseMembers, parseProfileCounts } from './parser.js';
import {
    COOLDOWN_MS, INLINE_WAIT_MAX_MS, MAX_PAGES_PER_STREAM, PAGE_SIZE, REQUESTS_PER_WINDOW, STATE_VERSION,
    likelyDone, pageUrl, parseRetryAfter, planRetry, profileUrl, randomDelay, retryFailureMessage, verifyScan
} from './scan.js';

const TYPES = ['followers', 'following'];
const pageKey = (type, page) => `pg:${type}:${page}`;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function newScan(id, username, startedAt, { full = false } = {}) {
    const stream = () => ({
        next: 1,                    // next page to read (head / full reading)
        done: false,
        count: 0,
        last: null,
        requests: 0,                // pages actually read, including the last-page probe
        mode: 'full',               // 'full' | 'quick'
        phase: 'head',              // quick only: 'head' | 'tail' (probe of the last page)
        resolved: false             // quick only: proven equal to "new names + old list"
    });
    return {
        v: STATE_VERSION,
        id,
        username,
        startedAt,
        status: 'running',          // 'running' | 'error'
        phase: 'profile',           // 'profile' | 'pages'
        expected: null,             // { followers, following } as { value, exact } | null
        full,                       // the user asked for a full scan: never go quick
        plans: { followers: null, following: null },   // quick-scan plans, see planQuick()
        streams: { followers: stream(), following: stream() },
        windowRounds: 0,            // request rounds since the last break
        resumeAt: 0,                // do nothing until this timestamp (breaks and retries)
        wait: null,                 // { reason, until } while waiting
        attempts: {},               // consecutive failed attempts per step
        truncated: false,
        error: null                 // { message, retryable, kind? }
    };
}

export function createEngine({
    storage,
    schedule,                       // { wakeAt(ms), clearWake(), watchdog(on) }
    fetchImpl,
    now = Date.now,
    sleep = defaultSleep,
    random = Math.random
}) {
    let queue = Promise.resolve();
    let running = false;
    let rerun = false;
    let loopPromise = Promise.resolve();

    // All writes go through one queue so a cancel can never interleave with a progress write.
    function enqueue(job) {
        const result = queue.then(job);
        queue = result.catch(() => { });
        return result;
    }

    async function getScan() {
        return (await storage.get('scan')).scan ?? null;
    }

    // Applies `mutate` to the scan with the given id. Returns the new state, or null when that
    // scan has been cancelled or replaced in the meantime (so stale work is silently dropped).
    // `extra` is written in the same storage call, e.g. the page that was just fetched.
    function update(id, mutate, extra = {}) {
        return enqueue(async () => {
            const current = await getScan();
            if (!current || current.id !== id) return null;
            const next = structuredClone(current);
            mutate(next);
            await storage.set({ ...extra, scan: next });
            return next;
        });
    }

    async function clearPages() {
        const keys = Object.keys(await storage.get(null)).filter(key => key.startsWith('pg:'));
        if (keys.length > 0) await storage.remove(keys);
    }

    async function fail(id, error) {
        const next = await update(id, scan => {
            scan.status = 'error';
            scan.error = error;
            scan.wait = null;
            scan.resumeAt = 0;
        });
        if (next) {
            schedule.clearWake();
            schedule.watchdog(false);
        }
    }

    // One HTTP request, reduced to the outcomes the scan cares about.
    async function request(url) {
        let response;
        try {
            response = await fetchImpl(url, { credentials: 'omit' });
        } catch {
            return { kind: 'network' };
        }

        if (response.status === 200) {
            let html;
            try {
                html = await response.text();
            } catch {
                return { kind: 'network' };
            }
            return looksBlocked(html) ? { kind: 'blocked' } : { kind: 'ok', html };
        }
        if (response.status === 404) return { kind: 'notfound' };
        if (response.status === 429 || response.status === 403) {
            return { kind: 'ratelimit', retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'), now()) };
        }
        if (response.status >= 500) return { kind: 'server' };
        return { kind: 'http', status: response.status };
    }

    // Decides how long to back off after failed requests. `failures` is [{ key, res }].
    function planFailures(scan, failures) {
        const attempts = {};
        let waitMs = 0;
        let reason = null;
        let exhausted = null;

        for (const { key, res } of failures) {
            const attempt = (scan.attempts[key] ?? 0) + 1;
            attempts[key] = attempt;

            const plan = planRetry(res.kind, attempt, res.retryAfterMs);
            if (!plan) {
                exhausted = exhausted ?? res.kind;
            } else if (plan.waitMs > waitMs) {
                waitMs = plan.waitMs;
                reason = plan.reason;
            }
        }
        return { attempts, waitMs, reason, exhausted };
    }

    function applyBackoff(scan, plan) {
        Object.assign(scan.attempts, plan.attempts);
        if (plan.exhausted) return;
        scan.resumeAt = now() + plan.waitMs;
        scan.wait = { reason: plan.reason, until: scan.resumeAt };
        if (plan.reason === 'ratelimit') scan.windowRounds = 0;
    }

    async function stepProfile(scan) {
        const res = await request(profileUrl(scan.username));

        if (res.kind === 'ok') {
            const expected = parseProfileCounts(res.html, scan.username);
            const baseline = (await storage.get('snapshots')).snapshots?.[nameKey(scan.username)] ?? null;

            const plans = {};
            for (const type of TYPES) {
                plans[type] = planQuick({ baseline, type, expected: expected[type], now: now(), full: scan.full });
            }

            await update(scan.id, s => {
                s.phase = 'pages';
                s.expected = expected;
                s.plans = plans;
                for (const type of TYPES) if (plans[type]) s.streams[type].mode = 'quick';
                s.attempts = {};
                s.wait = null;
            });
            return;
        }
        if (res.kind === 'notfound') {
            return fail(scan.id, { message: 'User not found.', retryable: false });
        }
        if (res.kind === 'http') {
            return fail(scan.id, { message: `Letterboxd answered with HTTP ${res.status}.`, retryable: false });
        }

        const plan = planFailures(scan, [{ key: 'profile', res }]);
        const next = await update(scan.id, s => applyBackoff(s, plan));
        if (next && plan.exhausted) {
            await fail(scan.id, { message: retryFailureMessage(plan.exhausted), retryable: true, kind: plan.exhausted });
        }
    }

    // Names on pages 1..count of one list, in page order.
    async function readPages(type, count) {
        if (count <= 0) return [];
        const keys = Array.from({ length: count }, (_, i) => pageKey(type, i + 1));
        const stored = await storage.get(keys);
        return keys.flatMap(key => stored[key] ?? []);
    }

    // The page a list needs next: a quick update ends with a probe of the list's last page.
    function pageToRead(scan, type) {
        const stream = scan.streams[type];
        return stream.mode === 'quick' && stream.phase === 'tail' ? scan.plans[type].tail.page : stream.next;
    }

    // Turns one response into what the scan should do with it.
    //   { fatal }  stop for good          { failure }  retry later
    //   { end }    the list is over       { tail }     result of the last-page probe (true = matches)
    //   { users, ... }  a page of members; for quick lists also the head check and tail verdict
    async function interpret(scan, type, res) {
        const stream = scan.streams[type];
        const plan = stream.mode === 'quick' ? scan.plans?.[type] : null;

        if (res.kind === 'http') return { fatal: { message: `Letterboxd answered with HTTP ${res.status}.`, retryable: false } };
        if (res.kind !== 'ok' && res.kind !== 'notfound') return { failure: res };

        const users = res.kind === 'ok' ? parseMembers(res.html) : [];

        if (plan && stream.phase === 'tail') return { tail: sameNames(users, plan.tail.names) };

        if (users.length === 0) {
            // An empty first page for a list the profile says is not empty means we can no longer read
            // the markup. Failing loudly beats reporting a bogus result.
            if (stream.next === 1 && (scan.expected?.[type]?.value ?? 0) > 0) {
                return { fatal: { message: `Could not read the ${type} list. Letterboxd's page layout may have changed.`, retryable: false } };
            }
            return { end: true };
        }
        if (users[0].toLowerCase() === stream.last) return { end: true };   // same page again: past the end

        const page = { users, key: pageKey(type, stream.next) };
        if (plan) {
            const names = [...await readPages(type, stream.next - 1), ...users];
            page.head = headCheck(plan, names).status;

            // A short list may already contain its last page.
            const tailStart = (plan.tail.page - 1) * PAGE_SIZE;
            if (page.head === 'ok' && plan.tail.page <= stream.next) {
                page.tailMatch = sameNames(names.slice(tailStart, tailStart + PAGE_SIZE), plan.tail.names);
            }
        }
        return page;
    }

    // One round: the next page of every unfinished list, fetched in parallel.
    async function stepPages(scan) {
        const active = TYPES.filter(type => !scan.streams[type].done);
        if (active.length === 0) return finish(scan);

        const responses = await Promise.all(active.map(async type => ({
            type,
            res: await request(pageUrl(scan.username, type, pageToRead(scan, type)))
        })));

        const outcomes = {};        // type -> result of interpret()
        const extra = {};           // page keys to persist together with the new cursor
        const failures = [];
        let fatal = null;

        for (const { type, res } of responses) {
            const outcome = await interpret(scan, type, res);
            if (outcome.fatal) fatal = outcome.fatal;
            else if (outcome.failure) failures.push({ key: type, res: outcome.failure });
            else {
                outcomes[type] = outcome;
                if (outcome.users) extra[outcome.key] = outcome.users;
            }
        }

        if (fatal) return fail(scan.id, fatal);

        const plan = failures.length > 0 ? planFailures(scan, failures) : null;

        const next = await update(scan.id, s => {
            let advanced = false;

            for (const type of TYPES) {
                const outcome = outcomes[type];
                if (!outcome) continue;
                const stream = s.streams[type];
                s.attempts[type] = 0;

                if (outcome.tail !== undefined) {
                    // Probe of the last page of a quick list.
                    stream.requests++;
                    advanced = true;
                    if (outcome.tail) {
                        stream.resolved = true;
                        stream.done = true;
                    } else {
                        stream.mode = 'full';       // the old list no longer lines up: read everything
                    }
                } else if (outcome.users) {
                    stream.next++;
                    stream.requests++;
                    stream.count += outcome.users.length;
                    stream.last = outcome.users[0].toLowerCase();
                    advanced = true;
                    if (stream.next > MAX_PAGES_PER_STREAM) {
                        stream.done = true;
                        s.truncated = true;
                    }

                    if (stream.mode === 'quick' && !stream.done) {
                        if (outcome.head === 'fail' || outcome.tailMatch === false) {
                            stream.mode = 'full';
                        } else if (outcome.tailMatch === true) {
                            stream.resolved = true;
                            stream.done = true;
                        } else if (outcome.head === 'ok') {
                            stream.phase = 'tail';
                        }
                    }
                } else {
                    stream.done = true;
                }
            }
            if (advanced) s.windowRounds++;

            if (plan) {
                applyBackoff(s, plan);
            } else {
                s.wait = null;
                const more = TYPES.some(type => !likelyDone(s, type));
                if (s.windowRounds >= REQUESTS_PER_WINDOW && more) {
                    s.windowRounds = 0;
                    s.resumeAt = now() + COOLDOWN_MS;
                    s.wait = { reason: 'cooldown', until: s.resumeAt };
                }
            }
        }, extra);

        if (!next) return;
        if (plan?.exhausted) {
            return fail(scan.id, { message: retryFailureMessage(plan.exhausted), retryable: true, kind: plan.exhausted });
        }
        if (next.resumeAt <= now() && TYPES.some(type => !next.streams[type].done)) {
            await sleep(randomDelay(random));
        }
    }

    async function finish(scan) {
        const keys = [];
        for (const type of TYPES) {
            for (let page = 1; page < scan.streams[type].next; page++) keys.push(pageKey(type, page));
        }
        const stored = await storage.get(keys);

        const read = type => {
            const names = [];
            for (let page = 1; page < scan.streams[type].next; page++) names.push(...(stored[pageKey(type, page)] ?? []));
            return uniqueNames(names);
        };

        // A resolved quick list is the new names read from the head followed by the saved old list.
        const baseline = TYPES.some(type => scan.streams[type].resolved)
            ? (await storage.get('snapshots')).snapshots?.[nameKey(scan.username)] ?? null
            : null;
        const lists = {};
        for (const type of TYPES) {
            const stream = scan.streams[type];
            if (!stream.resolved) {
                lists[type] = read(type);
            } else if (baseline?.[type]) {
                lists[type] = uniqueNames(mergeQuick(read(type).slice(0, scan.plans[type].delta), baseline[type]));
            } else {
                return fail(scan.id, {
                    message: 'The saved scan this quick update was based on is gone. Please run a new scan.',
                    retryable: false
                });
            }
        }
        const { followers, following } = lists;

        const completedAt = now();
        const verification = verifyScan(scan.expected, followers.length, following.length, scan.truncated);
        const resolved = TYPES.filter(type => scan.streams[type].resolved).length;
        const result = {
            scanId: scan.id,
            username: scan.username,
            completedAt,
            ...compareLists(followers, following, scan.username),
            followersCount: followers.length,
            followingCount: following.length,
            verification,
            scanInfo: {
                mode: resolved === TYPES.length ? 'quick' : resolved > 0 ? 'mixed' : 'full',
                pages: TYPES.reduce((sum, type) => sum + (scan.streams[type].requests ?? scan.streams[type].next - 1), 0)
            }
        };

        // What the next scan needs to decide whether it can be quick.
        const streamsMeta = {};
        for (const type of TYPES) {
            const expected = scan.expected?.[type];
            const previous = baseline?.streams?.[type];
            streamsMeta[type] = {
                profileCount: expected?.exact ? expected.value : null,
                fullAt: scan.streams[type].resolved ? previous.fullAt : completedAt,
                quickRuns: scan.streams[type].resolved ? previous.quickRuns + 1 : 0
            };
        }

        await enqueue(async () => {
            const current = await getScan();
            if (!current || current.id !== scan.id) return;

            const saved = await storage.get(['scanResult', 'snapshots', 'history']);

            // A restart between the write below and the cleanup re-runs finish(). The baseline was
            // already replaced by then, so recomputing would report "no changes": keep what we wrote.
            if (saved.scanResult?.scanId !== scan.id) {
                const tracked = trackScan({
                    owner: scan.username,
                    followers,
                    following,
                    verified: verification.ok === true,
                    streamsMeta,
                    snapshots: saved.snapshots,
                    history: saved.history,
                    now: completedAt
                });

                const write = { scanResult: { ...result, tracking: tracked.tracking } };
                if (tracked.changed) {
                    write.snapshots = tracked.snapshots;
                    write.history = tracked.history;
                }

                try {
                    await storage.set(write);
                } catch {
                    // Most likely the storage quota. The result itself matters more than its history.
                    await storage.set({
                        scanResult: { ...result, tracking: { status: 'unavailable', previousAt: null, gained: 0, lost: 0 } }
                    });
                }
            }

            await storage.remove(['scan', ...keys]);
            schedule.clearWake();
            schedule.watchdog(false);
        });
    }

    async function loop() {
        for (; ;) {
            const scan = await getScan();
            if (!scan || scan.status !== 'running') return;

            const waitMs = scan.resumeAt - now();
            if (waitMs > 0) {
                // Long waits: stop and let chrome.alarms wake the service worker. Short ones: sleep.
                if (waitMs > INLINE_WAIT_MAX_MS) {
                    schedule.wakeAt(scan.resumeAt);
                    return;
                }
                await sleep(waitMs);
                continue;
            }

            try {
                if (scan.phase === 'profile') await stepProfile(scan);
                else await stepPages(scan);
            } catch (error) {
                await fail(scan.id, { message: `Unexpected error: ${error.message}`, retryable: true, kind: 'unexpected' });
            }
        }
    }

    function ensureRunning() {
        if (running) {
            rerun = true;
            return loopPromise;
        }
        running = true;
        loopPromise = loop()
            .catch(error => console.error('[scan] loop stopped unexpectedly', error))
            .finally(() => {
                running = false;
                if (rerun) {
                    rerun = false;
                    ensureRunning();
                }
            });
        return loopPromise;
    }

    // Resolves once no loop is running any more (used by tests).
    async function whenIdle() {
        while (running) await loopPromise;
    }

    async function start(input, { full = false } = {}) {
        const username = normalizeUsername(input);
        if (!username) {
            return { ok: false, error: 'Please enter a valid Letterboxd username.' };
        }

        const id = `${now()}-${Math.floor(random() * 1e9)}`;
        await enqueue(async () => {
            await storage.remove(['scan', 'scanResult']);
            await clearPages();
            await storage.set({ scan: newScan(id, username, now(), { full }), lastUsername: username });
        });

        schedule.watchdog(true);
        ensureRunning();
        return { ok: true };
    }

    async function cancel() {
        await enqueue(async () => {
            await storage.remove(['scan', 'scanResult']);
            await clearPages();
            schedule.clearWake();
            schedule.watchdog(false);
        });
        return { ok: true };
    }

    // Forgets the baselines, the change log and the hidden list. The current result stays visible.
    // Refused while a scan is running: a quick update reads its baseline again when it finishes.
    function clearHistory() {
        return enqueue(async () => {
            if (await getScan()) return { ok: false, error: 'A scan is in progress. Cancel it or wait until it finishes first.' };
            await storage.remove(['snapshots', 'history', 'ignored']);
            return { ok: true };
        });
    }

    async function resume() {
        const scan = await getScan();
        if (!scan || scan.status !== 'error' || !scan.error?.retryable) {
            return { ok: false, error: 'Nothing to resume.' };
        }

        const next = await update(scan.id, s => {
            s.status = 'running';
            s.error = null;
            s.attempts = {};
            s.wait = null;
            s.resumeAt = 0;
            s.windowRounds = 0;
        });
        if (!next) return { ok: false, error: 'Nothing to resume.' };

        schedule.watchdog(true);
        ensureRunning();
        return { ok: true };
    }

    // Brings results from the previous (v2.0) storage format forward and drops scans whose
    // state layout is no longer understood.
    async function migrate() {
        const data = await storage.get(['scan', 'scanResult', 'savedUnfollowers', 'savedUsername']);

        if (Array.isArray(data.savedUnfollowers)) {
            if (!data.scan && !data.scanResult) {
                await storage.set({
                    scanResult: {
                        username: data.savedUsername ?? '',
                        completedAt: null,
                        unfollowers: data.savedUnfollowers
                            .map(href => String(href).replace(/\//g, ''))
                            .filter(isValidUsername),
                        followersCount: null,
                        followingCount: null,
                        verification: { ok: null }
                    }
                });
            }
            await storage.remove(['savedUnfollowers', 'savedUsername']);
        }

        if (data.scan && data.scan.v !== STATE_VERSION) {
            await storage.remove('scan');
            await clearPages();
        }
    }

    // Call on every service worker start: migrates storage and resumes an interrupted scan.
    async function init() {
        await enqueue(migrate);
        const scan = await getScan();
        if (scan?.status === 'running') {
            schedule.watchdog(true);
            ensureRunning();
        }
    }

    return { start, cancel, resume, clearHistory, init, ensureRunning, whenIdle };
}
