// Text for the toolbar badge and the notification shown after a background check finds people
// who unfollowed the account.

const MAX_NAMES = 3;

// summary: { username, lost, lostNames, lostYouFollow }
export function describeUnfollows({ username, lost, lostNames, lostYouFollow }) {
    const shown = lostNames.slice(0, MAX_NAMES).join(', ');
    const more = lost - Math.min(lostNames.length, MAX_NAMES);
    const who = more > 0 ? `${shown} and ${more} more` : shown;

    let message = `${lost === 1 ? '1 person' : `${lost} people`} unfollowed @${username}: ${who}.`;
    if (lostYouFollow > 0) {
        message += lostYouFollow === lost && lost === 1
            ? ' You still follow them.'
            : ` You still follow ${lostYouFollow} of them.`;
    }

    return {
        badge: lost > 99 ? '99+' : String(lost),
        title: 'Letterboxd Unfollower Toolkit',
        message
    };
}
