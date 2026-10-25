import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildCatalog, DEFAULT_REPOSITORY, parseGitPaths,
} from '../scripts/build-model-index.mjs';
import {
  filterModels, formatBytes, isValidModelPath, rawModelUrl,
  readableCategory, sourceFileUrl, viewerUrl,
} from '../pages/model-utils.mjs';

const project = resolve(import.meta.dirname, '..');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();

test('actual git tree is indexed without fetching model blobs', () => {
  // Never use git ls-tree -l on a blobless clone: it may download all model blobs.
  const data = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
    cwd: project, maxBuffer: 16 * 1024 * 1024,
  });
  const catalog = buildCatalog(parseGitPaths(data), { repository: DEFAULT_REPOSITORY, revision });
  assert.ok(catalog.count > 1000);
  assert.equal(catalog.models.length, catalog.count);
  assert.ok(catalog.models.some(model => model.format === 'ysm'));
  assert.ok(catalog.models.some(model => model.format === 'zip'));
  assert.ok(catalog.models.some(model => model.path === '_5Toubun/5Toubun_Itsuki-Nakano_v1.0.ysm'));
  assert.equal(new Set(catalog.models.map(model => model.path)).size, catalog.count);
});

test('encodes unicode, spaces and URL delimiters without changing path identity', () => {
  const path = 'Unknown/한글 100% # ? & 模型.ysm';
  const url = rawModelUrl(DEFAULT_REPOSITORY, revision, path);
  assert.equal(decodeURIComponent(new URL(url).pathname), '/' + DEFAULT_REPOSITORY + '/' + revision + '/' + path);
  assert.equal(new URL(url).origin, 'https://raw.githubusercontent.com');
  assert.equal(new URL(sourceFileUrl(DEFAULT_REPOSITORY, revision, path)).origin, 'https://github.com');
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).hash, '');
});

test('viewer URL uses the site subdirectory and one encoded file parameter', () => {
  const raw = rawModelUrl(DEFAULT_REPOSITORY, revision, '_5Toubun/5Toubun_Itsuki-Nakano_v1.0.ysm');
  const url = new URL(viewerUrl('https://legerdo.github.io/Yes-Steve-Model-Repo/viewer/', raw));
  assert.equal(url.pathname, '/Yes-Steve-Model-Repo/viewer/');
  assert.equal(url.searchParams.get('file'), raw);
  assert.equal([...url.searchParams].length, 1);
});

test('rejects unsafe paths, unsupported formats, duplicates and floating revisions', () => {
  assert.equal(isValidModelPath('../danger.ysm'), false);
  assert.equal(isValidModelPath('textures/file.png'), false);
  assert.equal(isValidModelPath('dir/./foo.ysm'), false);
  assert.equal(isValidModelPath('dir/foo.zip'), true);
  assert.throws(() => rawModelUrl(DEFAULT_REPOSITORY, revision, '../danger.ysm'));
  assert.throws(() => rawModelUrl(DEFAULT_REPOSITORY, 'main', 'valid.ysm'));
  assert.throws(() => buildCatalog([
    { path: 'foo.ysm', type: 'blob' }, { path: 'foo.ysm', type: 'blob' },
  ], { repository: DEFAULT_REPOSITORY, revision }), /Duplicate/);
});

test('filters by name/category/format, preserving Unicode', () => {
  const models = [
    { path: '_Arknights/Ak_Chen.ysm', name: 'Ak_Chen', category: '_Arknights', format: 'ysm' },
    { path: '_Arknights/Ak_Sora.zip', name: 'Ak_Sora', category: '_Arknights', format: 'zip' },
    { path: 'Unknown/가나다.ysm', name: '가나다', category: 'Unknown', format: 'ysm' },
  ];
  assert.equal(filterModels(models, { category: '_Arknights' }).length, 2);
  assert.deepEqual(filterModels(models, { category: '_Arknights', format: 'zip' }).map(x => x.name), ['Ak_Sora']);
  assert.equal(filterModels(models, { query: ' CHEN ' }).length, 1);
  assert.equal(filterModels(models, { query: '가나다' }).length, 1);
  assert.equal(readableCategory('_Arknights'), 'Arknights');
  assert.equal(formatBytes(null), '');
  assert.equal(formatBytes(1_048_576), '1.0 MiB');
});

test('page references bundled renderer and copyright notice, not arbitrary HTML', () => {
  const html = readFileSync(resolve(project, 'pages/index.html'), 'utf8');
  const app = readFileSync(resolve(project, 'pages/app.mjs'), 'utf8');
  assert.match(html, /\.\/app\.mjs/);
  assert.match(html, /viewer\/COPYING/);
  assert.match(app, /new URL\('\.\/viewer\/', location\.href\)/);
  assert.doesNotMatch(app, /innerHTML\s*=/);
});
