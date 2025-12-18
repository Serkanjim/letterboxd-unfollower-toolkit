document.addEventListener('DOMContentLoaded', restoreState);

// Define Event Listeners
document.getElementById('checkBtn').addEventListener('click', startProcess);
document.getElementById('downloadBtn').addEventListener('click', downloadResults);
document.getElementById('resetBtn').addEventListener('click', resetApp);

let unfollowersList = [];

// --- 1. MEMORY MANAGEMENT ---

function restoreState() {
    // If "storage" permission is missing in the manifest file, this will fail.
    // Please ensure your manifest.json is updated.
    if (typeof chrome.storage === 'undefined') {
        console.error("Storage permission not found! Please reload the extension.");
        return;
    }

    chrome.storage.local.get(['savedUnfollowers', 'savedUsername'], (data) => {
        if (data.savedUnfollowers && data.savedUnfollowers.length > 0) {
            unfollowersList = data.savedUnfollowers;
            showResultsScreen(unfollowersList);
            // Restore input value
            const userInput = document.getElementById('username');
            if(userInput) userInput.value = data.savedUsername || '';
        }
    });
}

function saveState(username, list) {
    chrome.storage.local.set({
        savedUsername: username,
        savedUnfollowers: list
    });
}

function resetApp() {
    chrome.storage.local.clear(() => {
        unfollowersList = [];
        
        // Reset View
        document.getElementById('results-view').classList.add('hidden');
        document.getElementById('search-view').classList.remove('hidden');
        
        // Clear text
        document.getElementById('status').textContent = '';
        document.getElementById('username').value = '';
        
        // Restore button state
        const checkBtn = document.getElementById('checkBtn');
        checkBtn.disabled = false;
        checkBtn.querySelector('.btn-text').textContent = "Check Unfollowers";
    });
}

// --- 2. MAIN PROCESS ---

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
    statusDiv.textContent = "⏳ Checking user...";
    
    // Hide old results
    document.getElementById('results-view').classList.add('hidden');
    unfollowersList = [];

    try {
        const baseUrl = `https://letterboxd.com/${username}/`;
        
        const check = await fetch(baseUrl);
        if (check.status !== 200) throw new Error("User not found or private.");

        const followers = await fetchUsers(baseUrl, 'followers', statusDiv);
        const following = await fetchUsers(baseUrl, 'following', statusDiv);

        statusDiv.textContent = "🔄 Calculating differences...";
        unfollowersList = [...following].filter(user => !followers.has(user));

        showResultsScreen(unfollowersList);
        saveState(username, unfollowersList);
        
        statusDiv.textContent = "";

    } catch (err) {
        statusDiv.textContent = `❌ Error: ${err.message}`;
        console.error(err);
    } finally {
        checkBtn.disabled = false;
        checkBtn.querySelector('.btn-text').textContent = "Check Unfollowers";
    }
}

// --- 3. HELPER FUNCTIONS ---

function showResultsScreen(list) {
    document.getElementById('search-view').classList.add('hidden');
    const resultsView = document.getElementById('results-view');
    resultsView.classList.remove('hidden'); // classList hatası alıyorsan HTML eskidir!

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
        statusDiv.textContent = `📥 Fetching ${type} (Page ${page})...`;
        try {
            const response = await fetch(`${baseUrl}${type}/page/${page}/`);
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

