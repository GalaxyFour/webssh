const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TimingReporter = require('../../tests/e2e/timing-reporter');
const { buildBaseline } = require('../../scripts/refresh-e2e-timing');

test('timing reporter persists attempts when the run fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-e2e-timing-'));
    const outputFile = path.join(directory, 'e2e-timing-shard-1-of-2.json');
    try {
        const reporter = new TimingReporter({ outputFile });
        const testCase = {
            location: { file: path.join(process.cwd(), 'tests/e2e/example.spec.js') },
            titlePath: () => ['', 'example.spec.js', 'outer suite', 'example test'],
        };
        reporter.onBegin({ workers: 1 }, { allTests: () => [testCase] });
        reporter.onTestEnd(testCase, { duration: 1250, retry: 0, status: 'failed' });
        reporter.onTestEnd(testCase, { duration: 750, retry: 1, status: 'passed' });
        reporter.onEnd({ status: 'failed' });

        const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        assert.equal(report.status, 'failed');
        assert.equal(report.tests.length, 1);
        assert.equal(
            report.tests[0].identity,
            'tests/e2e/example.spec.js::outer suite::example test',
        );
        assert.deepEqual(report.tests[0].attempts, [
            { retry: 0, status: 'failed', durationMs: 1250 },
            { retry: 1, status: 'passed', durationMs: 750 },
        ]);
        assert.equal(report.tests[0].durationMs, 2000);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('baseline refresh averages observed durations and keeps a conservative fallback', () => {
    const baseline = buildBaseline([
        {
            status: 'passed',
            discovered: 2,
            shard: null,
            tests: [
                { identity: 'tests/e2e/a.spec.js::one', durationMs: 1500,
                    attempts: [{ status: 'passed' }] },
                { identity: 'tests/e2e/b.spec.js::two', durationMs: 5000,
                    attempts: [{ status: 'passed' }] },
            ],
        },
        {
            status: 'passed',
            discovered: 1,
            shard: null,
            tests: [
                { identity: 'tests/e2e/a.spec.js::one', durationMs: 2500,
                    attempts: [{ status: 'passed' }] },
            ],
        },
    ], ['first.json', 'second.json']);

    assert.equal(baseline.fallbackSeconds, 30);
    assert.deepEqual(baseline.tests, {
        'tests/e2e/a.spec.js::one': 2,
        'tests/e2e/b.spec.js::two': 5,
    });
    assert.deepEqual(baseline.sources, ['first.json', 'second.json']);
});

test('baseline refresh rejects failed, incomplete and partial shard reports', () => {
    const completeTest = {
        identity: 'tests/e2e/a.spec.js::one',
        durationMs: 1000,
        attempts: [{ retry: 0, status: 'passed', durationMs: 1000 }],
    };
    assert.throws(() => buildBaseline([{
        status: 'failed', discovered: 1, shard: null, tests: [completeTest],
    }], ['failed.json']), /successful/i);
    assert.throws(() => buildBaseline([{
        status: 'passed', discovered: 2, shard: null, tests: [completeTest],
    }], ['incomplete.json']), /discovered 2.*recorded 1/i);
    assert.throws(() => buildBaseline([{
        status: 'passed', discovered: 1, shard: '1/2', tests: [completeTest],
    }], ['shard-1.json']), /complete shard set/i);
});
