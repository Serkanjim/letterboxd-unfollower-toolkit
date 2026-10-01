// Pure scan helpers: pacing constants, retry policy, result verification and progress maths.
// The scan state shape these functions read is created by createEngine() in lib/engine.js.

export const STATE_VERSION = 1;

export const PAGE_SIZE = 25;               // members per followers/following page
export const MIN_DELAY_MS = 550;           // pause between request rounds (randomised)
export const MAX_DELAY_MS = 850;
export const REQUESTS_PER_WINDOW = 30;     // requests per endpoint before a proactive break
export const COOLDOWN_MS = 301_000;        // length of that break (bucket refill)
export const INLINE_WAIT_MAX_MS = 20_000;  // longer waits hand control back to chrome.alarms
export const MAX_PAGES_PER_STREAM = 4000;  // safety net against endless pagination

const AVG_REQUEST_SECONDS = 1.0;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000;
const MIN_RATE_LIMIT_WAIT_MS = 5_000;
const NETWORK_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000];
const SERVER_BACKOFF_MS = [10_000, 30_000, 90_000];

export function pageUrl(username, type, page) {
    return `https://letterboxd.com/${username}/${type}/page/${page}/`;
}

export function profileUrl(username) {
    return `https://letterboxd.com/${username}/`;
}

export function randomDelay(random = Math.random) {
    return MIN_DELAY_MS + Math.floor(random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

// Retry-After is either delta-seconds or an HTTP date. Returns milliseconds or null.
export function parseRetryAfter(value, nowMs = Date.now()) {
    if (value == null || value === '') return null;
    if (/^\d+$/.test(String(value).trim())) return parseInt(value, 10) * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

// How long to wait before retrying a failed request, or null once retries are used up.
// kind: 'ratelimit' | 'blocked' | 'network' | 'server'; attempt is 1-based.
export function planRetry(kind, attempt, retryAfterMs = null) {
    if (kind === 'ratelimit' || kind === 'blocked') {
        if (attempt > MAX_RATE_LIMIT_RETRIES) return null;
        const base = retryAfterMs != null
            ? Math.max(retryAfterMs, MIN_RATE_LIMIT_WAIT_MS)
            : COOLDOWN_MS;
        return {
            reason: 'ratelimit',
            waitMs: Math.min(base * 1.5 ** (attempt - 1), MAX_RATE_LIMIT_WAIT_MS)
        };
    }

    const schedule = kind === 'server' ? SERVER_BACKOFF_MS : NETWORK_BACKOFF_MS;
    if (attempt > schedule.length) return null;
    return { reason: kind === 'server' ? 'server' : 'network', waitMs: schedule[attempt - 1] };
}

export function retryFailureMessage(kind) {
    switch (kind) {
        case 'ratelimit':
        case 'blocked':
            return 'Letterboxd keeps rate limiting the requests. Wait a few minutes, then resume.';
        case 'server':
            return 'Letterboxd is not responding properly. Try again later.';
        default:
            return 'Could not reach Letterboxd. Check your connection, then resume.';
    }
}

// Did we collect (almost) as many members as the profile claims exist?
// Only a shortfall matters: extra members just mean someone followed during the scan.
function checkCount(expected, got) {
    if (!expected) return { expected: null, got, ok: null };
    const tolerance = expected.exact
        ? Math.max(2, Math.ceil(expected.value * 0.02))
        : Math.ceil(expected.value * 0.1) + 2;
    return { expected: expected.value, got, ok: expected.value - got <= tolerance };
}

// ok === false  -> pages were probably missed, so the list may contain false positives
// ok === null   -> nothing to compare against (profile counts unreadable)
export function verifyScan(expected, gotFollowers, gotFollowing, truncated = false) {
    const followers = checkCount(expected?.followers, gotFollowers);
    const following = checkCount(expected?.following, gotFollowing);
    const checks = [followers.ok, following.ok].filter(ok => ok !== null);

    let ok = null;
    if (truncated) ok = false;
    else if (checks.length > 0) ok = checks.every(Boolean);

    return { ok, followers, following, truncated };
}

export function verificationWarning(verification) {
    if (!verification || verification.ok !== false) return '';
    const parts = [];
    for (const type of ['followers', 'following']) {
        const check = verification[type];
        if (check && check.ok === false) {
            parts.push(`${type}: read ${check.got.toLocaleString()} of ${check.expected.toLocaleString()}`);
        }
    }
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `⚠️ Some pages may have been missed${detail}. People who do follow you back might be listed. Run a new search to double-check.`;
}

// Pages a quick update of one list is expected to read: the head, plus one probe of the last page.
export function quickPageCount(plan) {
    return Math.ceil((plan.delta + plan.head.length) / PAGE_SIZE) + 1;
}

function expectedPages(scan, type) {
    const expected = scan.expected?.[type];
    return expected ? Math.max(1, Math.ceil(expected.value / PAGE_SIZE)) : null;
}

// Pages this scan expects to read for one list, and how many it has read so far.
function pagesPlanned(scan, type) {
    const plan = scan.plans?.[type];
    return scan.streams[type].mode === 'quick' && plan ? quickPageCount(plan) : expectedPages(scan, type);
}

function pagesRead(stream) {
    return stream.requests ?? stream.next - 1;
}

// A stream that has fetched every page the profile promised is almost certainly finished,
// even though we only learn so by requesting one more (empty) page.
export function likelyDone(scan, type) {
    const stream = scan.streams[type];
    if (stream.done) return true;
    const expected = scan.expected?.[type];
    return Boolean(expected?.exact) && stream.next > expectedPages(scan, type);
}

// { percent: 0-99 | null, pagesDone, pagesTotal }. percent is null when totals are unknown.
export function progressInfo(scan) {
    let pagesDone = 0;
    let pagesTotal = 0;
    let known = scan.phase !== 'profile';

    for (const type of ['followers', 'following']) {
        const stream = scan.streams[type];
        const fetched = pagesRead(stream);
        const total = pagesPlanned(scan, type);
        pagesDone += fetched;
        if (stream.done) pagesTotal += fetched;
        else if (total === null) known = false;
        else pagesTotal += Math.max(total, fetched);
    }

    if (scan.phase === 'profile') return { percent: 0, pagesDone, pagesTotal };
    if (!known || pagesTotal === 0) return { percent: null, pagesDone, pagesTotal };
    return { percent: Math.min(99, Math.round((pagesDone / pagesTotal) * 100)), pagesDone, pagesTotal };
}

// Seconds left, including breaks that are still to come. null if it cannot be estimated.
export function estimateSeconds(scan, nowMs = Date.now()) {
    if (scan.phase === 'profile') return null;

    let rounds = 0;
    for (const type of ['followers', 'following']) {
        const stream = scan.streams[type];
        if (stream.done) continue;
        const total = pagesPlanned(scan, type);
        if (total === null) return null;
        rounds = Math.max(rounds, total - pagesRead(stream));
    }
    rounds = Math.max(0, rounds);

    const breaks = rounds > 0
        ? Math.max(0, Math.ceil((scan.windowRounds + rounds) / REQUESTS_PER_WINDOW) - 1)
        : 0;
    const pending = Math.max(0, (scan.resumeAt - nowMs) / 1000);

    return Math.ceil(rounds * AVG_REQUEST_SECONDS + breaks * (COOLDOWN_MS / 1000) + pending);
}

export function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.ceil(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
