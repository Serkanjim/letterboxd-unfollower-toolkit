// Optional page badges: marks members who do not follow you back, using the list from your last scan.
//
// Off unless the user turned "Mark people who don't follow me back on Letterboxd pages" on in the popup.
// It only reads three keys from this extension's own storage (prefs, badgeData, ignored), sends nothing
// anywhere and changes nothing except adding small labels. Self-contained on purpose: a shared module
// would have to be exposed to web pages, which would let sites detect that the extension is installed.

(async () => {
    let data;
    try {
        data = await chrome.storage.local.get(['prefs', 'badgeData', 'ignored']);
    } catch {
        return;
    }
    if (data.prefs?.pageBadges !== true || !data.badgeData) return;

    const owner = String(data.badgeData.owner ?? '');
    const hidden = new Set(data.ignored?.[owner.toLowerCase()] ?? []);
    const flagged = new Set((data.badgeData.unfollowers ?? []).filter(name => !hidden.has(name)));
    if (flagged.size === 0) return;

    const PROFILE_PATH = /^\/([A-Za-z0-9_-]{1,40})\/?$/;
    const usernameOf = href => {
        try {
            const url = new URL(href, location.origin);
            const match = url.origin === location.origin ? url.pathname.match(PROFILE_PATH) : null;
            return match ? match[1].toLowerCase() : null;
        } catch {
            return null;
        }
    };

    const scanned = new Date(data.badgeData.at).toLocaleDateString();
    const tooltip = `Does not follow @${owner} back (scan from ${scanned}). Added by Letterboxd Unfollower Toolkit.`;

    const style = document.createElement('style');
    style.textContent = `
        .lbtk-badge { margin-left: 6px; padding: 1px 6px; border-radius: 8px; background: #ff8000; color: #fff;
            font-size: 10px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; vertical-align: middle; white-space: nowrap; }
        .lbtk-profile { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; padding: 8px 12px; border-radius: 8px;
            background: #ff8000; color: #fff; font: 700 12px/1.3 sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }`;
    document.head.append(style);

    function markRows() {
        for (const link of document.querySelectorAll('.person-summary a.name:not([data-lbtk])')) {
            link.dataset.lbtk = '1';
            if (!flagged.has(usernameOf(link.getAttribute('href')))) continue;

            const badge = document.createElement('span');
            badge.className = 'lbtk-badge';
            badge.textContent = 'not following back';
            badge.title = tooltip;
            link.after(badge);
        }
    }

    markRows();

    // Member lists can grow after load; re-check at most once per frame.
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            markRows();
        });
    }).observe(document.body, { childList: true, subtree: true });

    // On a member's own page: a small dismissible label.
    const profile = location.pathname.match(PROFILE_PATH);
    if (profile && flagged.has(profile[1].toLowerCase())) {
        const pill = document.createElement('div');
        pill.className = 'lbtk-profile';
        pill.textContent = `Not following @${owner} back  ✕`;
        pill.title = tooltip;
        pill.addEventListener('click', () => pill.remove());
        document.body.append(pill);
    }
})();
