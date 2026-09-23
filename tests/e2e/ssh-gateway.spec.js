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
    await page.locator('#usernameInput').fill('ordinary');
    await expect(page.locator('#passwordInput')).toHaveJSProperty('required', true);
    await page.locator('#usernameInput').fill('user:target');
    await expect(page.locator('#passwordInput')).toHaveJSProperty('required', false);
    await page.locator('#usernameInput').fill('ordinary');
    await expect(page.locator('#passwordInput')).toHaveJSProperty('required', true);
    assertNoExternalRequests(page);
});
