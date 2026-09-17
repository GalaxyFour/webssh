const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement(tagName = 'div') {
    const classes = new Set();
    const listeners = new Map();
    const element = {
        tagName: tagName.toUpperCase(),
        children: [],
        parentNode: null,
        dataset: {},
        attributes: {},
        style: {},
        hidden: false,
        textContent: '',
        className: '',
        id: '',
        scrollLeft: 0,
        scrollWidth: 1200,
        clientWidth: 300,
        scrollCalls: [],
        classList: {
            add(...values) { values.forEach(value => classes.add(value)); },
            remove(...values) { values.forEach(value => classes.delete(value)); },
            contains(value) { return classes.has(value); },
            toggle(value, force) {
                const next = force === undefined ? !classes.has(value) : Boolean(force);
                if (next) classes.add(value);
                else classes.delete(value);
                return next;
            },
        },
        appendChild(child) {
            child.parentNode?.removeChild?.(child);
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        get nextElementSibling() {
            const siblings = this.parentNode?.children || [];
            return siblings[siblings.indexOf(this) + 1] || null;
        },
        insertBefore(child, reference) {
            child.parentNode?.removeChild?.(child);
            child.parentNode = this;
            const index = this.children.indexOf(reference);
            this.children.splice(index < 0 ? this.children.length : index, 0, child);
            return child;
        },
        removeChild(child) {
            this.children = this.children.filter(candidate => candidate !== child);
            child.parentNode = null;
        },
        remove() { this.parentNode?.removeChild?.(this); },
        addEventListener(type, handler, options) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push({handler, options});
        },
        removeEventListener(type, handler) {
            const entries = listeners.get(type) || [];
            listeners.set(type, entries.filter(entry => entry.handler !== handler));
        },
        emit(type, event = {}) {
            (listeners.get(type) || []).forEach(
                entry => entry.handler({target: this, ...event}),
            );
        },
        fire(type, event = {}) {
            const merged = {target: this, ...event};
            (listeners.get(type) || []).slice().forEach(entry => {
                if (merged.defaultPrevented && type === 'click') return;
                entry.handler(merged);
            });
            return merged;
        },
        handlers(type) {
            return (listeners.get(type) || []).map(entry => entry.handler);
        },
        click() {
            this.fire('click', {stopPropagation() {}, preventDefault() {}});
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        scrollIntoView(options) {
            this.scrollCalls.push(options);
        },
        closest(selector) {
            if (selector === '.session-tabs-row') return this.row || null;
            return null;
        },
        querySelector(selector) {
            return this.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
            const matches = [];
            const visit = node => {
                const classNames = String(node.className || '').split(/\s+/).filter(Boolean);
                const matchesSelector = selector.startsWith('.')
                    ? classNames.includes(selector.slice(1))
                    : node.tagName === selector.toUpperCase();
                if (matchesSelector) matches.push(node);
                node.children.forEach(visit);
            };
            this.children.forEach(visit);
            return matches;
        },
    };
    return element;
}

function loadSessionManager() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'static', 'js', 'session-manager.js'),
        'utf8',
    );
    const elements = new Map();
    const body = createElement('body');
    body.dataset = {
        confirmSessionClose: 'false',
        disconnectSessionAction: 'retry',
        connectionHistoryScope: '',
    };
    const timers = [];
    const context = {
        console,
        document: {
            body,
            createElement,
            createTextNode: value => ({textContent: String(value)}),
            getElementById(id) {
                if (elements.has(id)) return elements.get(id);
                const findById = node => {
                    if (node.id === id) return node;
                    for (const child of node.children || []) {
                        const match = findById(child);
                        if (match) return match;
                    }
                    return null;
                };
                for (const root of elements.values()) {
                    const match = findById(root);
                    if (match) return match;
                }
                return null;
            },
            querySelectorAll: () => [],
        },
        TerminalManager: {
            destroyTerminal() {},
            resyncRestoredOutput() {},
            seedRestoredOutput() {},
        },
        CustomEvent: class CustomEvent {
            constructor(type, options) {
                this.type = type;
                this.detail = options?.detail;
            }
        },
        setTimeout: (handler) => {
            timers.push(handler);
            return timers.length;
        },
        window: {
            listeners: new Map(),
            timers,
            dispatchEvent(event) {
                const listeners = this.listeners?.get(event.type) || [];
                listeners.forEach(listener => listener(event));
                return true;
            },
            addEventListener(type, listener) {
                if (!this.listeners.has(type)) this.listeners.set(type, []);
                this.listeners.get(type).push(listener);
            },
            removeEventListener(type, listener) {
                const entries = this.listeners.get(type) || [];
                this.listeners.set(type, entries.filter(entry => entry !== listener));
            },
            setTimeout(handler) {
                timers.push(handler);
                return timers.length;
            },
        },
    };
    context.window.window = context.window;
    context.window.CustomEvent = context.CustomEvent;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__SessionManager = SessionManager;`, context);
    return {
        manager: context.__SessionManager,
        context,
        createElement,
        runTimers() {
            while (timers.length > 0) timers.shift()();
            while (context.window.timers.length > 0) context.window.timers.shift()();
        },
        registerElement(id, element) {
            element.id = id;
            elements.set(id, element);
            return element;
        },
    };
}

function prepareTabsHarness({rowHidden = false} = {}) {
    const harness = loadSessionManager();
    const tabs = harness.registerElement('sessionTabs', createElement('div'));
    const row = createElement('div');
    row.className = 'session-tabs-row';
    row.hidden = rowHidden;
    tabs.row = row;
    harness.manager.sessions = {
        sessionA: {username: 'alice', host: 'example.test'},
    };
    return {...harness, tabs, row};
}

test('creating a session tab scrolls the new tab into view', () => {
    const {manager, tabs} = prepareTabsHarness();

    manager.createSessionTab('sessionA');

    const tab = tabs.children.find(child => child.id === 'tab-sessionA');
    assert.ok(tab);
    assert.deepEqual(JSON.parse(JSON.stringify(tab.scrollCalls)), [
        {block: 'nearest', inline: 'nearest'},
    ]);
});

test('activating a pane scrolls its session tab into view', () => {
    const {manager, tabs} = prepareTabsHarness();
    manager.paneAssignments = ['sessionA'];
    manager.activePaneIndex = 0;
    manager.updateSessionMeta = () => {};
    manager.focusActivePane = () => {};
    manager.notifyWorkspaceChange = () => {};
    manager.ensureTerminalGrid = () => ({querySelectorAll: () => []});
    manager.createSessionTab('sessionA');

    const tab = tabs.children.find(child => child.id === 'tab-sessionA');
    tab.scrollCalls.length = 0;
    manager.setActivePane(0);

    assert.deepEqual(JSON.parse(JSON.stringify(tab.scrollCalls)), [
        {block: 'nearest', inline: 'nearest'},
    ]);
});

test('pending connections scroll their tab into view on create', () => {
    const {manager, tabs} = prepareTabsHarness();

    manager.createPendingConnection('request-1', 'example.test', 'alice', 22);

    const tab = tabs.children.find(child => child.id === 'pending-request-1');
    assert.ok(tab);
    assert.deepEqual(JSON.parse(JSON.stringify(tab.scrollCalls)), [
        {block: 'nearest', inline: 'nearest'},
    ]);
});

test('tab auto-scroll is skipped while the session rail is hidden', () => {
    const {manager, tabs} = prepareTabsHarness({rowHidden: true});

    manager.createSessionTab('sessionA');

    const tab = tabs.children.find(child => child.id === 'tab-sessionA');
    assert.ok(tab);
    assert.deepEqual(tab.scrollCalls, []);
});

test('vertical wheel input translates to horizontal tab scrolling', () => {
    const {manager, tabs} = prepareTabsHarness();
    manager.initTabScrollAffordances();
    tabs.scrollLeft = 100;

    let prevented = false;
    tabs.fire('wheel', {
        deltaX: 0, deltaY: 120, ctrlKey: false, metaKey: false, shiftKey: false,
        preventDefault() { prevented = true; },
    });

    assert.equal(prevented, true);
    assert.equal(tabs.scrollLeft, 220);
});

test('wheel at the scroll edge leaves page scrolling alone', () => {
    const {manager, tabs} = prepareTabsHarness();
    manager.initTabScrollAffordances();
    tabs.scrollLeft = 0;

    let prevented = false;
    tabs.fire('wheel', {
        deltaX: 0, deltaY: -120, ctrlKey: false, metaKey: false, shiftKey: false,
        preventDefault() { prevented = true; },
    });

    assert.equal(prevented, false);
    assert.equal(tabs.scrollLeft, 0);
});

test('drag-to-scroll moves tabs but preserves simple clicks', () => {
    const {
        manager, context, tabs, runTimers,
    } = prepareTabsHarness();
    let closeClicks = 0;
    manager.requestCloseSession = () => { closeClicks += 1; };
    manager.createSessionTab('sessionA');
    manager.initTabScrollAffordances();
    tabs.scrollLeft = 100;
    const tab = tabs.children.find(child => child.id === 'tab-sessionA');
    const close = tab.querySelector('.tab-close');

    // Simple click still reaches the close handler.
    close.click();
    assert.equal(closeClicks, 1);
    assert.equal(tabs.scrollLeft, 100);

    // A real drag scrolls the rail and suppresses the follow-up click.
    tabs.fire('pointerdown', {
        pointerId: 7, button: 0, clientX: 200, pointerType: 'mouse',
    });
    const moves = context.window.listeners.get('pointermove') || [];
    const ups = context.window.listeners.get('pointerup') || [];
    assert.ok(moves.length > 0);
    assert.ok(ups.length > 0);
    moves.forEach(handler => handler({pointerId: 7, clientX: 120, pointerType: 'mouse'}));
    assert.equal(tabs.scrollLeft, 180);
    ups.forEach(handler => handler({pointerId: 7, pointerType: 'mouse'}));
    const fireContainerClick = () => {
        let suppressed = false;
        tabs.fire('click', {
            target: tab,
            stopPropagation() {},
            preventDefault() { suppressed = true; },
        });
        return suppressed;
    };
    assert.equal(fireContainerClick(), true);
    runTimers();
    assert.equal(fireContainerClick(), false);
    assert.equal(tabs.style.userSelect, '');
});

function preparePlacementHarness({mobile = false, overflow = false} = {}) {
    const harness = prepareTabsHarness();
    const {row, tabs, context, manager} = harness;
    const button = harness.registerElement('newTabBtn', createElement('button'));
    const actions = createElement('div');
    actions.className = 'tab-row-actions';
    row.appendChild(tabs);
    row.appendChild(actions);
    row.appendChild(button);
    tabs.clientWidth = 300;
    tabs.scrollWidth = overflow ? 600 : 300;
    const media = {matches: mobile, addEventListener(type, callback) { this.callback = callback; }};
    context.window.matchMedia = () => media;
    const observers = [];
    const mutations = [];
    context.window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
    };
    context.window.MutationObserver = class {
        constructor(callback) { this.callback = callback; mutations.push(this); }
        observe() {}
    };
    button.focus = () => { context.document.activeElement = button; };
    const insertBefore = row.insertBefore;
    row.insertBefore = function(child, reference) {
        if (context.document.activeElement === child) context.document.activeElement = null;
        return insertBefore.call(this, child, reference);
    };
    manager.initTabScrollAffordances();
    return {...harness, button, actions, media,
        update() { observers.forEach(o => o.callback()); harness.runTimers(); },
        mutate() { mutations.forEach(o => o.callback()); harness.runTimers(); },
    };
}

test('desktop add button follows the final tab before the tools when tabs fit', () => {
    const {row, tabs, button, actions} = preparePlacementHarness();
    assert.deepEqual(row.children, [tabs, button, actions]);
});

test('overflow changes preserve button identity, focus, click and tab scroll offset', () => {
    const {context, row, tabs, button, actions, update} = preparePlacementHarness({overflow: true});
    let clicks = 0;
    button.addEventListener('click', () => clicks++);
    button.focus();
    tabs.scrollLeft = 100;
    assert.deepEqual(row.children, [tabs, actions, button]);
    tabs.scrollWidth = 300;
    update();
    assert.deepEqual(row.children, [tabs, button, actions]);
    assert.equal(context.document.activeElement, button);
    assert.equal(tabs.scrollLeft, 100);
    button.click();
    assert.equal(clicks, 1);
    tabs.scrollWidth = 500;
    update();
    update();
    assert.deepEqual(row.children, [tabs, actions, button]);
});

test('mobile add button stays after tools and returns beside fitting tabs on desktop', () => {
    const {row, tabs, button, actions, media, context, runTimers} = preparePlacementHarness({mobile: true});
    assert.deepEqual(row.children, [tabs, actions, button]);
    media.matches = false;
    context.window.dispatchEvent({type: 'resize'});
    runTimers();
    assert.deepEqual(row.children, [tabs, button, actions]);
});

test('reopening the hidden rail recalculates add button placement', () => {
    const {row, tabs, button, actions, update} = preparePlacementHarness();
    assert.deepEqual(row.children, [tabs, button, actions]);
    row.hidden = true;
    tabs.clientWidth = 0;
    update();
    row.hidden = false;
    tabs.clientWidth = 200;
    tabs.scrollWidth = 400;
    update();
    assert.deepEqual(row.children, [tabs, actions, button]);
});

test('tab content changes reposition add button without a viewport resize', () => {
    const {row, tabs, button, actions, mutate} = preparePlacementHarness();
    tabs.scrollWidth = 600;
    mutate();
    assert.deepEqual(row.children, [tabs, actions, button]);
    tabs.scrollWidth = 300;
    mutate();
    assert.deepEqual(row.children, [tabs, button, actions]);
});
