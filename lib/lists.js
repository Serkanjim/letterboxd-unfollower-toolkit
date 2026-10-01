// Set arithmetic on follower / following lists. Letterboxd usernames are case-insensitive,
// so everything is compared by lowercase name while keeping the original spelling for display.

export const nameKey = name => name.toLowerCase();

// First spelling wins; order is preserved.
export function uniqueNames(names) {
    const seen = new Set();
    const unique = [];
    for (const name of names) {
        if (seen.has(nameKey(name))) continue;
        seen.add(nameKey(name));
        unique.push(name);
    }
    return unique;
}

// unfollowers: you follow them, they do not follow you
// fans:        they follow you, you do not follow them
// mutuals:     both
export function compareLists(followers, following, ownUsername) {
    const followerKeys = new Set(followers.map(nameKey));
    const followingKeys = new Set(following.map(nameKey));
    const own = nameKey(ownUsername);
    const others = name => nameKey(name) !== own;

    return {
        unfollowers: following.filter(name => others(name) && !followerKeys.has(nameKey(name))),
        fans: followers.filter(name => others(name) && !followingKeys.has(nameKey(name))),
        mutuals: following.filter(name => others(name) && followerKeys.has(nameKey(name)))
    };
}

// gained: in `current` but not in `previous`; lost: the other way round.
export function diffFollowers(previous, current) {
    const previousKeys = new Set(previous.map(nameKey));
    const currentKeys = new Set(current.map(nameKey));
    return {
        gained: current.filter(name => !previousKeys.has(nameKey(name))),
        lost: previous.filter(name => !currentKeys.has(nameKey(name)))
    };
}
