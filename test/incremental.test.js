import test from 'node:test';
import assert from 'node:assert/strict';
import {
    QUICK_MAX_AGE_MS, QUICK_MAX_NEW, QUICK_MAX_RUNS, headCheck, mergeQuick, planQuick, sameNames
} from '../lib/incremental.js';
import { quickPageCount } from '../lib/scan.js';

const names = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const exact = value => ({ value, exact: true });

const baseline = (overrides = {}) => ({
    followers: names('f', 300),
    streams: { followers: { profileCount: 300, fullAt: 1_000, quickRuns: 0 } },
    ...overrides
});
const plan = (overrides = {}) => planQuick({
    baseline: baseline(),
    type: 'followers',
    expected: exact(300),
    now: 2_000,
    ...overrides
});

test('sameNames compares order-sensitively and ignores case', () => {
    assert.equal(sameNames(['A', 'b'], ['a', 'B']), true);
    assert.equal(sameNames(['a', 'b'], ['b', 'a']), false);
    assert.equal(sameNames(['a'], ['a', 'b']), false);
});

test('planQuick: nothing new means head page + last page', () => {
    const p = plan();
    assert.equal(p.delta, 0);
    assert.deepEqual(p.head, names('f', 25));
    assert.equal(p.tail.page, 12);
    assert.deepEqual(p.tail.names, names('f', 300).slice(275));
    assert.equal(quickPageCount(p), 2);
});

test('planQuick: new followers move the last page boundary', () => {
    const p = plan({ expected: exact(307) });                 // 7 new
    assert.equal(p.delta, 7);
    assert.equal(p.tail.page, 13);                            // ceil(307 / 25)
    // page 13 of the new list holds new positions 300..306 = old positions 293..299
    assert.deepEqual(p.tail.names, names('f', 300).slice(293));
    assert.equal(quickPageCount(p), 3);
});

test('planQuick refuses whenever a quick scan could not be trusted', () => {
    assert.equal(plan({ full: true }), null, 'user asked for a full scan');
    assert.equal(plan({ expected: exact(299) }), null, 'somebody left (negative delta)');
    assert.equal(plan({ expected: { value: 300, exact: false } }), null, 'approximate profile count');
    assert.equal(plan({ expected: null }), null, 'unreadable profile count');
    assert.equal(plan({ expected: exact(300 + QUICK_MAX_NEW + 1) }), null, 'too many new names');
    assert.notEqual(plan({ expected: exact(300 + QUICK_MAX_NEW) }), null);
    assert.equal(plan({ baseline: null }), null, 'no baseline');
    assert.equal(plan({ baseline: baseline({ followers: names('f', 99) }) }), null, 'small list');
    assert.equal(plan({ baseline: baseline({ streams: {} }) }), null, 'baseline without counts');
    assert.equal(plan({ baseline: baseline({ streams: { followers: { profileCount: null, fullAt: 1_000, quickRuns: 0 } } }) }), null);
    assert.equal(plan({ now: 1_000 + QUICK_MAX_AGE_MS + 1 }), null, 'baseline too old');
    assert.equal(plan({ baseline: baseline({ streams: { followers: { profileCount: 300, fullAt: 1_000, quickRuns: QUICK_MAX_RUNS } } }) }), null, 'too many quick scans in a row');
});

test('headCheck waits for enough names, then confirms new names + old head', () => {
    const p = plan({ expected: exact(303) });                 // 3 new
    const fresh = ['n0', 'n1', 'n2'];
    const page = list => list.slice(0, 25);

    assert.deepEqual(headCheck(p, page([...fresh, ...names('f', 300)])), { status: 'more' });   // 25 < 3 + 25
    const two = [...fresh, ...names('f', 300)].slice(0, 50);
    assert.deepEqual(headCheck(p, two), { status: 'ok', gained: fresh });
});

test('headCheck detects removals, swaps and other orders', () => {
    const p = plan({ expected: exact(301) });                 // 1 new
    const good = ['n0', ...names('f', 300)].slice(0, 50);
    assert.equal(headCheck(p, good).status, 'ok');

    // one gained AND one lost at the head: counts balance out only if D were 0, but D is 1
    const shifted = ['n0', ...names('f', 300).slice(1)].slice(0, 50);
    assert.equal(headCheck(p, shifted).status, 'fail');

    // the new name is not at the head (e.g. a name-sorted list)
    const elsewhere = [...names('f', 10), 'n0', ...names('f', 300).slice(10)].slice(0, 50);
    assert.equal(headCheck(p, elsewhere).status, 'fail');

    // somebody left (balanced by one more new follower) and D=0 sees a new head item
    const zero = plan();
    assert.equal(headCheck(zero, ['n0', ...names('f', 300).slice(1)].slice(0, 25)).status, 'fail');
});

test('mergeQuick puts the new names in front', () => {
    assert.deepEqual(mergeQuick(['n1'], ['a', 'b']), ['n1', 'a', 'b']);
    assert.deepEqual(mergeQuick([], ['a']), ['a']);
});
