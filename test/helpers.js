// In-memory stand-ins for chrome.storage, chrome.alarms, the clock and Letterboxd itself.
import { createEngine } from '../lib/engine.js';

// Like chrome.storage.local: promise based, and values are copied on the way in and out.
export function fakeStorage(initial = {}) {
    const data = structuredClone(initial);
    const pick = keys => {
        if (keys == null) return structuredClone(data);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in data) out[key] = structuredClone(data[key]);
        return out;
    };
    return {
        data,
        get: async keys => pick(keys),
        set: async values => { Object.assign(data, structuredClone(values)); },
        remove: async keys => { for (const key of [].concat(keys)) delete data[key]; }
    };
}

export function fakeClock(start = 1_700_000_000_000) {
    const clock = {
        t: start,
        now: () => clock.t,
        sleep: async ms => { clock.t += ms; },
        advance: ms => { clock.t += ms; }
    };
    return clock;
}

export function fakeSchedule() {
    const schedule = {
        wakes: [],
        watchdogOn: false,
        wakeAt: when => schedule.wakes.push(when),
        clearWake: () => { },
        watchdog: on => { schedule.watchdogOn = on; }
    };
    return schedule;
}

export const names = (prefix, count, from = 0) =>
    Array.from({ length: count }, (_, i) => `${prefix}${from + i}`);

export const memberRow = user => `<tr><td><a class="avatar" href="/${user}/"></a><h3><a href="/${user}/" class="name">${user}</a></h3></td></tr>`;

export function profileHtml(username, followers, following) {
    return `<h1>${username}</h1>
        <a href="/${username}/following/"><span class="value">${following.toLocaleString('en-US')}</span><span class="definition">Following</span></a>
        <a href="/${username}/followers/"><span class="value">${followers.toLocaleString('en-US')}</span><span class="definition">Followers</span></a>`;
}

// A fake letterboxd.com. `intercept({ type, page, call })` may return a replacement response
// ({ status, headers, body }) to simulate rate limits, outages and so on; `call` counts the
// requests made so far for that type/page (1-based).
export function fakeLetterboxd({ username = 'me', followers, following, profile, intercept } = {}) {
    const calls = {};
    const log = [];

    const respond = ({ status = 200, headers = {}, body = '' }) => ({
        status,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        text: async () => body
    });

    const fetchImpl = async url => {
        const match = url.match(/^https:\/\/letterboxd\.com\/([^/]+)\/(?:(followers|following)\/page\/(\d+)\/)?$/);
        if (!match) throw new Error(`unexpected URL ${url}`);

        const [, user, type = 'profile', pageText = '0'] = match;
        const page = Number(pageText);
        const key = `${type}:${page}`;
        calls[key] = (calls[key] ?? 0) + 1;
        log.push(key);

        let override = intercept?.({ type, page, call: calls[key], user });
        if (override?.gate) {            // hold the response until the test releases it
            await override.gate;
            override = null;
        }
        if (override) {
            if (override.throw) throw new TypeError('Failed to fetch');
            return respond(override);
        }

        if (user.toLowerCase() !== username.toLowerCase()) return respond({ status: 404 });
        if (type === 'profile') {
            return respond({ body: profile ?? profileHtml(username, followers.length, following.length) });
        }

        const list = type === 'followers' ? followers : following;
        const slice = list.slice((page - 1) * 25, page * 25);
        return slice.length > 0 ? respond({ body: slice.map(memberRow).join('') }) : respond({ status: 404 });
    };

    return { fetchImpl, calls, log };
}

export function makeEngine({ storage = fakeStorage(), clock = fakeClock(), schedule = fakeSchedule(), site, sleep } = {}) {
    const engine = createEngine({
        storage,
        schedule,
        fetchImpl: site.fetchImpl,
        now: clock.now,
        sleep: sleep ?? clock.sleep,
        random: () => 0
    });
    return { engine, storage, clock, schedule, site };
}

// Pretend the alarm fired `ms` later and let the engine run until it stops by itself.
export async function wake({ engine, clock }, ms = 0) {
    clock.advance(ms);
    engine.ensureRunning();
    await engine.whenIdle();
}
