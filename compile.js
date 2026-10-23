/**
 * Compiles JS source files to V8 bytecode (.jsc) using bytenode.
 * Run before packaging: node compile.js
 * The resulting .jsc files are what gets shipped — source is excluded.
 */
const bytenode = require('bytenode');
const path = require('path');
const fs = require('fs');

const files = ['main.js', 'server.js', 'services.js', 'store.js'];

(async () => {
  for (const file of files) {
    const src = path.join(__dirname, file);
    const out = src.replace('.js', '.jsc');
    await bytenode.compileFile({ filename: src, output: out });
    console.log(`Compiled: ${file} → ${path.basename(out)}`);
  }

  // Write loader stubs — Electron loads these; they just require the .jsc
  const loaderDir = path.join(__dirname, 'compiled');
  fs.mkdirSync(loaderDir, { recursive: true });

  for (const file of files) {
    const loaderPath = path.join(loaderDir, file);
    const jscPath = path.join('..', file.replace('.js', '.jsc'));
    fs.writeFileSync(loaderPath,
      `require('bytenode');\nrequire('${jscPath}');\n`
    );
  }

  console.log('\nDone. Use compiled/ as the entry in your package.json for production builds.');
})();
