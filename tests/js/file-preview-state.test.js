const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
    const source = fs.readFileSync(path.join(__dirname, '../../static/js/app.js'), 'utf8');
    const part = source.slice(source.indexOf('const FilePreview = {'), source.indexOf('window.FilePreview = FilePreview;'));
    const fields = { editorContent: { value: 'one' }, editorStatus: {}, previewFilename: {}, previewSize: {} };
    const events = [];
    const context = { setTimeout: fn => { context.timeout = fn; return 1; }, clearTimeout() {}, window: { removeEventListener() {}, addEventListener() {}, ModalManager: { open() {} } }, document: { getElementById: id => fields[id] || null }, socket: { connected: true, emit: (event, data) => events.push({event, data}) }, showNotification() {}, console };
    vm.runInNewContext(part + '\nglobalThis.preview = FilePreview;', context);
    const preview = context.preview;
    Object.assign(preview, { currentSourceId: 'sftp-session:s', currentPath: '/a', editMode: true, dirty: true, editRevision: 'r1' });
    preview.refresh = () => { preview.refreshed = true; };
    return { preview, fields, events, context };
}

test('save acknowledgement preserves text entered while saving and updates revision', () => {
    const {preview, fields, events} = setup();
    preview.saveEdit();
    const sent = events[0].data;
    fields.editorContent.value = 'two';
    preview.markDirty();
    preview.handleFileSaved({...sent, revision: 'r2'});
    assert.equal(preview.editMode, true);
    assert.equal(preview.dirty, true);
    assert.equal(preview.editRevision, 'r2');
    assert.equal(preview.refreshed, undefined);
    preview.saveEdit();
    assert.equal(events[1].data.content, 'two');
    assert.equal(events[1].data.expected_revision, 'r2');
});

test('opening another file clears old copy content until fresh response', async () => {
    const {preview, context} = setup();
    preview.showLoading = () => {};
    preview._previewFullContent = 'old file';
    let copied = false;
    context.TerminalManager = { writeTextToClipboard: async () => { copied = true; } };
    preview.open('sftp-session:s', '/b', 'b.txt');
    await preview.copyToClipboard();
    assert.equal(copied, false);
    assert.equal(preview._previewFullContent, null);
});

test('copy uses existing clipboard helper when browser Clipboard API is absent', async () => {
    const {preview, context} = setup();
    preview._previewFullContent = 'current file\n';
    context.navigator = {};
    let copied;
    context.TerminalManager = { writeTextToClipboard: async text => { copied = text; } };
    await preview.copyToClipboard();
    assert.equal(copied, 'current file\n');
});

test('unchanged successful save closes editor and duplicate submission is ignored', () => {
    const {preview, events} = setup();
    preview.saveEdit();
    preview.saveEdit();
    assert.equal(events.length, 1);
    preview.handleFileSaved({...events[0].data, revision: 'r2'});
    assert.equal(preview.editMode, false);
    assert.equal(preview.dirty, false);
    assert.equal(preview.refreshed, true);
});

test('failed save retains dirty text and permits a deliberate retry', () => {
    const {preview, events} = setup();
    preview.saveEdit();
    preview.handleSocketError({...events[0].data, operation: 'save_file', error: 'failed'});
    assert.equal(preview.dirty, true);
    preview.saveEdit();
    assert.equal(events.length, 2);
});

test('late acknowledgement updates revision without unlocking a newer pending save', () => {
    const {preview, events, context} = setup();
    preview.saveEdit();
    const first = events[0].data;
    context.timeout();
    assert.equal(preview.dirty, true);
    preview.saveEdit();
    assert.equal(events.length, 2);
    preview.handleFileSaved({...first, revision: 'late'});
    assert.equal(preview.editRevision, 'late');
    assert.equal(preview.editMode, true);
    preview.saveEdit();
    assert.equal(events.length, 2);
    preview.handleSocketError({...events[1].data, operation: 'save_file', error: 'conflict'});
    preview.saveEdit();
    assert.equal(events[2].data.expected_revision, 'late');
});

test('late acknowledgement reconciles revision and retains newer text', () => {
    const {preview, fields, events, context} = setup();
    preview.saveEdit();
    context.timeout();
    fields.editorContent.value = 'new draft';
    preview.handleFileSaved({...events[0].data, revision: 'r2'});
    assert.equal(preview.editMode, true);
    assert.equal(preview.dirty, true);
    preview.saveEdit();
    assert.equal(events[1].data.expected_revision, 'r2');
    assert.equal(events[1].data.content, 'new draft');
});

test('older acknowledgement cannot roll revision back after newer success', () => {
    const {preview, fields, events, context} = setup();
    preview.saveEdit();
    context.timeout();
    fields.editorContent.value = 'two';
    preview.saveEdit();
    fields.editorContent.value = 'three';
    preview.handleFileSaved({...events[1].data, revision: 'r3'});
    preview.handleFileSaved({...events[0].data, revision: 'r2'});
    assert.equal(preview.editRevision, 'r3');
    assert.equal(fields.editorContent.value, 'three');
});

test('reopening the same file ignores acknowledgement from abandoned editor', () => {
    const {preview, events, context} = setup();
    preview.saveEdit();
    context.timeout();
    preview.showLoading = () => {};
    preview.open('sftp-session:s', '/a', 'a.txt');
    preview.editMode = true;
    preview.editRevision = 'reopened';
    preview.handleFileSaved({...events[0].data, revision: 'old'});
    assert.equal(preview.editRevision, 'reopened');
});

test('disconnect cancels pending save and preserves text for revision-checked retry', () => {
    const {preview, events, context} = setup();
    preview.saveEdit();
    context.socket.connected = false;
    preview.interruptSave();
    preview.saveEdit();
    assert.equal(events.length, 1);
    context.socket.connected = true;
    preview.saveEdit();
    assert.equal(events[1].data.expected_revision, 'r1');
});
