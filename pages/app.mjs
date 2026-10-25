import {
  filterModels, formatBytes, isValidModelPath, rawModelUrl,
  readableCategory, sourceFileUrl, viewerUrl,
} from './model-utils.mjs';

const PAGE_SIZE = 48;
const DEFAULT_MODEL = '_5Toubun/5Toubun_Itsuki-Nakano_v1.0.ysm';
const $ = id => document.getElementById(id);
const ui = {
  search: $('search'), category: $('category'), format: $('format'),
  list: $('model-list'), count: $('results-count'), total: $('total-count'),
  version: $('catalog-version'), prev: $('prev-page'), next: $('next-page'),
  page: $('page-label'), name: $('selected-name'), path: $('selected-path'),
  selectedFormat: $('selected-format'), iframe: $('viewer'),
  placeholder: $('viewer-placeholder'), status: $('viewer-status'),
  openViewer: $('open-viewer'), openSource: $('open-source'),
  download: $('download-model'), copy: $('copy-link'),
};
let catalog = null;
let filtered = [];
let currentPage = 0;
let selected = null;
const numberFormat = new Intl.NumberFormat('ko-KR');

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

function setAnchor(anchor, href) {
  if (href) {
    anchor.href = href;
    anchor.setAttribute('aria-disabled', 'false');
  } else {
    anchor.removeAttribute('href');
    anchor.setAttribute('aria-disabled', 'true');
  }
}

function modelName(model) { return model.name.replaceAll('_', ' '); }

function renderList() {
  const fragment = document.createDocumentFragment();
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  for (const model of visible) {
    const button = document.createElement('button');
    button.className = 'model-row';
    button.type = 'button';
    button.title = model.path;
    button.setAttribute('aria-pressed', String(selected?.path === model.path));
    button.addEventListener('click', () => chooseModel(model, true));

    const avatar = document.createElement('span');
    avatar.className = 'model-avatar';
    avatar.textContent = modelName(model).trim().slice(0, 2).toLocaleUpperCase() || '3D';
    avatar.setAttribute('aria-hidden', 'true');
    const info = document.createElement('span');
    info.className = 'model-info';
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = modelName(model);
    const subtitle = document.createElement('span');
    subtitle.className = 'model-path';
    subtitle.textContent = readableCategory(model.category) +
      (Number.isFinite(model.size) ? ' · ' + formatBytes(model.size) : '');
    info.append(name, subtitle);
    const tag = document.createElement('span');
    tag.className = 'file-tag';
    tag.dataset.format = model.format;
    tag.textContent = '.' + model.format;
    button.append(avatar, info, tag);
    fragment.append(button);
  }
  if (!visible.length) {
    const msg = document.createElement('p');
    msg.className = 'empty-results';
    msg.textContent = '조건에 맞는 모델이 없음. 검색어와 필터를 바꿔 봐.';
    fragment.append(msg);
  }
  ui.list.replaceChildren(fragment);
  ui.count.textContent = numberFormat.format(filtered.length) + '개 결과';
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  ui.page.textContent = (currentPage + 1) + ' / ' + pages;
  ui.prev.disabled = currentPage <= 0;
  ui.next.disabled = currentPage >= pages - 1;
}

function applyFilters() {
  if (!catalog) return;
  filtered = filterModels(catalog.models, {
    query: ui.search.value, category: ui.category.value, format: ui.format.value,
  });
  currentPage = 0;
  renderList();
}

function chooseModel(model, updateHistory) {
  if (!catalog || !isValidModelPath(model.path)) return;
  const changed = selected?.path !== model.path;
  selected = model;
  ui.name.textContent = modelName(model);
  ui.path.textContent = model.path;
  ui.selectedFormat.textContent = '.' + model.format;
  ui.selectedFormat.hidden = false;
  const raw = rawModelUrl(catalog.repository, catalog.revision, model.path);
  const viewer = viewerUrl(new URL('./viewer/', location.href), raw);
  setAnchor(ui.openViewer, viewer);
  setAnchor(ui.openSource, sourceFileUrl(catalog.repository, catalog.revision, model.path));
  setAnchor(ui.download, raw);
  ui.download.download = model.path.split('/').at(-1);
  ui.copy.disabled = false;
  if (updateHistory) {
    const url = new URL(location.href);
    url.searchParams.set('model', model.path);
    history.pushState({ model: model.path }, '', url);
  }
  if (changed) {
    ui.placeholder.hidden = true;
    ui.iframe.classList.add('active');
    setStatus('모델 및 YSMViewer WebAssembly 로딩 중... 최초 실행에는 시간이 걸릴 수 있음.');
    ui.iframe.src = viewer;
  }
  renderList();
}

function populateCategories(models) {
  const categories = [...new Set(models.map(m => m.category))].sort(
    (a, b) => a.localeCompare(b, 'en', { numeric: true })
  );
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = readableCategory(category);
    ui.category.append(option);
  }
}

function validateCatalog(data) {
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.models) ||
      !/^[\w.-]+\/[\w.-]+$/.test(data.repository || '') ||
      !/^[0-9a-f]{40}$/i.test(data.revision || '') ||
      data.models.length !== data.count) {
    throw new Error('모델 인덱스 구조가 올바르지 않음.');
  }
  const paths = new Set();
  for (const model of data.models) {
    if (!isValidModelPath(model.path) || paths.has(model.path) ||
        !['ysm', 'zip'].includes(model.format) ||
        model.format !== model.path.split('.').at(-1).toLowerCase() ||
        typeof model.name !== 'string' || typeof model.category !== 'string') {
      throw new Error('모델 인덱스에 잘못된 항목이 있음.');
    }
    paths.add(model.path);
  }
  return data;
}

async function loadCatalog() {
  const response = await fetch('./models.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('models.json 다운로드 실패: HTTP ' + response.status);
  catalog = validateCatalog(await response.json());
  ui.total.textContent = numberFormat.format(catalog.count);
  ui.version.textContent = catalog.revision.slice(0, 7);
  populateCategories(catalog.models);
  filtered = catalog.models;
  const requested = new URL(location.href).searchParams.get('model');
  const first = catalog.models.find(m => m.path === requested) ||
    catalog.models.find(m => m.path === DEFAULT_MODEL) || catalog.models[0];
  renderList();
  chooseModel(first, false);
  if (requested && !catalog.models.some(m => m.path === requested)) {
    setStatus('URL에 지정한 모델이 없어 기본 캐릭터를 표시함.', true);
  }
}

ui.search.addEventListener('input', applyFilters);
ui.category.addEventListener('change', applyFilters);
ui.format.addEventListener('change', applyFilters);
ui.prev.addEventListener('click', () => {
  if (currentPage > 0) { currentPage--; renderList(); ui.list.scrollTop = 0; }
});
ui.next.addEventListener('click', () => {
  if ((currentPage + 1) * PAGE_SIZE < filtered.length) {
    currentPage++; renderList(); ui.list.scrollTop = 0;
  }
});
ui.iframe.addEventListener('load', () => {
  if (selected) setStatus('뷰어 초기화 중. 화면이 멈추면 전체 화면 버튼으로 확인해 줘.');
});
ui.iframe.addEventListener('error', () =>
  setStatus('뷰어 페이지를 불러오지 못했음. 전체 화면에서 오류를 확인해 줘.', true)
);
ui.copy.addEventListener('click', async () => {
  if (!selected) return;
  const url = new URL(location.href);
  url.searchParams.set('model', selected.path);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(url.toString());
    setStatus('선택한 모델의 공유 링크를 복사했음.');
  } catch { window.prompt('모델 공유 링크를 복사해 줘.', url.toString()); }
});
window.addEventListener('popstate', () => {
  if (!catalog) return;
  const model = catalog.models.find(m => m.path === new URL(location.href).searchParams.get('model'));
  if (model) chooseModel(model, false);
});

loadCatalog().catch(error => {
  ui.count.textContent = '목록 로딩 실패';
  ui.total.textContent = '!';
  const msg = document.createElement('p');
  msg.className = 'empty-results';
  msg.textContent = '모델 로딩 오류: ' + (error?.message || String(error));
  ui.list.replaceChildren(msg);
  setStatus('모델 인덱스 또는 네트워크 상태를 확인해 줘.', true);
  console.error('[YSM Gallery]', error);
});
