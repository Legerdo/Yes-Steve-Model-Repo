#!/usr/bin/env node
// Compatibility fix for the pinned YSMViewer browser renderer.
// Three.js PropertyBinding does not traverse nested .children[index] paths.
// Bind tracks directly to the target Object3D UUID instead of a scene path.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { patchBrowserMolangRenderer, prepareBrowserMolangFiles } from './patch-browser-molang.mjs';
import { patchBrowserAtlasSource } from './patch-browser-atlas.mjs';

const ORIGINAL_BINDING = `        const bonePath = getObjectPath(scene, boneObj);
        if (!bonePath) continue;`;
const UUID_BINDING = `        // UUIDs resolve the exact bone, including nested or duplicate-named bones.
        const bonePath = boneObj.uuid;`;

const ORIGINAL_PATH_HELPER = `function getObjectPath(root, target) {
    const visited = new Set();

    function search(node) {
        if (node === target) return '';
        if (visited.has(node)) return null;
        visited.add(node);

        for (let i = 0; i < node.children.length; i++) {
            if (node.children[i] === target) {
                return '.children[' + i + ']';
            }
            const sub = search(node.children[i]);
            if (sub !== null) {
                return '.children[' + i + ']' + sub;
            }
        }
        return null;
    }

    return search(root);
}

`;

function replaceOnce(source, original, replacement, label) {
    const occurrences = source.split(original).length - 1;
    if (occurrences !== 1) {
        throw new Error(`Pinned YSMViewer ${label} changed (${occurrences} matches), review upstream before upgrading`);
    }
    return source.replace(original, replacement);
}

export function patchBrowserAnimationSource(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    let result = source.replaceAll('\r\n', '\n');
    if (createHash('sha256').update(result).digest('hex') !== '3bb1f44d53911b008fcbc0a47b4a3db01632232b7fece263404a01e24665635f') {
        throw new Error('Pinned YSMViewer renderer changed; review upstream before upgrading');
    }
    result = replaceOnce(result, ORIGINAL_BINDING, UUID_BINDING, 'animation binding');
    result = replaceOnce(result, ORIGINAL_PATH_HELPER, '', 'animation path helper');
    result = patchBrowserMolangRenderer(result);
    result = patchBrowserAtlasSource(result);
    return newline === '\r\n' ? result.replaceAll('\n', '\r\n') : result;
}

async function main() {
    if (process.argv.length !== 3) {
        throw new Error('Usage: node scripts/patch-browser-animation.mjs <upstream-dir>');
    }
    const root = resolve(process.argv[2]);
    const file = join(root, 'YSMViewer.Browser', 'wwwroot', 'ysm-three-renderer.js');
    const original = await readFile(file, 'utf8');
    const renderer = patchBrowserAnimationSource(original);
    // Validate all upstream inputs before writing any patched file.
    const outputs = await prepareBrowserMolangFiles(root);
    outputs.push({ path: file, text: renderer });
    for (const output of outputs) await writeFile(output.path, output.text, 'utf8');
    console.log('Patched browser animations, managed MoLang, finite camera bounds and atlas sampling');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
