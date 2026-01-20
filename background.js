// Background Service Worker for Letterboxd Unfollower Toolkit
// Handles fetch operations in the background, even when popup is closed

let isProcessing = false;
let currentProgress = { current: 0, total: 0, phase: '' };
let analysisStartTime = 0;
let estimatedTotalSeconds = 0;
let currentFetchId = 0; // Unique ID for each fetch to prevent race conditions
let showProgressMessages = false; // Flag to control when to show fetching progress

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'START_FETCH') {
        // Cancel any previous fetch and start new one
        currentFetchId++;
        isProcessing = false; // Stop previous fetch
        setTimeout(() => {
            handleStartFetch(request.username, currentFetchId);
        }, 100); // Small delay to ensure previous fetch stops
        sendResponse({ status: 'started' });
        return true;
    }

    if (request.type === 'GET_STATUS') {
        sendResponse({
            isProcessing,
            progress: currentProgress,
            showProgressMessages // Is intro period or not?
        });
        return true;
    }

    if (request.type === 'CANCEL_FETCH') {
        currentFetchId++; // Invalidate current fetch
        isProcessing = false;
        sendResponse({ status: 'cancelled' });
        return true;
    }

    return false;
});

async function handleStartFetch(username, fetchId) {
    // If another fetch started, abort this one
    if (fetchId !== currentFetchId) return;

    isProcessing = true;
    currentProgress = { current: 0, total: 0, phase: 'init' };

    // Clear old results - fresh start for new fetch
    await chrome.storage.local.remove(['savedUnfollowers', 'savedUsername']);

    try {
        const baseUrl = `https://letterboxd.com/${username}/`;

        // Check if user exists (with retry for rate limit)
        sendProgressUpdate('checking', 0, 0, 'Checking user...');

        let check;
        let retryCount = 0;
        const MAX_RETRIES = 2; // 301s is too long, only 1 retry is enough
        const RATE_LIMIT_WAIT = 301000; // 301 seconds

        while (retryCount < MAX_RETRIES) {
            try {
                check = await fetch(baseUrl);

                if (check.status === 200) {
                    break; // Success!
                } else if (check.status === 403 || check.status === 429) {
                    retryCount++;
                    if (retryCount < MAX_RETRIES) {
                        // Rate limited, waiting...

                        // Show 301 second countdown
                        for (let i = 301; i > 0; i--) {
                            if (fetchId !== currentFetchId) return; // Cancel check
                            const minutes = Math.floor(i / 60);
                            const seconds = i % 60;
                            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
                            sendInfoMessage(`⏸️ Rate limited!\n⏳ Waiting ${timeStr}...`);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                } else if (check.status === 404) {
                    throw new Error('User not found.');
                } else {
                    throw new Error(`User check failed (${check.status})`);
                }
            } catch (fetchError) {
                if (fetchError.message.includes('User')) throw fetchError; // Pass through user not found error
                retryCount++;
                if (retryCount < MAX_RETRIES) {
                    // Fetch error, waiting...

                    // Show 301 second countdown
                    for (let i = 301; i > 0; i--) {
                        if (fetchId !== currentFetchId) return; // Cancel check
                        const minutes = Math.floor(i / 60);
                        const seconds = i % 60;
                        const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
                        sendInfoMessage(`⏸️ Connection error!\n⏳ Retrying in ${timeStr}...`);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                } else {
                    throw new Error('Failed to connect. Check your internet or try again.');
                }
            }
        }

        if (!check || check.status !== 200) {
            throw new Error('Rate limited. Please wait 5 minutes and try again.');
        }

        // Get total counts from profile page
        const profileHtml = await check.text();
        const counts = parseProfileCounts(profileHtml);

        // DEBUG: Profil sayfasından çekilen sayıları göster

        const followersPages = Math.ceil(counts.followers / 25) || 1;
        const followingPages = Math.ceil(counts.following / 25) || 1;
        const totalPages = followersPages + followingPages;

        currentProgress.total = totalPages;

        // Large account = at least one endpoint has more than 30 pages
        const maxEndpointPages = Math.max(followersPages, followingPages);
        const isLargeAccount = maxEndpointPages > 30;

        // Calculate estimated time
        // Fixed costs (startup messages: small=2x2s, large=3x2s)
        const STARTUP_OVERHEAD = isLargeAccount ? 6 : 4;

        // Her istek: ~700ms delay (ortalama) + ~300ms network = ~1.0s
        const avgDelayPerRequest = 1.0;
        let estimatedSeconds;

        if (isLargeAccount) {
            // Large account: parallel fetch + breaks
            // Parallel so max endpoint pages worth of request time (both at same time)
            const requestTime = maxEndpointPages * avgDelayPerRequest;
            // Break every 30 pages (batch count - 1 breaks)
            const batchCount = Math.ceil(maxEndpointPages / 30);
            const breaks = Math.max(0, batchCount - 1);
            const breakTime = breaks * 301;
            estimatedSeconds = Math.ceil(requestTime + breakTime + STARTUP_OVERHEAD);
        } else {
            // Small account: runs parallel, takes max page count time
            estimatedSeconds = Math.ceil(maxEndpointPages * avgDelayPerRequest + STARTUP_OVERHEAD);
        }

        // Show time in minutes and seconds
        const estMinutes = Math.floor(estimatedSeconds / 60);
        const estSeconds = estimatedSeconds % 60;

        // Save estimated time (timer starts when fetching begins)
        estimatedTotalSeconds = estimatedSeconds;

        // Create info message
        const totalUsers = counts.followers + counts.following;
        const infoMessage = `📊 Comparing ${totalUsers.toLocaleString()} users\n👥 ${counts.followers.toLocaleString()} followers vs ${counts.following.toLocaleString()} following`;

        // ETA mesajı
        const etaMessage = estMinutes > 0
            ? `⏱️ Estimated time\n⌛ ${estMinutes} min ${estSeconds} sec`
            : `⏱️ Estimated time\n⌛ ${estSeconds} seconds`;

        // Create owner username (extract from baseUrl)
        const ownerUsername = `/${username}/`;

        // Start timer
        const startTime = Date.now();
        analysisStartTime = startTime;

        // Don't show progress messages yet
        showProgressMessages = false;

        // Start fetching in background (don't await, run parallel)
        const fetchPromise = fetchUsersInterleaved(baseUrl, followersPages, followingPages, totalPages, ownerUsername, fetchId);

        // Show intro messages (without affecting progress bar, only updates message)
        sendInfoMessage(infoMessage);
        await new Promise(r => setTimeout(r, 2000));

        if (fetchId !== currentFetchId) return; // Cancel check

        sendInfoMessage(etaMessage);
        await new Promise(r => setTimeout(r, 2000));

        if (fetchId !== currentFetchId) return; // Cancel check

        if (isLargeAccount) {
            sendInfoMessage(`⚠️ Large account!\n🛡️ Safe mode enabled for reliability.`);
            await new Promise(r => setTimeout(r, 2000));
        }

        // Now progress messages can be shown
        showProgressMessages = true;

        // Wait for fetching to complete
        const result = await fetchPromise;
        const followers = result.followers;
        const following = result.following;

        // Stop timer
        const endTime = Date.now();
        const totalSeconds = ((endTime - startTime) / 1000).toFixed(1);

        // Check if this fetch is still valid (not cancelled or replaced)
        if (!isProcessing || fetchId !== currentFetchId) {
            return;
        }

        // Calculate unfollowers
        const unfollowersList = [...following].filter(user => !followers.has(user));

        // Final check before saving - make sure this is still the active fetch
        if (fetchId !== currentFetchId) {
            return;
        }

        // Save results to storage
        await chrome.storage.local.set({
            savedUsername: username,
            savedUnfollowers: unfollowersList
        });

        // Notify popup that fetch is complete
        sendFetchComplete(unfollowersList, username);

    } catch (err) {
        if (fetchId === currentFetchId) {
            sendError(err.message);
        }
    } finally {
        if (fetchId === currentFetchId) {
            isProcessing = false;
            currentProgress = { current: 0, total: 0, phase: '' };
        }
    }
}

function parseProfileCounts(html) {
    let followers = 0;
    let following = 0;

    // Extract followers/following counts with regex
    // Format: <a href="/username/followers/">123 Followers</a>
    const followersMatch = html.match(/href="[^"]*\/followers\/"[^>]*>[\s\S]*?([\d,]+)/i);
    const followingMatch = html.match(/href="[^"]*\/following\/"[^>]*>[\s\S]*?([\d,]+)/i);

    if (followersMatch) {
        followers = parseInt(followersMatch[1].replace(/,/g, '')) || 0;
    }
    if (followingMatch) {
        following = parseInt(followingMatch[1].replace(/,/g, '')) || 0;
    }

    return { followers, following };
}

// PARALLEL FETCH: Fetch followers and following pages AT THE SAME TIME
// Each endpoint has a 30 request limit, runs parallel
async function fetchUsersInterleaved(baseUrl, followersPages, followingPages, totalPages, ownerUsername, fetchId) {
    let followers = new Set();
    let following = new Set();

    const MIN_DELAY = 550;
    const MAX_DELAY = 850;
    const REQUEST_LIMIT_PER_ENDPOINT = 30; // 30 requests per endpoint
    const BUCKET_REFILL_TIME = 301000; // 301 seconds

    // Shared progress counter (for parallel operations)
    const progress = { completed: 0, total: totalPages };

    // Create page groups (30-page batches)
    const followersBatches = [];
    const followingBatches = [];

    for (let i = 1; i <= followersPages; i += REQUEST_LIMIT_PER_ENDPOINT) {
        const end = Math.min(i + REQUEST_LIMIT_PER_ENDPOINT - 1, followersPages);
        followersBatches.push({ start: i, end: end });
    }

    for (let i = 1; i <= followingPages; i += REQUEST_LIMIT_PER_ENDPOINT) {
        const end = Math.min(i + REQUEST_LIMIT_PER_ENDPOINT - 1, followingPages);
        followingBatches.push({ start: i, end: end });
    }

    const maxBatches = Math.max(followersBatches.length, followingBatches.length);

    for (let batchIndex = 0; batchIndex < maxBatches && isProcessing && fetchId === currentFetchId; batchIndex++) {
        const followersBatch = followersBatches[batchIndex];
        const followingBatch = followingBatches[batchIndex];

        // Progress mesajı - basit ve kullanıcı dostu
        sendProgressUpdate('parallel', progress.completed, totalPages,
            `🔍 Analyzing profile...`);

        // Start parallel fetch for both endpoints
        const parallelPromises = [];

        if (followersBatch) {
            parallelPromises.push(
                fetchBatchWithProgress(baseUrl, 'followers', followersBatch.start, followersBatch.end, ownerUsername, progress, totalPages, fetchId)
            );
        }

        if (followingBatch) {
            parallelPromises.push(
                fetchBatchWithProgress(baseUrl, 'following', followingBatch.start, followingBatch.end, ownerUsername, progress, totalPages, fetchId)
            );
        }

        // Fetch both endpoints in parallel
        const results = await Promise.all(parallelPromises);

        // Check if fetch was cancelled
        if (fetchId !== currentFetchId) break;

        // Merge results
        let resultIndex = 0;
        if (followersBatch) {
            results[resultIndex].forEach(user => followers.add(user));
            resultIndex++;
        }
        if (followingBatch) {
            results[resultIndex].forEach(user => following.add(user));
        }

        if (!isProcessing || fetchId !== currentFetchId) break;

        // If there are more batches, take a break
        if (batchIndex + 1 < maxBatches) {
            await bucketRefill(BUCKET_REFILL_TIME, progress.completed, totalPages);
        }
    }

    return { followers, following };
}

// Fetch a batch sequentially and update progress
async function fetchBatchWithProgress(baseUrl, type, startPage, endPage, ownerUsername, progress, totalPages, fetchId) {
    const users = new Set();
    const MIN_DELAY = 550;
    const MAX_DELAY = 850;

    for (let page = startPage; page <= endPage && isProcessing && fetchId === currentFetchId; page++) {
        // Record which page this side is on
        progress[type] = page;

        // Show message when both sides are on the same page
        const followersPage = progress.followers || 0;
        const followingPage = progress.following || 0;

        if (followersPage > 0 && followingPage > 0) {
            const minPage = Math.min(followersPage, followingPage);
            sendProgressUpdate('parallel', progress.completed, totalPages,
                `🚀 Fetching page ${minPage}...`);
        }

        const result = await fetchSinglePage(baseUrl, type, page, ownerUsername);

        // Check again after async operation
        if (fetchId !== currentFetchId) break;

        result.forEach(user => users.add(user));

        // Update progress
        progress.completed++;

        // Add delay
        const delay = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY)) + MIN_DELAY;
        await new Promise(r => setTimeout(r, delay));
    }

    return users;
}

// Fetch single page
async function fetchSinglePage(baseUrl, type, page, ownerUsername) {
    const users = new Set();

    try {
        const response = await fetch(`${baseUrl}${type}/page/${page}/`);
        if (response.status !== 200) return users;

        const text = await response.text();

        // Working regex - find a tags containing class="name"
        const nameRegex1 = /<a[^>]*class="name"[^>]*href="([^"]+)"[^>]*>/gi;
        const nameRegex2 = /<a[^>]*href="([^"]+)"[^>]*class="name"[^>]*>/gi;

        let match;
        while ((match = nameRegex1.exec(text)) !== null) {
            // Filter out own username and add
            if (match[1] !== ownerUsername) {
                users.add(match[1]);
            }
        }
        while ((match = nameRegex2.exec(text)) !== null) {
            if (match[1] !== ownerUsername) {
                users.add(match[1]);
            }
        }

    } catch (e) {
        console.error(`Error fetching ${type} page ${page}:`, e);
    }

    return users;
}

// Bucket refill countdown
async function bucketRefill(refillTime, current, total) {
    const refillSeconds = refillTime / 1000;
    for (let i = refillSeconds; i > 0; i--) {
        const minutes = Math.floor(i / 60);
        const seconds = i % 60;
        const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        sendProgressUpdate('cooldown', current, total,
            `☕ Taking a short break to avoid rate limits...\n⏳ ${timeStr} remaining`);
        await new Promise(r => setTimeout(r, 1000));
        if (!isProcessing) break;
    }
}

async function fetchUsersBackground(baseUrl, type, expectedPages, pageOffset, totalPages, safeMode = false) {
    let page = 1;
    let users = new Set();
    let hasNextPage = true;
    let retryCount = 0;
    let requestCount = 0;
    const MAX_RETRIES = 3;

    // Both modes use the same fast delay (550-850ms)
    const MIN_DELAY = 550;
    const MAX_DELAY = 850;

    // Safe mode: take 200 second break every 30 requests
    const BUCKET_LIMIT = 30;
    const BUCKET_REFILL_TIME = 200000; // 200 seconds

    while (hasNextPage && isProcessing) {
        const currentTotal = pageOffset + page;
        sendProgressUpdate(type, currentTotal, totalPages, `Fetching ${type} (Page ${page})...`);

        try {
            const response = await fetch(`${baseUrl}${type}/page/${page}/`);

            // 429 Rate Limit - Emergency Cooldown
            if (response.status === 429) {
                retryCount++;
                if (retryCount > MAX_RETRIES) {
                    sendProgressUpdate('error', currentTotal, totalPages, `Rate limit exceeded. Please try again later.`);
                    throw new Error('Rate limit exceeded after multiple retries');
                }

                // Emergency cooldown: 60s, 90s, 120s
                const cooldownTime = 60000 + (retryCount - 1) * 30000;
                sendProgressUpdate('cooldown', currentTotal, totalPages,
                    `⏸️ Rate limited! Cooling down for ${cooldownTime / 1000}s... (Retry ${retryCount}/${MAX_RETRIES})`);

                await new Promise(r => setTimeout(r, cooldownTime));
                continue; // Retry same page
            }

            // Reset retry count on success
            retryCount = 0;

            if (response.status !== 200) break;

            const text = await response.text();

            // Find a.name elements with regex
            // For both formats: class="name" href="..." or href="..." class="name"
            const nameRegex1 = /<a[^>]*class="name"[^>]*href="([^"]+)"[^>]*>/gi;
            const nameRegex2 = /<a[^>]*href="([^"]+)"[^>]*class="name"[^>]*>/gi;

            let match;
            let foundAny = false;

            while ((match = nameRegex1.exec(text)) !== null) {
                users.add(match[1]);
                foundAny = true;
            }

            while ((match = nameRegex2.exec(text)) !== null) {
                users.add(match[1]);
                foundAny = true;
            }

            if (!foundAny) {
                hasNextPage = false;
            } else {
                page++;
                requestCount++;

                // Safe mode: bucket refill break every 25 requests
                if (safeMode && requestCount >= BUCKET_LIMIT) {
                    const refillSeconds = BUCKET_REFILL_TIME / 1000;
                    for (let i = refillSeconds; i > 0; i--) {
                        sendProgressUpdate(type, currentTotal, totalPages,
                            `⏸️ Bucket refill... (${i}s remaining)`);
                        await new Promise(r => setTimeout(r, 1000));
                        if (!isProcessing) break;
                    }
                    requestCount = 0; // Reset counter
                } else {
                    // Normal delay
                    const delay = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY)) + MIN_DELAY;
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        } catch (e) {
            if (e.message.includes('Rate limit')) {
                throw e;
            }
            hasNextPage = false;
        }
    }

    return users;
}

let currentIntroMessage = ''; // Store current intro message

// Send message only, doesn't update progress bar
function sendInfoMessage(message) {
    currentIntroMessage = message;
    chrome.runtime.sendMessage({
        type: 'INFO_MESSAGE',
        message
    }).catch(() => {
        // Popup might be closed
    });
}

function sendProgressUpdate(phase, current, total, message) {
    currentProgress = { current, total, phase, message };

    // If it's an intro message, store it
    if (phase === 'info') {
        currentIntroMessage = message;
    }

    // During intro period, show intro message but update percentage
    let displayMessage = message;
    let displayPhase = phase;
    if (!showProgressMessages && phase !== 'info') {
        displayMessage = currentIntroMessage;
        displayPhase = 'info';
    }

    // Calculate remaining time
    let remainingMinutes = null;
    if (analysisStartTime > 0 && estimatedTotalSeconds > 0) {
        const elapsedSeconds = (Date.now() - analysisStartTime) / 1000;
        const remainingSeconds = Math.max(0, estimatedTotalSeconds - elapsedSeconds);
        remainingMinutes = Math.ceil(remainingSeconds / 60);
    }

    chrome.runtime.sendMessage({
        type: 'PROGRESS_UPDATE',
        phase: displayPhase,
        current,
        total,
        message: displayMessage,
        percentage: total > 0 ? Math.round((current / total) * 100) : 0,
        eta: remainingMinutes
    }).catch(() => {
        // Popup might be closed, that's okay
    });
}

function sendFetchComplete(unfollowers, username) {
    chrome.runtime.sendMessage({
        type: 'FETCH_COMPLETE',
        unfollowers,
        username
    }).catch(() => {
        // Popup might be closed, results are saved to storage
    });
}

function sendError(errorMessage) {
    chrome.runtime.sendMessage({
        type: 'FETCH_ERROR',
        error: errorMessage
    }).catch(() => {
        // Popup might be closed
    });
}
