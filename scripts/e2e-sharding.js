const DEFAULT_FALLBACK_SECONDS = 30;
const TEST_DIRECTORY = 'tests/e2e';

function parseShard(value) {
    const match = /^(\d+)\/(\d+)$/.exec(value || '');
    if (!match) {
        throw new Error('Expected --shard=<current>/<total> with positive integers.');
    }
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total)
            || current < 1 || total < 1 || current > total) {
        throw new Error(`Invalid shard ${value}: current must be between 1 and total.`);
    }
    return { current, total };
}

function stripLocation(file) {
    return file.replace(/:\d+(?::\d+)?$/, '').replaceAll('\\', '/');
}

function baselinePath(file) {
    if (file.startsWith(`${TEST_DIRECTORY}/`)) return file;
    return `${TEST_DIRECTORY}/${file}`;
}

function parsePlaywrightList(output) {
    const discovered = [];
    let inList = false;
    let reportedTotal = null;
    for (const rawLine of output.split(/\r?\n/)) {
        if (rawLine.trim() === 'Listing tests:') {
            inList = true;
            continue;
        }
        if (!inList) continue;
        const totalMatch = /^Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?/.exec(rawLine);
        if (totalMatch) {
            reportedTotal = Number(totalMatch[1]);
            break;
        }
        if (!rawLine.startsWith('  ') || !rawLine.includes('›')) continue;

        const parts = rawLine.trim().split(/\s+›\s+/);
        const project = parts[0].startsWith('[') ? parts.shift() : null;
        const file = stripLocation(parts.shift());
        if (!file || parts.length === 0) {
            throw new Error(`Could not parse Playwright test identity: ${rawLine.trim()}`);
        }
        const identityParts = [project, baselinePath(file), ...parts].filter(Boolean);
        const selectorParts = [project, file, ...parts].filter(Boolean);
        const identity = identityParts.join('::');
        discovered.push({
            identity,
            selector: selectorParts.join(' › '),
            group: identity,
        });
    }

    if (discovered.length === 0) {
        throw new Error('Playwright discovery returned no tests.');
    }
    if (!Number.isSafeInteger(reportedTotal)) {
        throw new Error('Playwright discovery output did not contain a parseable Total line.');
    }
    if (reportedTotal !== discovered.length) {
        throw new Error(
            `Playwright reported ${reportedTotal} tests but the weighted runner parsed `
            + `${discovered.length}; refusing partial discovery.`,
        );
    }
    const identities = new Set();
    for (const item of discovered) {
        if (identities.has(item.identity)) {
            throw new Error(`Duplicate Playwright test identity: ${item.identity}`);
        }
        identities.add(item.identity);
    }
    return discovered;
}

function assignTests(tests, shardCount, baseline) {
    if (!Number.isInteger(shardCount) || shardCount < 1) {
        throw new Error('Shard count must be a positive integer.');
    }
    const fallbackSeconds = Number(baseline?.fallbackSeconds
        ?? DEFAULT_FALLBACK_SECONDS);
    if (!Number.isFinite(fallbackSeconds) || fallbackSeconds <= 0) {
        throw new Error('Baseline fallbackSeconds must be a positive number.');
    }

    const groups = new Map();
    const identities = new Set();
    const weights = {};
    for (const item of tests) {
        if (!item?.identity || !item.selector) {
            throw new Error('Every discovered test needs an identity and selector.');
        }
        if (identities.has(item.identity)) {
            throw new Error(`Duplicate discovered test identity: ${item.identity}`);
        }
        identities.add(item.identity);
        const weight = Number(baseline?.tests?.[item.identity] ?? fallbackSeconds);
        if (!Number.isFinite(weight) || weight <= 0) {
            throw new Error(`Invalid duration weight for ${item.identity}.`);
        }
        weights[item.identity] = weight;
        const groupName = item.group || item.identity;
        const group = groups.get(groupName) || { name: groupName, tests: [], weight: 0 };
        group.tests.push({ ...item, group: groupName });
        group.weight += weight;
        groups.set(groupName, group);
    }

    const orderedGroups = [...groups.values()].sort((left, right) => (
        right.weight - left.weight || left.name.localeCompare(right.name, 'en')
    ));
    const shards = Array.from({ length: shardCount }, () => []);
    const loads = Array.from({ length: shardCount }, () => 0);
    for (const group of orderedGroups) {
        let destination = 0;
        for (let index = 1; index < shardCount; index += 1) {
            if (loads[index] < loads[destination]) destination = index;
        }
        shards[destination].push(...group.tests.sort(
            (left, right) => left.identity.localeCompare(right.identity, 'en'),
        ));
        loads[destination] += group.weight;
    }

    return { shards, loads, weights };
}

module.exports = {
    DEFAULT_FALLBACK_SECONDS,
    assignTests,
    parsePlaywrightList,
    parseShard,
};
