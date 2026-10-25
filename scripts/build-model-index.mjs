#!/usr/bin/env node
// Generate a GitHub Pages catalog without checking out the ~800 MiB of model blobs.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOSITORY = 'Legerdo/Yes-Steve-Model-Repo';

export function buildCatalog(entries, { repository, revision }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('Expected a pinned 40-character Git SHA');

  const names = new Set();
  const models = [];
  for (const entry of entries) {
    if (entry.type && entry.type !== 'blob') continue;
    const path = entry.path;
    if (typeof path !== 'string' || !/\.(ysm|zip)$/i.test(path)) continue;
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(s => !s || s === '.' || s === '..')) {
      throw new Error(`Unsafe repository path: ${path}`);
    }
    if (names.has(path)) throw new Error(`Duplicate model path: ${path}`);
    names.add(path);
    models.push({
      path,
      category: path.includes('/') ? path.split('/')[0] : 'Uncategorized',
      name: path.split('/').at(-1).replace(/\.(ysm|zip)$/i, ''),
      format: path.toLowerCase().endsWith('.ysm') ? 'ysm' : 'zip',
      size: Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null,
    });
  }

  models.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  if (!models.length) throw new Error('The source tree contains no YSM/ZIP model files');

  return { schemaVersion: 1, repository, revision, count: models.length, models };
}

export function parseGitPaths(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map(path => ({ type: 'blob', path }));
}

async function loadEntries(repository, revision, repoRoot) {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const url = `https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ysm-model-catalog-builder',
      },
    });
    if (!response.ok) throw new Error(`GitHub tree API returned ${response.status}`);
    const tree = await response.json();
    if (!Array.isArray(tree.tree) || tree.truncated) {
      throw new Error('GitHub tree API returned a missing or truncated tree');
    }
    return tree.tree;
  }

  // Useful for reproducible offline development with a blobless/sparse clone.
  const stdout = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', revision], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseGitPaths(stdout);
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const revision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8',
  }).trim();
  const outArg = process.argv.indexOf('--out');
  const output = resolve(process.cwd(), outArg >= 0 ? process.argv[outArg + 1] : 'dist/models.json');
  const catalog = buildCatalog(await loadEntries(repository, revision, repoRoot), { repository, revision });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(catalog)}\n`, 'utf8');
  console.log(`Indexed ${catalog.count} models at ${revision.slice(0, 12)} -> ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
