const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function baseGlobals() {
    const rafQueue = [];
    return {
        rafQueue,
        globals: {
            addEventListener() {},
            visualViewport: null,
            requestAnimationFrame(callback) {
                rafQueue.push(callback);
                return rafQueue.length;
            },
        },
    };
}

function xtermMock(unassigned, hooks = {}) {
    let hidden = unassigned;
    const wrapper = {
        setUnassigned(value) { hidden = value; },
        classList: {
            contains(name) {
                return name === 'unassigned' && hidden;
            },
        },
    };
    const terminal = {
        rows: 24,
        cols: 80,
        buffer: {active: {viewportY: 0, baseY: 0, length: 100}},
        element: {closest: () => wrapper},
        write(data, callback) {
            hooks.writes = hooks.writes || [];
            hooks.writes.push(data);
            if (typeof callback === 'function') callback();
        },
        reset() {
            hooks.resets = (hooks.resets || 0) + 1;
        },
        scrollToBottom() {
            hooks.scrolls = (hooks.scrolls || 0) + 1;
        },
        refresh(start, end) {
            hooks.refreshes = hooks.refreshes || [];
            hooks.refreshes.push([start, end]);
        },
        dispose() {},
    };
    return {terminal, wrapper, hooks};
}

function loadTerminalManager() {
    const {rafQueue, globals} = baseGlobals();
    global.window = globals;
    global.document = {};
    global.navigator = {};
    global.requestAnimationFrame = globals.requestAnimationFrame;
    delete require.cache[require.resolve('../../static/js/terminal-manager.js')];
    require('../../static/js/terminal-manager.js');
    return {manager: global.window.TerminalManager, rafQueue};
}

function resetManager(manager) {
    manager.terminals = {};
    manager.sessionTerminals = {};
    manager.terminalReady = {};
    manager.pendingOutput = {};
    manager.pendingOutputSizes = {};
    manager.transcripts = {};
    manager.transcriptSizes = {};
    manager.sequencedOutput = {};
    manager.sequencedOutputSizes = {};
    manager.lastOutputSequences = {};
    manager.backgroundWrites = {};
    manager.terminalWriteCallbacks = {};
    manager.clipboardDisposers = {};
    manager.osc52ClipboardAllowed = {};
    manager.scrollbarDisposers = {};
    manager.fitSyncTimer = null;
    manager.syncedSizes = {};
}

function flushRaf(rafQueue) {
    while (rafQueue.length > 0) {
        const callbacks = rafQueue.splice(0);
        callbacks.forEach(callback => callback());
    }
}

test('repaintVisibleTerminal repaints visible keys after layout settles', () => {
    const {manager, rafQueue} = loadTerminalManager();
    resetManager(manager);
    const peer = xtermMock(false);
    manager.terminals = {k: peer.terminal};
    manager.sessionTerminals = {s: ['k']};

    manager.repaintVisibleTerminal('s');
    assert.equal(peer.hooks.refreshes, undefined);
    flushRaf(rafQueue);
    flushRaf(rafQueue);
    assert.deepEqual(peer.hooks.refreshes, [[0, 23]]);
});

test('repaintVisibleTerminal skips hidden keys', () => {
    const {manager, rafQueue} = loadTerminalManager();
    resetManager(manager);
    const peer = xtermMock(true);
    manager.terminals = {k: peer.terminal};
    manager.sessionTerminals = {s: ['k']};

    manager.repaintVisibleTerminal('s');
    flushRaf(rafQueue);
    flushRaf(rafQueue);
    assert.equal(peer.hooks.refreshes, undefined);
});

test('scheduleFitAndSyncVisibleTerminals coalesces bursts into one pass', async () => {
    const {manager} = loadTerminalManager();
    resetManager(manager);
    let passes = 0;
    manager.fitAndSyncVisibleTerminals = () => {
        passes += 1;
        return [];
    };

    manager.scheduleFitAndSyncVisibleTerminals({socket: null});
    manager.scheduleFitAndSyncVisibleTerminals({socket: null});
    manager.scheduleFitAndSyncVisibleTerminals({socket: null});
    assert.equal(passes, 0);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(passes, 1);
    assert.equal(manager.fitSyncTimer, null);
});

test('rapid tab switches synchronize the latest visible session rather than the first', async () => {
    const {manager} = loadTerminalManager();
    resetManager(manager);
    const first = xtermMock(false);
    const last = xtermMock(true);
    manager.terminals = {first: first.terminal, last: last.terminal};
    manager.sessionTerminals = {first: ['first'], last: ['last']};
    const sent = [];
    const socket = {connected: true, emit: (event, data) => sent.push([event, data])};

    manager.scheduleFitAndSyncVisibleTerminals({socket, isConnected: id => id === 'first'});
    first.wrapper.setUnassigned(true);
    last.wrapper.setUnassigned(false);
    manager.scheduleFitAndSyncVisibleTerminals({socket, isConnected: id => id === 'last'});
    await new Promise(resolve => setTimeout(resolve, 160));

    assert.deepEqual(sent, [['ssh_resize', {session_id: 'last', rows: 24, cols: 80}]]);
});

test('disconnected resizes are not buffered or recorded as synchronized', () => {
    const {manager} = loadTerminalManager();
    resetManager(manager);
    const peer = xtermMock(false);
    manager.terminals = {k: peer.terminal};
    manager.sessionTerminals = {s: ['k']};
    manager.syncedSizes.s = {rows: 20, cols: 60};
    const sent = [];
    const socket = {connected: false, emit: (event, data) => sent.push([event, data])};

    manager.fitAndSyncVisibleTerminals({socket, force: true});
    assert.deepEqual(sent, []);
    assert.deepEqual(manager.syncedSizes.s, {rows: 20, cols: 60});
    socket.connected = true;
    manager.fitAndSyncVisibleTerminals({socket});
    assert.deepEqual(sent, [['ssh_resize', {session_id: 's', rows: 24, cols: 80}]]);
});

function loadSessionManager(termStub) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'static', 'js', 'session-manager.js'),
        'utf8',
    );
    const panes = new Map();
    const wrappers = new Map();
    const grid = {
        querySelector(selector) {
            const match = selector.match(/data-pane-index="(\d+)"/);
            return match ? panes.get(Number(match[1])) || null : null;
        },
    };
    const context = {
        console,
        document: {
            body: {dataset: {}},
            createElement: () => ({
                children: [],
                appendChild(child) {
                    this.children.push(child);
                    return child;
                },
            }),
            getElementById(id) {
                if (id === 'terminalGrid') return grid;
                return wrappers.get(id) || null;
            },
        },
        TerminalManager: termStub,
        CustomEvent: class CustomEvent {},
        window: {},
        localStorage: {
            getItem: () => null,
            setItem() {},
            removeItem() {},
        },
    };
    vm.createContext(context);
    vm.runInContext(
        `${source}\n;globalThis.__SessionManager = SessionManager;`,
        context,
    );
    return {manager: context.__SessionManager, panes, wrappers};
}

test('renderPane resumes live output and repaints without rebuilding the parser', () => {
    const calls = {resume: [], replay: [], repaint: []};
    const {manager, panes, wrappers} = loadSessionManager({
        fitTerminal() {},
        resumeVisibleOutput: sessionId => calls.resume.push(sessionId),
        replayDeferredOutput: sessionId => calls.replay.push(sessionId),
        repaintVisibleTerminal: sessionId => calls.repaint.push(sessionId),
    });
    wrappers.set('term-s1', {classList: {remove() {}}});
    panes.set(0, {innerHTML: '', appendChild() {}});
    manager.sessions = {s1: {id: 's1', terminalId: 'term-s1'}};
    manager.paneAssignments = ['s1'];

    manager.renderPane(0);

    assert.deepEqual(calls.resume, ['s1']);
    assert.deepEqual(calls.replay, []);
    assert.deepEqual(calls.repaint, ['s1']);
});
