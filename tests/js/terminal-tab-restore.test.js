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
    manager.pendingReplay = {};
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

test('resync skips xterm rebuild for hidden keys but accepts pending output', () => {
    const {manager} = loadTerminalManager();
    resetManager(manager);
    const peer = xtermMock(true);
    manager.terminals = {k: peer.terminal};
    manager.sessionTerminals = {s: ['k']};
    manager.terminalReady = {k: true};
    let acknowledgements = 0;
    manager.pendingOutput = {k: [{data: 'held', onWritten: () => acknowledgements++}]};
    manager.pendingOutputSizes = {k: 4};

    manager.resyncRestoredOutput('s', 'snapshot', 0);

    assert.equal(peer.hooks.resets || 0, 0);
    assert.equal(peer.hooks.writes, undefined);
    assert.equal(acknowledgements, 1);
    assert.equal(manager.pendingReplay.s, true);
    assert.equal(manager.terminalReady.k, true);
});

test('replayDeferredOutput rebuilds visible keys once and clears the flag', () => {
    const {manager} = loadTerminalManager();
    resetManager(manager);
    const peer = xtermMock(false);
    manager.terminals = {k: peer.terminal};
    manager.sessionTerminals = {s: ['k']};
    manager.terminalReady = {k: true};
    manager.transcripts = {s: ['screen']};
    manager.transcriptSizes = {s: 6};
    manager.pendingReplay = {s: true};
    const activated = [];
    manager.activateOsc52ClipboardHandler = (key) => activated.push(key);

    manager.replayDeferredOutput('s');

    assert.equal(peer.hooks.resets, 1);
    assert.deepEqual(peer.hooks.writes.filter(chunk => chunk !== ''), ['screen']);
    assert.deepEqual(activated, ['k']);
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

test('renderPane replays deferred output and repaints on unhide', () => {
    const calls = {fit: [], resume: [], replay: [], repaint: [], consumed: []};
    const {manager, panes, wrappers} = loadSessionManager({
        fitTerminal: sessionId => calls.fit.push(sessionId),
        resumeVisibleOutput: sessionId => calls.resume.push(sessionId),
        consumeDeferredReplay: sessionId => {
            calls.consumed.push(sessionId);
            return true;
        },
        replayDeferredOutput: sessionId => calls.replay.push(sessionId),
        repaintVisibleTerminal: sessionId => calls.repaint.push(sessionId),
    });
    const removed = [];
    wrappers.set('term-s1', {
        classList: {remove: name => removed.push(name)},
    });
    panes.set(0, {
        innerHTML: 'stale',
        appendChild() {},
    });
    manager.sessions = {s1: {id: 's1', terminalId: 'term-s1'}};
    manager.paneAssignments = ['s1'];

    manager.renderPane(0);

    assert.deepEqual(removed, ['unassigned']);
    assert.deepEqual(calls.fit, ['s1']);
    assert.deepEqual(calls.consumed, ['s1']);
    assert.deepEqual(calls.replay, ['s1']);
    assert.deepEqual(calls.resume, []);
    assert.deepEqual(calls.repaint, ['s1']);
});

test('renderPane resumes live output when no replay is deferred', () => {
    const calls = {resume: [], replay: [], repaint: []};
    const {manager, panes, wrappers} = loadSessionManager({
        fitTerminal() {},
        resumeVisibleOutput: sessionId => calls.resume.push(sessionId),
        consumeDeferredReplay: () => false,
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
