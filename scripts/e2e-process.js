const path = require('node:path');

function resolvePlaywrightCli() {
    const packageJsonPath = require.resolve('playwright/package.json');
    const packageJson = require(packageJsonPath);
    return path.join(path.dirname(packageJsonPath), packageJson.bin.playwright);
}

module.exports = { resolvePlaywrightCli };
