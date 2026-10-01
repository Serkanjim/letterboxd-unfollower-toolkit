import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDisplayName, parseMemberRows, parseMembers, safeAvatarUrl } from '../lib/parser.js';
import { MAX_PROFILES, mergeProfiles, profileKey, profileOf, profilesFromRows } from '../lib/profiles.js';
import { toCsv, toJson } from '../lib/export.js';
import { describeUnfollows } from '../lib/alerts.js';

const member = ({ user, name = user, src = 'https://a.ltrbxd.com/resized/avatar/x/80.jpg?v=1', cls = 'name' }) => `
    <tr><td class="table-person"><div class="person-summary">
      <a href="/${user}/" class="avatar -a40"><img src="${src}" alt="${name}" width="40" height="40"></a>
      <h3 class="title-3"><a href="/${user}/" class="${cls}">${name}</a></h3>
    </div></td></tr>`;

test('parseMemberRows reads username, display name and avatar', () => {
    const rows = parseMemberRows(member({ user: 'ann', name: 'Ann Lee' }) + member({ user: 'bob' }));
    assert.deepEqual(rows, [
        { username: 'ann', name: 'Ann Lee', avatar: 'https://a.ltrbxd.com/resized/avatar/x/80.jpg?v=1' },
        { username: 'bob', name: 'bob', avatar: 'https://a.ltrbxd.com/resized/avatar/x/80.jpg?v=1' }
    ]);
    assert.deepEqual(parseMembers(member({ user: 'ann' })), ['ann']);
});

test('display names are decoded, stripped of markup and bidi tricks, and bounded', () => {
    assert.equal(cleanDisplayName('Tom &amp; Jerry &#127916; &#x1F3AC;'), 'Tom & Jerry 🎬 🎬');
    assert.equal(cleanDisplayName('<b>bold</b> <i>name</i>'), 'bold name');
    assert.equal(cleanDisplayName('&lt;script&gt;'), '<script>');                  // stays text, never markup
    assert.equal(cleanDisplayName('evil‮gnp.exe‏'), 'evilgnp.exe');
    assert.equal(cleanDisplayName('a\u0000b\u001fc'), 'abc');
    assert.equal(cleanDisplayName('x'.repeat(100)).length, 60);
    assert.equal(cleanDisplayName('&#99999999;'), '&#99999999;');                  // not a code point: left alone
});

test('avatars are only accepted from Letterboxd hosts over https', () => {
    assert.equal(safeAvatarUrl('https://a.ltrbxd.com/p.jpg'), 'https://a.ltrbxd.com/p.jpg');
    assert.equal(safeAvatarUrl('/static/a.png'), 'https://letterboxd.com/static/a.png');
    assert.equal(safeAvatarUrl('//s.ltrbxd.com/a.png'), 'https://s.ltrbxd.com/a.png');
    for (const bad of ['http://a.ltrbxd.com/p.jpg', 'https://evil.example/p.jpg', 'https://ltrbxd.com.evil.example/p.jpg',
        'https://evil.example/?https://a.ltrbxd.com/p.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, 'x'.repeat(401)]) {
        assert.equal(safeAvatarUrl(bad), null, String(bad));
    }
});

test('lazy-loaded avatars (data-src) are understood; hostile ones are dropped', () => {
    const lazy = `<a class="avatar" href="/ann/"><img data-src="https://a.ltrbxd.com/l.jpg" src="data:image/gif;base64,R0lG"></a><a class="name" href="/ann/">Ann</a>`;
    assert.equal(parseMemberRows(lazy)[0].avatar, 'https://a.ltrbxd.com/l.jpg');

    const hostile = `<a class="avatar" href="/ann/"><img src="https://tracker.example/p.gif"></a><a class="name" href="/ann/">Ann</a>`;
    assert.equal(parseMemberRows(hostile)[0].avatar, null);
});

test('members without an avatar or readable name still parse', () => {
    const rows = parseMemberRows('<a class="name" href="/ann/"></a><a class="name" href="/bob/">Bob</a>');
    assert.deepEqual(rows, [
        { username: 'ann', name: null, avatar: null },
        { username: 'bob', name: 'Bob', avatar: null }
    ]);
});

test('profilesFromRows keeps only what is worth showing', () => {
    const profiles = profilesFromRows([
        { username: 'Ann', name: 'Ann Lee', avatar: 'https://a.ltrbxd.com/a.jpg' },
        { username: 'bob', name: 'BOB', avatar: null },          // same as the username: nothing to add
        { username: 'cy', name: null, avatar: 'https://a.ltrbxd.com/c.jpg' },
        { username: 'dee', name: null, avatar: null }
    ]);
    assert.deepEqual(profiles, {
        '@ann': ['Ann Lee', 'https://a.ltrbxd.com/a.jpg'],
        '@cy': ['', 'https://a.ltrbxd.com/c.jpg']
    });
    assert.deepEqual(profileOf(profiles, 'ANN'), { name: 'Ann Lee', avatar: 'https://a.ltrbxd.com/a.jpg' });
    assert.deepEqual(profileOf(profiles, 'nobody'), { name: null, avatar: null });
    assert.deepEqual(profileOf(undefined, 'x'), { name: null, avatar: null });
});

test('mergeProfiles refreshes entries, drops the oldest and is safe against odd usernames', () => {
    const merged = mergeProfiles({ '@a': ['A', ''], '@b': ['B', ''], '@c': ['C', ''] }, { '@a': ['A2', ''], '@d': ['D', ''] }, 3);
    assert.deepEqual(Object.keys(merged), ['@c', '@a', '@d']);          // b was oldest, a moved to the end
    assert.deepEqual(merged['@a'], ['A2', '']);

    const odd = mergeProfiles({}, profilesFromRows([{ username: '__proto__', name: 'x', avatar: null }, { username: '12345', name: 'y', avatar: null }]));
    assert.equal(Object.getPrototypeOf(odd), Object.prototype);
    assert.deepEqual(Object.keys(odd), ['@__proto__', '@12345']);
    assert.equal(profileKey('Zed'), '@zed');
    assert.ok(MAX_PROFILES >= 10_000);
});

test('CSV quoting and formula defusing', () => {
    const csv = toCsv(['username', 'displayName'], [
        { username: 'a', displayName: 'Plain' },
        { username: 'b', displayName: 'Comma, "Quote"' },
        { username: 'c', displayName: '=HYPERLINK("http://x","click")' },
        { username: 'd', displayName: '+1 555' },
        { username: 'e', displayName: '-2+3' },
        { username: 'f', displayName: '@SUM(A1)' },
        { username: 'g', displayName: 'two\nlines' },
        { username: 'h', displayName: null }
    ]);
    assert.equal(csv, [
        'username,displayName',
        'a,Plain',
        'b,"Comma, ""Quote"""',
        `c,"'=HYPERLINK(""http://x"",""click"")"`,
        "d,'+1 555",
        "e,'-2+3",
        "f,'@SUM(A1)",
        'g,"two\nlines"',
        'h,',
        ''
    ].join('\r\n'));
});

test('JSON export carries its metadata', () => {
    const json = JSON.parse(toJson({ account: 'me', list: 'fans' }, [{ username: 'a' }]));
    assert.deepEqual(json, { account: 'me', list: 'fans', count: 1, items: [{ username: 'a' }] });
});

test('describeUnfollows words the badge and the notification', () => {
    assert.deepEqual(describeUnfollows({ username: 'me', lost: 1, lostNames: ['ann'], lostYouFollow: 1 }), {
        badge: '1', title: 'Letterboxd Unfollower Toolkit', message: '1 person unfollowed @me: ann. You still follow them.'
    });
    const many = describeUnfollows({ username: 'me', lost: 120, lostNames: ['a', 'b', 'c', 'd'], lostYouFollow: 7 });
    assert.equal(many.badge, '99+');
    assert.equal(many.message, '120 people unfollowed @me: a, b, c and 117 more. You still follow 7 of them.');
    assert.equal(describeUnfollows({ username: 'me', lost: 2, lostNames: ['a', 'b'], lostYouFollow: 0 }).message, '2 people unfollowed @me: a, b.');
});

import { DEFAULT_PREFS, normalizePrefs } from '../lib/prefs.js';

test('prefs default to the safe choices and survive garbage', () => {
    assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS);
    assert.deepEqual(normalizePrefs('nope'), DEFAULT_PREFS);
    assert.equal(DEFAULT_PREFS.pageBadges, false);
    assert.equal(DEFAULT_PREFS.daily.enabled, false);
    assert.equal(DEFAULT_PREFS.daily.notify, false);

    const cleaned = normalizePrefs({ sort: 'weird', avatars: 'yes', pageBadges: 'true', daily: { enabled: 1, username: 'me/x', notify: 'y' } });
    assert.deepEqual(cleaned, DEFAULT_PREFS);
});

test('a daily check is only enabled for a valid account', () => {
    assert.equal(normalizePrefs({ daily: { enabled: true, username: null } }).daily.enabled, false);
    assert.deepEqual(normalizePrefs({ sort: 'name', avatars: false, pageBadges: true, daily: { enabled: true, username: 'me', notify: true } }), {
        sort: 'name', avatars: false, pageBadges: true, daily: { enabled: true, username: 'me', notify: true }
    });
});
