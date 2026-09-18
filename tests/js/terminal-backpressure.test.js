const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = {
    addEventListener() {},
    visualViewport: null,
};
global.document = {};
global.navigator = {};

require('../../static/js/terminal-manager.js');
const TerminalManager = global.window.TerminalManager;

function wrapperMock(unassigned) {
    let hidden = unassigned;
    return {
        setUnassigned(value) { hidden = value; },
        classList: {
            contains(name) {
                return name === 'unassigned' && hidden;
            },
        },
    };
}

function xtermMock(unassigned, hooks = {}) {
    const wrapper = wrapperMock(unassigned);
    const terminal = {
        rows: 24,
        cols: 80,
        buffer: {active: {viewportY: 0, baseY: 0, length: 100}},
        element: {
            closest: () => wrapper,
        },
        write(data, callback) {
            hooks.writes = hooks.writes || [];
            hooks.callbacks = hooks.callbacks || [];
            hooks.writes.push(data);
            hooks.callbacks.push(callback);
        },
        scrollToBottom() {
            hooks.scrolls = (hooks.scrolls || 0) + 1;
        },
        reset() {
            hooks.resets = (hooks.resets || 0) + 1;
        },
        dispose() {},
    };
    return {terminal, wrapper, hooks};
}

function resetManager() {
    TerminalManager.terminals = {};
    TerminalManager.sessionTerminals = {};
    TerminalManager.terminalReady = {};
    TerminalManager.pendingOutput = {};
    TerminalManager.pendingOutputSizes = {};
    TerminalManager.transcripts = {};
    TerminalManager.transcriptSizes = {};
    TerminalManager.sequencedOutput = {};
    TerminalManager.sequencedOutputSizes = {};
    TerminalManager.lastOutputSequences = {};
    TerminalManager.skippedOutput = {};
    TerminalManager.terminalWriteCallbacks = {};
    TerminalManager.clipboardDisposers = {};
    TerminalManager.osc52ClipboardAllowed = {};
    TerminalManager.scrollbarDisposers = {};
}

test('hidden panes skip xterm rendering but keep transcript and prompt ACK', () => {
    resetManager();
    const visible = xtermMock(false);
    const hidden = xtermMock(true);
    TerminalManager.terminals = {
        visibleKey: visible.terminal,
        hiddenKey: hidden.terminal,
    };
    TerminalManager.sessionTerminals = {s: ['visibleKey', 'hiddenKey']};
    TerminalManager.terminalReady = {visibleKey: true, hiddenKey: true};

    let acknowledgements = 0;
    TerminalManager.writeOutput('s', 'chunk', 5, () => {
        acknowledgements += 1;
    });

    assert.deepEqual(visible.hooks.writes, ['chunk']);
    assert.deepEqual(hidden.hooks.writes || [], []);
    assert.equal(acknowledgements, 0);
    assert.equal(TerminalManager.getTranscript('s'), 'chunk');
    assert.deepEqual(
        TerminalManager.sequencedOutput.s,
        [{sequence: 5, data: 'chunk'}],
    );
    assert.deepEqual(TerminalManager.skippedOutput.s, ['hiddenKey']);

    visible.hooks.callbacks[0]();
    assert.equal(acknowledgements, 1);
});

test('all-hidden sessions acknowledge immediately without rendering', () => {
    resetManager();
    const first = xtermMock(true);
    const second = xtermMock(true);
    TerminalManager.terminals = {
        firstKey: first.terminal,
        secondKey: second.terminal,
    };
    TerminalManager.sessionTerminals = {s: ['firstKey', 'secondKey']};
    TerminalManager.terminalReady = {firstKey: true, secondKey: true};

    let acknowledgements = 0;
    TerminalManager.writeOutput('s', 'background', null, () => {
        acknowledgements += 1;
    });

    assert.equal(acknowledgements, 1);
    assert.deepEqual(first.hooks.writes || [], []);
    assert.deepEqual(second.hooks.writes || [], []);
    assert.equal(TerminalManager.getTranscript('s'), 'background');
    assert.deepEqual(
        (TerminalManager.skippedOutput.s || []).sort(),
        ['firstKey', 'secondKey'],
    );
});

test('replaySkippedOutput rebuilds visible terminals from the transcript', () => {
    resetManager();
    const originalRegister = TerminalManager.registerOsc52ClipboardHandler;
    const activations = [];
    TerminalManager.registerOsc52ClipboardHandler = () => {
        activations.push(true);
        return {dispose() {}};
    };
    try {
        const peer = xtermMock(false);
        TerminalManager.terminals = {replayKey: peer.terminal};
        TerminalManager.sessionTerminals = {s: ['replayKey']};
        TerminalManager.terminalReady = {replayKey: true};
        TerminalManager.transcripts = {s: ['first ', 'second']};
        TerminalManager.transcriptSizes = {s: 13};
        TerminalManager.skippedOutput = {s: ['replayKey']};
        TerminalManager.osc52ClipboardAllowed = {replayKey: true};

        let completed = 0;
        TerminalManager.replaySkippedOutput('s', () => {
            completed += 1;
        });

        assert.equal(peer.hooks.resets, 1);
        assert.deepEqual(peer.hooks.writes, ['first second']);
        assert.equal(completed, 0);
        assert.deepEqual(activations, []);

        peer.hooks.callbacks[0]();
        assert.equal(completed, 1);
        assert.deepEqual(activations, [true]);
        assert.equal(TerminalManager.skippedOutput.s, undefined);
    } finally {
        TerminalManager.registerOsc52ClipboardHandler = originalRegister;
    }
});

test('replaySkippedOutput defers terminals that are still hidden or unattached', () => {
    resetManager();
    const hidden = xtermMock(true);
    TerminalManager.terminals = {hiddenKey: hidden.terminal};
    TerminalManager.sessionTerminals = {s: ['hiddenKey', 'pendingKey']};
    TerminalManager.terminalReady = {hiddenKey: true, pendingKey: false};
    TerminalManager.transcripts = {s: ['live']};
    TerminalManager.transcriptSizes = {s: 4};
    TerminalManager.skippedOutput = {s: ['hiddenKey', 'pendingKey']};

    let completed = 0;
    TerminalManager.replaySkippedOutput('s', () => {
        completed += 1;
    });

    assert.equal(completed, 1);
    assert.deepEqual(hidden.hooks.writes || [], []);
    assert.deepEqual(TerminalManager.skippedOutput.s, ['hiddenKey', 'pendingKey']);

    hidden.wrapper.setUnassigned(false);
    TerminalManager.replaySkippedOutput('s');
    assert.deepEqual(hidden.hooks.writes, ['live']);
    assert.deepEqual(TerminalManager.skippedOutput.s, ['pendingKey']);
});

test('destroyTerminalKey drops skipped flags for the removed key', () => {
    resetManager();
    TerminalManager.terminals = {a: {dispose() {}}, b: {dispose() {}}};
    TerminalManager.sessionTerminals = {s: ['a', 'b']};
    TerminalManager.pendingOutput = {a: [], b: []};
    TerminalManager.terminalWriteCallbacks = {a: new Set(), b: new Set()};
    TerminalManager.skippedOutput = {s: ['a', 'b']};

    TerminalManager.destroyTerminalKey('a', 's');
    assert.deepEqual(TerminalManager.sessionTerminals.s, ['b']);
    assert.deepEqual(TerminalManager.skippedOutput.s, ['b']);

    TerminalManager.destroyTerminalKey('b', 's');
    assert.equal(TerminalManager.skippedOutput.s, undefined);
});

test('scrollbar interval skips DOM work for hidden panes and disposes cleanly', () => {
    resetManager();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalCreateElement = global.document.createElement;
    let intervalCallback = null;
    const cleared = [];
    const thumb = {
        style: {},
        setPointerCapture() {},
        addEventListener() {},
        removeEventListener() {},
    };
    const scrollbar = {
        className: '',
        innerHTML: '',
        style: {},
        clientHeight: 200,
        querySelector: () => thumb,
        addEventListener() {},
        removeEventListener() {},
        remove() {},
    };
    global.setInterval = callback => {
        intervalCallback = callback;
        return 999;
    };
    global.clearInterval = id => {
        cleared.push(id);
    };
    global.document.createElement = () => scrollbar;
    try {
        const peer = xtermMock(false);
        peer.terminal.buffer.active.length = 500;
        peer.terminal.onScroll = () => ({dispose() {}});
        peer.terminal.onResize = () => ({dispose() {}});
        TerminalManager.terminals = {scrollKey: peer.terminal};

        const container = {style: {}, appendChild() {}};
        TerminalManager.setupScrollbar(container, peer.terminal, 'scrollKey');
        assert.equal(typeof intervalCallback, 'function');

        const visibleTop = thumb.style.top;
        peer.terminal.buffer.active.viewportY = 40;
        intervalCallback();
        assert.notEqual(thumb.style.top, visibleTop);

        peer.wrapper.setUnassigned(true);
        const frozen = {...thumb.style};
        const frozenDisplay = scrollbar.style.display;
        peer.terminal.buffer.active.viewportY = 120;
        intervalCallback();
        assert.deepEqual({...thumb.style}, frozen);
        assert.equal(scrollbar.style.display, frozenDisplay);

        TerminalManager.scrollbarDisposers.scrollKey();
        assert.deepEqual(cleared, [999]);
        assert.equal(TerminalManager.scrollbarDisposers.scrollKey, undefined);
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        if (originalCreateElement === undefined) {
            delete global.document.createElement;
        } else {
            global.document.createElement = originalCreateElement;
        }
    }
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

test('renderPane replays skipped output when a session becomes visible', () => {
    const calls = {fit: [], replay: []};
    const {manager, panes, wrappers} = loadSessionManager({
        fitTerminal: sessionId => calls.fit.push(sessionId),
        replaySkippedOutput: sessionId => calls.replay.push(sessionId),
    });
    const removed = [];
    const appended = [];
    wrappers.set('term-s1', {
        classList: {remove: name => removed.push(name)},
    });
    panes.set(0, {
        innerHTML: 'stale',
        appendChild: node => appended.push(node),
    });
    manager.sessions = {s1: {id: 's1', terminalId: 'term-s1'}};
    manager.paneAssignments = ['s1'];

    manager.renderPane(0);

    assert.deepEqual(removed, ['unassigned']);
    assert.deepEqual(appended, [wrappers.get('term-s1')]);
    assert.deepEqual(calls.fit, ['s1']);
    assert.deepEqual(calls.replay, ['s1']);
});
