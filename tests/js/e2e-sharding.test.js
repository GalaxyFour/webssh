const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const {
    DEFAULT_FALLBACK_SECONDS,
    assignTests,
    parsePlaywrightList,
    parseShard,
} = require('../../scripts/e2e-sharding');
const { resolvePlaywrightCli } = require('../../scripts/e2e-process');

function sampleTests() {
    return [
        { identity: 'tests/e2e/a.spec.js::slow', selector: 'a.spec.js › slow' },
        { identity: 'tests/e2e/b.spec.js::medium', selector: 'b.spec.js › medium' },
        { identity: 'tests/e2e/c.spec.js::quick', selector: 'c.spec.js › quick' },
        { identity: 'tests/e2e/d.spec.js::new test', selector: 'd.spec.js › new test' },
    ];
}

test('Playwright CLI resolves through the installed package bin metadata', () => {
    const cli = resolvePlaywrightCli();
    assert.equal(fs.existsSync(cli), true);
    assert.match(cli.replaceAll('\\', '/'), /node_modules\/playwright\/cli\.js$/);
});

test('parseShard accepts one-based shard coordinates', () => {
    assert.deepEqual(parseShard('1/2'), { current: 1, total: 2 });
    assert.deepEqual(parseShard('12/12'), { current: 12, total: 12 });
});

test('parseShard rejects malformed or out-of-range shard coordinates', () => {
    for (const value of [
        undefined,
        '',
        '0/2',
        '3/2',
        '1/0',
        '1',
        '1/2/3',
        'x/2',
        '9007199254740992/9007199254740992',
    ]) {
        assert.throws(() => parseShard(value), /shard/i, String(value));
    }
});

test('parsePlaywrightList removes line identities and rejects duplicate test identities', () => {
    const output = [
        'Listing tests:',
        '  alpha.spec.js:10:2 › nested suite › first test',
        '  beta.spec.js:30:4 › second test',
        'Total: 2 tests in 2 files',
        '',
    ].join('\r\n');

    assert.deepEqual(parsePlaywrightList(output), [
        {
            identity: 'tests/e2e/alpha.spec.js::nested suite::first test',
            selector: 'alpha.spec.js › nested suite › first test',
            group: 'tests/e2e/alpha.spec.js::nested suite::first test',
        },
        {
            identity: 'tests/e2e/beta.spec.js::second test',
            selector: 'beta.spec.js › second test',
            group: 'tests/e2e/beta.spec.js::second test',
        },
    ]);

    assert.throws(() => parsePlaywrightList([
        'Listing tests:',
        '  alpha.spec.js:10:2 › duplicate',
        '  alpha.spec.js:20:2 › duplicate',
        'Total: 2 tests in 1 file',
    ].join('\n')), /duplicate/i);

    assert.throws(() => parsePlaywrightList([
        'Listing tests:',
        '  alpha.spec.js:10:2 › only parsed test',
        'Total: 2 tests in 1 file',
    ].join('\n')), /reported 2 tests.*parsed 1/i);
});

test('duration assignment is deterministic, complete and disjoint', () => {
    const baseline = {
        fallbackSeconds: DEFAULT_FALLBACK_SECONDS,
        tests: {
            'tests/e2e/a.spec.js::slow': 20,
            'tests/e2e/b.spec.js::medium': 10,
            'tests/e2e/c.spec.js::quick': 2,
        },
    };
    const forward = assignTests(sampleTests(), 2, baseline);
    const reverse = assignTests(sampleTests().reverse(), 2, baseline);

    const mapping = result => Object.fromEntries(result.shards.flatMap(
        (shard, index) => shard.map(item => [item.identity, index]),
    ));
    assert.deepEqual(mapping(forward), mapping(reverse));

    const selected = forward.shards.flat().map(item => item.identity);
    assert.equal(selected.length, sampleTests().length);
    assert.equal(new Set(selected).size, sampleTests().length);
    assert.deepEqual(new Set(selected), new Set(sampleTests().map(item => item.identity)));
});

test('new tests use the conservative fallback and fixture groups stay together', () => {
    const tests = [
        { identity: 'tests/e2e/a.spec.js::one', selector: 'a.spec.js › one', group: 'serial-a' },
        { identity: 'tests/e2e/a.spec.js::two', selector: 'a.spec.js › two', group: 'serial-a' },
        { identity: 'tests/e2e/b.spec.js::new', selector: 'b.spec.js › new', group: 'new' },
    ];
    const result = assignTests(tests, 2, {
        fallbackSeconds: DEFAULT_FALLBACK_SECONDS,
        tests: {
            'tests/e2e/a.spec.js::one': 2,
            'tests/e2e/a.spec.js::two': 3,
        },
    });

    const groupShards = result.shards.map(shard => shard.map(item => item.group));
    assert.equal(groupShards.filter(groups => groups.includes('serial-a')).length, 1);
    assert.equal(result.weights['tests/e2e/b.spec.js::new'], DEFAULT_FALLBACK_SECONDS);
});
