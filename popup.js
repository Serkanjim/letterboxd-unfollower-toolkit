// Popup UI. The scan itself runs in the background service worker (lib/engine.js) and keeps its
// state in chrome.storage.local, so everything shown here is rendered from storage:
//   scan        progress of the running (or failed) scan
//   scanResult  result of the last finished scan (not following back, fans, mutuals, tracking)
//   history     change log per account ("who unfollowed me since last scan")
//   ignored     names hidden from the "not following back" list (this file is the only writer)

import { isValidUsername, normalizeUsername } from './lib/parser.js';
import { estimateSeconds, formatDuration, progressInfo, verificationWarning } from './lib/scan.js';

const $ = id => document.getElementById(id);
const IDLE_INFO = '✅ You can close this window. Analysis runs in background.';
const RENDER_LIMIT = 300;       // rows drawn before "Show all"; keeps huge mutual lists snappy
const HISTORY_SHOWN = 10;       // change-log entries shown in the Changes tab

const TABS = {
    unfollowers: { title: 'Not Following Back', file: 'not_following_back.txt' },
    fans: { title: 'Fans (They Follow You)', file: 'fans.txt' },
    mutuals: { title: 'Mutual Followers', file: 'mutual_followers.txt' },
    changes: { title: 'Changes Since Last Scan', file: 'changes.txt' }
};

let scan = null;            // scan state from storage, or null
let result = null;          // last finished result from storage, or null
let history = {};           // change log from storage
let ignored = {};           // hidden names from storage: { [account]: [lowercase names] }
let localMessage = '';      // validation / request errors that are not part of the scan state
let footerNote = '';        // short-lived message in the footer
let ticker = null;          // 1s timer that keeps countdowns fresh while a scan is active
let activeTab = 'unfollowers';
let showHidden = false;     // "not following back" tab: list the hidden names instead
let showAll = false;        // lift RENDER_LIMIT for the current list
let clearTimer = null;      // armed while "Clear saved history" waits for its confirming click

$('checkBtn').addEventListener('click', startProcess);
$('resumeBtn').addEventListener('click', resumeScan);
$('cancelBtn').addEventListener('click', discard);
$('resetBtn').addEventListener('click', discard);
$('downloadBtn').addEventListener('click', downloadResults);
$('clearDataBtn').addEventListener('click', clearHistory);
$('hiddenToggle').addEventListener('click', () => {
    showHidden = !showHidden;
    showAll = false;
    renderResults();
});
$('username').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !$('checkBtn').disabled) startProcess();
});

const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
document.querySelector('.tabs').addEventListener('keydown', event => {
    const index = tabs.findIndex(tab => tab.dataset.tab === activeTab);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[(target + tabs.length) % tabs.length];
    selectTab(next.dataset.tab);
    next.focus();
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.scan || changes.scanResult || changes.history || changes.ignored)) refresh();
});

init();

async function init() {
    send({ type: 'SYNC' });     // wakes the worker so it can resume an interrupted scan
    await refresh();
}

async function send(message) {
    try {
        return (await chrome.runtime.sendMessage(message)) ?? { ok: false, error: 'The background worker did not answer.' };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

async function refresh() {
    const head = await chrome.storage.local.get(['scan', 'lastUsername']);
    scan = head.scan ?? null;

    // Results (and the potentially large history) are only needed when no scan is running.
    if (scan) {
        result = null;
    } else {
        const data = await chrome.storage.local.get(['scanResult', 'history', 'ignored']);
        result = data.scanResult ?? null;
        history = data.history ?? {};
        ignored = data.ignored ?? {};
    }

    const input = $('username');
    if (!input.value) input.value = scan?.username ?? result?.username ?? head.lastUsername ?? '';

    render();
}

// --- Rendering ---

function show(node, visible) {
    node.classList.toggle('hidden', !visible);
}

function render() {
    const scanning = scan?.status === 'running';
    const failed = scan?.status === 'error';
    const showResults = !scan && result !== null;

    show($('search-view'), !showResults);
    show($('results-view'), showResults);
    show($('status'), !showResults);
    show($('progress-container'), scanning);
    show($('resumeBtn'), failed && Boolean(scan.error?.retryable));
    show($('cancelBtn'), scan !== null);

    $('checkBtn').disabled = scanning;
    $('checkBtn').querySelector('.btn-text').textContent = scanning ? 'Processing...' : 'Check Unfollowers';

    if (showResults) renderResults();
    renderLive();

    if (scanning && !ticker) ticker = setInterval(renderLive, 1000);
    if (!scanning && ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

// The parts that change with time: status text, progress bar and the footer hint.
function renderLive() {
    const now = Date.now();

    if (!scan) {
        $('status').textContent = localMessage;
        $('windowInfo').textContent = footerNote || (result ? completionText(result) : IDLE_INFO);
        return;
    }

    $('status').textContent = describeScan(scan, now);
    if (scan.status !== 'running') {
        $('windowInfo').textContent = IDLE_INFO;
        return;
    }

    const { percent } = progressInfo(scan);
    $('progressFill').style.width = `${percent ?? 5}%`;
    $('progressText').textContent = percent === null ? '…' : `${percent}%`;
    if (percent === null) $('progressBar').removeAttribute('aria-valuenow');
    else $('progressBar').setAttribute('aria-valuenow', String(percent));

    $('windowInfo').textContent = etaText(estimateSeconds(scan, now));
}

// "Analysis complete", plus how it was done when we know: quick updates read far fewer pages.
function completionText(finished) {
    const info = finished.scanInfo;
    if (!info) return '✅ Analysis complete!';
    const how = info.mode === 'full' ? 'full scan' : info.mode === 'quick' ? 'quick update' : 'partly quick update';
    return `✅ Analysis complete · ${how}, ${info.pages} ${info.pages === 1 ? 'page' : 'pages'} read`;
}

function describeScan(state, now) {
    if (state.status === 'error') {
        return `❌ Error: ${state.error?.message ?? 'Something went wrong.'}`;
    }

    if (state.resumeAt > now) {
        const left = formatDuration((state.resumeAt - now) / 1000);
        switch (state.wait?.reason) {
            case 'cooldown':
                return `☕ Taking a short break to avoid rate limits...\n⏳ ${left} remaining`;
            case 'ratelimit':
                return `⏸️ Rate limited!\n⏳ Retrying in ${left}`;
            case 'server':
                return `⚠️ Letterboxd is not answering properly.\n⏳ Retrying in ${left}`;
            default:
                return `📡 Connection problem.\n⏳ Retrying in ${left}`;
        }
    }

    if (state.phase === 'profile') return '🔎 Checking user...';

    const { followers, following } = state.expected ?? {};

    // Both lists are being checked against the previous scan instead of being read in full.
    if (['followers', 'following'].some(type => state.streams[type].mode === 'quick' && !state.streams[type].done)) {
        return '⚡ Quick update: checking what changed\n🕘 since your last scan...';
    }

    const page = Math.max(state.streams.followers.next, state.streams.following.next);
    const totals = followers && following
        ? `\n👥 ${countLabel(followers)} followers · ${countLabel(following)} following`
        : '';
    return `🚀 Fetching page ${page}...${totals}`;
}

function countLabel(count) {
    return `${count.exact ? '' : '~'}${count.value.toLocaleString()}`;
}

function etaText(seconds) {
    if (seconds === null) return IDLE_INFO;
    if (seconds <= 30) return '✅ Almost done! Just a few seconds...';
    const minutes = Math.ceil(seconds / 60);
    if (minutes > 1) return `✅ You can close this window. Come back in ${minutes} minutes.`;
    if (minutes === 1) return '✅ You can close this window. Come back in 1 minute.';
    return '✅ Almost done! Just a few seconds...';
}

function formatDate(timestamp) {
    return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// --- Result tabs ---

function selectTab(id) {
    if (!TABS[id]) return;
    activeTab = id;
    showHidden = false;
    showAll = false;
    if (result) renderResults();
}

// Everything the tabs display, derived from the stored result, the hidden list and the history.
function resultView() {
    const owner = result.username.toLowerCase();
    const hiddenKeys = new Set(ignored[owner] ?? []);
    const named = list => (Array.isArray(list) ? list.filter(isValidUsername) : null);

    const unfollowers = named(result.unfollowers) ?? [];
    const tracking = result.tracking ?? null;

    return {
        owner,
        shown: unfollowers.filter(name => !hiddenKeys.has(name.toLowerCase())),
        hidden: unfollowers.filter(name => hiddenKeys.has(name.toLowerCase())),
        fans: named(result.fans),             // null for results saved by older versions
        mutuals: named(result.mutuals),
        tracking,
        changeCount: tracking?.status === 'ok' ? tracking.gained + tracking.lost : 0,
        entries: (history[owner] ?? []).slice(0, HISTORY_SHOWN)
    };
}

function renderResults() {
    const view = resultView();
    const warning = verificationWarning(result.verification);

    const counts = {
        unfollowers: view.shown.length,
        fans: view.fans?.length ?? '',
        mutuals: view.mutuals?.length ?? '',
        changes: view.changeCount || ''
    };
    for (const tab of tabs) {
        const selected = tab.dataset.tab === activeTab;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        tab.querySelector('.tab-count').textContent = counts[tab.dataset.tab];
    }

    const hiddenMode = activeTab === 'unfollowers' && showHidden && view.hidden.length > 0;
    if (activeTab === 'unfollowers' && showHidden && view.hidden.length === 0) showHidden = false;

    $('resultsTitle').textContent = hiddenMode ? 'Hidden Users' : TABS[activeTab].title;
    $('count').textContent = hiddenMode ? view.hidden.length : (counts[activeTab] || 0);
    $('verification').textContent = warning;
    show($('verification'), warning !== '');

    const toggle = $('hiddenToggle');
    show(toggle, activeTab === 'unfollowers' && view.hidden.length > 0);
    toggle.textContent = hiddenMode ? '← Back to the list' : `Show hidden (${view.hidden.length})`;

    const list = $('list');
    list.replaceChildren();

    switch (activeTab) {
        case 'unfollowers':
            if (hiddenMode) {
                appendRows(list, view.hidden, name => userRow(name, { dimmed: true, action: hideAction(name, false) }));
            } else if (view.shown.length === 0) {
                appendNote(list, warning
                    ? 'No unfollowers found in the pages that were read.'
                    : view.hidden.length > 0
                        ? 'Nobody left here: everyone else is hidden or follows you back.'
                        : '🎉 Everyone you follow follows you back!', 'empty-state');
            } else {
                appendRows(list, view.shown, name => userRow(name, { action: hideAction(name, true) }));
            }
            break;
        case 'fans':
            renderPlainList(list, view.fans, 'Nobody follows you without being followed back.');
            break;
        case 'mutuals':
            renderPlainList(list, view.mutuals, 'No mutual followers yet.');
            break;
        case 'changes':
            renderChanges(list, view);
            break;
    }
}

function renderPlainList(list, users, emptyText) {
    if (users === null) appendNote(list, 'Run a new scan to see this list.', 'empty-state');
    else if (users.length === 0) appendNote(list, emptyText, 'empty-state');
    else appendRows(list, users, name => userRow(name));
}

function trackingNote(tracking) {
    switch (tracking?.status) {
        case 'first':
            return '📌 First scan saved. Scan again later to see who unfollowed you and who followed you.';
        case 'ok':
            return `Compared with your scan from ${formatDate(tracking.previousAt)}.`
                + (tracking.gained + tracking.lost === 0 ? ' No changes.' : '');
        case 'skipped':
            return '⚠️ Changes were not compared because this scan could not be fully verified. Your saved history was left untouched.';
        case 'unavailable':
            return '⚠️ The history could not be saved (browser storage is full). Try "Clear saved history", then scan again.';
        default:
            return 'Run a new scan to start tracking changes.';
    }
}

function renderChanges(list, view) {
    appendNote(list, trackingNote(view.tracking));

    for (const entry of view.entries) {
        const title = document.createElement('li');
        title.className = 'section-title';
        const counts = [];
        if (entry.lostCount > 0) counts.push(`−${entry.lostCount} left`);
        if (entry.gainedCount > 0) counts.push(`+${entry.gainedCount} new`);
        title.textContent = [formatDate(entry.at), ...counts].join(' · ');
        list.append(title);

        const youFollow = new Set(entry.lostYouFollow.map(name => name.toLowerCase()));
        const lost = entry.lost.filter(isValidUsername);
        const gained = entry.gained.filter(isValidUsername);

        for (const name of lost) {
            list.append(userRow(name, {
                prefix: '➖',
                hint: youFollow.has(name.toLowerCase()) ? 'you follow them' : ''
            }));
        }
        if (entry.lostCount > entry.lost.length) appendNote(list, `…and ${entry.lostCount - entry.lost.length} more who left.`);

        for (const name of gained) list.append(userRow(name, { prefix: '➕' }));
        if (entry.gainedCount > entry.gained.length) appendNote(list, `…and ${entry.gainedCount - entry.gained.length} more new followers.`);
    }
}

function appendNote(list, text, className = 'note') {
    const item = document.createElement('li');
    item.className = className;
    item.textContent = text;
    list.append(item);
}

// Draws the first RENDER_LIMIT rows and a "Show all" row for the rest.
function appendRows(list, users, build) {
    const limit = showAll ? users.length : RENDER_LIMIT;
    for (const name of users.slice(0, limit)) list.append(build(name));

    if (users.length > limit) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        item.className = 'more';
        button.className = 'link-btn';
        button.type = 'button';
        button.textContent = `Show all ${users.length.toLocaleString()}`;
        button.addEventListener('click', () => {
            showAll = true;
            renderResults();
        });
        item.append(button);
        list.append(item);
    }
}

function userRow(name, { prefix = '👤', hint = '', action = null, dimmed = false } = {}) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const arrow = document.createElement('span');

    item.className = `row${dimmed ? ' dimmed' : ''}`;
    link.href = profileLink(name);
    link.textContent = `${prefix} ${name}`;

    if (hint) {
        const note = document.createElement('span');
        note.className = 'hint';
        note.textContent = hint;
        link.append(note);
    }

    arrow.className = 'ext-arrow';
    arrow.textContent = '↗';
    link.append(arrow);
    link.addEventListener('click', event => {
        event.preventDefault();
        openSmartWindow(link.href);
    });
    item.append(link);

    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'row-action';
        button.textContent = action.label;
        button.setAttribute('aria-label', `${action.label} ${name}`);
        button.addEventListener('click', action.run);
        item.append(button);
    }
    return item;
}

function hideAction(name, hide) {
    return { label: hide ? 'Hide' : 'Unhide', run: () => setHidden(name, hide) };
}

// --- Actions ---

async function setHidden(name, hide) {
    const owner = result.username.toLowerCase();
    const names = new Set(ignored[owner] ?? []);
    if (hide) names.add(name.toLowerCase());
    else names.delete(name.toLowerCase());

    ignored = { ...ignored, [owner]: [...names] };
    renderResults();                                    // update right away, storage follows
    await chrome.storage.local.set({ ignored });
}

async function startProcess() {
    const username = normalizeUsername($('username').value);
    if (!username) {
        localMessage = '❌ Please enter a valid Letterboxd username (or paste a profile URL).';
        renderLive();
        return;
    }

    $('username').value = username;
    localMessage = '⏳ Starting...';
    $('checkBtn').disabled = true;
    renderLive();

    activeTab = 'unfollowers';
    showHidden = false;
    showAll = false;

    const response = await send({ type: 'START_SCAN', username, full: $('fullScan').checked });
    localMessage = response.ok ? '' : `❌ ${response.error}`;
    await refresh();
}

async function resumeScan() {
    $('resumeBtn').disabled = true;
    const response = await send({ type: 'RESUME_SCAN' });
    $('resumeBtn').disabled = false;
    localMessage = response.ok ? '' : `❌ ${response.error}`;
    await refresh();
}

// Cancels a running scan or leaves the results; the saved history and hidden list are kept.
async function discard() {
    await send({ type: 'CANCEL_SCAN' });
    localMessage = '';
    await refresh();
    $('username').focus();
    $('username').select();
}

function resetClearButton() {
    clearTimeout(clearTimer);
    clearTimer = null;
    $('clearDataBtn').textContent = 'Clear saved history';
}

// Two clicks, so a stray click cannot wipe the history.
async function clearHistory() {
    if (!clearTimer) {
        $('clearDataBtn').textContent = 'Click again to confirm';
        clearTimer = setTimeout(resetClearButton, 4000);
        return;
    }

    resetClearButton();
    const response = await send({ type: 'CLEAR_HISTORY' });
    footerNote = response.ok ? '🗑️ Saved history and hidden names cleared.' : `❌ ${response.error}`;
    setTimeout(() => {
        footerNote = '';
        renderLive();
    }, 4000);
    await refresh();
}

function profileLink(username) {
    return `https://letterboxd.com/${username}/`;
}

function openSmartWindow(url) {
    const width = 610;
    const height = 700;
    const left = (screen.width - width) / 2;
    const top = (screen.height - height) / 2;

    window.open(url, 'LetterboxdUser', `width=${width},height=${height},top=${top},left=${left},scrollbars=yes,resizable=yes`);
}

// The text file mirrors the tab that is currently open.
function exportLines(view, warning) {
    const withWarning = lines => (warning ? [lines[0], warning, ...lines.slice(1)] : lines);
    const links = users => ['', ...users.map(profileLink)];

    switch (activeTab) {
        case 'fans':
            return withWarning([`Users who follow you but are not followed back (${view.fans?.length ?? 0}):`, ...links(view.fans ?? [])]);
        case 'mutuals':
            return withWarning([`Mutual followers (${view.mutuals?.length ?? 0}):`, ...links(view.mutuals ?? [])]);
        case 'changes': {
            const lines = [trackingNote(view.tracking)];
            for (const entry of view.entries) {
                lines.push('', `${formatDate(entry.at)}: ${entry.lostCount} left, ${entry.gainedCount} new`);
                lines.push(...entry.lost.filter(isValidUsername).map(name => `- ${profileLink(name)}`));
                lines.push(...entry.gained.filter(isValidUsername).map(name => `+ ${profileLink(name)}`));
            }
            return lines;
        }
        default: {
            const hiddenNote = view.hidden.length > 0 ? ` (${view.hidden.length} hidden not included)` : '';
            return withWarning([`Users not following back (${view.shown.length})${hiddenNote}:`, ...links(view.shown)]);
        }
    }
}

function downloadResults() {
    const lines = exportLines(resultView(), verificationWarning(result.verification));

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = TABS[activeTab].file;
    a.click();
    URL.revokeObjectURL(url);
}
