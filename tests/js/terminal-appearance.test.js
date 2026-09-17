const test = require('node:test');
const assert = require('node:assert/strict');
const appearance = require('../../static/js/terminal-appearance');

const base = {background: '#182028', foreground: '#eeeeee', cursor: '#ffffff', red: '#cc0000'};
test('custom terminal colors survive a different app theme without changing ANSI colors', () => {
    const settings = {background: '#112233', foreground: '#abcdef', cursor_color: '#fedcba'};
    const result = appearance.resolve(settings, base, 'monospace', 14);
    assert.equal(result.surface, '#112233');
    assert.equal(result.options.theme.foreground, '#abcdef');
    assert.equal(result.options.theme.cursor, '#fedcba');
    assert.equal(result.options.theme.red, base.red);
    assert.equal(base.foreground, '#eeeeee');
    assert.equal(appearance.resolve(settings, {...base, background: '#ffffff'}, 'monospace', 14).surface, '#112233');
});
test('opacity affects only the background surface, not terminal text', () => {
    const result = appearance.resolve({background_opacity: 25}, base, 'monospace', 14);
    assert.equal(result.opacity, .25);
    assert.equal(result.options.theme.background, '#00000000');
    assert.equal(result.options.theme.foreground, base.foreground);
    assert.equal(result.options.allowTransparency, true);
});
test('custom typography survives responsive sizing and reset follows theme defaults', () => {
    const result = appearance.resolve({font_family: 'JetBrains Mono', font_size: 19, line_height: 1.4, letter_spacing: .5, font_weight: 'bold', cursor_style: 'bar', cursor_blink: false}, base, 'Consolas', 12);
    assert.equal(result.options.fontSize, 19);
    assert.equal(result.options.fontFamily, '"JetBrains Mono", monospace');
    assert.equal(result.options.lineHeight, 1.4);
    assert.equal(result.options.letterSpacing, .5);
    assert.equal(result.options.fontWeight, 'bold');
    assert.equal(result.options.cursorStyle, 'bar');
    assert.equal(result.options.cursorBlink, false);
    const reset = appearance.resolve({}, base, 'Consolas', 12);
    assert.equal(reset.options.fontSize, 12);
    assert.equal(reset.options.fontFamily, 'Consolas');
    assert.equal(reset.surface, base.background);
    assert.equal(reset.opacity, 1);
});
test('invalid browser-side values cannot inject CSS or unbounded terminal geometry', () => {
    const result = appearance.resolve({font_family: 'x";url(https://example.com)', background: 'url(x)', font_size: 999, line_height: Infinity, letter_spacing: NaN, background_opacity: -5}, base, 'monospace', 14);
    assert.equal(result.options.fontFamily, 'monospace');
    assert.equal(result.surface, base.background);
    assert.equal(result.options.fontSize, 14);
    assert.equal(result.options.lineHeight, 1);
    assert.equal(result.options.letterSpacing, 0);
    assert.equal(result.opacity, 1);
});

test('theme refresh applies saved typography and colors to existing terminal instances', () => {
    global.window = {addEventListener() {}, TerminalAppearance: appearance};
    require('../../static/js/terminal-manager');
    const manager = window.TerminalManager;
    manager.buildTheme = () => base;
    manager.getMonoFont = () => 'monospace';
    manager.getResponsiveFontSize = () => 12;
    appearance.setPreferences({font_size: 20, font_family: 'Consolas', cursor_style: 'underline', foreground: '#aabbcc'});
    const terminal = {options: {}, rows: 24, refresh() {}};
    manager.terminals = {one: terminal};
    manager.sessionTerminals = {session: ['one']};
    manager.applyThemeToTerminal('session');
    assert.equal(terminal.options.fontSize, 20);
    assert.equal(terminal.options.theme.foreground, '#aabbcc');
    assert.equal(terminal.options.cursorStyle, 'underline');
    appearance.setPreferences({});
    manager.applyThemeToTerminal('session');
    assert.equal(terminal.options.fontSize, 12);
    assert.equal(terminal.options.theme.foreground, base.foreground);
});
