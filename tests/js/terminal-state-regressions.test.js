const test = require('node:test');
const assert = require('node:assert/strict');
const {Terminal} = require('../../static/vendor/xterm/xterm.js');

global.window = {addEventListener() {}, visualViewport: null};
global.document = {};
global.navigator = {};
require('../../static/js/terminal-manager.js');
const manager = window.TerminalManager;

function setup() {
    for (const key of ['terminals', 'sessionTerminals', 'terminalReady',
        'pendingOutput', 'pendingOutputSizes', 'transcripts', 'transcriptSizes',
        'sequencedOutput', 'sequencedOutputSizes', 'lastOutputSequences',
        'backgroundWrites', 'terminalWriteCallbacks',
        'clipboardDisposers', 'osc52ClipboardAllowed']) manager[key] = {};
    let hidden = false;
    const terminal = new Terminal({cols: 80, rows: 24, allowProposedApi: true});
    Object.defineProperty(terminal, 'element', {
        value: {closest: () => ({classList: {contains: () => hidden}})},
    });
    manager.terminals.k = terminal;
    manager.sessionTerminals.s = ['k'];
    manager.terminalReady.k = true;
    return {terminal, hide(value) { hidden = value; }};
}

const accept = data => new Promise(resolve => manager.writeOutput('s', data, null, resolve));
const resume = () => manager.resumeVisibleOutput('s');
const drained = terminal => new Promise(resolve => terminal.write('', resolve));

test('background transcript eviction preserves terminal protocol modes', async () => {
    const peer = setup();
    try {
        await accept('\x1b[?1049h\x1b[?2004h\x1b[?1h');
        peer.hide(true);
        await accept('x'.repeat(110000));
        await accept('y'.repeat(110000));
        peer.hide(false);
        resume();
        await drained(peer.terminal);
        assert.equal(peer.terminal.buffer.active.type, 'alternate');
        assert.equal(peer.terminal.modes.bracketedPasteMode, true);
        assert.equal(peer.terminal.modes.applicationCursorKeysMode, true);
    } finally {
        manager.destroyTerminalKey('k', 's');
    }
});

test('switching with an in-flight write does not duplicate output', async () => {
    const peer = setup();
    try {
        manager.writeOutput('s', 'before ');
        peer.hide(true);
        manager.writeOutput('s', 'during');
        peer.hide(false);
        resume();
        await drained(peer.terminal);
        assert.equal(peer.terminal.buffer.active.getLine(0).translateToString(true), 'before during');
    } finally {
        manager.destroyTerminalKey('k', 's');
    }
});

test('background batching preserves escape sequences split across writes', async () => {
    const peer = setup();
    try {
        await accept('\x1b[?20');
        peer.hide(true);
        await accept('04h');
        peer.hide(false);
        resume();
        await drained(peer.terminal);
        assert.equal(peer.terminal.modes.bracketedPasteMode, true);
    } finally {
        manager.destroyTerminalKey('k', 's');
    }
});

test('resync cancels queued old-transport writes without accepting their ACKs', async () => {
    const peer = setup();
    try {
        peer.hide(true);
        let staleAcknowledgements = 0;
        manager.writeOutput('s', 'old', 1, () => staleAcknowledgements++);
        manager.resyncRestoredOutput('s', 'snapshot', 1);
        await drained(peer.terminal);
        manager.flushBackgroundOutput('k');
        await drained(peer.terminal);
        assert.equal(staleAcknowledgements, 0);
        assert.equal(peer.terminal.buffer.active.getLine(0).translateToString(true), 'snapshot');
    } finally {
        manager.destroyTerminalKey('k', 's');
    }
});
