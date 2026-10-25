#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] || 'dist');
const required = [
  'index.html', 'app.mjs', 'styles.css', 'model-utils.mjs', 'models.json',
  'viewer/index.html', 'viewer/main.js', 'viewer/COPYING', 'viewer/SOURCE.txt',
  'viewer/_framework/dotnet.js',
];
for (const filename of required) {
  if (!(await stat(join(root, filename)).catch(() => null))?.isFile()) {
    throw new Error('Missing deployment file: ' + filename);
  }
}
const assets = await readdir(join(root, 'viewer/_framework'));
if (!assets.some(file => file.endsWith('.wasm'))) {
  throw new Error('YSMViewer browser WASM runtime missing');
}
const catalog = JSON.parse(await readFile(join(root, 'models.json'), 'utf8'));
if (!Array.isArray(catalog.models) || catalog.models.length !== catalog.count || catalog.count < 1) {
  throw new Error('Invalid model index');
}
console.log('Verified Pages artifact: ' + catalog.count + ' models, ' + assets.length + ' framework assets');
