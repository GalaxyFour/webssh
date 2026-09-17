(function(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TerminalAppearance = api;
}(typeof window !== 'undefined' ? window : null, function() {
    'use strict';
    function resolve(settings, base, font, size) {
        const value = settings && typeof settings === 'object' ? settings : {};
        const number = (key, min, max, fallback, integer = false) => (
            typeof value[key] === 'number' && Number.isFinite(value[key])
            && value[key] >= min && value[key] <= max
            && (!integer || Number.isInteger(value[key])) ? value[key] : fallback
        );
        const color = (key, fallback) => /^#[\da-f]{6}$/i.test(value[key]) ? value[key] : fallback;
        const family = typeof value.font_family === 'string'
            && value.font_family !== 'theme'
            && /^[a-z\d][a-z\d _-]{0,63}$/i.test(value.font_family)
            ? `"${value.font_family}", monospace` : font;
        return {
            surface: color('background', base.background),
            opacity: number('background_opacity', 0, 100, 100, true) / 100,
            options: {
                allowTransparency: true,
                theme: {...base, background: '#00000000',
                    foreground: color('foreground', base.foreground),
                    cursor: color('cursor_color', base.cursor),
                    selectionBackground: color('selection_background', base.selectionBackground),
                },
                fontFamily: family,
                fontSize: number('font_size', 8, 32, size, true),
                lineHeight: number('line_height', 1, 2, 1),
                letterSpacing: number('letter_spacing', -1, 3, 0),
                fontWeight: value.font_weight === 'bold' ? 'bold' : 'normal',
                cursorStyle: ['block', 'underline', 'bar'].includes(value.cursor_style) ? value.cursor_style : 'block',
                cursorBlink: typeof value.cursor_blink === 'boolean' ? value.cursor_blink : true,
            },
        };
    }
    let preferences = {};
    if (typeof document !== 'undefined') {
        try { preferences = JSON.parse(document.body.dataset.terminalAppearance || '{}'); } catch { /* Follow theme. */ }
    }
    const getPreferences = () => preferences;
    const setPreferences = value => { preferences = {...value}; };

    function init() {
        const modal = document.getElementById('terminalAppearanceModal');
        if (!modal) return;
        const form = document.getElementById('terminalAppearanceForm');
        const previewElement = document.getElementById('terminalAppearancePreview');
        const status = document.getElementById('terminalAppearanceStatus');
        const manager = window.TerminalManager;
        const controls = Array.from(form.querySelectorAll('[data-appearance]'));
        let draft = {...preferences};
        let preview;
        let fit;
        let saving = false;
        const t = key => window.i18n?.t?.(key) || key;

        function updatePreview() {
            const resolved = resolve(draft, manager.buildTheme(), manager.getMonoFont(), manager.getResponsiveFontSize());
            previewElement.style.setProperty('--terminal-surface-color', resolved.surface);
            previewElement.style.setProperty('--terminal-surface-opacity', `${resolved.opacity * 100}%`);
            if (preview) {
                Object.assign(preview.options, resolved.options);
                fit.fit();
            }
            document.getElementById('terminalOpacityValue').textContent = `${draft.background_opacity ?? 100}%`;
        }
        function renderControls() {
            const base = manager.buildTheme();
            const colors = {background: base.background, foreground: base.foreground, cursor_color: base.cursor, selection_background: '#587899'};
            const defaults = {font_family: 'theme', font_size: '', line_height: 1, letter_spacing: 0, font_weight: 'normal', background_opacity: 100, cursor_style: 'block', cursor_blink: true};
            controls.forEach(control => {
                const key = control.dataset.appearance;
                if (control.type === 'checkbox') control.checked = draft[key] ?? defaults[key];
                else control.value = draft[key] ?? colors[key] ?? defaults[key];
            });
            form.querySelectorAll('[data-color-override]').forEach(control => {
                control.checked = Boolean(draft[control.dataset.colorOverride]);
                form.querySelector(`[data-appearance="${control.dataset.colorOverride}"]`).disabled = !control.checked;
            });
            updatePreview();
        }
        function open() {
            window.mobileAppShell?.closeMoreMenu();
            draft = {...preferences};
            status.textContent = '';
            renderControls();
            requestAnimationFrame(() => {
                // The mobile menu restores its focus in this frame first.
                window.ModalManager.open(modal);
                if (!preview) {
                    preview = new Terminal({...resolve(draft, manager.buildTheme(), manager.getMonoFont(), manager.getResponsiveFontSize()).options, rows: 6, disableStdin: true, scrollback: 0});
                    fit = new FitAddon.FitAddon();
                    preview.loadAddon(fit);
                    preview.open(previewElement);
                    preview.write('\x1b[32mops\x1b[0m@webssh:~$ ls -lh\r\n\x1b[34mprojects/\x1b[0m  \x1b[33mnotes.txt\x1b[0m  config.yaml\r\n\x1b[36mTerminal preview\x1b[0m — Aa Bb 0123456789\r\nops@webssh:~$ ');
                }
                updatePreview();
            });
        }
        document.querySelectorAll('[data-open-terminal-appearance]').forEach(button => button.addEventListener('click', open));
        modal.querySelectorAll('[data-close-terminal-appearance]').forEach(button => button.addEventListener('click', () => window.ModalManager.close(modal)));
        controls.forEach(control => control.addEventListener('input', () => {
            status.textContent = '';
            const key = control.dataset.appearance;
            if (control.type === 'checkbox') draft[key] = control.checked;
            else if (control.type === 'number' || control.type === 'range') draft[key] = control.value === '' ? null : Number(control.value);
            else draft[key] = control.value;
            updatePreview();
        }));
        form.querySelectorAll('[data-color-override]').forEach(control => control.addEventListener('change', () => {
            status.textContent = '';
            const key = control.dataset.colorOverride;
            const picker = form.querySelector(`[data-appearance="${key}"]`);
            picker.disabled = !control.checked;
            if (control.checked) draft[key] = picker.value;
            else delete draft[key];
            updatePreview();
        }));
        document.getElementById('terminalAppearanceReset').addEventListener('click', () => {
            draft = {};
            renderControls();
            status.textContent = t('terminalAppearance.resetHint');
        });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (saving || !form.reportValidity()) return;
            saving = true;
            const submitted = {...draft};
            const submit = document.getElementById('terminalAppearanceSave');
            submit.disabled = true;
            form.querySelectorAll('fieldset').forEach(fieldset => { fieldset.disabled = true; });
            document.getElementById('terminalAppearanceReset').disabled = true;
            status.textContent = t('terminalAppearance.saving');
            try {
                const appRoot = (document.querySelector('meta[name="app-root"]')?.content || '').replace(/\/$/, '');
                const response = await fetch(`${appRoot}/api/account/preferences`, {
                    method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]')?.content || ''},
                    body: JSON.stringify({terminal_appearance: submitted}),
                });
                const result = await response.json();
                if (!response.ok || !result.settings?.terminal_appearance) throw new Error('Save failed');
                setPreferences(result.settings.terminal_appearance);
                manager.applyThemeToAll();
                status.textContent = t('terminalAppearance.saved');
            } catch {
                status.textContent = t('terminalAppearance.failed');
            } finally {
                saving = false;
                submit.disabled = false;
                form.querySelectorAll('fieldset').forEach(fieldset => { fieldset.disabled = false; });
                document.getElementById('terminalAppearanceReset').disabled = false;
            }
        });
        const refreshPreview = () => {
            if (modal.classList.contains('show')) updatePreview();
        };
        window.addEventListener('resize', refreshPreview);
        window.addEventListener('themeChanged', refreshPreview);
        manager.updateAppearanceSurface();
    }
    if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
    return {resolve, getPreferences, setPreferences};
}));
