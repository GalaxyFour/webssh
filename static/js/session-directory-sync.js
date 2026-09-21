(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) root.SessionDirectorySync = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const inputs = new Map();

    function trackTerminal(sessionId, terminal) {
        const state = { dirty: true, version: 0, terminal };
        inputs.set(sessionId, state);
        // Readline/ZLE announce the start of an editable prompt with DEC 2004.
        // Return false so xterm still handles the mode itself. An alternate
        // screen and the remote foreground-process check are separate guards.
        terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
            if (params.includes(2004) && !state.replayDepth) state.dirty = false;
            return false;
        });
        terminal.onData(data => noteInput(sessionId, data));
    }

    function noteInput(sessionId, data) {
        if (!data || /^\x1b\[[?>]?[0-9;]*c$/.test(data)) return;
        const state = inputs.get(sessionId);
        if (state) { state.dirty = true; state.version += 1; }
    }

    function beginReplay(sessionId) {
        const state = inputs.get(sessionId);
        if (!state) return;
        state.replayDepth = (state.replayDepth || 0) + 1;
        state.dirty = true;
    }

    function endReplay(sessionId) {
        const state = inputs.get(sessionId);
        if (!state) return;
        state.replayDepth = Math.max(0, (state.replayDepth || 0) - 1);
        // An old prompt in the transcript may be followed by unfinished input.
        // Require a subsequent live prompt boundary before sending a command.
        state.dirty = true;
    }

    function canSend(sessionId) {
        const state = inputs.get(sessionId);
        return Boolean(state && !state.dirty
            && state.terminal.buffer.active.type === 'normal'
            && state.terminal.modes.bracketedPasteMode);
    }

    function validPath(path) {
        return typeof path === 'string' && path.startsWith('/')
            && new TextEncoder().encode(path).length <= 4096
            && !/[\x00-\x1f\x7f-\x9f]/.test(path);
    }

    function cdCommand(path, shell = 'sh') {
        if (!validPath(path)) return null;
        if (shell === 'fish') {
            return `cd -- '${path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'\r`;
        }
        return `cd -- '${path.replace(/'/g, `'\\''`)}'\r`;
    }

    function createController(options) {
        const { socket, manager, indicator, input, panel } = options;
        const setTimer = options.setTimeout || setTimeout;
        const clearTimer = options.clearTimeout || clearTimeout;
        const inputReady = options.canSend || canSend;
        const inputVersion = options.inputVersion || (id => inputs.get(id)?.version);
        const enabledByDefault = options.enabledByDefault !== false;
        const sessionOverrides = new Map();
        let sessionId = null;
        let visible = false;
        let generation = 0;
        let timer = null;
        let timeout = null;
        let request = null;
        let directory = null;
        let awaitingChange = null;

        function isEnabled(id) {
            return Boolean(id && (sessionOverrides.has(id)
                ? sessionOverrides.get(id)
                : enabledByDefault));
        }

        function active() {
            return Boolean(sessionId && visible && isEnabled(sessionId)
                && manager.isEmbeddedOpen?.()
                && manager.getPaneSourceId('left') === `sftp-session:${sessionId}`);
        }

        function cancel() {
            generation += 1;
            clearTimer(timer);
            clearTimer(timeout);
            timer = timeout = request = null;
            awaitingChange = null;
        }

        function render() {
            const enabled = isEnabled(sessionId);
            if (indicator) indicator.hidden = !sessionId;
            if (input) {
                input.checked = enabled;
                input.disabled = !sessionId;
            }
            if (panel?.dataset) panel.dataset.directorySyncEnabled = String(enabled);
        }

        function setEnabled(value) {
            if (!sessionId) return false;
            sessionOverrides.set(sessionId, Boolean(value));
            cancel();
            directory = null;
            render();
            if (isEnabled(sessionId)) poll();
            return true;
        }

        function schedule(delay = 1500) {
            clearTimer(timer);
            if (active()) timer = setTimer(() => poll(), delay);
        }

        function follow(path) {
            const state = manager.panes.left;
            state.autoHomeEligible = false;
            if (state.path !== path) manager.navigatePaneTo('left', path, { directorySync: true });
        }

        function poll(targetPath = null) {
            if (!active() || request) return false;
            const token = { generation, sessionId, version: inputVersion(sessionId) };
            request = token;
            timeout = setTimer(() => {
                if (request !== token) return;
                request = null;
                schedule(10000);
            }, 5000);
            socket.emit('request_session_directory', { session_id: sessionId }, result => {
                if (request !== token || token.generation !== generation || !active()) return;
                clearTimer(timeout);
                request = null;
                const next = result?.directory;
                if (!result?.success || !validPath(next?.path)) {
                    schedule(10000);
                    return;
                }
                directory = next;
                if (targetPath !== null) {
                    if (!next.shell_ready || !inputReady(sessionId)
                            || token.version !== inputVersion(sessionId)
                            || options.hasPendingInput?.(sessionId)) {
                        schedule();
                        return;
                    }
                    if (next.path === targetPath) {
                        follow(next.path);
                        schedule();
                        return;
                    }
                    awaitingChange = { previous: next.path, polls: 0 };
                    noteInput(sessionId, targetPath);
                    // Deliberately target this SSH session, never broadcast.
                    options.sendInput(sessionId, cdCommand(targetPath, next.shell));
                    schedule(350);
                    return;
                }
                if (awaitingChange) {
                    awaitingChange.polls += 1;
                    if (!next.shell_ready || !inputReady(sessionId)) {
                        if (awaitingChange.polls >= 6) {
                            awaitingChange = null;
                        }
                        schedule(); return;
                    }
                    if (next.path === awaitingChange.previous && awaitingChange.polls < 3) {
                        schedule(500);
                        return;
                    }
                    awaitingChange = null;
                    follow(next.path);
                    schedule();
                    return;
                }
                follow(next.path);
                schedule();
            });
            return true;
        }

        input?.addEventListener?.('change', () => setEnabled(input.checked));

        return {
            setContext(id, isVisible) {
                if (id === sessionId && visible === isVisible) {
                    // The embedded source can finish mounting after context selection.
                    if (active() && timer === null && !request) poll();
                    return;
                }
                cancel();
                sessionId = id;
                visible = isVisible;
                directory = null;
                render();
                poll();
            },
            navigate(id, path) {
                if (id !== sessionId || !active()) return false;
                if (!validPath(path)) {
                    return true;
                }
                if (!inputReady(sessionId) || awaitingChange) {
                    return true;
                }
                // A user navigation supersedes a read-only poll. Its late
                // response must neither send input nor move the file pane.
                cancel();
                poll(path);
                return true;
            },
            removeSession(id) {
                inputs.delete(id);
                sessionOverrides.delete(id);
                if (id === sessionId) { cancel(); sessionId = null; render(); }
            },
            setEnabled,
            isEnabled,
            getDirectory() { return directory; },
        };
    }

    return {
        createController,
        trackTerminal,
        beginReplay,
        endReplay,
        noteInput,
        canSend,
        cdCommand,
        validPath,
    };
}));
