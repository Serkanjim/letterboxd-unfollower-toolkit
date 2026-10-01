import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLists, diffFollowers, uniqueNames } from '../lib/lists.js';

test('uniqueNames keeps the first spelling and the order', () => {
    assert.deepEqual(uniqueNames(['b', 'A', 'a', 'B', 'c']), ['b', 'A', 'c']);
});

test('compareLists splits into not-following-back, fans and mutuals', () => {
    const followers = ['ann', 'bob', 'Cy', 'dee'];
    const following = ['Bob', 'cy', 'eve', 'fay'];
    assert.deepEqual(compareLists(followers, following, 'me'), {
        unfollowers: ['eve', 'fay'],
        fans: ['ann', 'dee'],
        mutuals: ['Bob', 'cy']
    });
});

test('compareLists never lists the account itself', () => {
    const lists = compareLists(['ME', 'a'], ['me', 'b'], 'Me');
    assert.deepEqual(lists, { unfollowers: ['b'], fans: ['a'], mutuals: [] });
});

test('compareLists handles empty lists', () => {
    assert.deepEqual(compareLists([], [], 'me'), { unfollowers: [], fans: [], mutuals: [] });
});

test('diffFollowers reports gained and lost, ignoring case', () => {
    assert.deepEqual(diffFollowers(['a', 'B', 'c'], ['A', 'b', 'd']), { gained: ['d'], lost: ['c'] });
    assert.deepEqual(diffFollowers(['a'], ['a']), { gained: [], lost: [] });
});
