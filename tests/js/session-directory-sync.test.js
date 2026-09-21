const assert = require('node:assert/strict');
const test = require('node:test');
const sync = require('../../static/js/session-directory-sync.js');

function harness(options = {}) {
    const requests = [], sent = [], moves = [], timers = new Map();
    let seq = 0, ready = true, version = 0, source = 'sftp-session:a';
    const indicator = {hidden: true};
    const inputListeners = {};
    const checkbox = {
        checked: false,
        disabled: true,
        addEventListener(type, listener) { inputListeners[type] = listener; },
    };
    const panel = {dataset: {}};
    const manager = {
        panes: {left: {path: '/old'}},
        isEmbeddedOpen: () => true,
        getPaneSourceId: () => source,
        navigatePaneTo(pane, path, options) {
            moves.push([pane, path, options]); manager.panes.left.path = path;
        },
    };
    const controller = sync.createController({
        socket: {emit(event, data, callback) { requests.push({event, data, callback}); }},
        manager, indicator, input: checkbox, panel, ...options,
        canSend: () => ready, inputVersion: () => version,
        sendInput: (...args) => sent.push(args),
        setTimeout(fn) {timers.set(++seq, fn); return seq;},
        clearTimeout(id) {timers.delete(id);},
    });
    controller.setContext('a', true);
    function reply(index, path='/tmp', shell_ready=true, shell='bash') {
        requests[index].callback({success:true, directory:{path, shell_ready, shell_id:'42', shell}});
    }
    return {controller, requests, sent, moves, indicator, checkbox, panel, reply, manager,
        ready(value) {ready=value;}, input() {version++;}, source(id) {source=`sftp-session:${id}`;},
        toggle(value) {checkbox.checked = value; inputListeners.change();}};
}

test('personal setting off leaves folder navigation independent', () => {
    const h=harness({enabledByDefault: false});
    assert.equal(h.requests.length,0);
    assert.equal(h.controller.navigate('a','/tmp'),false);
    assert.equal(h.indicator.hidden, false);
    assert.equal(h.checkbox.checked, false);
    assert.equal(h.panel.dataset.directorySyncEnabled, 'false');
});

test('personal setting on checks the per-session switch and follows automatically', () => {
    const h = harness({});
    assert.equal(h.requests.length, 1);
    h.reply(0);
    assert.deepEqual(h.moves, [['left', '/tmp', {directorySync:true}]]);
    assert.deepEqual(h.sent, []);
    assert.equal(h.indicator.hidden, false);
    assert.equal(h.checkbox.checked, true);
    assert.equal(h.panel.dataset.directorySyncEnabled, 'true');
    h.source('b'); h.controller.setContext('b', true);
    assert.equal(h.requests.length, 2);
});

test('the panel switch overrides the default for each session', () => {
    const h = harness({enabledByDefault: false});
    h.toggle(true);
    assert.equal(h.checkbox.checked, true);
    assert.equal(h.requests.length, 1);
    h.toggle(false);
    assert.equal(h.checkbox.checked, false);
    assert.equal(h.controller.navigate('a', '/tmp'), false);
    h.source('b'); h.controller.setContext('b', true);
    assert.equal(h.checkbox.checked, false);
    h.toggle(true);
    assert.equal(h.requests.length, 2);
    h.source('a'); h.controller.setContext('a', true);
    assert.equal(h.checkbox.checked, false);
});

test('default on starts after the embedded source finishes mounting', () => {
    const h = harness({});
    h.reply(0);
    h.source('loading'); h.controller.setContext('b', true);
    assert.equal(h.requests.length, 1);
    h.source('b'); h.controller.setContext('b', true);
    assert.equal(h.requests.length, 2);
    h.controller.setContext('b', true);
    assert.equal(h.requests.length, 2);
});

test('folder navigation probes again and targets exactly its SSH session', () => {
    const h=harness();h.reply(0);
    h.controller.navigate('a',"/tmp/O'Brien $HOME");
    assert.equal(h.sent.length,0);h.reply(1);
    assert.deepEqual(h.sent,[['a',"cd -- '/tmp/O'\\''Brien $HOME'\r"]]);
    assert.equal(h.manager.panes.left.path,'/tmp');
});

test('busy foreground application or concurrent typing prevents terminal input', () => {
    for (const mode of ['busy','typing','dirty']) {
        const h=harness();h.reply(0);
        if(mode==='dirty') h.ready(false);
        h.controller.navigate('a','/elsewhere');
        if(mode==='typing') h.input();
        if(mode!=='dirty') h.reply(1,'/tmp',mode!=='busy');
        assert.deepEqual(h.sent,[]);
    }
});

test('hide, session switch and source changes invalidate late replies', () => {
    for(const mode of ['hide','switch','source']) {
        const h=harness();h.reply(0);
        h.controller.navigate('a','/elsewhere');
        if(mode==='hide') h.controller.setContext('a',false);
        if(mode==='switch') {h.source('b');h.controller.setContext('b',true);}
        if(mode==='source') h.source('other');
        h.reply(1);
        assert.deepEqual(h.sent,[]);
    }
});

test('superseded folder requests do not send stale cd', () => {
    const h=harness();h.reply(0);
    h.controller.navigate('a','/first');h.controller.navigate('a','/second');
    h.reply(1);assert.deepEqual(h.sent,[]);h.reply(2);
    assert.deepEqual(h.sent,[['a',"cd -- '/second'\r"]]);
});

test('paths reject relative, control and oversized input and quote metacharacters', () => {
    for(const value of ['relative','/tmp\nwhoami','/tmp\r', '/\x1b[31m', '/\x85', '/'+ 'é'.repeat(4096)]) {
        assert.equal(sync.cdCommand(value),null);
    }
    assert.equal(sync.cdCommand('/tmp/$(touch nope); *'),"cd -- '/tmp/$(touch nope); *'\r");
    assert.equal(
        sync.cdCommand("/tmp/back\\slash'quoted; touch nope", 'fish'),
        "cd -- '/tmp/back\\\\slash\\'quoted; touch nope'\r",
    );
});

test('prompt tracking starts conservatively and pauses on typed input and alternate screen', () => {
    let mode, onData;
    const terminal={parser:{registerCsiHandler(_id,fn){mode=fn;}},onData(fn){onData=fn;},buffer:{active:{type:'normal'}},modes:{bracketedPasteMode:true}};
    sync.trackTerminal('tracked',terminal);
    assert.equal(sync.canSend('tracked'),false);
    assert.equal(mode([2004]),false);assert.equal(sync.canSend('tracked'),true);
    onData('echo unfinished');assert.equal(sync.canSend('tracked'),false);
    mode([2004]);terminal.buffer.active.type='alternate';assert.equal(sync.canSend('tracked'),false);
});

test('replayed prompt history stays unsafe until a new live prompt boundary', () => {
    let mode;
    const terminal = {
        parser: {registerCsiHandler(_id, fn) { mode = fn; }},
        onData() {},
        buffer: {active: {type: 'normal'}},
        modes: {bracketedPasteMode: true},
    };
    sync.trackTerminal('restored', terminal);
    sync.beginReplay('restored');
    mode([2004]);
    sync.endReplay('restored');
    assert.equal(sync.canSend('restored'), false);
    mode([2004]);
    assert.equal(sync.canSend('restored'), true);
});

test('unsupported probes never move Files or write to the shell', () => {
    const h=harness();
    h.requests[0].callback({success:false,reason:'unsupported'});
    assert.deepEqual(h.moves,[]);assert.deepEqual(h.sent,[]);
});

test('a late read-only poll cannot undo a newer folder navigation', () => {
    const h=harness();
    h.controller.navigate('a','/wanted');
    h.reply(0,'/stale');assert.deepEqual(h.moves,[]);
    h.reply(1,'/actual');
    assert.deepEqual(h.sent,[['a',"cd -- '/wanted'\r"]]);
});
