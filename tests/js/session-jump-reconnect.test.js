const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(route) {
    const sent = [];
    const context = { document: { body: { dataset: {} } }, window: {
        socket: { emit: (event, payload) => sent.push({event, payload}) },
        showNotification() {}, prepareSessionReconnectJump: () => route,
    }, confirm: () => true, setTimeout: fn => fn() };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../static/js/session-manager.js'), 'utf8')
        + '\n globalThis.manager = SessionManager;', context);
    const manager = context.manager;
    manager.getDisplayLabel = () => 'test';
    manager.closeSession = () => {};
    manager.removeSessionUI = () => {};
    manager.sessions.test = {host: 'private.example', port: 22, username: 'test', keyId: 'key',
        authType: 'key', viaJump: 'bastion.example', jumpHostId: 'bastion', connected: true,
        useTmux: true, tmuxSessionName: 'test'};
    return {manager, sent};
}

for (const persistent of [false, true]) {
    test(`reconnect preserves saved bastion reference (persistent=${persistent})`, () => {
        const {manager, sent} = setup({proxyJump: {jump_host_id: 'bastion'}});
        manager.sessions.test.isPersistentCandidate = persistent;
        manager.requestReconnect('test');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].payload.proxy_jump.jump_host_id, 'bastion');
    });
    test(`unresolved/password bastion opens form before removing session (persistent=${persistent})`, () => {
        const {manager, sent} = setup({requiresForm: true});
        manager.sessions.test.isPersistentCandidate = persistent;
        let form = false;
        manager.prefillConnectionForm = (_id, force) => { form = force; };
        manager.closeSession = manager.removeSessionUI = () => assert.fail('removed before route resolution');
        manager.requestReconnect('test');
        assert.equal(form, true);
        assert.equal(sent.length, 0);
    });
}

function routeHelper() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {value: '', checked: false,
            classList: {toggle() {}, add() {}}, focus() {}});
        return elements.get(id);
    };
    const context = {document: {getElementById: element}, window: {
        setConnectionAdvancedExpanded() {}, JumpHostManager: {loaded: true,
            getById: () => null, updatePasswordVisibility() {}},
    }};
    const source = fs.readFileSync(path.join(__dirname, '../../static/js/app.js'), 'utf8');
    vm.runInNewContext(source.slice(source.indexOf('    let selectedConnectionProfileState ='),
        source.indexOf('    let connectionHistoryStorage ='))
        + '\n globalThis.blocked = refreshConnectionProfileJumpResolution;', context);
    return {context, element, prepare: context.window.prepareSessionReconnectJump};
}

test('route helper refuses silent direct fallback for legacy, deleted and loading bastions', () => {
    const {context, element, prepare} = routeHelper();
    for (const session of [{viaJump: 'legacy'}, {jumpHostId: 'deleted'}, {reconnectRouteKnown: false}]) {
        assert.equal(prepare(session, {applyToForm: true}).requiresForm, true);
        assert.equal(context.blocked(), true);
        element('connectionProfileDirectConfirm').checked = true;
        assert.equal(context.blocked(), false);
        element('connectionProfileDirectConfirm').checked = false;
    }
    context.window.JumpHostManager.getById = () => ({auth_type: 'key'});
    context.window.JumpHostManager.loaded = false;
    assert.equal(prepare({jumpHostId: 'saved'}).requiresForm, true);
});

test('route helper sends only saved reference and prompts for password bastions', () => {
    const {context, element, prepare} = routeHelper();
    context.window.JumpHostManager.getById = () => ({auth_type: 'key'});
    assert.equal(prepare({jumpHostId: 'saved'}).proxyJump.jump_host_id, 'saved');
    assert.equal(Boolean(prepare({jumpHostId: 'saved'}).requiresForm), false);
    context.window.JumpHostManager.getById = () => ({auth_type: 'password'});
    assert.equal(prepare({jumpHostId: 'saved'}, {applyToForm: true}).requiresForm, true);
    assert.equal(element('jumpHostSelect').value, 'saved');
    assert.equal(context.blocked(), false);
    assert.equal(Boolean(prepare({reconnectRouteKnown: true}).requiresForm), false);
});
