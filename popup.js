// Popup UI. The scan itself runs in the background service worker (lib/engine.js) and keeps its
// state in chrome.storage.local, so everything shown here is rendered from storage:
//   scan        progress of the running (or failed) scan
//   scanResult  result of the last finished scan

import { isValidUsername, normalizeUsername } from './lib/parser.js';
import { estimateSeconds, formatDuration, progressInfo, verificationWarning } from './lib/scan.js';

const $ = id => document.getElementById(id);
const IDLE_INFO = '✅ You can close this window. Analysis runs in background.';

let scan = null;            // scan state from storage, or null
let result = null;          // last finished result from storage, or null
let localMessage = '';      // validation / request errors that are not part of the scan state
let ticker = null;          // 1s timer that keeps countdowns fresh while a scan is active

$('checkBtn').addEventListener('click', startProcess);
$('resumeBtn').addEventListener('click', resumeScan);
$('cancelBtn').addEventListener('click', () => discard({ clearInput: false }));
$('resetBtn').addEventListener('click', () => discard({ clearInput: true }));
$('downloadBtn').addEventListener('click', downloadResults);
$('username').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !$('checkBtn').disabled) startProcess();
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.scan || changes.scanResult)) refresh();
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
    const data = await chrome.storage.local.get(['scan', 'scanResult']);
    scan = data.scan ?? null;
    result = data.scanResult ?? null;

    const input = $('username');
    if (!input.value) input.value = scan?.username ?? result?.username ?? '';

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
        $('windowInfo').textContent = result ? '✅ Analysis complete!' : IDLE_INFO;
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

    const page = Math.max(state.streams.followers.next, state.streams.following.next);
    const { followers, following } = state.expected ?? {};
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
    const minutes = Math.ceil(seconds / 60);
    if (minutes > 1) return `✅ You can close this window. Come back in ${minutes} minutes.`;
    if (minutes === 1) return '✅ You can close this window. Come back in 1 minute.';
    return '✅ Almost done! Just a few seconds...';
}

function renderResults() {
    const users = result.unfollowers.filter(isValidUsername);
    const warning = verificationWarning(result.verification);

    $('count').textContent = users.length;
    $('verification').textContent = warning;
    show($('verification'), warning !== '');

    const list = $('list');
    list.replaceChildren();

    if (users.length === 0) {
        const item = document.createElement('li');
        item.className = 'empty-state';
        item.textContent = warning
            ? 'No unfollowers found in the pages that were read.'
            : '🎉 Everyone you follow follows you back!';
        list.append(item);
        return;
    }

    for (const name of users) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        const arrow = document.createElement('span');

        link.href = profileLink(name);
        link.textContent = `👤 ${name}`;
        arrow.className = 'ext-arrow';
        arrow.textContent = '↗';
        link.append(arrow);

        link.addEventListener('click', event => {
            event.preventDefault();
            openSmartWindow(link.href);
        });

        item.append(link);
        list.append(item);
    }
}

// --- Actions ---

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

    const response = await send({ type: 'START_SCAN', username });
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

async function discard({ clearInput }) {
    await send({ type: 'CANCEL_SCAN' });
    localMessage = '';
    if (clearInput) $('username').value = '';
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

function downloadResults() {
    const users = result.unfollowers.filter(isValidUsername);
    const warning = verificationWarning(result.verification);

    const lines = [`Users not following back (${users.length}):`];
    if (warning) lines.push(warning);
    lines.push('', ...users.map(profileLink));

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'not_following_back.txt';
    a.click();
    URL.revokeObjectURL(url);
}
