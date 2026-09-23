import { decode, detectEncoding, normalizePath, fragmentOf, isExternal } from '../engine/codec.js';
import { listBooks, getBookRecord, putBookRecord, patchBookRecord, deleteBookData, putBookFile, getBookFile, getAllTerms, seedBookTerms, searchLibraryPages, normalizeSearch } from './library.js';

const $ = (id) => document.getElementById(id);
const landing = $('landing');
const workspace = $('workspace');
const homeBtn = $('homeBtn');
const pickBtn = $('pickBtn');
const setDefaultBtn = $('setDefaultBtn');
const anotherBtn = $('anotherBtn');
const shelfBtn = $('shelfBtn');
const fileInput = $('fileInput');
const dropZone = $('dropZone');
const sidebarBtn = $('sidebarBtn');
const searchBtn = $('searchBtn');
const mobileToolsBtn = $('mobileToolsBtn');
const sidebar = $('sidebar');
const historyBackBtn = $('historyBackBtn');
const historyForwardBtn = $('historyForwardBtn');
const bookTitle = $('bookTitle');
const bookMeta = $('bookMeta');
const globalSearchForm = $('globalSearchForm');
const globalSearchInput = $('globalSearchInput');
const globalSearchResults = $('globalSearchResults');
const searchScopeMenu = $('searchScopeMenu');
const searchStatus = $('searchStatus');
const bookmarkBtn = $('bookmarkBtn');
const copyBtn = $('copyBtn');
const splitBtn = $('splitBtn');
const fontDownBtn = $('fontDownBtn');
const fontUpBtn = $('fontUpBtn');
const fontLabel = $('fontLabel');
const themeSelect = $('themeSelect');
const tabbar = $('tabbar');
const newTabBtn = $('newTabBtn');
const tocFilter = $('tocFilter');
const indexFilter = $('indexFilter');
const tocList = $('tocList');
const indexList = $('indexList');
const bookmarkList = $('bookmarkList');
const recentList = $('recentList');
const desk = document.querySelector('.desk');
const secondaryPaneEl = $('secondaryPane');
const closeSplitBtn = $('closeSplitBtn');
const previewCard = $('previewCard');
const previewTitle = $('previewTitle');
const previewText = $('previewText');
const previewClose = $('previewClose');
const previewOpen = $('previewOpen');
const previewTab = $('previewTab');
const previewSplit = $('previewSplit');
const selectionBar = $('selectionBar');
const selectionInfo = $('selectionInfo');
const selectionCopyBtn = $('selectionCopyBtn');
const overlay = $('overlay');
const overlayTitle = $('overlayTitle');
const overlayText = $('overlayText');
const toast = $('toast');
const libraryList = $('libraryList');
const libraryStorage = $('libraryStorage');
const shelfPrompt = $('shelfPrompt');
const shelfSaveBtn = $('shelfSaveBtn');
const shelfSkipBtn = $('shelfSkipBtn');

const DEFAULT_MODE_KEY = 'chm-preview-default-mode-v1';
const SETTINGS_KEY = 'ruledesk-reader-settings-v1';
const MAX_RECENT = 40;
const MAX_BOOKMARKS = 120;

const panes = {
  primary: {
    frame: $('primaryFrame'), loading: $('primaryLoading'), title: $('primaryPaneTitle'),
    urls: new Set(), generation: 0, tabId: null,
  },
  secondary: {
    frame: $('secondaryFrame'), loading: $('secondaryLoading'), title: $('secondaryPaneTitle'),
    urls: new Set(), generation: 0, tabId: null,
  },
};

let client = null;
let currentFile = null;
let currentHandle = null;
let currentBookId = '';
let currentShelfRecord = null;
let pendingShelfFile = null;
let shelfBooks = [];
let libraryTerms = [];
const indexWorkers = new Map();
let book = null;
let bookKey = '';
let tabs = [];
let nextTabId = 1;
let activeTabId = null;
let splitTabId = null;
let bookmarks = [];
let recent = [];
let dragDepth = 0;
let searchGeneration = 0;
let searchScopes = [];
let activeSearchScopeId = 'book';
let previewGeneration = 0;
let previewContext = null;
let previewHoverTimer = null;
let selectionState = null;
let tocContextMenu = null;
const previewCache = new Map();

const readerSettings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      theme: ['light', 'dark', 'parchment'].includes(saved.theme) ? saved.theme : 'parchment',
      fontScale: Number.isFinite(saved.fontScale) ? Math.min(160, Math.max(80, saved.fontScale)) : 100,
    };
  } catch {
    return { theme: 'parchment', fontScale: 100 };
  }
})();

themeSelect.value = readerSettings.theme;
fontLabel.textContent = `${readerSettings.fontScale}%`;

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
};

function showToast(message, kind = 'info', timeout = 3600) {
  toast.textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), timeout);
}

function setOverlay(visible, title = '', text = '') {
  overlay.hidden = !visible;
  if (title) overlayTitle.textContent = title;
  if (text) overlayText.textContent = text;
}

function setPaneLoading(name, visible, text = '正在读取…') {
  const pane = panes[name];
  pane.loading.hidden = !visible;
  const span = pane.loading.querySelector('span');
  if (span) span.textContent = text;
}

function revokeUrls(urls) {
  for (const url of urls || []) { try { URL.revokeObjectURL(url); } catch {} }
  urls?.clear?.();
}

function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}


function bookIdForFile(file) {
  return `b-${stableHash(`${file?.name || ''}|${file?.size || 0}|${file?.lastModified || 0}`)}`;
}

function isTouchPrimaryDevice() {
  return matchMedia('(hover: none) and (pointer: coarse)').matches || (navigator.maxTouchPoints > 1 && !matchMedia('(hover: hover) and (pointer: fine)').matches);
}

function isMobileLike() {
  return isTouchPrimaryDevice() || (navigator.maxTouchPoints > 1 && innerWidth <= 1100);
}

function usesCompactChrome() {
  return innerWidth <= 820 || (innerWidth <= 1400 && isTouchPrimaryDevice());
}

function syncAdaptiveChrome() {
  const tabletCompact = innerWidth > 820 && innerWidth <= 1400 && isTouchPrimaryDevice();
  document.body.classList.toggle('tablet-compact', tabletCompact);
  if (!usesCompactChrome()) {
    sidebar?.classList.remove('mobile-open');
    document.body.classList.remove('mobile-tools-open');
    globalSearchForm?.classList.remove('mobile-search-open');
    mobileToolsBtn?.setAttribute('aria-expanded', 'false');
  } else {
    document.body.classList.remove('sidebar-hidden');
  }
}

function canUseDesktopFilePicker() {
  return typeof window.showOpenFilePicker === 'function' && !isMobileLike() && window.isSecureContext;
}

function indexLabel(record) {
  if (!record) return '';
  const done = Number(record.indexDone || 0);
  const total = Number(record.indexTotal || record.pageCount || 0);
  if (record.indexState === 'ready') return '索引已就绪';
  if (record.indexState === 'error') return '索引构建失败';
  if (record.indexState === 'building') {
    const percent = total ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
    return `正在构建索引 ${percent}%`;
  }
  return '目录索引立即可用 · 正文索引待构建';
}

function updateBookMetaDisplay() {
  if (!book || !currentFile) return;
  const basic = `${formatBytes(currentFile.size)} · ${(book.spine?.length || 0).toLocaleString()} 页 · ${String(book.encoding || '').toUpperCase()} · ${book.compression ? 'LZX' : '未压缩'}`;
  const suffix = currentShelfRecord ? ` · ${indexLabel(currentShelfRecord)}` : '';
  bookMeta.textContent = basic + suffix;
}

async function updateStorageEstimate() {
  try {
    const [estimate, persisted] = await Promise.all([navigator.storage?.estimate?.(), navigator.storage?.persisted?.().catch?.(() => false) ?? false]);
    const mode = persisted ? '持久化' : 'best-effort';
    if (!estimate || !Number.isFinite(estimate.usage) || !Number.isFinite(estimate.quota)) {
      libraryStorage.textContent = `${mode} · 浏览器本地存储`;
      return;
    }
    libraryStorage.textContent = `${mode} · ${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`;
  } catch { libraryStorage.textContent = 'best-effort · 浏览器本地存储'; }
}

function renderLibrary() {
  libraryList.replaceChildren();
  if (!shelfBooks.length) {
    const empty = document.createElement('div');
    empty.className = 'library-empty';
    empty.textContent = '还没有保存的规则书。打开一本 CHM 后即可加入书架。';
    libraryList.append(empty);
    return;
  }
  for (const record of shelfBooks) {
    const card = document.createElement('article');
    card.className = `library-card${record.stale ? ' stale' : ''}`;
    card.dataset.bookId = record.id;
    const icon = document.createElement('div'); icon.className = 'library-book-icon'; icon.textContent = 'R';
    const main = document.createElement('div'); main.className = 'library-card-main';
    const title = document.createElement('button'); title.type = 'button'; title.className = 'library-card-title'; title.textContent = record.title || record.name || '规则书'; title.title = title.textContent;
    title.addEventListener('click', () => void openShelfBook(record.id));
    const meta = document.createElement('div'); meta.className = 'library-card-meta';
    const sourceLabel = record.sourceType === 'handle' ? '原文件 · 0 额外副本' : record.sourceType === 'idb' ? '离线副本 · IndexedDB' : '离线副本 · OPFS';
    meta.textContent = `${formatBytes(record.size || 0)} · ${(record.pageCount || 0).toLocaleString()} 页 · ${String(record.encoding || '').toUpperCase()} · ${record.compression ? 'LZX' : '未压缩'} · ${sourceLabel}`;
    const index = document.createElement('div'); index.className = 'library-card-index';
    const label = document.createElement('span'); label.textContent = indexLabel(record);
    const progress = document.createElement('span'); progress.className = 'library-progress';
    const fill = document.createElement('i');
    const total = Number(record.indexTotal || record.pageCount || 0); const done = Number(record.indexDone || 0);
    fill.style.width = `${record.indexState === 'ready' ? 100 : total ? Math.max(2, Math.round(done / total * 100)) : 2}%`;
    progress.append(fill); index.append(label, progress);
    main.append(title, meta, index);
    const actions = document.createElement('div'); actions.className = 'library-card-actions';
    const open = document.createElement('button'); open.type = 'button'; open.textContent = '打开'; open.addEventListener('click', () => void openShelfBook(record.id));
    const rename = document.createElement('button'); rename.type = 'button'; rename.textContent = '改名'; rename.title = '修改书架中显示的规则书名称'; rename.addEventListener('click', () => void renameShelfBook(record.id));
    const del = document.createElement('button'); del.type = 'button'; del.textContent = '删除'; del.title = '从本地书架删除'; del.addEventListener('click', () => void removeShelfBook(record.id));
    actions.append(open, rename, del); card.append(icon, main, actions); libraryList.append(card);
  }
}

async function refreshLibrary() {
  try {
    shelfBooks = await listBooks();
    libraryTerms = await getAllTerms();
    renderLibrary();
    await updateStorageEstimate();
    if (currentBookId) {
      currentShelfRecord = shelfBooks.find((item) => item.id === currentBookId) || currentShelfRecord;
      updateBookMetaDisplay();
    }
  } catch (error) {
    libraryStorage.textContent = '本地书架不可用';
    console.warn('RuleDesk library:', error);
  }
}

async function refreshLibraryTerms() {
  try { libraryTerms = await getAllTerms(); } catch {}
}

async function getFileFromShelfRecord(record) {
  if (record.sourceType === 'handle' && record.handle) {
    let permission = 'prompt';
    try { permission = await record.handle.queryPermission({ mode: 'read' }); } catch {}
    if (permission !== 'granted') {
      try { permission = await record.handle.requestPermission({ mode: 'read' }); } catch { permission = 'denied'; }
    }
    if (permission !== 'granted') throw new Error('需要重新授权访问这一本本地规则书');
    return { file: await record.handle.getFile(), handle: record.handle };
  }
  if (record.sourceType === 'opfs' && record.opfsName && navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(record.opfsName);
    return { file: await handle.getFile(), handle: null };
  }
  if (record.sourceType === 'idb') {
    const file = await getBookFile(record.id);
    if (file) return { file, handle: null };
  }
  throw new Error('这本规则书的本地文件已经不可用；可重新选择原 CHM 后再次保存到书架');
}

async function openShelfBook(id, target = null) {
  const record = await getBookRecord(id);
  if (!record) { showToast('书架记录不存在，已刷新书架', 'error'); await refreshLibrary(); return; }
  try {
    const { file, handle } = await getFileFromShelfRecord(record);
    await openFile(file, { handle, shelfRecord: record, fromShelf: true });
    if (target?.path) await navigateActive(target.path, target.fragment || '', target.searchQuery || '', target.searchOccurrence || 0);
  } catch (error) {
    showToast(error?.message || String(error), 'error', 7000);
  }
}

async function renameShelfBook(id) {
  const record = await getBookRecord(id);
  if (!record) return;
  const current = String(record.title || record.name || '规则书').trim();
  const value = prompt('修改书架中的规则书名称：', current);
  if (value === null) return;
  const title = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 120);
  if (!title) { showToast('规则书名称不能为空', 'error'); return; }
  const updated = await patchBookRecord(id, { title, customTitle: true, renamedAt: Date.now() });
  if (!updated) return;
  if (currentBookId === id) {
    currentShelfRecord = { ...(currentShelfRecord || updated), ...updated };
    bookTitle.textContent = title;
    document.title = `${currentEntry(getTab(activeTabId))?.title || title} · ${title} · RuleDesk`;
  }
  await refreshLibrary();
  showToast(`已重命名为《${title}》`);
}

async function removeShelfBook(id) {
  const record = await getBookRecord(id);
  if (!record) return;
  const deleteNote = record.sourceType === 'handle' ? '，不会删除电脑上的原始 CHM 文件' : '和浏览器内离线副本';
  if (!confirm(`从本地书架删除《${record.title || record.name || '规则书'}》？\n\n会同时删除这本书的持久化搜索索引${deleteNote}。`)) return;
  if (record.sourceType === 'opfs' && record.opfsName && navigator.storage?.getDirectory) {
    try { const root = await navigator.storage.getDirectory(); await root.removeEntry(record.opfsName); } catch {}
  }
  const worker = indexWorkers.get(id); if (worker) { worker.terminate(); indexWorkers.delete(id); }
  await deleteBookData(id);
  if (currentBookId === id) { currentShelfRecord = null; updateBookMetaDisplay(); }
  await refreshLibrary();
  showToast('已从本地书架删除');
}

function shelfRecordForCurrent(sourceType, extra = {}) {
  return {
    id: currentBookId,
    name: currentFile?.name || book?.title || '规则书.chm',
    title: book?.title || currentFile?.name?.replace(/\.chm$/i, '') || '规则书',
    size: currentFile?.size || 0,
    lastModified: currentFile?.lastModified || 0,
    sourceType,
    encoding: book?.encoding || 'utf-8',
    compression: Boolean(book?.compression),
    pageCount: book?.spine?.length || book?.docs?.length || 0,
    docCount: book?.docs?.length || 0,
    indexState: 'queued',
    indexDone: 0,
    indexTotal: book?.docs?.length || 0,
    addedAt: Date.now(),
    lastOpened: Date.now(),
    ...extra,
  };
}

async function startPersistentIndex(record, file) {
  if (!record || !file || record.indexState === 'ready' || indexWorkers.has(record.id)) return;
  const worker = new Worker(new URL('./index-worker.js', import.meta.url), { type: 'module', name: `ruledesk-index-${record.id}` });
  let nextTermRefresh = 25;
  indexWorkers.set(record.id, worker);
  currentShelfRecord = currentBookId === record.id ? { ...record, indexState: 'building', indexDone: record.indexDone || 0 } : currentShelfRecord;
  updateBookMetaDisplay();
  worker.addEventListener('message', async (event) => {
    const msg = event.data || {};
    if (msg.bookId !== record.id) return;
    if (msg.type === 'progress') {
      const patch = { indexState: 'building', indexDone: msg.done, indexTotal: msg.total };
      const i = shelfBooks.findIndex((item) => item.id === record.id);
      if (i >= 0) shelfBooks[i] = { ...shelfBooks[i], ...patch };
      if (currentBookId === record.id) { currentShelfRecord = { ...(currentShelfRecord || record), ...patch }; updateBookMetaDisplay(); }
      if (Number(msg.percent || 0) >= nextTermRefresh) { nextTermRefresh += 25; void refreshLibraryTerms(); }
      renderLibrary();
    } else if (msg.type === 'done') {
      indexWorkers.get(record.id)?.terminate(); indexWorkers.delete(record.id);
      await refreshLibrary();
      if (currentBookId === record.id) showToast('本地全文索引构建完成');
    } else if (msg.type === 'error') {
      indexWorkers.get(record.id)?.terminate(); indexWorkers.delete(record.id);
      await refreshLibrary();
      showToast(`索引构建失败：${msg.error || '未知错误'}`, 'error');
    }
  });
  worker.addEventListener('error', async (event) => {
    worker.terminate(); indexWorkers.delete(record.id);
    await patchBookRecord(record.id, { indexState: 'error', indexError: event.message || '索引 Worker 失败' }).catch(() => {});
    await refreshLibrary();
  });
  await patchBookRecord(record.id, { indexState: 'building', indexDone: record.indexDone || 0, indexTotal: book?.docs?.length || record.indexTotal || 0 }).catch(() => {});
  worker.postMessage({ type: 'build', file, bookId: record.id, encoding: book?.encoding || record.encoding, docs: book?.docs || [] });
}

async function saveCurrentHandleToShelf(handle) {
  if (!handle || !currentFile || !book) return null;
  const existing = await getBookRecord(currentBookId);
  const fresh = shelfRecordForCurrent('handle', { handle });
  const record = existing ? {
    ...fresh,
    ...existing,
    handle,
    sourceType: 'handle',
    title: existing.customTitle ? existing.title : (book?.title || existing.title),
    size: currentFile.size,
    lastModified: currentFile.lastModified,
    encoding: book?.encoding || existing.encoding,
    compression: Boolean(book?.compression),
    pageCount: book?.spine?.length || existing.pageCount,
    docCount: book?.docs?.length || existing.docCount,
    lastOpened: Date.now(),
  } : fresh;
  await putBookRecord(record);
  await seedBookTerms(record.id, book);
  currentShelfRecord = record;
  await refreshLibrary();
  if (record.indexState !== 'ready') void startPersistentIndex(record, currentFile);
  return record;
}

async function saveCurrentOfflineShelf() {
  if (!currentFile || !book) return;
  shelfSaveBtn.disabled = true;
  shelfSaveBtn.textContent = '正在保存…';
  try {
    try { await navigator.storage?.persist?.(); } catch {}

    let sourceType = '';
    let opfsName = null;
    let opfsError = null;

    if (navigator.storage?.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        opfsName = `ruledesk-${currentBookId}.chm`;
        const handle = await root.getFileHandle(opfsName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(currentFile);
        await writable.close();
        sourceType = 'opfs';
      } catch (error) {
        opfsError = error;
        console.warn('OPFS unavailable, falling back to IndexedDB:', error);
      }
    }

    if (!sourceType) {
      if (typeof indexedDB === 'undefined') throw opfsError || new Error('当前浏览器不支持可用的离线文件存储');
      await putBookFile(currentBookId, currentFile);
      sourceType = 'idb';
      opfsName = null;
    }

    const existing = await getBookRecord(currentBookId);
    const fresh = shelfRecordForCurrent(sourceType, { opfsName });
    const record = existing ? {
      ...fresh,
      ...existing,
      sourceType,
      opfsName,
      handle: null,
      title: existing.customTitle ? existing.title : (book?.title || existing.title),
      size: currentFile.size,
      lastModified: currentFile.lastModified,
      encoding: book?.encoding || existing.encoding,
      compression: Boolean(book?.compression),
      pageCount: book?.spine?.length || existing.pageCount,
      docCount: book?.docs?.length || existing.docCount,
      lastOpened: Date.now(),
    } : fresh;
    await putBookRecord(record);
    await seedBookTerms(record.id, book);
    currentShelfRecord = record;
    shelfPrompt.hidden = true;
    pendingShelfFile = null;
    await refreshLibrary();
    void startPersistentIndex(record, currentFile);
    const storageName = sourceType === 'opfs' ? 'OPFS' : 'IndexedDB 兼容存储';
    showToast(`已保存到离线书架（${storageName}），正在后台构建全文索引`, 'info', 6500);
  } catch (error) {
    const quota = error?.name === 'QuotaExceededError' ? '浏览器本地空间不足；可清理站点数据后重试。' : '';
    showToast(`离线保存失败：${quota || error?.message || error} 仍可继续本次阅读。`, 'error', 8000);
  } finally {
    shelfSaveBtn.disabled = false;
    shelfSaveBtn.textContent = '保存到离线书架';
  }
}

async function chooseFile() {
  if (canUseDesktopFilePicker()) {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Compiled HTML Help', accept: { 'application/vnd.ms-htmlhelp': ['.chm'] } }] });
      if (!handle) return;
      const file = await handle.getFile();
      await openFile(file, { handle, rememberHandle: true });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.warn('File System Access picker unavailable, falling back:', error);
    }
  }
  fileInput.click();
}

function getStorageArray(kind) {
  if (!bookKey) return [];
  try {
    const value = JSON.parse(localStorage.getItem(`ruledesk-${kind}-${bookKey}`) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function saveStorageArray(kind, value) {
  if (!bookKey) return;
  try { localStorage.setItem(`ruledesk-${kind}-${bookKey}`, JSON.stringify(value)); } catch {}
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(readerSettings)); } catch {}
}

function applyAppTheme() {
  document.body.dataset.readerTheme = readerSettings.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', readerSettings.theme === 'dark' ? '#171714' : readerSettings.theme === 'parchment' ? '#eee4cc' : '#f8f8f5');
  }
}
applyAppTheme();

class WorkerClient {
  constructor(onProgress) {
    this.worker = new Worker(new URL('../chm-worker.js', import.meta.url), { type: 'module', name: 'ruledesk-chm-reader' });
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
    this.onProgress = onProgress;
    this.worker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'progress' && message.id === 0) { this.onProgress?.(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || 'CHM Worker 请求失败'));
    });
    this.worker.addEventListener('error', (event) => this.failAll(new Error(event.message || 'CHM Web Worker 加载失败')));
    this.worker.addEventListener('messageerror', () => this.failAll(new Error('浏览器无法解析 CHM Worker 返回的数据')));
  }
  failAll(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  request(type, payload = {}, timeoutMs = 300000) {
    if (this.closed) return Promise.reject(new Error('CHM 会话已关闭'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} 操作超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  async open(file) { return (await this.request('open', { file }, 300000)).book; }
  async read(path, maxBytes = 128 * 1024 * 1024) { return this.request('read', { path, maxBytes }, 180000); }
  async search(query, limit = 80, paths = null) { return (await this.request('search', { query, limit, paths }, 600000)).hits; }
  dropCaches() { return this.request('dropCaches').catch(() => {}); }
  destroy() { if (!this.closed) { this.closed = true; this.failAll(new DOMException('CHM 会话已关闭', 'AbortError')); this.worker.terminate(); } }
}

function destroySession() {
  searchGeneration += 1;
  previewGeneration += 1;
  client?.destroy();
  client = null;
  currentFile = null;
  currentHandle = null;
  currentBookId = '';
  currentShelfRecord = null;
  pendingShelfFile = null;
  shelfPrompt.hidden = true;
  book = null;
  bookKey = '';
  tabs = [];
  nextTabId = 1;
  activeTabId = null;
  splitTabId = null;
  bookmarks = [];
  recent = [];
  previewCache.clear();
  selectionState = null;
  selectionBar.hidden = true;
  previewCard.hidden = true;
  for (const pane of Object.values(panes)) {
    pane.generation += 1;
    pane.tabId = null;
    revokeUrls(pane.urls);
    pane.urls = new Set();
    pane.frame.removeAttribute('srcdoc');
  }
  tabbar.replaceChildren();
  tocList.replaceChildren();
  indexList.replaceChildren();
  globalSearchResults.replaceChildren();
  bookmarkList.replaceChildren();
  recentList.replaceChildren();
  fileInput.value = '';
  document.title = 'RuleDesk · 跑团规则台';
}

function goHome() {
  capturePane('primary');
  capturePane('secondary');
  destroySession();
  workspace.hidden = true;
  landing.hidden = false;
  setOverlay(false);
  document.body.classList.remove('sidebar-hidden', 'reading-mode', 'mobile-tools-open');
  mobileToolsBtn?.setAttribute('aria-expanded', 'false');
  sidebar.classList.remove('mobile-open');
}

function activeEncoding(bytes) {
  const sniffed = detectEncoding(bytes);
  if (sniffed && sniffed !== 'windows-1252') return sniffed;
  return book?.encoding || sniffed || 'utf-8';
}

function plainTextHtml(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><pre>${escaped}</pre></body></html>`;
}

function refInfo(basePath, raw) {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'blocked' };
  if (value.startsWith('#')) return { kind: 'fragment', fragment: fragmentOf(value) };
  if (/^data:image\/(?:avif|bmp|gif|jpeg|jpg|png|webp);/i.test(value)) return { kind: 'data', url: value };
  if (/^(?:https?:|mailto:|tel:|ftp:)/i.test(value)) return { kind: 'external', url: value };
  if (isExternal(value) || /^(?:vbscript:|resource:|shell:)/i.test(value)) return { kind: 'blocked' };
  const path = normalizePath(basePath, value);
  if (!path) return { kind: 'blocked' };
  return { kind: 'internal', path, fragment: fragmentOf(value) || '' };
}

function sanitizeSvgText(source) {
  try {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return '';
    doc.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((el) => el.remove());
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#') && !/^data:image\//i.test(value)) el.removeAttribute(attr.name);
      }
    });
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch { return ''; }
}

async function rewriteCss(css, basePath, loadResource) {
  let source = String(css || '')
    .replace(/@import\s+(?:url\()?\s*(?:"[^"]*"|'[^']*'|[^;)\s]+)\s*\)?\s*;?/gi, '')
    .replace(/(?:expression\s*\([^)]*\)|-moz-binding\s*:[^;}]+|behavior\s*:[^;}]+)/gi, '');
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;
  const matches = [...source.matchAll(re)];
  if (!matches.length) return source;
  const replacements = await Promise.all(matches.map(async (match) => {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    const ref = refInfo(basePath, raw);
    if (ref.kind === 'data') return `url("${ref.url.replace(/"/g, '%22')}")`;
    if (ref.kind === 'fragment') return `url("#${ref.fragment}")`;
    if (ref.kind !== 'internal') return 'url("")';
    const url = await loadResource(ref.path);
    return `url("${url || ''}")`;
  }));
  let out = '';
  let cursor = 0;
  matches.forEach((match, i) => { out += source.slice(cursor, match.index) + replacements[i]; cursor = match.index + match[0].length; });
  return out + source.slice(cursor);
}

function themePalette() {
  if (readerSettings.theme === 'dark') return { bg: '#151617', text: '#e8e6df', muted: '#aaa79e', link: '#8ab4f8', panel: '#1d1f20', border: '#444640' };
  if (readerSettings.theme === 'parchment') return { bg: '#f2ead6', text: '#372d20', muted: '#6f604b', link: '#74401e', panel: '#eadfc4', border: '#c8b78f' };
  return { bg: '#ffffff', text: '#20201d', muted: '#696961', link: '#315da8', panel: '#f6f6f2', border: '#d7d7d0' };
}

async function prepareHtml(rawHtml, basePath, paneName, generation) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const urls = new Set();
  const promises = new Map();
  const loadResource = async (requestedPath) => {
    const normalized = normalizePath('/', requestedPath);
    if (!normalized || generation !== panes[paneName].generation) return null;
    const key = normalized.toLocaleLowerCase();
    if (promises.has(key)) return promises.get(key);
    const promise = (async () => {
      try {
        const result = await client.read(normalized, 128 * 1024 * 1024);
        if (generation !== panes[paneName].generation) return null;
        const bytes = new Uint8Array(result.data);
        let blob;
        if (/^text\/css/i.test(result.mime)) {
          const rewritten = await rewriteCss(decode(bytes, activeEncoding(bytes)), normalized, loadResource);
          blob = new Blob([rewritten], { type: 'text/css;charset=utf-8' });
        } else if (/^image\/svg\+xml/i.test(result.mime)) {
          const svg = sanitizeSvgText(decode(bytes, 'utf-8'));
          if (!svg) return null;
          blob = new Blob([svg], { type: 'image/svg+xml' });
        } else {
          blob = new Blob([bytes], { type: result.mime || 'application/octet-stream' });
        }
        const url = URL.createObjectURL(blob);
        urls.add(url);
        return url;
      } catch { return null; }
    })();
    promises.set(key, promise);
    return promise;
  };

  doc.querySelectorAll('script,noscript,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,option,base,template').forEach((el) => el.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ['srcdoc', 'ping', 'formaction', 'integrity', 'crossorigin', 'target'].includes(name)) el.removeAttribute(attr.name);
    }
  });
  doc.querySelectorAll('[bgcolor],[text],[link],[vlink],[alink]').forEach((el) => {
    ['bgcolor', 'text', 'link', 'vlink', 'alink'].forEach((a) => el.removeAttribute(a));
  });

  for (const el of [...doc.querySelectorAll('a[href],area[href]')]) {
    const ref = refInfo(basePath, el.getAttribute('href') || '');
    // Old CHM pages often use target=_top/_parent or named frames.  Native
    // navigation from srcdoc must never be allowed to escape the reader.
    el.removeAttribute('href');
    el.removeAttribute('target');
    el.removeAttribute('download');
    if (ref.kind === 'fragment') {
      el.setAttribute('href', '#');
      el.dataset.chmLocalFragment = ref.fragment || '';
    } else if (ref.kind === 'internal') {
      el.setAttribute('href', '#');
      el.dataset.chmPath = ref.path;
      if (ref.fragment) el.dataset.chmFragment = ref.fragment;
      const linkLabel = cleanText(el.textContent || '').slice(0, 220);
      if (linkLabel) el.dataset.chmLabel = linkLabel;
    } else {
      el.setAttribute('href', '#');
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('title', '外部/主动链接在 RuleDesk 中默认禁用');
    }
  }

  for (const el of [...doc.querySelectorAll('link[href]')]) {
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const ref = refInfo(basePath, el.getAttribute('href') || '');
    if (!rel.includes('stylesheet') || ref.kind !== 'internal') { el.remove(); continue; }
    const url = await loadResource(ref.path);
    if (url) el.setAttribute('href', url); else el.remove();
  }

  const resourceAttrs = [
    ['img', 'src'], ['source', 'src'], ['audio', 'src'], ['video', 'src'], ['video', 'poster'], ['track', 'src'],
    ['body', 'background'], ['table', 'background'], ['td', 'background'], ['th', 'background'],
    ['image', 'href'], ['image', 'xlink:href'], ['use', 'href'], ['use', 'xlink:href'],
  ];
  for (const [selector, attr] of resourceAttrs) {
    for (const el of [...doc.querySelectorAll(`${selector}[${CSS.escape(attr)}]`)]) {
      const ref = refInfo(basePath, el.getAttribute(attr) || '');
      if (ref.kind === 'data') el.setAttribute(attr, ref.url);
      else if (ref.kind === 'fragment') el.setAttribute(attr, `#${ref.fragment}`);
      else if (ref.kind === 'internal') {
        const url = await loadResource(ref.path);
        if (url) el.setAttribute(attr, url); else el.removeAttribute(attr);
      } else el.removeAttribute(attr);
    }
  }
  doc.querySelectorAll('[srcset]').forEach((el) => el.removeAttribute('srcset'));
  for (const style of [...doc.querySelectorAll('style')]) style.textContent = await rewriteCss(style.textContent || '', basePath, loadResource);
  for (const el of [...doc.querySelectorAll('[style]')]) el.setAttribute('style', await rewriteCss(el.getAttribute('style') || '', basePath, loadResource));

  for (const table of [...doc.querySelectorAll('table')]) {
    if (table.parentElement?.closest('table')) continue;
    const rows = [...table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr')].slice(0, 12);
    const columnCount = rows.reduce((max, row) => {
      const count = [...row.children].reduce((sum, cell) => sum + Math.max(1, Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1), 0);
      return Math.max(max, count);
    }, 0);
    const cells = [...table.querySelectorAll('th,td')];
    const textWeight = (value) => [...cleanText(value || '')].reduce((sum, ch) => {
      if (/\s/.test(ch)) return sum + .28;
      if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) return sum + 1;
      if (/[A-Z0-9]/.test(ch)) return sum + .62;
      return sum + .5;
    }, 0);
    let longCells = 0;
    for (const cell of cells) {
      const weight = textWeight(cell.textContent || '');
      if (weight > 9) longCells += 1;
      if (weight > 12) cell.classList.add('rd-cell-long');
      if (weight > 24) cell.classList.add('rd-cell-xlong');
    }
    const wide = columnCount >= 5 || (columnCount >= 4 && longCells >= 2);
    const wrap = doc.createElement('div');
    wrap.className = wide ? 'rd-table-scroll rd-table-wide' : 'rd-table-scroll';
    wrap.dataset.columns = String(columnCount || '');
    table.parentNode?.insertBefore(wrap, table);
    wrap.append(table);
  }

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', ["default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline' blob:", 'img-src data: blob:', 'font-src data: blob:', 'media-src data: blob:', "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; '));
  doc.head.prepend(csp);

  const palette = themePalette();
  const style = doc.createElement('style');
  style.id = 'ruledesk-reader-theme';
  style.textContent = `
    :root{color-scheme:${readerSettings.theme === 'dark' ? 'dark' : 'light'}}
    html,body{min-height:100%;margin:0;background:${palette.bg}!important;color:${palette.text}!important}
    html{overflow-x:hidden}
    body{box-sizing:border-box;padding:24px clamp(18px,4vw,54px)!important;background:${palette.bg}!important;color:${palette.text}!important;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif!important;font-size:${readerSettings.fontScale}%!important;line-height:1.72!important;overflow-wrap:anywhere;max-width:100%}
    body,body p,body li,body dd,body dt,body div,body span,body td,body th{line-height:1.72}
    a{color:${palette.link}!important;text-underline-offset:2px}a[aria-disabled=true]{color:${palette.muted}!important;text-decoration:line-through;cursor:not-allowed}
    img,svg,video{max-width:100%!important;height:auto}.rd-table-scroll{max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-inline:contain;margin:14px 0}.rd-table-scroll>table{max-width:none!important;margin:0!important}
    .rd-table-wide>table{width:max-content!important;min-width:100%!important;table-layout:auto!important}.rd-table-wide td,.rd-table-wide th{min-width:4.6em;max-width:20em;overflow-wrap:normal!important;word-break:normal!important}.rd-table-wide td:not(.rd-cell-long):not(.rd-cell-xlong),.rd-table-wide th:not(.rd-cell-long):not(.rd-cell-xlong){white-space:nowrap!important}.rd-table-wide .rd-cell-long{min-width:8.5em}.rd-table-wide .rd-cell-xlong{min-width:12em}
    table{border-collapse:collapse}td,th{border-color:${palette.border}!important}th{background:${palette.panel}!important}blockquote,pre,code{background:${palette.panel}!important;border-color:${palette.border}!important}
    pre{white-space:pre-wrap;word-break:break-word;overflow:auto}hr{border-color:${palette.border}!important}
    ::selection{background:${readerSettings.theme === 'dark' ? '#6b5b22' : '#f1d87d'};color:inherit}
    mark.rd-search-hit{background:${readerSettings.theme === 'dark' ? '#8a6b19' : '#ffe36e'}!important;color:inherit!important;border-radius:3px;padding:0 .06em;box-shadow:0 0 0 2px ${readerSettings.theme === 'dark' ? 'rgba(255,222,100,.18)' : 'rgba(180,130,0,.12)'}}
    .rd-jump-target{background:${readerSettings.theme === 'dark' ? '#705713' : '#ffe071'}!important;color:inherit!important;border-radius:5px;padding:.05em .22em!important;box-decoration-break:clone;-webkit-box-decoration-break:clone;box-shadow:0 0 0 3px ${readerSettings.theme === 'dark' ? 'rgba(255,224,112,.16)' : 'rgba(170,115,0,.13)'};scroll-margin-block:28vh}
    @media(max-width:720px){body{padding:15px 13px 10px!important}.rd-table-scroll{margin-left:-4px;margin-right:-4px;padding-bottom:3px}.rd-table-wide td,.rd-table-wide th{min-width:5.2em}.rd-table-wide .rd-cell-long{min-width:9.5em}.rd-table-wide .rd-cell-xlong{min-width:14em}}
  `;
  doc.head.append(style);
  return { html: `<!doctype html>${doc.documentElement.outerHTML}`, title: doc.title || '', urls };
}

function getTab(id) { return tabs.find((tab) => tab.id === id) || null; }
function currentEntry(tab) { return tab?.history?.[tab.historyIndex] || null; }

function capturePane(name) {
  const pane = panes[name];
  const tab = getTab(pane.tabId);
  const entry = currentEntry(tab);
  if (!tab || !entry) return;
  try { entry.scrollY = pane.frame.contentWindow?.scrollY || 0; } catch {}
}

function updateHistoryButtons() {
  const tab = getTab(activeTabId);
  historyBackBtn.disabled = !tab || tab.historyIndex <= 0;
  historyForwardBtn.disabled = !tab || tab.historyIndex < 0 || tab.historyIndex >= tab.history.length - 1;
}

function updateBookmarkButton() {
  const tab = getTab(activeTabId);
  const entry = currentEntry(tab);
  const marked = entry && bookmarks.some((item) => item.path.toLocaleLowerCase() === entry.path.toLocaleLowerCase());
  bookmarkBtn.textContent = marked ? '★' : '☆';
  bookmarkBtn.classList.toggle('marked', Boolean(marked));
}

function renderTabs() {
  tabbar.replaceChildren();
  for (const tab of tabs) {
    const button = document.createElement('div');
    button.className = `rule-tab${tab.id === activeTabId ? ' active' : ''}`;
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.dataset.tabId = String(tab.id);
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || '新标签';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭标签';
    close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(tab.id); });
    button.append(title, close);
    button.addEventListener('click', () => activateTab(tab.id));
    button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateTab(tab.id); } });
    tabbar.append(button);
  }
  updateHistoryButtons();
  updateBookmarkButton();
}

function createTab(path, title = '新标签', activate = true) {
  const tab = { id: nextTabId++, title, history: [], historyIndex: -1 };
  tabs.push(tab);
  if (activate) {
    activeTabId = tab.id;
    panes.primary.tabId = tab.id;
  }
  if (path) {
    tab.history.push({ path, fragment: '', scrollY: 0, title });
    tab.historyIndex = 0;
  }
  renderTabs();
  return tab;
}

function closeTab(id) {
  if (tabs.length <= 1) { showToast('至少保留一个标签页'); return; }
  capturePane('primary'); capturePane('secondary');
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  tabs.splice(index, 1);
  if (splitTabId === id) closeSplit();
  if (activeTabId === id) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = next.id;
    panes.primary.tabId = next.id;
    void loadCurrentTab('primary');
  }
  renderTabs();
}

function activateTab(id) {
  const target = getTab(id);
  if (!target) return;
  capturePane('primary');
  if (id === splitTabId) {
    const previous = activeTabId;
    activeTabId = splitTabId;
    splitTabId = previous;
    panes.primary.tabId = activeTabId;
    panes.secondary.tabId = splitTabId;
    renderTabs();
    void loadCurrentTab('primary');
    void loadCurrentTab('secondary');
    return;
  }
  activeTabId = id;
  panes.primary.tabId = id;
  renderTabs();
  void loadCurrentTab('primary');
}

function cleanText(value) { return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim(); }

function addRecent(path, title) {
  if (!path) return;
  const lower = path.toLocaleLowerCase();
  recent = recent.filter((item) => item.path.toLocaleLowerCase() !== lower);
  recent.unshift({ path, title: title || path.split('/').pop(), ts: Date.now() });
  recent = recent.slice(0, MAX_RECENT);
  saveStorageArray('recent', recent);
  renderRecent();
}

function renderBookmarks() {
  bookmarkList.replaceChildren();
  if (!bookmarks.length) { bookmarkList.innerHTML = '<p class="empty">还没有常用规则。打开页面后点击工具栏的 ☆ 即可收藏。</p>'; return; }
  for (const item of bookmarks) bookmarkList.append(makeSideButton(item.title || item.path, item.path, '常用规则'));
}

function renderRecent() {
  recentList.replaceChildren();
  if (!recent.length) { recentList.innerHTML = '<p class="empty">浏览过的规则会出现在这里。</p>'; return; }
  for (const item of recent) {
    const meta = item.ts ? new Date(item.ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '最近';
    recentList.append(makeSideButton(item.title || item.path, item.path, meta));
  }
}

function toggleBookmark() {
  const tab = getTab(activeTabId);
  const entry = currentEntry(tab);
  if (!entry) return;
  const lower = entry.path.toLocaleLowerCase();
  const index = bookmarks.findIndex((item) => item.path.toLocaleLowerCase() === lower);
  if (index >= 0) { bookmarks.splice(index, 1); showToast('已从常用规则移除'); }
  else { bookmarks.unshift({ path: entry.path, title: entry.title || tab.title || entry.path.split('/').pop(), ts: Date.now() }); bookmarks = bookmarks.slice(0, MAX_BOOKMARKS); showToast('已加入常用规则'); }
  saveStorageArray('bookmarks', bookmarks);
  renderBookmarks();
  updateBookmarkButton();
}

function makeSideButton(label, path, meta = '', snippet = '', options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'side-item';
  button.dataset.path = path;
  const title = document.createElement('span');
  title.textContent = label || path;
  button.append(title);
  if (meta) { const small = document.createElement('span'); small.className = 'meta'; small.textContent = meta; button.append(small); }
  if (snippet) { const small = document.createElement('span'); small.className = 'snippet'; small.textContent = snippet; button.append(small); }
  button.addEventListener('click', () => { if (typeof options.onClick === 'function') void options.onClick(); else void navigateActive(path, options.fragment || '', options.searchQuery || '', Number.isFinite(options.searchOccurrence) ? options.searchOccurrence : 0); });
  return button;
}

function syncTocToggle(group) {
  if (!(group instanceof HTMLDetailsElement)) return;
  const toggle = group.querySelector(':scope > summary .nav-toggle');
  if (!toggle) return;
  const name = group.dataset.tocName || '目录';
  toggle.setAttribute('aria-expanded', group.open ? 'true' : 'false');
  toggle.setAttribute('aria-label', `${group.open ? '收起' : '展开'} ${name}`);
}

function setTocGroupOpen(group, open) {
  if (!(group instanceof HTMLDetailsElement)) return;
  group.open = Boolean(open);
  syncTocToggle(group);
}

function closeTocContextMenu() {
  if (tocContextMenu) tocContextMenu.hidden = true;
}

function ensureTocContextMenu() {
  if (tocContextMenu) return tocContextMenu;
  tocContextMenu = document.createElement('div');
  tocContextMenu.className = 'toc-context-menu';
  tocContextMenu.hidden = true;
  tocContextMenu.setAttribute('role', 'menu');
  document.body.append(tocContextMenu);
  document.addEventListener('pointerdown', (event) => {
    if (!tocContextMenu.hidden && !tocContextMenu.contains(event.target)) closeTocContextMenu();
  });
  window.addEventListener('blur', closeTocContextMenu);
  window.addEventListener('resize', closeTocContextMenu);
  document.addEventListener('scroll', closeTocContextMenu, true);
  return tocContextMenu;
}

function openTocContextMenu(event, group = null) {
  event.preventDefault();
  event.stopPropagation();
  const menu = ensureTocContextMenu();
  menu.replaceChildren();
  const addAction = (label, action, disabled = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toc-context-action';
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => { closeTocContextMenu(); action(); });
    menu.append(button);
  };
  const descendants = group ? [...group.querySelectorAll('.nav-group')] : [];
  if (group) {
    addAction('展开此项全部', () => {
      setTocGroupOpen(group, true);
      descendants.forEach((item) => setTocGroupOpen(item, true));
    });
    addAction('收起此项以下', () => {
      descendants.forEach((item) => setTocGroupOpen(item, false));
      setTocGroupOpen(group, false);
    });
  }
  addAction('收起全部', () => {
    tocList.querySelectorAll('.nav-group').forEach((item) => setTocGroupOpen(item, false));
  });
  menu.hidden = false;
  const gap = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - rect.width - gap);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - gap);
  menu.style.left = `${Math.max(gap, left)}px`;
  menu.style.top = `${Math.max(gap, top)}px`;
}

function renderToc(tree) {
  tocList.replaceChildren();
  closeTocContextMenu();
  let rendered = 0;
  const append = (nodes, parent, depth = 0) => {
    for (const node of nodes || []) {
      if (rendered++ > 20000) return;
      if (node.children?.length) {
        const details = document.createElement('details');
        details.className = 'nav-group';
        details.dataset.tocName = node.name || '目录';

        const summary = document.createElement('summary');
        summary.dataset.depth = String(depth);
        // 禁用 <summary> 自身的默认切换。目录展开/收起只能由左侧箭头触发。
        summary.addEventListener('click', (event) => event.preventDefault());
        summary.addEventListener('contextmenu', (event) => openTocContextMenu(event, details));

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'nav-toggle';
        toggle.textContent = '›';
        toggle.setAttribute('aria-label', `${details.open ? '收起' : '展开'} ${node.name || '目录'}`);
        toggle.setAttribute('aria-expanded', details.open ? 'true' : 'false');
        toggle.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          setTocGroupOpen(details, !details.open);
        });

        let label;
        if (node.local) {
          label = document.createElement('button');
          label.type = 'button';
          label.className = 'nav-label';
          label.dataset.path = node.local;
          label.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void navigateActive(node.local);
          });
        } else {
          label = document.createElement('span');
          label.className = 'nav-label nav-label-static';
        }
        label.textContent = node.name || '(未命名)';
        summary.append(toggle, label);

        const children = document.createElement('div');
        children.className = 'nav-children';
        append(node.children, children, depth + 1);
        details.append(summary, children);
        parent.append(details);
      } else if (node.local) {
        const leaf = makeSideButton(node.name || node.local, node.local);
        leaf.classList.add('toc-leaf');
        leaf.addEventListener('contextmenu', (event) => openTocContextMenu(event, null));
        parent.append(leaf);
      }
    }
  };
  append(tree, tocList);
  if (!tocList.childElementCount) tocList.innerHTML = '<p class="empty">这个规则书没有可显示的目录。</p>';
}

function renderIndex(items) {
  indexList.replaceChildren();
  for (const item of (items || []).slice(0, 20000)) {
    const path = item.targets?.[0]; if (path) indexList.append(makeSideButton(item.name, path));
  }
  if (!indexList.childElementCount) indexList.innerHTML = '<p class="empty">这个规则书没有关键词索引。</p>';
}

function filterSideList(container, value) {
  const q = value.trim().toLocaleLowerCase();
  container.querySelectorAll('.side-item').forEach((el) => { el.hidden = Boolean(q) && !el.textContent.toLocaleLowerCase().includes(q); });
  container.querySelectorAll('.nav-group').forEach((group) => {
    if (!q) { group.hidden = false; return; }
    const own = group.querySelector(':scope > summary')?.textContent.toLocaleLowerCase().includes(q);
    const child = [...group.querySelectorAll('.side-item')].some((el) => !el.hidden);
    group.hidden = !(own || child); if (own || child) group.open = true;
  });
}

function switchSide(name) {
  document.querySelectorAll('.side-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.side === name));
  const map = { search: 'searchSide', toc: 'tocSide', index: 'indexSide', bookmarks: 'bookmarksSide', recent: 'recentSide' };
  Object.entries(map).forEach(([key, id]) => $(id).classList.toggle('active', key === name));
}

const tocScopeCache = new WeakMap();

function findTocChain(path) {
  if (!book?.toc?.length || !path) return [];
  const target = (normalizePath('/', path) || path).toLocaleLowerCase();
  let found = [];
  const walk = (nodes, chain = []) => {
    for (const node of nodes || []) {
      const next = [...chain, node];
      const local = node.local ? (normalizePath('/', node.local) || node.local).toLocaleLowerCase() : '';
      if (local && local === target) { found = next; return true; }
      if (node.children?.length && walk(node.children, next)) return true;
    }
    return false;
  };
  walk(book.toc);
  return found;
}

function scopePathsForNode(node) {
  if (!node) return [];
  const cached = tocScopeCache.get(node);
  if (cached) return cached;
  const docs = new Set((book?.docs || []).map((path) => (normalizePath('/', path) || path).toLocaleLowerCase()));
  const seen = new Set();
  const paths = [];
  const walk = (item) => {
    if (item?.local) {
      const path = normalizePath('/', item.local) || item.local;
      const key = path.toLocaleLowerCase();
      if (docs.has(key) && !seen.has(key)) { seen.add(key); paths.push(path); }
    }
    for (const child of item?.children || []) walk(child);
  };
  walk(node);
  tocScopeCache.set(node, paths);
  return paths;
}

function buildSearchScopes(path) {
  const chain = findTocChain(path);
  const scopes = [];
  const signatures = new Set();
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i];
    if (i !== chain.length - 1 && !node?.children?.length) continue;
    const paths = scopePathsForNode(node);
    if (!paths.length) continue;
    const signature = paths.map((item) => item.toLocaleLowerCase()).join('\n');
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    scopes.push({
      id: `toc-${i}-${stableHash(`${node.name || ''}|${paths.length}|${paths[0] || ''}`)}`,
      label: cleanText(node.name || '当前目录') || '当前目录',
      paths,
      depth: i,
      kind: 'toc',
    });
  }
  scopes.push({ id: 'book', label: '整本规则书', paths: null, depth: -1, kind: 'book' });
  if (shelfBooks.length) scopes.push({ id: 'library', label: '本地规则库', paths: null, depth: -2, kind: 'library' });
  return scopes;
}

function getActiveSearchScope() {
  return searchScopes.find((scope) => scope.id === activeSearchScopeId) || searchScopes[0] || { id: 'book', label: '整本规则书', paths: null, kind: 'book' };
}

function renderSearchScopeMenu() {
  searchScopeMenu.replaceChildren();
  const q = globalSearchInput.value.trim();
  const scopes = searchScopes.length ? searchScopes : buildSearchScopes(currentEntry(getTab(activeTabId))?.path || book?.defaultPath || '');
  for (const [index, scope] of scopes.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `search-scope-option${scope.id === activeSearchScopeId ? ' active' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', scope.id === activeSearchScopeId ? 'true' : 'false');
    const icon = document.createElement('span');
    icon.className = 'scope-icon';
    icon.textContent = scope.kind === 'library' ? '▣' : scope.kind === 'book' ? '▤' : index === 0 ? '⌕' : '↥';
    const copy = document.createElement('span');
    copy.className = 'scope-copy';
    const title = document.createElement('span');
    title.className = 'scope-title';
    title.textContent = scope.kind === 'library' ? '搜索本地规则库' : scope.kind === 'book' ? '搜索整本规则书' : `在「${scope.label}」中搜索`;
    const hint = document.createElement('span');
    hint.className = 'scope-hint';
    if (q) hint.textContent = `查找“${q}”`;
    else if (scope.kind === 'library') hint.textContent = '聚合搜索书架中的 5E / 5R / COC 等已保存规则书';
    else hint.textContent = scope.kind === 'book' ? '扩大到全书正文、目录和索引' : '仅搜索这个目录节点及其下属内容';
    copy.append(title, hint);
    const count = document.createElement('span');
    count.className = 'scope-count';
    count.textContent = scope.kind === 'library' ? `${shelfBooks.length} 本` : scope.paths ? `${scope.paths.length} 页` : `${book?.docs?.length || 0} 页`;
    button.append(icon, copy, count);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      activeSearchScopeId = scope.id;
      renderSearchScopeMenu();
      searchScopeMenu.hidden = true;
      if (!q) return;
      switchSide('search');
      const localHits = localSearch(q, scope);
      renderSearch(localHits, [], q, scope);
      if (q.length >= 2) void runFullSearch(q);
      else searchStatus.textContent = `搜索范围：${scope.label}。继续输入，至少 2 个字符可搜索正文。`;
    });
    searchScopeMenu.append(button);
  }
}

function updateSearchScopes(path) {
  searchScopes = buildSearchScopes(path);
  activeSearchScopeId = searchScopes[0]?.id || 'book';
  renderSearchScopeMenu();
}

function showSearchScopeMenu() {
  if (!globalSearchInput.value.trim()) { searchScopeMenu.hidden = true; return; }
  renderSearchScopeMenu();
  searchScopeMenu.hidden = false;
}

function scoreQuickMatch(keys, label, query) {
  const q = normalizeSearch(query);
  if (!q) return 0;
  const normalizedLabel = normalizeSearch(label);
  if (normalizedLabel === q) return 140;
  if (keys?.some((key) => key === q)) return 135;
  if (normalizedLabel.startsWith(q)) return 112;
  if (keys?.some((key) => key.startsWith(q))) return 108;
  if (normalizedLabel.includes(q)) return 86;
  if (keys?.some((key) => key.includes(q))) return 82;
  return 0;
}

function localSearch(query, scope = getActiveSearchScope()) {
  const q = query.trim();
  if (!q) return [];
  if (scope?.kind === 'library') {
    const rows = [];
    for (const term of libraryTerms) {
      const score = scoreQuickMatch(term.keys || [], term.label || '', q);
      if (score) rows.push({ ...term, title: term.label, score, source: term.source || '持久化索引' });
    }
    return rows.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title))).slice(0, 160);
  }

  const lowQ = q.toLocaleLowerCase();
  const found = new Map();
  const allowed = scope?.paths ? new Set(scope.paths.map((path) => (normalizePath('/', path) || path).toLocaleLowerCase())) : null;
  const inScope = (path) => !allowed || (path && allowed.has((normalizePath('/', path) || path).toLocaleLowerCase()));
  const add = (path, title, score, source, extra = {}) => {
    if (!path || !inScope(path)) return;
    const key = `${path.toLocaleLowerCase()}|${extra.anchor || ''}`;
    const old = found.get(key);
    if (!old || score > old.score) found.set(key, { path, title, score, source, ...extra });
  };
  for (const item of book?.spine || []) {
    const title = String(item.name || item.local || '');
    const low = title.toLocaleLowerCase();
    let score = 0;
    if (low === lowQ) score = 120; else if (low.startsWith(lowQ)) score = 95; else if (low.includes(lowQ)) score = 70;
    if (score) add(item.local, title, score, '目录');
  }
  for (const item of book?.index || []) {
    const low = String(item.name || '').toLocaleLowerCase();
    let score = 0;
    if (low === lowQ) score = 110; else if (low.startsWith(lowQ)) score = 90; else if (low.includes(lowQ)) score = 68;
    if (score) add(item.targets?.[0], item.name, score, '索引');
  }
  // A saved book has an additional persistent quick-term index. This enables
  // pinyin initials (jjgj) and English originals (prone / grappled) without
  // waiting for a full-text scan on every search.
  if (currentBookId) {
    for (const term of libraryTerms) {
      if (term.bookId !== currentBookId || !inScope(term.path)) continue;
      const score = scoreQuickMatch(term.keys || [], term.label || '', q);
      if (score) add(term.path, term.label, score + 8, term.source || '术语索引', { anchor: term.anchor || '', targetQuery: term.searchText || term.label });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title))).slice(0, 80);
}

function appendLibraryGroupedResults(hits, query, kind = 'quick') {
  const byBook = new Map();
  for (const hit of hits) {
    const id = hit.bookId;
    if (!id) continue;
    if (!byBook.has(id)) byBook.set(id, []);
    byBook.get(id).push(hit);
  }
  for (const record of shelfBooks) {
    const rows = byBook.get(record.id);
    if (!rows?.length) continue;
    const heading = document.createElement('div'); heading.className = 'side-section-label'; heading.textContent = `${record.title || record.name} · ${kind === 'quick' ? '术语/标题' : '正文'}`; globalSearchResults.append(heading);
    let shown = 0;
    for (const hit of rows) {
      if (shown >= 45) break;
      if (kind === 'quick') {
        const targetQuery = hit.targetQuery || hit.searchText || hit.label || query;
        const meta = `${hit.source || '持久化索引'} · ${record.indexState === 'ready' ? '索引已就绪' : indexLabel(record)}`;
        globalSearchResults.append(makeSideButton(hit.title || hit.path, hit.path, meta, '', {
          onClick: () => openShelfBook(record.id, { path: hit.path, fragment: hit.anchor || '', searchQuery: targetQuery, searchOccurrence: 0 }),
        }));
        shown += 1;
      } else {
        const matches = hit.matches?.length ? hit.matches : [{ occurrenceIndex: 0, snippet: '' }];
        for (const match of matches) {
          if (shown >= 45) break;
          const meta = `正文匹配 · 点击直达 · ${record.title || record.name}`;
          globalSearchResults.append(makeSideButton(hit.title || hit.path, hit.path, meta, match.snippet || '', {
            onClick: () => openShelfBook(record.id, { path: hit.path, searchQuery: query, searchOccurrence: match.occurrenceIndex || 0 }),
          }));
          shown += 1;
        }
      }
    }
  }
}

function renderSearch(localHits, fullHits = [], query = globalSearchInput.value.trim(), scope = getActiveSearchScope()) {
  globalSearchResults.replaceChildren();
  if (scope?.kind === 'library') {
    appendLibraryGroupedResults(localHits, query, 'quick');
    appendLibraryGroupedResults(fullHits, query, 'full');
    if (!globalSearchResults.childElementCount) globalSearchResults.innerHTML = '<p class="empty">本地规则库中没有匹配结果。尚未完成后台索引的规则书只能先匹配目录/术语。</p>';
    return;
  }
  const seen = new Set();
  const fullKeys = new Set(fullHits.map((hit) => hit.path?.toLocaleLowerCase()).filter(Boolean));
  const instantHits = localHits.filter((hit) => !fullKeys.has(hit.path?.toLocaleLowerCase()));
  const addInstantSection = () => {
    const usable = instantHits.filter((hit) => {
      const key = `${hit.path?.toLocaleLowerCase()}|${hit.anchor || ''}`;
      if (!hit.path || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!usable.length) return;
    const heading = document.createElement('div'); heading.className = 'side-section-label'; heading.textContent = '即时匹配'; globalSearchResults.append(heading);
    for (const hit of usable.slice(0, 60)) {
      const meta = `${hit.source || '目录'} · 点击后定位正文`;
      globalSearchResults.append(makeSideButton(hit.title || hit.path, hit.path, meta, '', { fragment: hit.anchor || '', searchQuery: hit.targetQuery || query, searchOccurrence: 0 }));
    }
  };
  const addFullSection = () => {
    if (!fullHits.length) return;
    const heading = document.createElement('div'); heading.className = 'side-section-label'; heading.textContent = '正文结果'; globalSearchResults.append(heading);
    let rendered = 0;
    for (const hit of fullHits) {
      const pathKey = hit.path?.toLocaleLowerCase();
      if (!pathKey) continue;
      const matches = Array.isArray(hit.matches) && hit.matches.length ? hit.matches : [{ occurrenceIndex: hit.occurrenceIndex || 0, snippet: hit.snippet || '' }];
      const total = Number.isFinite(hit.occurrenceTotal) ? hit.occurrenceTotal : matches.length;
      for (const match of matches) {
        if (rendered >= 180) break;
        const occurrence = Number.isFinite(match.occurrenceIndex) ? match.occurrenceIndex : 0;
        const key = `${pathKey}#${occurrence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const meta = `正文匹配 · 第 ${occurrence + 1}/${total} 处 · 点击直达`;
        globalSearchResults.append(makeSideButton(hit.title || hit.path, hit.path, meta, match.snippet || '', { searchQuery: query, searchOccurrence: occurrence }));
        rendered += 1;
      }
      if (rendered >= 180) break;
    }
  };
  addInstantSection();
  addFullSection();
  if (!globalSearchResults.childElementCount) globalSearchResults.innerHTML = '<p class="empty">没有匹配结果。</p>';
}

async function runFullSearch(query) {
  const q = query.trim();
  if (q.length < 2) return;
  const generation = ++searchGeneration;
  const scope = getActiveSearchScope();
  const scopeId = scope.id;
  switchSide('search');
  const localHits = localSearch(q, scope);
  renderSearch(localHits, [], q, scope);

  if (scope.kind === 'library') {
    const indexed = shelfBooks.filter((item) => item.indexState === 'ready' || Number(item.indexDone || 0) > 0);
    searchStatus.textContent = indexed.length ? `正在本地规则库中搜索 ${indexed.length} 本已建立正文索引的规则书；术语/拼音/英文索引已先显示。` : '书架中的正文索引尚未完成；当前先显示目录、拼音和英文术语匹配。';
    try {
      const hits = await searchLibraryPages(q, indexed.map((item) => item.id), 150);
      if (generation !== searchGeneration || globalSearchInput.value.trim() !== q || getActiveSearchScope().id !== scopeId) return;
      renderSearch(localHits, hits, q, scope);
      const pages = hits.length;
      const matches = hits.reduce((sum, hit) => sum + (hit.matches?.length || 1), 0);
      searchStatus.textContent = `本地规则库：${shelfBooks.length} 本规则书；正文命中 ${pages} 页，当前展示 ${matches} 处。`;
    } catch (error) {
      if (generation !== searchGeneration) return;
      searchStatus.textContent = '本地规则库正文搜索失败，术语/标题匹配仍可使用。';
      showToast(`本地索引搜索失败：${error?.message || error}`, 'error');
    }
    return;
  }

  if (!client) return;
  searchStatus.textContent = `正在「${scope.label}」中按需搜索正文；目录/索引匹配会先显示。`;
  try {
    const hits = await client.search(q, 100, scope.paths);
    if (generation !== searchGeneration || globalSearchInput.value.trim() !== q || getActiveSearchScope().id !== scopeId) return;
    renderSearch(localHits, hits, q, scope);
    const matchCount = hits.reduce((sum, hit) => sum + (Number.isFinite(hit.occurrenceTotal) ? hit.occurrenceTotal : (hit.matches?.length || 1)), 0);
    searchStatus.textContent = `搜索范围：${scope.label}。正文搜索完成：${hits.length} 个页面，共 ${matchCount} 处命中。`;
  } catch (error) {
    if (generation !== searchGeneration) return;
    searchStatus.textContent = '正文搜索失败，目录与索引匹配仍可使用。';
    showToast(`搜索失败：${error?.message || error}`, 'error');
  }
}

function captureSelection(name) {
  const pane = panes[name];
  try {
    const text = cleanText(pane.frame.contentWindow?.getSelection()?.toString() || '');
    if (text.length < 2) { selectionState = null; selectionBar.hidden = true; return; }
    const tab = getTab(pane.tabId); const entry = currentEntry(tab);
    selectionState = { text: text.slice(0, 12000), title: entry?.title || tab?.title || '规则', path: entry?.path || '', pane: name };
    selectionInfo.textContent = `已选择 ${Math.min(text.length, 12000)} 字`;
    selectionBar.hidden = false;
  } catch {}
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select(); const ok = document.execCommand('copy'); area.remove(); return ok;
  } catch { return false; }
}

async function copyRuleCard() {
  const tab = getTab(activeTabId); const entry = currentEntry(tab);
  let text = selectionState?.text || '';
  let title = selectionState?.title || entry?.title || tab?.title || '规则';
  if (!text) {
    try { text = cleanText(panes.primary.frame.contentDocument?.body?.innerText || '').slice(0, 12000); } catch {}
  }
  if (!text) { showToast('当前没有可复制的正文'); return; }
  const card = `【${title}】\n\n${text}\n\n—— ${book?.title || currentFile?.name || 'RuleDesk'}`;
  const ok = await copyText(card);
  showToast(ok ? '规则卡已复制，可直接粘贴到 QQ / Discord / KOOK' : '复制失败，请使用浏览器的复制功能', ok ? 'info' : 'error');
}

function highlightSearchText(name, query, occurrenceIndex = 0) {
  const q = String(query || '').trim();
  if (!q) return false;
  const frame = panes[name].frame;
  let doc;
  try { doc = frame.contentDocument; } catch { return false; }
  if (!doc?.body) return false;

  // A page can be restored from history after having been searched before.
  // Remove old markers first so a new query is matched against the real text.
  for (const mark of [...doc.querySelectorAll('mark.rd-search-hit')]) mark.replaceWith(...mark.childNodes);
  doc.body.normalize();

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.data) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script,style,noscript,template')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const parts = [];
  let flat = '';
  let node;
  while ((node = walker.nextNode())) {
    const start = flat.length;
    flat += node.data;
    parts.push({ node, start, end: flat.length });
  }
  const low = flat.toLocaleLowerCase();
  const needle = q.toLocaleLowerCase();
  const positions = [];
  let from = 0;
  while (from <= low.length - needle.length) {
    const pos = low.indexOf(needle, from);
    if (pos < 0) break;
    positions.push(pos);
    from = pos + Math.max(1, needle.length);
  }
  if (!positions.length) return false;
  const wanted = Math.min(Math.max(0, Number(occurrenceIndex) || 0), positions.length - 1);
  const pos = positions[wanted];
  const endPos = pos + q.length;
  const segments = parts.filter((part) => part.end > pos && part.start < endPos).map((part) => ({
    node: part.node,
    start: Math.max(0, pos - part.start),
    end: Math.min(part.node.data.length, endPos - part.start),
  }));
  if (!segments.length) return false;

  let firstMark = null;
  // Work from the last text node backwards so splitting nodes cannot invalidate
  // offsets of earlier segments.
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    const textNode = segment.node;
    if (!textNode.parentNode || segment.end <= segment.start) continue;
    const matched = textNode.splitText(segment.start);
    matched.splitText(segment.end - segment.start);
    const mark = doc.createElement('mark');
    mark.className = 'rd-search-hit';
    mark.dataset.rdSearchHit = String(wanted + 1);
    matched.parentNode.replaceChild(mark, matched);
    mark.append(matched);
    firstMark = mark;
  }
  if (!firstMark) return false;
  try { firstMark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch { firstMark.scrollIntoView(); }
  return true;
}

function decodeFragmentValue(fragment) {
  try { return decodeURIComponent(String(fragment || '')); } catch { return String(fragment || ''); }
}

function compactCompareText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, '');
}

function fragmentTarget(doc, fragment, label = '') {
  const decoded = decodeFragmentValue(fragment);
  if (!decoded || !doc) return null;
  const candidates = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('[id],[name]')) {
    if ((el.getAttribute('id') || '') !== decoded && (el.getAttribute('name') || '') !== decoded) continue;
    if (seen.has(el)) continue;
    seen.add(el); candidates.push(el);
  }
  if (!candidates.length) return null;
  if (candidates.length === 1 || !label) return candidates[0];
  const wanted = compactCompareText(label);
  if (!wanted) return candidates[0];
  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const visible = visibleJumpTarget(candidate);
    const text = compactCompareText(visible?.textContent || candidate.textContent || '');
    let score = 0;
    if (text && wanted.includes(text)) score = 10000 + text.length;
    else if (text && text.includes(wanted)) score = 9000 + wanted.length;
    else if (text) {
      let common = 0;
      for (let i = 0; i < Math.min(text.length, wanted.length); i += 1) if (text[i] === wanted[i]) common += 1;
      score = common;
    }
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

function visibleJumpTarget(target) {
  if (!target) return null;
  if (/^H[1-6]$/i.test(target.tagName || '')) return target;
  const heading = target.closest?.('h1,h2,h3,h4,h5,h6');
  if (heading) return heading;
  const ownText = cleanText(target.textContent || '');
  if (ownText) return target;
  let next = target.nextElementSibling;
  while (next && !cleanText(next.textContent || '')) next = next.nextElementSibling;
  return next || target.parentElement || target;
}

function focusJumpTarget(name, fragment, label = '') {
  const frame = panes[name].frame;
  try {
    const doc = frame.contentDocument;
    const rawTarget = fragmentTarget(doc, fragment, label);
    const target = visibleJumpTarget(rawTarget);
    if (!target) return false;
    doc.querySelectorAll('.rd-jump-target').forEach((el) => el.classList.remove('rd-jump-target'));
    target.classList.add('rd-jump-target');
    if (label) target.setAttribute('data-rd-jump-label', cleanText(label).slice(0, 220));
    try { target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch { target.scrollIntoView(); }
    return cleanText(target.textContent || label || '').slice(0, 140) || true;
  } catch { return false; }
}

function openInternalLinkInNewTab(path, fragment = '', label = '', sourcePane = 'primary') {
  capturePane(sourcePane);
  const cleanLabel = cleanText(label || '');
  const title = (cleanLabel || fragment || String(path || '').split('/').pop() || '规则').slice(0, 90);
  const tab = createTab(path, title, true);
  const entry = tab.history[0];
  if (entry) {
    entry.fragment = fragment || '';
    entry.jumpLabel = cleanLabel;
    entry.scrollY = 0;
  }
  panes.primary.tabId = tab.id;
  void loadPage(tab.id, path, fragment, 'primary', { push: false, restoreScroll: 0, jumpLabel: cleanLabel });
}

function headingLevel(el) {
  const match = /^H([1-6])$/i.exec(el?.tagName || '');
  return match ? Number(match[1]) : 0;
}

function fragmentPreview(doc, fragment, fallbackLabel = '') {
  const rawTarget = fragmentTarget(doc, fragment, fallbackLabel);
  const target = visibleJumpTarget(rawTarget);
  if (!target) return null;
  const heading = /^H[1-6]$/i.test(target.tagName || '') ? target : target.closest?.('h1,h2,h3,h4,h5,h6');
  const start = heading || target;
  const focus = cleanText(start.textContent || fallbackLabel || '');
  const level = headingLevel(heading);
  const parts = [];
  let total = 0;
  let node = start.nextElementSibling;
  while (node && total < 1800) {
    const nodeLevel = headingLevel(node);
    if (nodeLevel && level && nodeLevel <= level) break;
    const text = cleanText(node.textContent || '');
    if (text) {
      parts.push(text);
      total += text.length;
    }
    node = node.nextElementSibling;
  }
  if (!parts.length && start !== target) {
    const own = cleanText(target.textContent || '');
    if (own && own !== focus) parts.push(own);
  }
  return {
    title: focus || cleanText(fallbackLabel) || cleanText(doc.title || '') || '规则预览',
    focus: focus || cleanText(fallbackLabel || ''),
    text: parts.join('\n\n').slice(0, 1800),
  };
}

function renderPreviewItem(item) {
  previewTitle.textContent = item?.title || '规则预览';
  previewText.replaceChildren();
  if (item?.focus) {
    const mark = document.createElement('mark');
    mark.className = 'preview-jump-hit';
    mark.textContent = item.focus;
    previewText.append(mark);
    if (item.text) previewText.append(document.createTextNode(`\n\n${item.text}`));
  } else {
    previewText.textContent = item?.text || '这个页面没有可预览的纯文本内容。';
  }
}

function scrollToPosition(name, fragment, y = 0) {
  const frame = panes[name].frame;
  try {
    if (fragment) {
      const decoded = decodeFragmentValue(fragment);
      const target = frame.contentDocument?.getElementById(decoded) || frame.contentDocument?.getElementsByName(decoded)?.[0];
      if (target) { target.scrollIntoView({ block: 'start' }); return; }
    }
    frame.contentWindow?.scrollTo(0, y || 0);
  } catch {}
}

function attachFrameInteractions(name, generation) {
  const pane = panes[name];
  let doc;
  try { doc = pane.frame.contentDocument; } catch { return; }
  if (!doc) return;
  doc.addEventListener('click', (event) => {
    const anchor = event.target && typeof event.target.closest === 'function' ? event.target.closest('a,area') : null;
    if (!anchor) return;

    // CHM pages were commonly authored for framesets and may contain target=_top,
    // target=_parent, named-frame targets or bare # links.  Always suppress native
    // navigation and route safe destinations ourselves so the outer RuleDesk app
    // can never be replaced by a topic link.
    const path = anchor.dataset.chmPath || '';
    const fragment = anchor.dataset.chmFragment || '';
    const linkLabel = anchor.dataset.chmLabel || cleanText(anchor.textContent || '');
    const localFragment = anchor.dataset.chmLocalFragment || '';
    const disabled = anchor.getAttribute('aria-disabled') === 'true';
    if (!path && !localFragment && !disabled && !anchor.hasAttribute('href')) return;

    event.preventDefault();
    event.stopPropagation();

    if (disabled) return;
    clearTimeout(previewHoverTimer);
    previewGeneration += 1;
    previewCard.hidden = true;
    if (path) {
      if (matchMedia('(pointer: coarse)').matches) { void showPreview(path, fragment, name, linkLabel); return; }
      // Precise cross-reference links (page#fragment), such as spell compendia,
      // keep the source list open and open the referenced rule in a new tab.
      if (fragment) { openInternalLinkInNewTab(path, fragment, linkLabel, name); return; }
      void navigateTab(pane.tabId, path, fragment, name, true);
      return;
    }
    if (localFragment) {
      const decoded = (() => { try { return decodeURIComponent(localFragment); } catch { return localFragment; } })();
      const target = doc.getElementById(decoded) || doc.getElementsByName(decoded)?.[0];
      target?.scrollIntoView({ block: 'start', inline: 'nearest' });
    }
  }, true);
  doc.addEventListener('mouseover', (event) => {
    if (matchMedia('(pointer: coarse)').matches) return;
    const anchor = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-chm-path]') : null;
    if (!anchor?.dataset.chmPath) return;
    clearTimeout(previewHoverTimer);
    const linkLabel = anchor.dataset.chmLabel || cleanText(anchor.textContent || '');
    previewHoverTimer = setTimeout(() => void showPreview(anchor.dataset.chmPath, anchor.dataset.chmFragment || '', name, linkLabel), 330);
  });
  doc.addEventListener('mouseout', (event) => {
    const anchor = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-chm-path]') : null;
    if (!anchor) return;
    clearTimeout(previewHoverTimer);
  });
  doc.addEventListener('mouseup', () => captureSelection(name));
  pane.frame.contentWindow?.addEventListener('scroll', () => {
    clearTimeout(pane.scrollTimer);
    pane.scrollTimer = setTimeout(() => capturePane(name), 180);
  }, { passive: true });
  if (generation !== pane.generation) return;
}

async function loadPage(tabId, path, fragment, name, { push = true, restoreScroll = 0, searchQuery = null, searchOccurrence = null, jumpLabel = null } = {}) {
  if (!client || !book || !path) return;
  const pane = panes[name];
  const tab = getTab(tabId);
  selectionState = null; selectionBar.hidden = true;
  if (!tab) return;
  const normalized = normalizePath('/', path) || path;
  if (name === 'primary' && tabId === activeTabId) updateSearchScopes(normalized);
  if (push) {
    capturePane(name);
    const current = currentEntry(tab);
    const requestedSearch = String(searchQuery || '');
    const requestedOccurrence = Number.isFinite(searchOccurrence) ? Math.max(0, Math.floor(searchOccurrence)) : 0;
    if (!current || current.path.toLocaleLowerCase() !== normalized.toLocaleLowerCase() || (current.fragment || '') !== (fragment || '') || (current.searchQuery || '') !== requestedSearch || (current.searchOccurrence || 0) !== requestedOccurrence) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push({ path: normalized, fragment: fragment || '', searchQuery: requestedSearch, searchOccurrence: requestedOccurrence, jumpLabel: String(jumpLabel || ''), scrollY: 0, title: normalized.split('/').pop() || '规则' });
      tab.historyIndex = tab.history.length - 1;
    }
  }
  const entry = currentEntry(tab);
  pane.tabId = tabId;
  const generation = ++pane.generation;
  setPaneLoading(name, true, '正在按需解压规则页…');
  try {
    const result = await client.read(normalized, 128 * 1024 * 1024);
    if (generation !== pane.generation) return;
    const bytes = new Uint8Array(result.data);
    let source = decode(bytes, activeEncoding(bytes));
    if (/^text\/plain/i.test(result.mime) || /\.txt$/i.test(normalized)) source = plainTextHtml(source);
    const prepared = await prepareHtml(source, normalized, name, generation);
    if (generation !== pane.generation) { revokeUrls(prepared.urls); return; }
    const previous = pane.urls;
    entry.path = normalized; entry.fragment = fragment || '';
    if (searchQuery !== null) entry.searchQuery = String(searchQuery || '');
    if (searchOccurrence !== null) entry.searchOccurrence = Number.isFinite(searchOccurrence) ? Math.max(0, Math.floor(searchOccurrence)) : 0;
    if (jumpLabel !== null) entry.jumpLabel = String(jumpLabel || '');
    const effectiveJumpLabel = jumpLabel === null ? (entry.jumpLabel || '') : String(jumpLabel || '');
    entry.title = effectiveJumpLabel || prepared.title || entry.title || normalized.split('/').pop() || '规则';
    tab.title = entry.title;
    pane.title.textContent = entry.title;
    pane.frame.onload = () => {
      if (generation !== pane.generation) return;
      attachFrameInteractions(name, generation);
      const targetSearch = searchQuery === null ? (entry.searchQuery || '') : String(searchQuery || '');
      const targetOccurrence = searchOccurrence === null ? (entry.searchOccurrence || 0) : (Number.isFinite(searchOccurrence) ? Math.max(0, Math.floor(searchOccurrence)) : 0);
      const targetJumpLabel = jumpLabel === null ? (entry.jumpLabel || '') : String(jumpLabel || '');
      const located = targetSearch ? highlightSearchText(name, targetSearch, targetOccurrence) : false;
      const jumped = !located && fragment && targetJumpLabel ? focusJumpTarget(name, fragment, targetJumpLabel) : false;
      if (typeof jumped === 'string' && jumped) {
        entry.title = jumped;
        tab.title = jumped;
        pane.title.textContent = jumped;
      }
      if (!located && !jumped) scrollToPosition(name, fragment, restoreScroll ?? entry.scrollY ?? 0);
      revokeUrls(previous); pane.urls = prepared.urls; setPaneLoading(name, false);
      addRecent(normalized, entry.title);
      renderTabs(); updateHistoryButtons(); updateBookmarkButton();
      document.title = `${entry.title} · ${currentShelfRecord?.customTitle ? currentShelfRecord.title : (book.title || currentShelfRecord?.title || '规则书')} · RuleDesk`;
    };
    pane.frame.srcdoc = prepared.html;
  } catch (error) {
    if (generation !== pane.generation) return;
    setPaneLoading(name, false);
    showToast(`规则页打开失败：${error?.message || error}`, 'error', 6000);
  }
}

async function loadCurrentTab(name) {
  const pane = panes[name]; const tab = getTab(pane.tabId); const entry = currentEntry(tab);
  if (!entry) return;
  await loadPage(tab.id, entry.path, entry.fragment || '', name, { push: false, restoreScroll: entry.scrollY || 0 });
}

function navigateTab(tabId, path, fragment = '', name = 'primary', push = true, searchQuery = '', searchOccurrence = 0, jumpLabel = '') {
  return loadPage(tabId, path, fragment, name, { push, restoreScroll: 0, searchQuery, searchOccurrence, jumpLabel });
}

function navigateActive(path, fragment = '', searchQuery = '', searchOccurrence = 0) {
  sidebar.classList.remove('mobile-open');
  return navigateTab(activeTabId, path, fragment, 'primary', true, searchQuery, searchOccurrence);
}

function navigateHistory(delta) {
  const tab = getTab(activeTabId); if (!tab) return;
  const next = tab.historyIndex + delta; if (next < 0 || next >= tab.history.length) return;
  capturePane('primary'); tab.historyIndex = next; updateHistoryButtons();
  const entry = currentEntry(tab); if (entry) void loadPage(tab.id, entry.path, entry.fragment || '', 'primary', { push: false, restoreScroll: entry.scrollY || 0 });
}

function closeSplit() {
  capturePane('secondary');
  splitTabId = null; panes.secondary.tabId = null; panes.secondary.generation += 1;
  revokeUrls(panes.secondary.urls); panes.secondary.urls = new Set(); panes.secondary.frame.removeAttribute('srcdoc');
  secondaryPaneEl.hidden = true; desk.classList.remove('split'); splitBtn.textContent = '⇱ 分栏';
}

function openSplit(path = null, title = '对照规则', fragment = '', jumpLabel = '') {
  if (!path) {
    const tab = getTab(activeTabId); const entry = currentEntry(tab); if (!entry) return;
    const splitTab = createTab(entry.path, `${tab.title} · 对照`, false);
    splitTab.history[0].fragment = entry.fragment || ''; splitTab.history[0].scrollY = entry.scrollY || 0;
    splitTabId = splitTab.id;
  } else {
    const splitTab = createTab(path, title, false); if (splitTab.history[0]) { splitTab.history[0].fragment = fragment || ''; splitTab.history[0].jumpLabel = jumpLabel || ''; } splitTabId = splitTab.id;
  }
  panes.secondary.tabId = splitTabId; secondaryPaneEl.hidden = false; desk.classList.add('split'); splitBtn.textContent = '× 分栏';
  renderTabs(); void loadCurrentTab('secondary');
}

function toggleSplit() { if (splitTabId) closeSplit(); else openSplit(); }

async function showPreview(path, fragment = '', sourcePane = 'primary', jumpLabel = '') {
  if (!client || !path) return;
  const normalized = normalizePath('/', path) || path;
  const generation = ++previewGeneration;
  const cleanLabel = cleanText(jumpLabel || '');
  previewContext = { path: normalized, fragment, sourcePane, jumpLabel: cleanLabel };
  previewCard.hidden = false;
  previewOpen.textContent = fragment ? '新标签打开' : '打开';
  previewTab.hidden = Boolean(fragment);
  previewTitle.textContent = '正在读取规则…'; previewText.textContent = '';
  const cacheKey = `${normalized.toLocaleLowerCase()}#${String(fragment || '').toLocaleLowerCase()}`;
  const cached = previewCache.get(cacheKey);
  if (cached) { renderPreviewItem(cached); return; }
  try {
    const result = await client.read(normalized, 16 * 1024 * 1024);
    if (generation !== previewGeneration) return;
    const bytes = new Uint8Array(result.data);
    const html = decode(bytes, activeEncoding(bytes));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove());
    const focused = fragment ? fragmentPreview(doc, fragment, cleanLabel) : null;
    const item = focused || {
      title: cleanText(doc.title || normalized.split('/').pop() || '规则预览'),
      focus: '',
      text: cleanText(doc.body?.innerText || doc.body?.textContent || '').slice(0, 1600) || '这个页面没有可预览的纯文本内容。',
    };
    if (previewCache.size > 160) previewCache.delete(previewCache.keys().next().value);
    previewCache.set(cacheKey, item);
    renderPreviewItem(item);
  } catch (error) {
    if (generation !== previewGeneration) return;
    previewTitle.textContent = '预览失败'; previewText.textContent = error?.message || String(error);
  }
}

function openPreviewNormally() {
  if (!previewContext) return;
  const { path, fragment, sourcePane, jumpLabel } = previewContext;
  previewCard.hidden = true;
  if (fragment) { openInternalLinkInNewTab(path, fragment, jumpLabel || previewTitle.textContent, sourcePane); return; }
  const pane = panes[sourcePane] || panes.primary;
  void navigateTab(pane.tabId, path, fragment, sourcePane, true, '', 0, jumpLabel || '');
}

function openPreviewTab() {
  if (!previewContext) return;
  const { path, fragment, jumpLabel } = previewContext;
  const title = jumpLabel || previewTitle.textContent || '规则';
  previewCard.hidden = true;
  openInternalLinkInNewTab(path, fragment, title);
}

function openPreviewSplit() {
  if (!previewContext) return;
  if (splitTabId) closeSplit();
  openSplit(previewContext.path, previewTitle.textContent || '对照规则', previewContext.fragment || '', previewContext.jumpLabel || previewTitle.textContent || '');
  previewCard.hidden = true;
}

function refreshVisiblePanes() {
  capturePane('primary'); capturePane('secondary');
  if (panes.primary.tabId) void loadCurrentTab('primary');
  if (splitTabId && panes.secondary.tabId) void loadCurrentTab('secondary');
}

async function openFile(file, options = {}) {
  if (!file) return;
  if (!/\.chm$/i.test(file.name)) { showToast('请选择 .chm 规则书', 'error'); return; }
  destroySession();
  currentFile = file;
  currentHandle = options.handle || null;
  currentBookId = bookIdForFile(file);
  currentShelfRecord = options.shelfRecord || await getBookRecord(currentBookId).catch(() => null);
  setOverlay(true, '正在打开规则书', `正在读取 ${formatBytes(file.size)} 的目录和索引…`);
  try {
    client = new WorkerClient((progress) => {
      if (progress.phase === 'search') searchStatus.textContent = `正在「${getActiveSearchScope().label}」中扫描正文 ${progress.current}/${progress.total || '?'}…`;
    });
    book = await client.open(file);
    if (!book?.defaultPath && !book?.spine?.length) throw new Error('CHM 中没有找到可阅读的规则页面');
    bookKey = stableHash(`${file.name}|${file.size}|${file.lastModified}`);
    bookmarks = getStorageArray('bookmarks'); recent = getStorageArray('recent');
    bookTitle.textContent = currentShelfRecord?.customTitle ? currentShelfRecord.title : (book.title || currentShelfRecord?.title || file.name);

    if (currentShelfRecord) {
      currentShelfRecord = await patchBookRecord(currentShelfRecord.id, {
        title: currentShelfRecord.customTitle ? currentShelfRecord.title : (book.title || currentShelfRecord.title),
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        encoding: book.encoding,
        compression: Boolean(book.compression),
        pageCount: book.spine?.length || book.docs?.length || 0,
        docCount: book.docs?.length || 0,
        lastOpened: Date.now(),
        handle: options.handle || currentShelfRecord.handle,
      }) || currentShelfRecord;
    }

    updateBookMetaDisplay();
    renderToc(book.toc || []); renderIndex(book.index || []); renderBookmarks(); renderRecent();
    landing.hidden = true; workspace.hidden = false; setOverlay(false);
    document.body.classList.add('reading-mode');
    document.body.classList.remove('sidebar-hidden', 'mobile-tools-open');
    mobileToolsBtn?.setAttribute('aria-expanded', 'false');
    sidebar.classList.remove('mobile-open');
    const start = book.defaultPath || book.spine?.[0]?.local || book.docs?.[0];
    const tab = createTab(start, currentShelfRecord?.customTitle ? currentShelfRecord.title : (book.title || '规则书'), true);
    panes.primary.tabId = tab.id;
    await loadCurrentTab('primary');

    if (options.rememberHandle && options.handle) {
      try {
        await saveCurrentHandleToShelf(options.handle);
      } catch (error) {
        console.warn('无法保存桌面文件句柄，改用可选离线副本：', error);
        shelfPrompt.hidden = false;
        showToast('规则书已打开，但浏览器无法记住原文件。可选择保存离线副本。', 'info', 6500);
      }
    } else if (currentShelfRecord) {
      await seedBookTerms(currentShelfRecord.id, book).catch(() => {});
      await refreshLibrary();
      if (currentShelfRecord.indexState !== 'ready') void startPersistentIndex(currentShelfRecord, file);
    } else {
      pendingShelfFile = file;
      shelfPrompt.hidden = false;
    }

    if (file.size >= 200 * 1024 * 1024) showToast('大规则书已启用切片读取；桌面 Chrome / Edge 通常最稳定。', 'info', 6000);
  } catch (error) {
    setOverlay(false); const message = error?.message || String(error); destroySession(); workspace.hidden = true; landing.hidden = false;
    document.body.classList.remove('reading-mode', 'mobile-tools-open');
    mobileToolsBtn?.setAttribute('aria-expanded', 'false');
    showToast(`规则书打开失败：${message}`, 'error', 8000);
  }
}

pickBtn.addEventListener('click', () => void chooseFile());
anotherBtn.addEventListener('click', () => void chooseFile());
shelfBtn.addEventListener('click', () => { goHome(); void refreshLibrary(); });
homeBtn.addEventListener('click', goHome);
setDefaultBtn.addEventListener('click', () => { localStorage.setItem(DEFAULT_MODE_KEY, 'ruledesk'); showToast('已将 RuleDesk 设为默认模式'); });
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; fileInput.value = ''; if (file) void openFile(file); });
shelfSaveBtn.addEventListener('click', () => void saveCurrentOfflineShelf());
shelfSkipBtn.addEventListener('click', () => { shelfPrompt.hidden = true; pendingShelfFile = null; });
sidebarBtn.addEventListener('click', () => {
  if (usesCompactChrome()) sidebar.classList.toggle('mobile-open');
  else document.body.classList.toggle('sidebar-hidden');
});
mobileToolsBtn?.addEventListener('click', () => {
  if (!usesCompactChrome()) return;
  const open = document.body.classList.toggle('mobile-tools-open');
  mobileToolsBtn.setAttribute('aria-expanded', String(open));
  mobileToolsBtn.setAttribute('aria-label', open ? '收起更多工具' : '显示更多工具');
  mobileToolsBtn.title = open ? '收起更多工具' : '显示更多工具';
});
searchBtn.addEventListener('click', () => {
  if (workspace.hidden) return;
  globalSearchForm.classList.add('mobile-search-open');
  globalSearchInput.focus();
  globalSearchInput.select();
  showSearchScopeMenu();
});
historyBackBtn.addEventListener('click', () => navigateHistory(-1));
historyForwardBtn.addEventListener('click', () => navigateHistory(1));
bookmarkBtn.addEventListener('click', toggleBookmark);
copyBtn.addEventListener('click', () => void copyRuleCard());
selectionCopyBtn.addEventListener('click', () => void copyRuleCard());
splitBtn.addEventListener('click', toggleSplit);
closeSplitBtn.addEventListener('click', closeSplit);
newTabBtn.addEventListener('click', () => {
  const current = currentEntry(getTab(activeTabId));
  const tab = createTab(current?.path || book?.defaultPath, '新标签', true);
  if (tab.history[0] && current) { tab.history[0].fragment = current.fragment || ''; tab.history[0].scrollY = current.scrollY || 0; }
  void loadCurrentTab('primary');
});

themeSelect.addEventListener('change', () => { readerSettings.theme = themeSelect.value; applyAppTheme(); saveSettings(); refreshVisiblePanes(); });
fontDownBtn.addEventListener('click', () => { readerSettings.fontScale = Math.max(80, readerSettings.fontScale - 10); fontLabel.textContent = `${readerSettings.fontScale}%`; saveSettings(); refreshVisiblePanes(); });
fontUpBtn.addEventListener('click', () => { readerSettings.fontScale = Math.min(160, readerSettings.fontScale + 10); fontLabel.textContent = `${readerSettings.fontScale}%`; saveSettings(); refreshVisiblePanes(); });

document.querySelectorAll('.side-tab').forEach((tab) => tab.addEventListener('click', () => switchSide(tab.dataset.side)));
tocFilter.addEventListener('input', () => filterSideList(tocList, tocFilter.value));
indexFilter.addEventListener('input', () => filterSideList(indexList, indexFilter.value));

globalSearchInput.addEventListener('input', () => {
  const q = globalSearchInput.value.trim();
  switchSide('search');
  searchGeneration += 1;
  if (!q) {
    searchScopeMenu.hidden = true;
    globalSearchResults.replaceChildren();
    searchStatus.textContent = '输入关键词后，可从当前目录逐级扩大到整本规则书。';
    return;
  }
  showSearchScopeMenu();
  const scope = getActiveSearchScope();
  renderSearch(localSearch(q, scope));
  searchStatus.textContent = q.length >= 2
    ? `当前范围：${scope.label}。选择搜索栏下方的目录层级，或按 Enter 搜索正文。`
    : `当前范围：${scope.label}。继续输入，至少 2 个字符可搜索正文。`;
});
globalSearchInput.addEventListener('focus', showSearchScopeMenu);
globalSearchInput.addEventListener('blur', () => { setTimeout(() => { searchScopeMenu.hidden = true; }, 120); });
globalSearchForm.addEventListener('submit', (event) => { event.preventDefault(); searchScopeMenu.hidden = true; void runFullSearch(globalSearchInput.value); });

previewClose.addEventListener('click', () => { previewGeneration += 1; previewCard.hidden = true; });
previewOpen.addEventListener('click', openPreviewNormally);
previewTab.addEventListener('click', openPreviewTab);
previewSplit.addEventListener('click', openPreviewSplit);

for (const target of [document.body, dropZone]) {
  target.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth += 1; document.body.classList.add('dragging'); });
  target.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  target.addEventListener('dragleave', (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  target.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); const file = event.dataTransfer?.files?.[0]; if (file) void openFile(file); });
}

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (workspace.hidden) return; if (usesCompactChrome()) globalSearchForm.classList.add('mobile-search-open'); globalSearchInput.focus(); globalSearchInput.select(); showSearchScopeMenu(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); void chooseFile(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && !workspace.hidden) { event.preventDefault(); toggleBookmark(); }
  if (event.altKey && event.key === 'ArrowLeft' && !workspace.hidden) { event.preventDefault(); navigateHistory(-1); }
  if (event.altKey && event.key === 'ArrowRight' && !workspace.hidden) { event.preventDefault(); navigateHistory(1); }
  if (event.key === 'Escape') { sidebar.classList.remove('mobile-open'); globalSearchForm.classList.remove('mobile-search-open'); searchScopeMenu.hidden = true; previewCard.hidden = true; selectionBar.hidden = true; selectionState = null; document.body.classList.remove('mobile-tools-open'); mobileToolsBtn?.setAttribute('aria-expanded', 'false'); }
});
window.addEventListener('beforeunload', () => { capturePane('primary'); capturePane('secondary'); destroySession(); });

syncAdaptiveChrome();
window.addEventListener('resize', syncAdaptiveChrome);
void refreshLibrary();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch((error) => console.warn('RuleDesk Service Worker:', error));
  }, { once: true });
}
