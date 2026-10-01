// Background service worker for Letterboxd Unfollower Toolkit.
// All scan logic lives in lib/engine.js. This file only connects it to chrome.* APIs.
//
// Progress is persisted in chrome.storage.local and the popup renders straight from storage, so
// an interrupted service worker simply resumes the scan when chrome.alarms wakes it up again.

import { createEngine } from './lib/engine.js';
import { describeUnfollows } from './lib/alerts.js';
import { normalizePrefs } from './lib/prefs.js';

const WAKE_ALARM = 'lb-scan-wake';          // fires when a break or retry wait is over
const WATCHDOG_ALARM = 'lb-scan-watchdog';  // restarts the loop if the worker was stopped mid-scan
const DAILY_ALARM = 'lb-daily-check';       // the optional once-a-day background check
const WATCHDOG_PERIOD_MINUTES = 0.5;
const DAILY_PERIOD_MINUTES = 24 * 60;

async function readPrefs() {
    return normalizePrefs((await chrome.storage.local.get('prefs')).prefs);
}

// Badge always; a notification only if the user asked for it and granted the optional permission.
async function notify(summary) {
    const { daily } = await readPrefs();
    const text = describeUnfollows(summary);

    await chrome.action.setBadgeBackgroundColor({ color: '#ff8000' });
    await chrome.action.setBadgeText({ text: text.badge });

    if (daily.notify && await chrome.permissions.contains({ permissions: ['notifications'] }) && chrome.notifications) {
        await chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon.png'),
            title: text.title,
            message: text.message
        });
    }
}

const engine = createEngine({
    storage: chrome.storage.local,
    fetchImpl: (url, options) => fetch(url, options),
    notify,
    schedule: {
        wakeAt: when => chrome.alarms.create(WAKE_ALARM, { when: Math.max(when, Date.now() + 1000) }),
        clearWake: () => chrome.alarms.clear(WAKE_ALARM),
        watchdog: on => on
            ? chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES })
            : chrome.alarms.clear(WATCHDOG_ALARM)
    }
});

// Keeps the daily alarm in line with the setting (called on every worker start and whenever it changes).
async function syncDailyAlarm() {
    const { daily } = await readPrefs();
    const existing = await chrome.alarms.get(DAILY_ALARM);

    if (daily.enabled) {
        if (!existing) {
            await chrome.alarms.create(DAILY_ALARM, { delayInMinutes: DAILY_PERIOD_MINUTES, periodInMinutes: DAILY_PERIOD_MINUTES });
        }
    } else if (existing) {
        await chrome.alarms.clear(DAILY_ALARM);
    }
}

async function runDailyCheck() {
    const { daily } = await readPrefs();
    if (daily.enabled) await engine.runAuto(daily.username);
}

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === WAKE_ALARM || alarm.name === WATCHDOG_ALARM) engine.ensureRunning();
    if (alarm.name === DAILY_ALARM) runDailyCheck().catch(error => console.error('[daily] check failed', error));
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.prefs) syncDailyAlarm().catch(error => console.error('[daily] sync failed', error));
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Only our own extension pages may drive the scan.
    if (sender.id !== chrome.runtime.id) return false;

    let work;
    switch (request.type) {
        case 'START_SCAN':
            work = engine.start(request.username, { full: request.full === true });
            break;
        case 'CANCEL_SCAN':
            work = engine.cancel();
            break;
        case 'RESUME_SCAN':
            work = engine.resume();
            break;
        case 'CLEAR_HISTORY':
            work = engine.clearHistory();
            break;
        case 'SYNC':
            // Opening the popup wakes the worker, and init() below has already resumed any scan.
            work = Promise.resolve({ ok: true });
            break;
        default:
            return false;
    }

    work.then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true; // keep the channel open for the async response
});

// Runs on every worker start (install, update, browser start, alarm, message).
engine.init().catch(error => console.error('[scan] init failed', error));
syncDailyAlarm().catch(error => console.error('[daily] sync failed', error));
