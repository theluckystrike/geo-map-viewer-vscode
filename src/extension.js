'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { validateWebviewMessage, sizePlan, fmtSize, formatOf, LABELS, shapefileSidecars, MB } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'geoMapViewer.map';
// Same viewer, offered as "Open With" for text formats people also edit (GeoJSON, KML, WKT, JSON, CSV, ZIP).
const VIEW_TYPE_OPTION = 'geoMapViewer.mapOption';
const EXT_ID = 'zovo.geo-map-viewer';
const LIVE_MAX = 20 * MB; // live preview from unsaved editor text up to this size
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('geoMapViewer');
  return { maxFileMB: c.get('maxFileMB', 512), basemap: c.get('basemap', true), livePreview: c.get('livePreview', true) };
}

/**
 * A plain Uint8Array (not a Node Buffer): VS Code sends plain typed arrays to the webview as binary, while a
 * Buffer goes through its toJSON() as a list of numbers, which is slow and huge for a 100 MB file.
 */
function plain(u) {
  if (!u) return u;
  if (u.constructor === Uint8Array) return u;
  return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? new Uint8Array(u.buffer) : new Uint8Array(u);
}

/** Read a file through workspace.fs (works in Remote SSH, WSL, Codespaces and virtual workspaces). null if missing. */
async function readIfExists(uri) {
  try { return plain(await vscode.workspace.fs.readFile(uri)); } catch { return null; }
}

async function readSidecars(uri) {
  const dir = uri.with({ path: path.posix.dirname(uri.path) });
  const base = path.posix.basename(uri.path);
  const side = {};
  for (const s of shapefileSidecars(base)) {
    for (const n of s.names) {
      const data = await readIfExists(vscode.Uri.joinPath(dir, n));
      if (data) { side[s.ext] = data; break; }
    }
  }
  if (side.prj) side.prj = new TextDecoder('utf-8').decode(side.prj);
  if (side.cpg) side.cpg = new TextDecoder('utf-8').decode(side.cpg);
  return side;
}

class MapEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Only the extension's own files are readable from the webview. The data file is sent as bytes.
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('geoMapViewer') };
    const name = path.posix.basename(uri.path);
    const fmt = formatOf(name) || 'geojson';
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'geoMapViewer'),
    });
    let disposed = false;
    let counted = false, failed = false;
    const subs = [];
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    const sendFile = async () => {
      const stat = await vscode.workspace.fs.stat(uri);
      if (!sizePlan(stat.size, settings().maxFileMB).load) return;
      const data = plain(await vscode.workspace.fs.readFile(uri));
      const side = fmt === 'shp' ? await readSidecars(uri) : {};
      await post({ type: 'bytes', data, side });
    };

    // Live preview: unsaved edits in a text editor for the same file redraw the map (small text files only).
    let liveTimer;
    if (settings().livePreview && ['geojson', 'json', 'topojson', 'kml', 'gpx', 'wkt', 'csv'].includes(fmt)) {
      subs.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== uri.toString() || !e.contentChanges.length) return;
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => {
          const text = e.document.getText();
          if (text.length > LIVE_MAX) return;
          post({ type: 'bytes', data: new TextEncoder().encode(text), side: {} });
        }, 500);
      }));
    }
    // Saved changes on disk (also from other tools) reload the map.
    try {
      const dir = uri.with({ path: path.posix.dirname(uri.path) });
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name));
      let t;
      const again = () => { clearTimeout(t); t = setTimeout(() => sendFile().catch(() => {}), 300); };
      w.onDidChange(again); w.onDidCreate(again);
      subs.push(w);
    } catch { /* watching is optional */ }

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') {
          const stat = await vscode.workspace.fs.stat(uri);
          const s = settings();
          const plan = sizePlan(stat.size, s.maxFileMB);
          await post({
            type: 'init', name, format: fmt, label: LABELS[fmt] || fmt, size: stat.size, sizeText: fmtSize(stat.size), plan,
            basemapUrl: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'basemap.json')).toString(), basemapDefault: s.basemap,
          });
          if (plan.load) await sendFile();
          return;
        }
        if (msg.type === 'reload') { await sendFile(); return; }
        if (msg.type === 'rendered') {
          if (msg.ok) { if (!counted) { counted = true; rating.success(); } }
          else if (!counted && !failed) { failed = true; rating.failure(); }
          return;
        }
        if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await post({ type: 'copied' }); return; }
        if (msg.type === 'png') {
          const folder = uri.with({ path: path.posix.dirname(uri.path) });
          const base = name.replace(/\.[^.]+$/, '');
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folder, `${base}-map.png`), filters: { 'PNG image': ['png'] }, saveLabel: 'Save Map Image',
          });
          if (!target) { await post({ type: 'saved', cancelled: true }); return; }
          if (target.toString() === uri.toString() || !/\.png$/i.test(target.path)) {
            await post({ type: 'error', message: 'Choose a file name that ends in .png. The data file is never overwritten.', soft: true });
            return;
          }
          await vscode.workspace.fs.writeFile(target, msg.data);
          await post({ type: 'saved', path: target.scheme === 'file' ? target.fsPath : target.toString(), bytes: msg.data.length });
        }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e) });
      }
    });
    panel.onDidDispose(() => { disposed = true; clearTimeout(liveTimer); for (const s of subs) { try { s.dispose(); } catch {} } });
  }
}

function targetUri(uri) {
  if (uri instanceof vscode.Uri) return uri;
  const ed = vscode.window.activeTextEditor;
  if (ed) return ed.document.uri;
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab && tab.input && tab.input.uri ? tab.input.uri : null;
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'geoMapViewer', name: 'GeoJSON Map Viewer' });
  registerSupport({ vscode, context, prefix: 'geoMapViewer', selfId: EXT_ID });
  const open = async (uri, column) => {
    const target = targetUri(uri);
    if (!target) { vscode.window.showInformationMessage('Open a GeoJSON, KML, GPX, shapefile, TopoJSON, WKT or CSV file first.'); return; }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE_OPTION, column ? { viewColumn: column, preserveFocus: true } : undefined);
  };
  context.subscriptions.push(
    ...[VIEW_TYPE, VIEW_TYPE_OPTION].map(t => vscode.window.registerCustomEditorProvider(t, new MapEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    })),
    vscode.commands.registerCommand('geoMapViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#geoMapViewer.start`, false)),
    vscode.commands.registerCommand('geoMapViewer.openWith', uri => open(uri)),
    vscode.commands.registerCommand('geoMapViewer.openToSide', uri => open(uri, vscode.ViewColumn.Beside)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, MapEditorProvider, VIEW_TYPE, VIEW_TYPE_OPTION, readSidecars, plain };
