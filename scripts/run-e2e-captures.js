const { spawnSync } = require('node:child_process');
const { resolvePlaywrightCli } = require('./e2e-process');

const playwrightCli = resolvePlaywrightCli();
const captureFiles = [
    'tests/e2e/product-captures.spec.js',
    'tests/e2e/session-workspace.spec.js',
    'tests/e2e/review-regressions.spec.js',
];
const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '--forbid-only', ...captureFiles],
    {
        cwd: process.cwd(),
        env: { ...process.env, WEBSSH_CAPTURE_ASSETS: '1' },
        stdio: 'inherit',
    },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
