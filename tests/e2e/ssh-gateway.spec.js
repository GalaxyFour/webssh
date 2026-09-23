const {test, expect} = require('playwright/test');
const {login, assertNoExternalRequests} = require('./helpers');

test('gateway challenges are correlated, masked, text-only and transient', async ({page}) => {
    await login(page);
    await page.evaluate(() => {
        window.__gatewaySent = [];
        const original = window.socket.emit.bind(window.socket);
        window.socket.emit = (event, data, ack) => {
            if (event.startsWith('ssh_gateway_')) {
                window.__gatewaySent.push({event, data: structuredClone(data)});
                ack?.({success: true});
                return;
            }
            return original(event, data, ack);
        };
        const dispatch = data => window.socket.listeners('ssh_gateway_challenge').forEach(fn => fn(data));
        dispatch({client_request_id: 'unsolicited', prompts: []});
        window.SSHGatewayDialog.prepare({username: 'user:target', client_request_id: 'gateway-test'});
        dispatch({
            client_request_id: 'gateway-test', challenge_id: 'one-shot',
            title: '<img src=x onerror=alert(1)>',
            instructions: 'Approve https://example.test/approval then return. javascript:alert(1)',
            prompts: [{label: '<script>bad()</script>'}],
        });
    });
    const modal = page.locator('#sshGatewayModal');
    await expect(modal).toHaveClass(/show/);
    await expect(modal.locator('img,script')).toHaveCount(0);
    await expect(modal.locator('input')).toHaveAttribute('type', 'password');
    await expect(modal.locator('a')).toHaveCount(1);
    await expect(modal.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
    await modal.locator('input').fill('123456');
    await modal.locator('button[type=submit]').click();
    await expect(modal.locator('input')).toHaveValue('');
    expect(await page.evaluate(() => window.__gatewaySent[0])).toEqual({
        event: 'ssh_gateway_answer',
        data: {client_request_id: 'gateway-test', challenge_id: 'one-shot', answers: ['123456']},
    });
    await page.evaluate(() => {
        window.socket.listeners('ssh_error').forEach(fn => fn({
            client_request_id: 'gateway-test', error: 'cancelled',
        }));
    });
    await expect(modal).not.toHaveClass(/show/);
    await expect(modal.locator('input')).toHaveCount(0);
    assertNoExternalRequests(page);
});

test('ordinary passwords stay required and gateway passwords can be empty', async ({page}) => {
    await login(page);
    await page.evaluate(() => window.openDefaultConnectionModal());
    await page.locator('#hostInput').fill('example.com');
    await page.locator('#usernameInput').fill('ordinary');
    await expect(page.locator('#passwordHint')).toHaveText('');
    await page.evaluate(() => {
        window.__ordinaryConnects = [];
        const original = window.socket.emit.bind(window.socket);
        window.socket.emit = (event, data, ...args) => {
            if (event === 'ssh_connect') {
                window.__ordinaryConnects.push(data);
                return;
            }
            return original(event, data, ...args);
        };
    });
    await page.locator('#connectBtn').click();
    await expect(page.locator('#passwordInput')).toBeFocused();
    expect(await page.evaluate(() => window.__ordinaryConnects.length)).toBe(0);
    await page.locator('#usernameInput').fill('user:target');
    await expect(page.locator('#passwordInput')).toHaveJSProperty('required', false);
    const gatewayHint = await page.evaluate(() => window.i18n.t('gateway.passwordHint'));
    const requiredHint = await page.evaluate(() => window.i18n.t('connection.passwordRequired'));
    await expect(page.locator('#passwordHint')).toHaveText(gatewayHint);
    await page.locator('#usernameInput').fill('ordinary');
    await expect(page.locator('#passwordHint')).toHaveText(requiredHint);
    await page.locator('#passwordInput').fill('test-password');
    await expect(page.locator('#passwordHint')).toHaveText('');
    await page.locator('#usernameInput').fill('user:target');
    await page.locator('#passwordInput').fill('');
    await expect(page.locator('#passwordHint')).toHaveText(gatewayHint);
    await page.locator('#authTypeSelect').selectOption('key');
    await page.locator('#authTypeSelect').selectOption('password');
    await expect(page.locator('#passwordInput')).toHaveJSProperty('required', false);
    await expect(page.locator('#passwordHint')).toHaveText(gatewayHint);
    await page.locator('#usernameInput').fill('ordinary');
    await page.locator('#passwordInput').fill('test-password');
    await page.locator('#connectBtn').click();
    expect(await page.evaluate(() => window.__ordinaryConnects.map(data => data.username))).toEqual(['ordinary']);
    assertNoExternalRequests(page);
});


for (const action of ['button', 'escape']) {
    test(`gateway direct reconnect can be cancelled using ${action}`, async ({page}) => {
        await login(page);
        await page.evaluate(() => {
            window.__gatewayCancels = [];
            const original = window.socket.emit.bind(window.socket);
            window.socket.emit = (event, data, ack) => {
                if (event === 'ssh_connect_cancel') {
                    window.__gatewayCancels.push(data.client_request_id);
                    ack?.({success: true, cancelled: true});
                    return;
                }
                return original(event, data, ack);
            };
            window.SSHGatewayDialog.prepare({username: 'user:target', client_request_id: 'reconnect_test'});
            window.socket.listeners('ssh_gateway_challenge').forEach(fn => fn({
                client_request_id: 'reconnect_test', challenge_id: 'otp', prompts: [{label: 'OTP'}],
            }));
        });
        const modal = page.locator('#sshGatewayModal');
        await expect(modal).toHaveClass(/show/);
        if (action === 'escape') await modal.locator('input').press('Escape');
        else await modal.locator('.btn-secondary').click();
        await expect(modal).not.toHaveClass(/show/);
        expect(await page.evaluate(() => window.__gatewayCancels)).toEqual(['reconnect_test']);
    });
}


test('quick gateway errors and disconnect release only the matching request', async ({page}) => {
    await login(page);
    const result = await page.evaluate(() => {
        const manager = window.getSFTPFileManager();
        const dispatch = (event, data) => window.socket.listeners(event).forEach(fn => fn(data));
        manager.gatewayQuickRequestId = 'new-request';
        dispatch('quick_connect_error', {client_request_id: 'old-request', error: 'Invalid host'});
        const afterOld = manager.gatewayQuickRequestId;
        dispatch('quick_connect_error', {client_request_id: 'new-request', error: 'Invalid host'});
        const afterCurrent = manager.gatewayQuickRequestId;
        manager.gatewayQuickRequestId = 'retry';
        dispatch('disconnect', 'transport close');
        return {afterOld, afterCurrent, afterDisconnect: manager.gatewayQuickRequestId};
    });
    expect(result).toEqual({afterOld: 'new-request', afterCurrent: null, afterDisconnect: null});
});
