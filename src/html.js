'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {{cspSource:string, scriptUri:string, styleUri:string, title:string, nonce?:string, showSupportLinks?:boolean}} p
 * showSupportLinks false hides the small Sponsor and More free viewers line (setting geoMapViewer.showSupportLinks).
 */
function buildHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  // The webview script moves this line into the status bar once the viewer is built.
  const footer = footerHtml('geoMapViewer', p.showSupportLinks !== false, 'zovo-support-fixed');
  // connect-src: only the bundled basemap (webview resource origin). worker-src blob: the map worker is created
  // from the bundled script as a blob URL. No remote origin is allowed anywhere, so nothing in a file
  // (KML NetworkLinks, remote icons) can be fetched.
  const csp = [
    "default-src 'none'", `style-src ${p.cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`,
    `img-src ${p.cspSource} data: blob:`, `connect-src ${p.cspSource}`, `font-src ${p.cspSource}`, 'worker-src blob:',
].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app"><p class="loading">Opening the map...</p></div>
${footer}
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr };
