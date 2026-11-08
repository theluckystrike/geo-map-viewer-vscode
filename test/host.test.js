'use strict';
// Extension host with a fake vscode module: files are read only through workspace.fs (so Remote SSH, WSL,
// Codespaces and virtual workspaces work), bytes go to the webview as plain Uint8Array, shapefile side files
// are found next to the .shp, and the rating ask counts successes and failures.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

function fakeVscode(files) {
  const reads = [];
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.posix.join(u.path, ...parts)); }
    static parse(s) { const m = /^([a-z-]+):\/\/[^/]*(\/.*)$/.exec(s); return new Uri(m[1], m[2]); }
    with(o) { return new Uri(o.scheme || this.scheme, o.path || this.path); }
    toString() { return `${this.scheme}://host${this.path}`; }
    get fsPath() { return this.path; }
  }
  const disposable = { dispose() {} };
  const vscode = {
    Uri, ViewColumn: { Beside: -2 }, RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    workspace: {
      fs: {
        stat: async u => { if (!(u.path in files)) throw new Error('ENOENT'); return { size: files[u.path].length }; },
        readFile: async u => { reads.push(u.toString()); if (!(u.path in files)) throw new Error('ENOENT'); return Buffer.from(files[u.path]); },
        writeFile: async () => {},
      },
      getConfiguration: () => ({ get: (k, d) => d }),
      onDidChangeTextDocument: () => disposable,
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} }),
      isTrusted: true,
    },
    window: { showSaveDialog: async () => undefined, showInformationMessage: async () => undefined, state: { focused: true }, registerCustomEditorProvider: () => disposable, activeTextEditor: null },
    commands: { registerCommand: () => disposable, executeCommand: async () => {} },
    env: { clipboard: { writeText: async () => {} }, sessionId: 's', remoteName: 'ssh-remote', openExternal: async () => {} },
  };
  return { vscode, reads };
}

function loadExtension(vscode) {
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try {
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}src${path.sep}`)) delete require.cache[k];
    return require('../src/extension.js');
  } finally { Module._load = orig; }
}

function fakePanel() {
  const sent = [];
  let onMsg;
  return {
    sent,
    send: m => onMsg(m),
    panel: {
      webview: { options: null, html: '', cspSource: 'vscode-webview://x', asWebviewUri: u => ({ toString: () => `https://file+.vscode-resource.vscode-cdn.net${u.path}` }), postMessage: async m => { sent.push(m); return true; }, onDidReceiveMessage: f => { onMsg = f; } },
      onDidDispose: () => {},
    },
  };
}

test('remote file (vscode-remote scheme): read through workspace.fs, side files found, bytes are a plain Uint8Array', async () => {
  const files = { '/data/roads.shp': new Uint8Array(120), '/data/roads.DBF': new Uint8Array(40), '/data/roads.prj': Buffer.from('GEOGCS["GCS_WGS_1984"]'), '/ext/media/basemap.json': Buffer.from('{}') };
  const { vscode, reads } = fakeVscode(files);
  const ext = loadExtension(vscode);
  const ctx = { extensionUri: new vscode.Uri('file', '/ext'), subscriptions: [], globalState: { get: () => undefined, update: async () => {} } };
  ext.activate(ctx);
  const prov = new ext.MapEditorProvider(ctx);
  const f = fakePanel();
  const uri = new vscode.Uri('vscode-remote', '/data/roads.shp');
  await prov.resolveCustomEditor(prov.openCustomDocument(uri), f.panel);
  assert.match(f.panel.webview.html, /default-src 'none'/);
  assert.deepStrictEqual(f.panel.webview.options.localResourceRoots.map(u => u.path), ['/ext/dist', '/ext/media'], 'the data folder is not exposed to the webview');
  await f.send({ type: 'ready' });
  const init = f.sent.find(m => m.type === 'init');
  assert.strictEqual(init.format, 'shp');
  assert.strictEqual(init.plan.load, true);
  const b = f.sent.find(m => m.type === 'bytes');
  assert.ok(b, 'bytes sent');
  assert.strictEqual(b.data.constructor, Uint8Array, 'not a Node Buffer (that would go as JSON)');
  assert.strictEqual(b.side.dbf.constructor, Uint8Array);
  assert.match(b.side.prj, /GCS_WGS_1984/);
  assert.ok(reads.every(r => r.startsWith('vscode-remote://')), 'every read uses the file\'s own scheme: ' + reads.join(', '));
  assert.ok(reads.some(r => r.endsWith('roads.DBF')), 'side file in upper case found');
});

test('oversized file: message, not read; bad messages dropped; PNG never overwrites the data file', async () => {
  const files = { '/d/big.geojson': { length: 600 * 1024 * 1024 } };
  const { vscode, reads } = fakeVscode(files);
  const ext = loadExtension(vscode);
  const ctx = { extensionUri: new vscode.Uri('file', '/ext'), subscriptions: [], globalState: { get: () => undefined, update: async () => {} } };
  const prov = new ext.MapEditorProvider(ctx);
  const f = fakePanel();
  await prov.resolveCustomEditor(prov.openCustomDocument(new vscode.Uri('file', '/d/big.geojson')), f.panel);
  await f.send({ type: 'ready' });
  assert.strictEqual(f.sent[0].plan.load, false);
  assert.ok(!f.sent.some(m => m.type === 'bytes'));
  assert.strictEqual(reads.length, 0);
  await f.send({ type: 'evalThis', code: 'x' });
  await f.send({ type: 'png', data: new Uint8Array([1, 2, 3]) });
  assert.strictEqual(f.sent.length, 1, 'invalid messages get no answer');
  vscode.window.showSaveDialog = async () => new vscode.Uri('file', '/d/big.geojson');
  await f.send({ type: 'png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) });
  assert.match(f.sent[f.sent.length - 1].message, /ends in \.png/);
});

test('rating: success once per tab after a draw, failure after an error, no ask in a remote window', async () => {
  const files = { '/d/a.gpx': Buffer.from('<gpx/>'), '/ext/media/basemap.json': Buffer.from('{}') };
  const { vscode } = fakeVscode(files);
  let state;
  const ctx = { extensionUri: new vscode.Uri('file', '/ext'), subscriptions: [], globalState: { get: () => state, update: async (k, v) => { state = v; } } };
  const ext = loadExtension(vscode);
  let asked = 0;
  vscode.window.showInformationMessage = async () => { asked++; };
  ext.activate(ctx);
  const prov = new ext.MapEditorProvider(ctx);
  const f = fakePanel();
  await prov.resolveCustomEditor(prov.openCustomDocument(new vscode.Uri('file', '/d/a.gpx')), f.panel);
  await f.send({ type: 'rendered', ok: true, features: 3 });
  await f.send({ type: 'rendered', ok: true, features: 3 });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(state, 'rating state stored');
  assert.strictEqual(state.count, 1, 'one success per tab');
  await f.send({ type: 'rendered', ok: false });
  assert.strictEqual(state.lastErrorAt, 0, 'no failure after a success in the same tab');
  const g = fakePanel();
  await prov.resolveCustomEditor(prov.openCustomDocument(new vscode.Uri('file', '/d/a.gpx')), g.panel);
  await g.send({ type: 'rendered', ok: false });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(state.lastErrorAt > 0, 'a tab that failed records a failure');
  assert.strictEqual(asked, 0);
});

test('plain(): Buffer views become plain Uint8Array without changing bytes', () => {
  const { vscode } = fakeVscode({});
  const ext = loadExtension(vscode);
  const big = Buffer.alloc(20000, 7);
  const p1 = ext.plain(big);
  assert.strictEqual(p1.constructor, Uint8Array);
  assert.strictEqual(p1.length, 20000);
  const small = Buffer.from('abc'); // pooled: byteOffset can be non-zero
  const p2 = ext.plain(small);
  assert.deepStrictEqual([...p2], [97, 98, 99]);
  assert.strictEqual(p2.constructor, Uint8Array);
});
