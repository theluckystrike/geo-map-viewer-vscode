'use strict';
// Bundles the extension host, the map worker and the webview with esbuild. The worker bundle is embedded in
// the webview bundle as a string (the webview starts it from a blob URL), so no extra file is fetched.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
(async () => {
  const w = await esbuild.build({ ...common, entryPoints: ['src/webview/worker.js'], write: false, platform: 'browser', format: 'iife', target: 'chrome110' });
  const workerSource = w.outputFiles[0].text;
  const embed = { name: 'worker-source', setup(b) { b.onResolve({ filter: /^worker-source$/ }, () => ({ path: 'worker-source', namespace: 'ws' })); b.onLoad({ filter: /.*/, namespace: 'ws' }, () => ({ contents: workerSource, loader: 'text' })); } };
  await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
    esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110', plugins: [embed] }),
  ]);
  const kb = f => (fs.statSync(path.join(root, f)).size / 1024).toFixed(0);
  console.log(`built: webview ${kb('dist/webview.js')} KB (worker ${(workerSource.length / 1024).toFixed(0)} KB inside), extension ${kb('dist/extension.js')} KB`);
})().catch(e => { console.error(e); process.exit(1); });
