// Background service worker for Letterboxd Unfollower Toolkit.
// All scan logic lives in lib/engine.js. This file only connects it to chrome.* APIs.
//
// Progress is persisted in chrome.storage.local and the popup renders straight from storage, so
// an interrupted service worker simply resumes the scan when chrome.alarms wakes it up again.

import { createEngine } from './lib/engine.js';

const WAKE_ALARM = 'lb-scan-wake';          // fires when a break or retry wait is over
const WATCHDOG_ALARM = 'lb-scan-watchdog';  // restarts the loop if the worker was stopped mid-scan
const WATCHDOG_PERIOD_MINUTES = 0.5;

const engine = createEngine({
    storage: chrome.storage.local,
    fetchImpl: (url, options) => fetch(url, options),
    schedule: {
        wakeAt: when => chrome.alarms.create(WAKE_ALARM, { when: Math.max(when, Date.now() + 1000) }),
        clearWake: () => chrome.alarms.clear(WAKE_ALARM),
        watchdog: on => on
            ? chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES })
            : chrome.alarms.clear(WATCHDOG_ALARM)
    }
});

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === WAKE_ALARM || alarm.name === WATCHDOG_ALARM) engine.ensureRunning();
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
