export function isValidModelPath(path) {
  return typeof path === 'string' && /\.(ysm|zip)$/i.test(path) &&
    !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function rawModelUrl(repository, revision, path) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('Invalid revision');
  if (!isValidModelPath(path)) throw new Error('Invalid model path');
  return `https://raw.githubusercontent.com/${repository}/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function sourceFileUrl(repository, revision, path) {
  const raw = new URL(rawModelUrl(repository, revision, path));
  return `https://github.com/${repository}/blob/${revision}${raw.pathname.split(`/${repository}/${revision}`)[1]}`;
}

export function viewerUrl(viewerBase, modelUrl) {
  const url = new URL(viewerBase);
  url.searchParams.set('file', modelUrl);
  return url.toString();
}

export function filterModels(models, { query = '', category = '', format = '' } = {}) {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase();
  return models.filter(model =>
    (!category || model.category === category) &&
    (!format || model.format === format) &&
    (!needle || `${model.path} ${model.name}`.normalize('NFKC').toLocaleLowerCase().includes(needle))
  );
}

export function readableCategory(category) {
  return category.replace(/^_+/, '').replaceAll('_', ' ') || category;
}

export function formatBytes(size) {
  if (!Number.isFinite(size) || size < 0) return '';
  return size < 1024 * 1024 ? `${(size / 1024).toFixed(0)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
