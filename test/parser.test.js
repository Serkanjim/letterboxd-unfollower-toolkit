import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidUsername, looksBlocked, normalizeUsername, parseMembers, parseProfileCounts, usernameFromHref
} from '../lib/parser.js';

test('normalizeUsername accepts names, @names and profile URLs', () => {
    assert.equal(normalizeUsername('  serkan  '), 'serkan');
    assert.equal(normalizeUsername('@serkan'), 'serkan');
    assert.equal(normalizeUsername('letterboxd.com/serkan'), 'serkan');
    assert.equal(normalizeUsername('https://letterboxd.com/serkan/'), 'serkan');
    assert.equal(normalizeUsername('https://www.letterboxd.com/serkan/following/page/2/'), 'serkan');
});

test('normalizeUsername rejects input that would break the request URL', () => {
    for (const bad of ['', '   ', 'me/following', 'me?x=', '../film/heat', 'me#', 'a b', 'x'.repeat(41), null, undefined, 42]) {
        assert.equal(normalizeUsername(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
});

test('normalizeUsername rejects pasted URLs that are not profiles', () => {
    assert.equal(normalizeUsername('https://letterboxd.com/film/heat/'), null);
    assert.equal(normalizeUsername('https://letterboxd.com/lists/'), null);
});

test('usernameFromHref only accepts a single-segment profile path', () => {
    assert.equal(usernameFromHref('/alice/'), 'alice');
    assert.equal(usernameFromHref('/alice'), 'alice');
    assert.equal(usernameFromHref('https://letterboxd.com/alice/'), 'alice');
    assert.equal(usernameFromHref('/film/heat/'), null);
    assert.equal(usernameFromHref('@evil.example/'), null);
    assert.equal(usernameFromHref('https://evil.example/alice/'), null);
    assert.equal(usernameFromHref('/<img src=x onerror=alert(1)>/'), null);
    assert.equal(usernameFromHref(undefined), null);
});

test('isValidUsername', () => {
    assert.equal(isValidUsername('Alice_01'), true);
    assert.equal(isValidUsername('al ice'), false);
});

test('parseMembers is independent of attribute order and extra classes', () => {
    const html = `
        <a class="avatar -a40" href="/skipme/"><img></a>
        <a class="name" href="/a/">A</a>
        <a href="/b/" class="name">B</a>
        <a class="name -x" href="/c/">C</a>
        <a class="title name" href='/d/'>D</a>
        <a data-x="1 > 0" class="name" href="/e/">E</a>
        <a class="name" href="/a/">A again</a>`;
    assert.deepEqual(parseMembers(html), ['a', 'b', 'c', 'd', 'e']);
});

test('parseMembers drops hostile and non-profile hrefs', () => {
    const html = `
        <a class="name" href="@evil.example/">x</a>
        <a class="name" href="/<img src=x onerror=alert(1)>/">y</a>
        <a class="name" href="/film/heat/">film</a>
        <a class="name" href="/ok/">ok</a>`;
    assert.deepEqual(parseMembers(html), ['ok']);
});

test('parseMembers returns [] when the markup is unrecognised', () => {
    assert.deepEqual(parseMembers('<div>nothing to see</div>'), []);
});

const stats = (followers, following, extra = '') => `
    <a href="/me/following/" ${extra}><span class="value">${following}</span><span class="definition">Following</span></a>
    <a href="/me/followers/" ${extra}><span class="value">${followers}</span><span class="definition">Followers</span></a>`;

test('parseProfileCounts reads exact counts', () => {
    assert.deepEqual(parseProfileCounts(stats('1,234', '56'), 'me'), {
        followers: { value: 1234, exact: true },
        following: { value: 56, exact: true }
    });
});

test('parseProfileCounts is not fooled by digits in attributes', () => {
    const html = stats('1,234', '56', 'class="s2 tooltip" data-x="9" title="2 things"');
    assert.deepEqual(parseProfileCounts(html, 'me').followers, { value: 1234, exact: true });
});

test('parseProfileCounts flags abbreviated counts as approximate', () => {
    const counts = parseProfileCounts(stats('12k', '1.5k'), 'me');
    assert.deepEqual(counts.followers, { value: 12000, exact: false });
    assert.deepEqual(counts.following, { value: 1500, exact: false });
});

test('parseProfileCounts ignores links that belong to other users and unknown markup', () => {
    const other = '<a href="/someone/followers/"><span>999</span></a>';
    assert.deepEqual(parseProfileCounts(other, 'me'), { followers: null, following: null });
    assert.deepEqual(parseProfileCounts('<div>no stats</div>', 'me'), { followers: null, following: null });
});

test('parseProfileCounts matches the username case-insensitively', () => {
    assert.equal(parseProfileCounts(stats('7', '8'), 'ME').followers.value, 7);
});

test('looksBlocked spots bot-protection pages', () => {
    assert.equal(looksBlocked('<html><head><title>Just a moment...</title>'), true);
    assert.equal(looksBlocked('<script src="/cdn-cgi/challenge-platform/h/b"></script>'), true);
    assert.equal(looksBlocked('<title>Followers • Letterboxd</title>'), false);
});
