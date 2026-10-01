// Popup UI. The scan itself runs in the background service worker (lib/engine.js) and keeps its
// state in chrome.storage.local, so everything shown here is rendered from storage:
//   scan        progress of the running (or failed) scan
//   scanResult  result of the last finished scan (not following back, fans, mutuals, tracking)
//   history     change log per account ("who unfollowed me since last scan")
//   ignored     names hidden from the "not following back" list (this file is the only writer)
//   profiles    display names and avatars of members (cosmetic)
//   prefs       settings (this file is the only writer); autoCheck: outcome of the last background check

import { toCsv, toJson } from './lib/export.js';
import { isValidUsername, normalizeUsername, safeAvatarUrl } from './lib/parser.js';
import { normalizePrefs } from './lib/prefs.js';
import { profileOf } from './lib/profiles.js';
import { estimateSeconds, formatDuration, progressInfo, verificationWarning } from './lib/scan.js';

const $ = id => document.getElementById(id);
const IDLE_INFO = '✅ You can close this window. Analysis runs in background.';
const RENDER_LIMIT = 300;       // rows drawn before "Show all"; keeps huge mutual lists snappy
const HISTORY_SHOWN = 10;       // change-log entries shown in the Changes tab

const TABS = {
    unfollowers: { title: 'Not Following Back', file: 'not_following_back' },
    fans: { title: 'Fans (They Follow You)', file: 'fans' },
    mutuals: { title: 'Mutual Followers', file: 'mutual_followers' },
    changes: { title: 'Changes Since Last Scan', file: 'changes' }
};
const EXPORT_FORMATS = {
    txt: { extension: 'txt', type: 'text/plain' },
    csv: { extension: 'csv', type: 'text/csv' },
    json: { extension: 'json', type: 'application/json' }
};

let scan = null;            // scan state from storage, or null
let result = null;          // last finished result from storage, or null
let history = {};           // change log from storage
let ignored = {};           // hidden names from storage: { [account]: [lowercase names] }
let profiles = {};          // display names / avatars from storage
let profilesFor = null;     // scanId the profiles above were loaded for
let prefs = normalizePrefs(undefined);
let autoCheck = null;       // outcome of the last background check
let filterText = '';        // lowercase text typed in the filter box
let prefilled = false;      // the username box has been filled once
let settingsNote = '';      // short-lived message in the settings panel
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
$('copyBtn').addEventListener('click', copyList);
$('filter').addEventListener('input', event => {
    filterText = event.target.value.trim().toLowerCase();
    showAll = false;
    if (result) renderResults();
});
$('sortSelect').addEventListener('change', event => savePrefs({ ...prefs, sort: event.target.value }));
$('prefAvatars').addEventListener('change', event => savePrefs({ ...prefs, avatars: event.target.checked }));
$('prefBadges').addEventListener('change', event => savePrefs({ ...prefs, pageBadges: event.target.checked }));
$('prefDaily').addEventListener('change', toggleDaily);
$('prefNotify').addEventListener('change', toggleNotify);

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
    if (area === 'local' && (changes.scan || changes.scanResult || changes.history || changes.ignored || changes.prefs || changes.autoCheck)) refresh();
});

init();

async function init() {
    send({ type: 'SYNC' });     // wakes the worker so it can resume an interrupted scan
    clearBadge();               // opening the popup is "looking": the unfollow count on the icon is done
    await refresh();
}

function clearBadge() {
    try {
        chrome.action.setBadgeText({ text: '' });
    } catch { /* not critical */ }
}

async function send(message) {
    try {
        return (await chrome.runtime.sendMessage(message)) ?? { ok: false, error: 'The background worker did not answer.' };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

// If the active tab is a Letterboxd profile, that is probably who the user wants to check.
// (Tab addresses are visible to the extension because it has host access to letterboxd.com.)
async function activeTabUsername() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab?.url ? normalizeUsername(tab.url) : null;
    } catch {
        return null;
    }
}

async function refresh() {
    const head = await chrome.storage.local.get(['scan', 'lastUsername', 'prefs', 'autoCheck']);
    scan = head.scan ?? null;
    prefs = normalizePrefs(head.prefs);
    autoCheck = head.autoCheck ?? null;

    // Results (and the potentially large history and face data) are only needed when no scan is running.
    if (scan) {
        result = null;
    } else {
        const data = await chrome.storage.local.get(['scanResult', 'history', 'ignored']);
        result = data.scanResult ?? null;
        history = data.history ?? {};
        ignored = data.ignored ?? {};

        const resultKey = result?.scanId ?? 'legacy';
        if (result && profilesFor !== resultKey) {
            profiles = (await chrome.storage.local.get('profiles')).profiles ?? {};
            profilesFor = resultKey;
        }
    }

    const input = $('username');
    if (!prefilled && !input.value) {
        const candidate = scan?.username ?? result?.username ?? await activeTabUsername() ?? head.lastUsername ?? '';
        if (candidate) {
            input.value = candidate;
            prefilled = true;
        }
    }

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
    renderSettings();
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

const label = name => profileOf(profiles, name).name ?? name;
const matchesFilter = name => filterText === '' || name.toLowerCase().includes(filterText) || label(name).toLowerCase().includes(filterText);

// A list as displayed: filtered by the box and ordered by the setting.
function arranged(names) {
    const matching = names.filter(matchesFilter);
    return prefs.sort === 'name'
        ? [...matching].sort((a, b) => label(a).localeCompare(label(b), undefined, { sensitivity: 'base' }))
        : matching;
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
    $('verification').textContent = warning;
    show($('verification'), warning !== '');
    $('sortSelect').value = prefs.sort;
    show($('sortSelect'), activeTab !== 'changes');

    const toggle = $('hiddenToggle');
    show(toggle, activeTab === 'unfollowers' && view.hidden.length > 0);
    toggle.textContent = hiddenMode ? '← Back to the list' : `Show hidden (${view.hidden.length})`;

    const list = $('list');
    list.replaceChildren();

    // The names this tab lists, before and after the filter.
    const source = activeTab === 'fans' ? view.fans
        : activeTab === 'mutuals' ? view.mutuals
            : hiddenMode ? view.hidden : view.shown;
    const items = source ? arranged(source) : [];
    $('count').textContent = activeTab === 'changes'
        ? (counts.changes || 0)
        : filterText && source ? `${items.length} / ${source.length}` : (source?.length ?? 0);

    if (activeTab === 'changes') {
        renderChanges(list, view);
    } else if (source === null) {
        appendNote(list, 'Run a new scan to see this list.', 'empty-state');
    } else if (source.length === 0) {
        appendNote(list, emptyText(view, warning), 'empty-state');
    } else if (items.length === 0) {
        appendNote(list, `No names match "${$('filter').value.trim()}".`, 'empty-state');
    } else {
        appendRows(list, items, name => userRow(name, activeTab === 'unfollowers' ? { dimmed: hiddenMode, action: hideAction(name, !hiddenMode) } : {}));
    }
}

function emptyText(view, warning) {
    if (activeTab === 'fans') return 'Nobody follows you without being followed back.';
    if (activeTab === 'mutuals') return 'No mutual followers yet.';
    if (warning) return 'No unfollowers found in the pages that were read.';
    return view.hidden.length > 0
        ? 'Nobody left here: everyone else is hidden or follows you back.'
        : '🎉 Everyone you follow follows you back!';
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
        const lost = entry.lost.filter(isValidUsername).filter(matchesFilter);
        const gained = entry.gained.filter(isValidUsername).filter(matchesFilter);

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

// Round avatar, or a letter in a circle when there is no picture (or it fails to load).
function avatarNode(name, face) {
    const initial = () => {
        const fallback = document.createElement('span');
        fallback.className = 'avatar avatar-fallback';
        fallback.dataset.letter = (face.name ?? name).charAt(0).toUpperCase();
        fallback.setAttribute('aria-hidden', 'true');
        return fallback;
    };

    const src = face.avatar ? safeAvatarUrl(face.avatar) : null;
    if (!src) return initial();

    const image = document.createElement('img');
    image.className = 'avatar';
    image.src = src;
    image.alt = '';
    image.width = 24;
    image.height = 24;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';       // Letterboxd's image host does not need to know where we are
    image.addEventListener('error', () => image.replaceWith(initial()), { once: true });
    return image;
}

function userRow(name, { prefix = '', hint = '', action = null, dimmed = false } = {}) {
    const face = profileOf(profiles, name);
    const item = document.createElement('li');
    const link = document.createElement('a');
    const who = document.createElement('span');
    const arrow = document.createElement('span');

    item.className = `row${dimmed ? ' dimmed' : ''}`;
    link.className = 'person';
    link.href = profileLink(name);

    if (prefix) {
        const mark = document.createElement('span');
        mark.className = 'prefix';
        mark.textContent = prefix;
        link.append(mark);
    }
    if (prefs.avatars) {
        link.append(avatarNode(name, face));
    } else if (!prefix) {
        const mark = document.createElement('span');
        mark.className = 'prefix';
        mark.textContent = '👤';
        link.append(mark);
    }

    who.className = 'who';
    who.textContent = face.name ?? name;
    if (face.name) {
        const handle = document.createElement('small');
        handle.className = 'handle';
        handle.textContent = `@${name}`;
        who.append(handle);
    }
    link.append(who);

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
    filterText = '';
    $('filter').value = '';

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
    if (response.ok) {
        profiles = {};
        profilesFor = null;
    }
    flashFooter(response.ok ? '🗑️ Saved history, hidden names and faces cleared.' : `❌ ${response.error}`);
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

function flashFooter(text) {
    footerNote = text;
    renderLive();
    setTimeout(() => {
        footerNote = '';
        renderLive();
    }, 4000);
}

// --- Export and copy: both mirror the tab that is open, as filtered and ordered on screen ---

// Names of the list tab that is open (hidden names excluded unless the hidden view is open).
function listedNames(view) {
    const source = activeTab === 'fans' ? view.fans
        : activeTab === 'mutuals' ? view.mutuals
            : showHidden ? view.hidden : view.shown;
    return arranged(source ?? []);
}

// One record per person for list tabs; one per change for the Changes tab.
function exportRecords(view) {
    const record = name => ({ username: name, displayName: profileOf(profiles, name).name ?? '', profileUrl: profileLink(name) });

    if (activeTab !== 'changes') {
        return { columns: ['username', 'displayName', 'profileUrl'], records: listedNames(view).map(record) };
    }

    const records = [];
    for (const entry of view.entries) {
        const youFollow = new Set(entry.lostYouFollow.map(name => name.toLowerCase()));
        for (const [change, names] of [['left', entry.lost], ['new', entry.gained]]) {
            for (const name of names.filter(isValidUsername).filter(matchesFilter)) {
                records.push({
                    date: new Date(entry.at).toISOString().slice(0, 10),
                    change,
                    ...record(name),
                    youFollow: change === 'left' ? youFollow.has(name.toLowerCase()) : ''
                });
            }
        }
    }
    return { columns: ['date', 'change', 'username', 'displayName', 'profileUrl', 'youFollow'], records };
}

function exportText(view, warning) {
    const filterNote = filterText ? ` (filtered by "${$('filter').value.trim()}")` : '';
    const withWarning = lines => (warning ? [lines[0], warning, ...lines.slice(1)] : lines);
    const links = users => ['', ...users.map(profileLink)];

    switch (activeTab) {
        case 'fans':
            return withWarning([`Users who follow you but are not followed back (${listedNames(view).length})${filterNote}:`, ...links(listedNames(view))]);
        case 'mutuals':
            return withWarning([`Mutual followers (${listedNames(view).length})${filterNote}:`, ...links(listedNames(view))]);
        case 'changes': {
            const lines = [trackingNote(view.tracking)];
            for (const entry of view.entries) {
                lines.push('', `${formatDate(entry.at)}: ${entry.lostCount} left, ${entry.gainedCount} new`);
                lines.push(...entry.lost.filter(isValidUsername).filter(matchesFilter).map(name => `- ${profileLink(name)}`));
                lines.push(...entry.gained.filter(isValidUsername).filter(matchesFilter).map(name => `+ ${profileLink(name)}`));
            }
            return lines;
        }
        default: {
            const hiddenNote = !showHidden && view.hidden.length > 0 ? ` (${view.hidden.length} hidden not included)` : '';
            const names = listedNames(view);
            return withWarning([`${showHidden ? 'Hidden users' : 'Users not following back'} (${names.length})${hiddenNote}${filterNote}:`, ...links(names)]);
        }
    }
}

function downloadResults() {
    const view = resultView();
    const format = EXPORT_FORMATS[$('exportFormat').value] ?? EXPORT_FORMATS.txt;
    const { columns, records } = exportRecords(view);

    let content;
    if (format.extension === 'csv') {
        content = toCsv(columns, records);
    } else if (format.extension === 'json') {
        content = toJson({
            exportedAt: new Date().toISOString(),
            account: result.username,
            list: activeTab,
            filter: filterText ? $('filter').value.trim() : null,
            scanCompletedAt: result.completedAt ? new Date(result.completedAt).toISOString() : null
        }, records);
    } else {
        content = exportText(view, verificationWarning(result.verification)).join('\n');
    }

    const blob = new Blob([content], { type: format.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${TABS[activeTab].file}.${format.extension}`;
    a.click();
    URL.revokeObjectURL(url);
}

async function copyList() {
    const { records } = exportRecords(resultView());
    if (records.length === 0) {
        flashFooter('Nothing to copy.');
        return;
    }

    const lines = records.map(record => (record.change ? `${record.change === 'left' ? '-' : '+'} ${record.profileUrl}` : record.profileUrl));
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        flashFooter(`📋 Copied ${records.length} ${records.length === 1 ? 'link' : 'links'}.`);
    } catch {
        flashFooter('❌ The browser did not allow copying.');
    }
}

// --- Settings ---

async function savePrefs(next) {
    prefs = normalizePrefs(next);
    await chrome.storage.local.set({ prefs });
    render();
}

function formatDateTime(timestamp) {
    return new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function dailyStatusText() {
    if (settingsNote) return settingsNote;
    if (!prefs.daily.enabled) return '';
    if (!autoCheck) return 'The first check runs about 24 hours after you turned this on.';
    if (!autoCheck.ok) return `Last check (${formatDateTime(autoCheck.at)}) did not finish: ${autoCheck.error}`;

    const changes = [];
    if (autoCheck.lost > 0) changes.push(`${autoCheck.lost} left`);
    if (autoCheck.gained > 0) changes.push(`${autoCheck.gained} new`);
    return `Last check ${formatDateTime(autoCheck.at)}: ${changes.join(', ') || 'no changes'}.`;
}

function renderSettings() {
    $('prefAvatars').checked = prefs.avatars;
    $('prefBadges').checked = prefs.pageBadges;
    $('prefDaily').checked = prefs.daily.enabled;
    $('prefNotify').checked = prefs.daily.notify;
    $('prefNotify').disabled = !prefs.daily.enabled;
    $('dailyAccount').textContent = prefs.daily.enabled ? ` for @${prefs.daily.username}` : '';
    $('settingsNote').textContent = dailyStatusText();
}

function noteSetting(text) {
    settingsNote = text;
    renderSettings();
    setTimeout(() => {
        settingsNote = '';
        renderSettings();
    }, 5000);
}

async function toggleDaily(event) {
    if (!event.target.checked) {
        await savePrefs({ ...prefs, daily: { ...prefs.daily, enabled: false } });
        return;
    }

    // A background check compares with the last scan, so there has to be one.
    const account = result?.username ?? scan?.username ?? prefs.daily.username;
    if (!account) {
        event.target.checked = false;
        noteSetting('Run a scan first, then turn this on.');
        return;
    }
    await savePrefs({ ...prefs, daily: { ...prefs.daily, enabled: true, username: account } });
}

async function toggleNotify(event) {
    if (!event.target.checked) {
        await savePrefs({ ...prefs, daily: { ...prefs.daily, notify: false } });
        return;
    }

    // Asked now, from this click, and only if the user wants notifications.
    let granted = false;
    try {
        granted = await chrome.permissions.request({ permissions: ['notifications'] });
    } catch { /* treated as refused */ }

    if (!granted) {
        event.target.checked = false;
        noteSetting('Notifications were not allowed, so only the icon badge will be used.');
        return;
    }
    await savePrefs({ ...prefs, daily: { ...prefs.daily, notify: true } });
}
