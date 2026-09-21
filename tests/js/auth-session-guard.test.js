const assert = require('node:assert/strict');
const test = require('node:test');
const guardModule = require('../../static/js/auth-session-guard.js');

function storage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
    };
}

test('warns before web authentication expiry and distinguishes it from SSH idle', () => {
    const notices = [];
    const timers = [];
    const browserWindow = {
        document: {body: {dataset: {}}, getElementById() { return null; }},
        sessionStorage: storage(),
        location: {pathname: '/', search: '', hash: '', assign() {}},
        showNotification(value) { notices.push(value); return () => {}; },
        setTimeout(callback, delay) { timers.push({callback, delay}); return timers.length; },
    };
    const guard = guardModule.create({
        window: browserWindow,
        document: browserWindow.document,
        expiresAt: 1000 + (4 * 60 * 1000),
        now: () => 1000,
        setTimeout: browserWindow.setTimeout,
    });
    guard.schedule();
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /separate from the SSH idle timeout/);
    assert.equal(notices[0].persistent, true);
    assert.equal(timers[0].delay, 3 * 60 * 1000);
});

test('expiry stores workspace context before returning to login', () => {
    const assigned = [];
    const sessionStorage = storage();
    const note = {value: 'unfinished note'};
    const browserDocument = {
        body: {dataset: {primaryWorkspace: 'workspaces'}},
        getElementById(id) { return id === 'sessionNotepad' ? note : null; },
    };
    const browserWindow = {
        document: browserDocument, sessionStorage,
        APP_ROOT: '/ssh', authSessionRedirectPending: false,
        location: {pathname: '/', search: '?view=1', hash: '#current', assign: value => assigned.push(value)},
        SessionManager: {getActiveSession: () => 'session-a'},
        workspaceLayoutController: {getState: () => ({activeContext: 'files'})},
        notepadController: {hasUnsaved: () => true},
        SessionCommandLauncher: {parameterDrafts: new Map([['command-a', '--draft']])},
        setTimeout() {},
    };
    const guard = guardModule.create({
        window: browserWindow, document: browserDocument, storage: sessionStorage,
        expiresAt: 0, now: () => 1234, setTimeout() {},
    });
    guard.expire();
    assert.equal(browserWindow.authSessionRedirectPending, true);
    assert.deepEqual(assigned, ['/ssh/login?next=%2F%3Fview%3D1']);
    assert.deepEqual(guardModule.readRestore(sessionStorage, 1234), {
        savedAt: 1234, path: '/?view=1#current', sessionId: 'session-a',
        primaryView: 'workspaces', activeContext: 'files', noteDraft: 'unfinished note',
        layout: null, paneAssignments: [], commandDrafts: [['command-a', '--draft']],
    });
});
