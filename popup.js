document.addEventListener('DOMContentLoaded', restoreState);

// Define Event Listeners
document.getElementById('checkBtn').addEventListener('click', startProcess);
document.getElementById('downloadBtn').addEventListener('click', downloadResults);
document.getElementById('resetBtn').addEventListener('click', resetApp);

let unfollowersList = [];
let etaCountdownInterval = null;
let remainingMinutes = null; // null = ETA not yet calculated
let currentSearchUsername = ''; // Track which username we're searching for

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Info messages - only updates status text, doesn't touch progress bar
    if (message.type === 'INFO_MESSAGE') {
        const statusDiv = document.getElementById('status');
        statusDiv.textContent = message.message;
    }

    if (message.type === 'PROGRESS_UPDATE') {
        updateProgress(message.percentage, message.message);

        // Update ETA when received
        if (message.eta !== null && message.eta !== undefined && message.eta > 0) {
            // Only update ETA with positive values
            // And if there's already an ETA, only allow smaller values (shouldn't go backwards)
            if (remainingMinutes === null || message.eta <= remainingMinutes || !etaCountdownInterval) {
                remainingMinutes = message.eta;
                updateFooterETA();
            }

            // Start countdown if this is the first time
            if (!etaCountdownInterval && message.eta > 0) {
                startETACountdown();
            }
        }
    }

    if (message.type === 'FETCH_COMPLETE') {
        // Only process if this is for our current search
        if (message.username && message.username !== currentSearchUsername) {
            return false;
        }

        unfollowersList = message.unfollowers;
        hideProgress();
        showResultsScreen(unfollowersList);
        resetButtonState();
        stopETACountdown();

        // Reset footer
        document.getElementById('windowInfo').textContent = '✅ Analysis complete!';
    }

    if (message.type === 'FETCH_ERROR') {
        hideProgress();
        document.getElementById('status').textContent = `❌ Error: ${message.error}`;
        resetButtonState();
        stopETACountdown();
    }

    return false;
});

function startETACountdown() {
    // Decrease by one minute every 60 seconds
    etaCountdownInterval = setInterval(() => {
        remainingMinutes--;
        updateFooterETA();

        if (remainingMinutes <= 0) {
            stopETACountdown();
        }
    }, 60000); // 60 seconds
}

function stopETACountdown() {
    if (etaCountdownInterval) {
        clearInterval(etaCountdownInterval);
        etaCountdownInterval = null;
    }
}

function updateFooterETA() {
    const windowInfo = document.getElementById('windowInfo');

    // If ETA not yet calculated, show default message
    if (remainingMinutes === null) {
        windowInfo.textContent = `✅ You can close this window. Analysis runs in background.`;
        return;
    }

    if (remainingMinutes > 1) {
        windowInfo.textContent = `✅ You can close this window. Come back in ${remainingMinutes} minutes.`;
    } else if (remainingMinutes === 1) {
        windowInfo.textContent = `✅ You can close this window. Come back in 1 minute.`;
    } else {
        windowInfo.textContent = `✅ Almost done! Just a few seconds...`;
    }
}

// --- 1. MEMORY MANAGEMENT ---

let statusCheckInterval = null; // Periodic status check while popup is open

function restoreState() {
    if (typeof chrome.storage === 'undefined') {
        console.error("Storage permission not found! Please reload the extension.");
        return;
    }

    // First check if background is still processing
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
        if (response && response.isProcessing) {
            // Background is still working, show progress
            const checkBtn = document.getElementById('checkBtn');
            checkBtn.disabled = true;
            checkBtn.querySelector('.btn-text').textContent = "Processing...";
            showProgress();

            // Show progress
            const progress = response.progress;
            const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
            updateProgress(percentage, progress.message || 'Processing...');

            // Start periodic status check (stay updated while popup is open)
            startStatusCheck();
        }
    });

    chrome.storage.local.get(['savedUnfollowers', 'savedUsername'], (data) => {
        if (data.savedUnfollowers && data.savedUnfollowers.length > 0) {
            unfollowersList = data.savedUnfollowers;
            showResultsScreen(unfollowersList);
            const userInput = document.getElementById('username');
            if (userInput) userInput.value = data.savedUsername || '';
        }
    });
}

// Periodically check status while popup is open
function startStatusCheck() {
    if (statusCheckInterval) return; // Don't start if already running

    statusCheckInterval = setInterval(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
            if (chrome.runtime.lastError) {
                stopStatusCheck();
                return;
            }

            if (response && response.isProcessing) {
                const progress = response.progress;
                const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

                // Only show progress messages when intro is done
                if (response.showProgressMessages) {
                    updateProgress(percentage, progress.message || 'Processing...');
                } else {
                    // During intro - only update progress bar, don't touch message
                    const progressFill = document.querySelector('.progress-fill');
                    const progressText = document.querySelector('.progress-text');
                    if (progressFill) progressFill.style.width = `${percentage}%`;
                    if (progressText) progressText.textContent = `${percentage}%`;
                }
            } else {
                // Process finished, stop status check
                stopStatusCheck();

                // Load and show results from storage
                chrome.storage.local.get(['savedUnfollowers', 'savedUsername'], (data) => {
                    if (data.savedUnfollowers) {
                        unfollowersList = data.savedUnfollowers;
                        hideProgress();
                        showResultsScreen(unfollowersList);
                        resetButtonState();
                        stopETACountdown();
                        document.getElementById('windowInfo').textContent = '✅ Analysis complete!';
                    }
                });
            }
        });
    }, 500); // Check every 500ms
}

function stopStatusCheck() {
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
        statusCheckInterval = null;
    }
}

function saveState(username, list) {
    chrome.storage.local.set({
        savedUsername: username,
        savedUnfollowers: list
    });
}

function resetApp() {
    // Cancel any ongoing background fetch
    chrome.runtime.sendMessage({ type: 'CANCEL_FETCH' });

    // Clear current search tracking
    currentSearchUsername = '';

    // Reset ETA
    remainingMinutes = null;
    stopETACountdown();
    stopStatusCheck();

    chrome.storage.local.clear(() => {
        unfollowersList = [];

        // Reset View
        document.getElementById('results-view').classList.add('hidden');
        document.getElementById('search-view').classList.remove('hidden');
        hideProgress();

        // Clear text
        document.getElementById('status').textContent = '';
        document.getElementById('username').value = '';
        document.getElementById('windowInfo').textContent = '✅ You can close this window. Analysis runs in background.';

        // Restore button state
        resetButtonState();
    });
}

function resetButtonState() {
    const checkBtn = document.getElementById('checkBtn');
    checkBtn.disabled = false;
    checkBtn.querySelector('.btn-text').textContent = "Check Unfollowers";
}

// --- 2. PROGRESS BAR FUNCTIONS ---

function showProgress() {
    document.getElementById('progress-container').classList.remove('hidden');
}

function hideProgress() {
    document.getElementById('progress-container').classList.add('hidden');
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = '0%';
}

function updateProgress(percentage, message) {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const statusDiv = document.getElementById('status');

    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${percentage}%`;

    if (message) {
        statusDiv.textContent = message;
    }
}

// --- 3. MAIN PROCESS ---

async function startProcess() {
    const usernameInput = document.getElementById('username');
    const username = usernameInput.value.trim();
    const statusDiv = document.getElementById('status');
    const checkBtn = document.getElementById('checkBtn');

    if (!username) {
        statusDiv.textContent = "❌ Please enter a username.";
        return;
    }

    // UI Preparation
    checkBtn.disabled = true;
    checkBtn.querySelector('.btn-text').textContent = "Processing...";
    statusDiv.classList.remove('hidden'); // Show status messages
    statusDiv.textContent = "⏳ Starting...";
    showProgress();
    updateProgress(0, "⏳ Starting...");

    // Track which username we're searching for
    currentSearchUsername = username;

    // Hide old results and CLEAR OLD STORAGE DATA
    document.getElementById('results-view').classList.add('hidden');
    unfollowersList = [];

    // Clear old results - fresh start for new search
    chrome.storage.local.remove(['savedUnfollowers', 'savedUsername']);

    // Send message to background script to start fetching
    chrome.runtime.sendMessage({
        type: 'START_FETCH',
        username: username
    }, (response) => {
        if (chrome.runtime.lastError) {
            // Background script not available, fall back to popup-based fetch
            fallbackFetch(username);
        } else {
            // Background çalışıyor, periyodik status check başlat
            // Bu sayede popup focus kaybetse bile güncel kalır
            startStatusCheck();
        }
    });
}

// Fallback function if background script fails
async function fallbackFetch(username) {
    const statusDiv = document.getElementById('status');
    const checkBtn = document.getElementById('checkBtn');

    try {
        const baseUrl = `https://letterboxd.com/${username}/`;

        const check = await fetch(baseUrl);
        if (check.status !== 200) throw new Error("User not found or private.");

        const followers = await fetchUsers(baseUrl, 'followers', statusDiv);
        const following = await fetchUsers(baseUrl, 'following', statusDiv);

        statusDiv.textContent = "🔄 Calculating differences...";
        unfollowersList = [...following].filter(user => !followers.has(user));

        hideProgress();
        showResultsScreen(unfollowersList);
        saveState(username, unfollowersList);

        statusDiv.textContent = "";

    } catch (err) {
        statusDiv.textContent = `❌ Error: ${err.message}`;
        hideProgress();
        console.error(err);
    } finally {
        resetButtonState();
    }
}

// --- 4. HELPER FUNCTIONS ---

function showResultsScreen(list) {
    document.getElementById('search-view').classList.add('hidden');
    document.getElementById('status').classList.add('hidden');
    document.getElementById('progress-container').classList.add('hidden');

    const resultsView = document.getElementById('results-view');
    resultsView.classList.remove('hidden');

    const listEl = document.getElementById('list');
    const countEl = document.getElementById('count');

    listEl.innerHTML = '';
    countEl.textContent = list.length;

    list.forEach(link => {
        const li = document.createElement('li');
        const a = document.createElement('a');

        const cleanName = link.replace(/\//g, '');
        a.innerHTML = `👤 ${cleanName} <span style="float:right; opacity:0.6; font-size:10px;">↗</span>`;
        a.href = `https://letterboxd.com${link}`;

        // Smart Window Opening
        a.onclick = (e) => {
            e.preventDefault();
            openSmartWindow(`https://letterboxd.com${link}`);
        };

        li.appendChild(a);
        listEl.appendChild(li);
    });
}

function openSmartWindow(url) {
    const width = 610;
    const height = 700;
    const left = (screen.width - width) / 2;
    const top = (screen.height - height) / 2;

    window.open(url, 'LetterboxdUser', `width=${width},height=${height},top=${top},left=${left},scrollbars=yes,resizable=yes`);
}

async function fetchUsers(baseUrl, type, statusDiv) {
    let page = 1;
    let users = new Set();
    let hasNextPage = true;

    while (hasNextPage) {
        statusDiv.textContent = `📥 Fetching page ${page}...`;
        try {
            const response = await fetch(`${baseUrl}${type}/page/${page}/`);

            // 429 Rate Limit - Wait 301 seconds and retry
            if (response.status === 429) {
                statusDiv.textContent = `⏸️ Rate limited! Waiting 301 seconds...`;
                await new Promise(r => setTimeout(r, 301000));
                continue; // Retry same page
            }

            if (response.status !== 200) break;

            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const elements = doc.querySelectorAll('a.name');

            if (elements.length === 0) {
                hasNextPage = false;
            } else {
                elements.forEach(el => {
                    users.add(el.getAttribute('href'));
                });
                page++;
                await new Promise(r => setTimeout(r, 600));
            }
        } catch (e) {
            hasNextPage = false;
        }
    }
    return users;
}

function downloadResults() {
    const textContent = unfollowersList.map(u => `https://letterboxd.com${u}`).join('\n');
    const blob = new Blob([`Users not following back (${unfollowersList.length}):\n\n` + textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'not_following_back.txt';
    a.click();
    URL.revokeObjectURL(url);
}
