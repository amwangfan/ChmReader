import {
  decode,
  detectEncoding,
  normalizePath,
  fragmentOf,
  isExternal,
} from './engine/codec.js';

const $ = (id) => document.getElementById(id);

const landing = $('landing');
const reader = $('reader');
const homeBtn = $('homeBtn');
const pickBtn = $('pickBtn');
const anotherBtn = $('anotherBtn');
const fileInput = $('fileInput');
const dropZone = $('dropZone');
const sidebarBtn = $('sidebarBtn');
const sidebar = $('sidebar');
const docTitle = $('docTitle');
const docMeta = $('docMeta');
const prevBtn = $('prevBtn');
const nextBtn = $('nextBtn');
const encodingSelect = $('encodingSelect');
const tocPanel = $('tocPanel');
const indexPanel = $('indexPanel');
const searchPanel = $('searchPanel');
const tocFilter = $('tocFilter');
const indexFilter = $('indexFilter');
const tocList = $('tocList');
const indexList = $('indexList');
const searchForm = $('searchForm');
const searchInput = $('searchInput');
const searchList = $('searchList');
const contentFrame = $('contentFrame');
const pageLoading = $('pageLoading');
const loadingText = $('loadingText');
const overlay = $('overlay');
const overlayTitle = $('overlayTitle');
const overlayText = $('overlayText');
const toast = $('toast');

const modeModal = $('modeModal');
const defaultModeBtn = $('defaultModeBtn');
const chooseNormalMode = $('chooseNormalMode');
const chooseRuleMode = $('chooseRuleMode');
const DEFAULT_MODE_KEY = 'chm-preview-default-mode-v1';

function showModeChooser() { modeModal.hidden = false; }
function hideModeChooser() { modeModal.hidden = true; }
function chooseDefaultMode(mode) {
  localStorage.setItem(DEFAULT_MODE_KEY, mode);
  hideModeChooser();
  if (mode === 'ruledesk') location.href = './ruledesk/';
}

const modeParams = new URLSearchParams(location.search);
const savedDefaultMode = localStorage.getItem(DEFAULT_MODE_KEY);
if (!modeParams.has('stay') && savedDefaultMode === 'ruledesk') {
  location.replace('./ruledesk/');
} else if (!savedDefaultMode && !modeParams.has('stay')) {
  showModeChooser();
}
defaultModeBtn?.addEventListener('click', showModeChooser);
chooseNormalMode?.addEventListener('click', () => chooseDefaultMode('normal'));
chooseRuleMode?.addEventListener('click', () => chooseDefaultMode('ruledesk'));

let client = null;
let currentFile = null;
let book = null;
let currentPath = null;
let currentSpineIndex = -1;
let pageGeneration = 0;
let currentPageUrls = new Set();
let dragDepth = 0;
let tocContextMenu = null;

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
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

function setPageLoading(visible, text = '正在读取页面…') {
  pageLoading.hidden = !visible;
  loadingText.textContent = text;
}

function revokeUrls(urls) {
  for (const url of urls || []) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  urls?.clear?.();
}

class WorkerClient {
  constructor(onProgress) {
    this.worker = new Worker(new URL('./chm-worker.js', import.meta.url), {
      type: 'module',
      name: 'chm-local-reader',
    });
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
    this.onProgress = onProgress;

    this.worker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'progress' && message.id === 0) {
        this.onProgress?.(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || 'CHM Worker 请求失败'));
    });

    this.worker.addEventListener('error', (event) => {
      this.failAll(new Error(event.message || 'CHM Web Worker 加载失败'));
    });

    this.worker.addEventListener('messageerror', () => {
      this.failAll(new Error('浏览器无法解析 CHM Worker 返回的数据'));
    });
  }

  failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  request(type, payload = {}, timeoutMs = 300000) {
    if (this.closed) return Promise.reject(new Error('CHM 会话已关闭'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} 操作超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  async open(file) {
    return (await this.request('open', { file }, 300000)).book;
  }

  async read(path, maxBytes = 256 * 1024 * 1024) {
    return this.request('read', { path, maxBytes }, 180000);
  }

  async search(query, limit = 80) {
    return (await this.request('search', { query, limit }, 600000)).hits;
  }

  dropCaches() {
    return this.request('dropCaches').catch(() => {});
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new DOMException('CHM 会话已关闭', 'AbortError'));
    this.worker.terminate();
  }
}

function destroySession() {
  pageGeneration += 1;
  client?.destroy();
  client = null;
  currentFile = null;
  book = null;
  currentPath = null;
  currentSpineIndex = -1;
  revokeUrls(currentPageUrls);
  currentPageUrls = new Set();
  contentFrame.removeAttribute('srcdoc');
  tocList.replaceChildren();
  indexList.replaceChildren();
  searchList.replaceChildren();
  fileInput.value = '';
  document.title = 'CHM Preview';
}

function goHome() {
  destroySession();
  reader.hidden = true;
  landing.hidden = false;
  sidebar.classList.remove('mobile-open');
  document.body.classList.remove('sidebar-hidden');
  setOverlay(false);
  setPageLoading(false);
}

function activeEncoding(bytes) {
  if (encodingSelect.value) return encodingSelect.value;
  const sniffed = detectEncoding(bytes);
  if (sniffed && sniffed !== 'windows-1252') return sniffed;
  return book?.encoding || sniffed || 'utf-8';
}

function plainTextHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><pre>${escaped}</pre></body></html>`;
}

function refInfo(basePath, raw) {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'blocked' };
  if (value.startsWith('#')) return { kind: 'fragment', fragment: fragmentOf(value) };
  if (/^data:image\/(?:avif|bmp|gif|jpeg|jpg|png|webp);/i.test(value)) {
    return { kind: 'data', url: value };
  }
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
        else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#') && !/^data:image\//i.test(value)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return '';
  }
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
  matches.forEach((match, i) => {
    out += source.slice(cursor, match.index) + replacements[i];
    cursor = match.index + match[0].length;
  });
  return out + source.slice(cursor);
}

async function prepareHtml(rawHtml, basePath, generation) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const urls = new Set();
  const promises = new Map();

  const loadResource = async (requestedPath) => {
    const normalized = normalizePath('/', requestedPath);
    if (!normalized || generation !== pageGeneration) return null;
    if (promises.has(normalized.toLocaleLowerCase())) return promises.get(normalized.toLocaleLowerCase());

    const promise = (async () => {
      try {
        const result = await client.read(normalized, 128 * 1024 * 1024);
        if (generation !== pageGeneration) return null;
        const bytes = new Uint8Array(result.data);
        let blob;

        if (/^text\/css/i.test(result.mime)) {
          const css = decode(bytes, activeEncoding(bytes));
          const rewritten = await rewriteCss(css, normalized, loadResource);
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
      } catch {
        return null;
      }
    })();

    promises.set(normalized.toLocaleLowerCase(), promise);
    return promise;
  };

  doc.querySelectorAll(
    'script,noscript,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,option,base,template'
  ).forEach((el) => el.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach((el) => el.remove());

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ['srcdoc', 'ping', 'formaction', 'integrity', 'crossorigin', 'target'].includes(name)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  for (const el of [...doc.querySelectorAll('a[href],area[href]')]) {
    const raw = el.getAttribute('href') || '';
    const ref = refInfo(basePath, raw);
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
    } else {
      el.setAttribute('href', '#');
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('title', '出于安全考虑，外部/主动链接已禁用');
    }
  }

  for (const el of [...doc.querySelectorAll('link[href]')]) {
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const ref = refInfo(basePath, el.getAttribute('href') || '');
    if (!rel.includes('stylesheet') || ref.kind !== 'internal') {
      el.remove();
      continue;
    }
    const url = await loadResource(ref.path);
    if (url) el.setAttribute('href', url);
    else el.remove();
  }

  const resourceAttrs = [
    ['img', 'src'], ['source', 'src'], ['audio', 'src'], ['video', 'src'], ['video', 'poster'],
    ['track', 'src'], ['body', 'background'], ['table', 'background'], ['td', 'background'], ['th', 'background'],
    ['image', 'href'], ['image', 'xlink:href'], ['use', 'href'], ['use', 'xlink:href'],
  ];

  for (const [selector, attr] of resourceAttrs) {
    for (const el of [...doc.querySelectorAll(`${selector}[${CSS.escape(attr)}]`)]) {
      const raw = el.getAttribute(attr) || '';
      const ref = refInfo(basePath, raw);
      if (ref.kind === 'data') {
        el.setAttribute(attr, ref.url);
      } else if (ref.kind === 'fragment') {
        el.setAttribute(attr, `#${ref.fragment}`);
      } else if (ref.kind === 'internal') {
        const url = await loadResource(ref.path);
        if (url) el.setAttribute(attr, url);
        else el.removeAttribute(attr);
      } else {
        el.removeAttribute(attr);
      }
    }
  }

  doc.querySelectorAll('[srcset]').forEach((el) => el.removeAttribute('srcset'));

  for (const style of [...doc.querySelectorAll('style')]) {
    style.textContent = await rewriteCss(style.textContent || '', basePath, loadResource);
  }
  for (const el of [...doc.querySelectorAll('[style]')]) {
    el.setAttribute('style', await rewriteCss(el.getAttribute('style') || '', basePath, loadResource));
  }

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline' blob:",
    'img-src data: blob:',
    'font-src data: blob:',
    'media-src data: blob:',
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  doc.head.prepend(csp);

  const readerStyle = doc.createElement('style');
  readerStyle.textContent = `
    html,body{min-height:100%;margin:0}
    body{box-sizing:border-box;padding:22px 26px;background:#fff;color:#20201d;overflow-wrap:anywhere}
    img,svg,video,table{max-width:100%}
    pre{white-space:pre-wrap;word-break:break-word}
    a[aria-disabled="true"]{cursor:not-allowed;text-decoration:line-through;color:inherit}
    mark.chm-search-hit{background:#ffe36e;color:inherit;border-radius:3px;padding:0 .06em;box-shadow:0 0 0 2px rgba(180,130,0,.12)}
    @media(max-width:720px){body{padding:16px}}
  `;
  doc.head.append(readerStyle);

  return {
    html: `<!doctype html>${doc.documentElement.outerHTML}`,
    title: doc.title || '',
    urls,
  };
}

function highlightSearchText(query, occurrenceIndex = 0) {
  const q = String(query || '').trim();
  if (!q) return false;
  let doc;
  try { doc = contentFrame.contentDocument; } catch { return false; }
  if (!doc?.body) return false;
  for (const mark of [...doc.querySelectorAll('mark.chm-search-hit')]) mark.replaceWith(...mark.childNodes);
  doc.body.normalize();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.data || parent.closest('script,style,noscript,template')) return NodeFilter.FILTER_REJECT;
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
  let firstMark = null;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (!segment.node.parentNode || segment.end <= segment.start) continue;
    const matched = segment.node.splitText(segment.start);
    matched.splitText(segment.end - segment.start);
    const mark = doc.createElement('mark');
    mark.className = 'chm-search-hit';
    mark.dataset.searchOccurrence = String(wanted + 1);
    matched.parentNode.replaceChild(mark, matched);
    mark.append(matched);
    firstMark = mark;
  }
  if (!firstMark) return false;
  try { firstMark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch { firstMark.scrollIntoView(); }
  return true;
}

function scrollToFragment(fragment) {
  if (!fragment) return;
  try {
    const doc = contentFrame.contentDocument;
    const decoded = (() => { try { return decodeURIComponent(fragment); } catch { return fragment; } })();
    const target = doc?.getElementById(decoded) || doc?.getElementsByName(decoded)?.[0];
    target?.scrollIntoView({ block: 'start' });
  } catch {}
}

function updateNavButtons() {
  const spine = book?.spine || [];
  const folded = (currentPath || '').toLocaleLowerCase();
  currentSpineIndex = spine.findIndex((item) => (item.local || '').toLocaleLowerCase() === folded);
  prevBtn.disabled = currentSpineIndex <= 0;
  nextBtn.disabled = currentSpineIndex < 0 || currentSpineIndex >= spine.length - 1;

  document.querySelectorAll('.nav-item.active').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-path]').forEach((el) => {
    if ((el.dataset.path || '').toLocaleLowerCase() === folded) el.classList.add('active');
  });
}

async function openTopic(path, fragment = '', searchQuery = '', searchOccurrence = 0) {
  if (!client || !book || !path) return;
  const normalized = normalizePath('/', path) || path;

  if (currentPath?.toLocaleLowerCase() === normalized.toLocaleLowerCase() && (fragment || searchQuery)) {
    if (searchQuery && highlightSearchText(searchQuery, searchOccurrence)) return;
    scrollToFragment(fragment);
    return;
  }

  const generation = ++pageGeneration;
  setPageLoading(true, '正在按需解压页面…');

  try {
    const result = await client.read(normalized, 128 * 1024 * 1024);
    if (generation !== pageGeneration) return;
    const bytes = new Uint8Array(result.data);
    const encoding = activeEncoding(bytes);
    let source = decode(bytes, encoding);
    if (/^text\/plain/i.test(result.mime) || /\.txt$/i.test(normalized)) source = plainTextHtml(source);

    const prepared = await prepareHtml(source, normalized, generation);
    if (generation !== pageGeneration) {
      revokeUrls(prepared.urls);
      return;
    }

    const previousUrls = currentPageUrls;
    currentPath = normalized;
    updateNavButtons();

    contentFrame.onload = () => {
      if (generation !== pageGeneration) return;
      try {
        const frameDoc = contentFrame.contentDocument;
        frameDoc?.addEventListener('click', (event) => {
          const target = event.target && typeof event.target.closest === 'function' ? event.target.closest('a,area') : null;
          if (!target) return;
          const nextPath = target.dataset.chmPath || '';
          const nextFragment = target.dataset.chmFragment || '';
          const localFragment = target.dataset.chmLocalFragment || '';
          const disabled = target.getAttribute('aria-disabled') === 'true';
          if (!nextPath && !localFragment && !disabled && !target.hasAttribute('href')) return;

          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          if (nextPath) { void openTopic(nextPath, nextFragment); return; }
          if (localFragment) {
            const decoded = (() => { try { return decodeURIComponent(localFragment); } catch { return localFragment; } })();
            const destination = frameDoc.getElementById(decoded) || frameDoc.getElementsByName(decoded)?.[0];
            destination?.scrollIntoView({ block: 'start', inline: 'nearest' });
          }
        }, true);
      } catch {}
      const located = searchQuery ? highlightSearchText(searchQuery, searchOccurrence) : false;
      if (!located) scrollToFragment(fragment);
      revokeUrls(previousUrls);
      currentPageUrls = prepared.urls;
      setPageLoading(false);
    };

    contentFrame.srcdoc = prepared.html;
    if (prepared.title) document.title = `${prepared.title} · ${book.title}`;
    else document.title = `${book.title} · CHM Preview`;
  } catch (error) {
    if (generation !== pageGeneration) return;
    setPageLoading(false);
    showToast(`页面打开失败：${error?.message || error}`, 'error', 6000);
  }
}

function nodeButton(node, depth = 0) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-item';
  button.textContent = node.name || node.local || '(未命名)';
  button.style.paddingLeft = `${8 + Math.min(depth, 8) * 8}px`;
  if (node.local) button.dataset.path = node.local;
  button.addEventListener('click', () => node.local && openTopic(node.local, '', button.dataset.searchQuery || '', Number(button.dataset.searchOccurrence || 0)));
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
  const maxNodes = 20000;

  const appendNodes = (nodes, parent, depth = 0) => {
    for (const node of nodes || []) {
      if (rendered++ >= maxNodes) return;
      if (node.children?.length) {
        const details = document.createElement('details');
        details.className = 'nav-group';
        details.dataset.tocName = node.name || '目录';

        const summary = document.createElement('summary');
        summary.dataset.depth = String(depth);
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
            void openTopic(node.local);
          });
        } else {
          label = document.createElement('span');
          label.className = 'nav-label nav-label-static';
        }
        label.textContent = node.name || '(未命名)';
        summary.append(toggle, label);

        const children = document.createElement('div');
        children.className = 'nav-children';
        appendNodes(node.children, children, depth + 1);
        details.append(summary, children);
        parent.append(details);
      } else {
        const leaf = nodeButton(node, depth);
        leaf.addEventListener('contextmenu', (event) => openTocContextMenu(event, null));
        parent.append(leaf);
      }
    }
  };

  appendNodes(tree, tocList);
  if (!tocList.childElementCount) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '这个 CHM 没有可显示的目录。';
    tocList.append(note);
  } else if (rendered >= maxNodes) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = `目录项目过多，界面只渲染前 ${maxNodes.toLocaleString()} 项。`;
    tocList.append(note);
  }
}

function renderIndex(items) {
  indexList.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const item of (items || []).slice(0, 20000)) {
    const path = item.targets?.[0];
    if (!path) continue;
    const button = nodeButton({ name: item.name, local: path });
    fragment.append(button);
  }
  indexList.append(fragment);
  if (!indexList.childElementCount) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '这个 CHM 没有关键词索引。';
    indexList.append(note);
  }
}

function filterList(container, value) {
  const q = value.trim().toLocaleLowerCase();
  container.querySelectorAll('.nav-item').forEach((el) => {
    el.hidden = q && !el.textContent.toLocaleLowerCase().includes(q);
  });
  container.querySelectorAll('.nav-group').forEach((group) => {
    if (!q) {
      group.hidden = false;
      return;
    }
    const own = group.querySelector(':scope > summary')?.textContent.toLocaleLowerCase().includes(q);
    const childMatch = [...group.querySelectorAll('.nav-item')].some((el) => !el.hidden);
    group.hidden = !(own || childMatch);
    if (own || childMatch) group.open = true;
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  tocPanel.classList.toggle('active', name === 'toc');
  indexPanel.classList.toggle('active', name === 'index');
  searchPanel.classList.toggle('active', name === 'search');
}

async function openFile(file) {
  if (!file) return;
  if (!/\.chm$/i.test(file.name)) {
    showToast('请选择 .chm 文件', 'error');
    return;
  }

  destroySession();
  currentFile = file;
  setOverlay(true, '正在打开 CHM', `正在读取 ${formatBytes(file.size)} 的目录结构…`);

  try {
    client = new WorkerClient((progress) => {
      if (progress.phase === 'search') {
        const total = progress.total || 0;
        overlayText.textContent = total ? `正在搜索 ${progress.current}/${total} 个页面…` : '正在搜索正文…';
      }
    });

    book = await client.open(file);
    if (!book?.defaultPath && !book?.spine?.length) throw new Error('CHM 中没有找到可阅读的 HTML 页面');

    docTitle.textContent = book.title || file.name;
    docMeta.textContent = `${formatBytes(file.size)} · ${book.entryCount.toLocaleString()} 项 · ${book.compression ? 'LZX' : '未压缩'} · ${book.encoding}`;
    encodingSelect.value = '';
    renderToc(book.toc || []);
    renderIndex(book.index || []);

    document.body.classList.remove('sidebar-hidden');
    sidebar.classList.remove('mobile-open');
    landing.hidden = true;
    reader.hidden = false;
    setOverlay(false);

    if (file.size >= 1024 * 1024 * 1024) {
      showToast('这是超大 CHM（≥1 GiB）。读取采用切片方式，但浏览器/设备本身仍可能有内存限制。', 'info', 8000);
    } else if (file.size >= 200 * 1024 * 1024) {
      showToast('大文件已启用按需读取；桌面版 Chrome / Edge 通常更稳定。', 'info', 6000);
    }

    const start = book.defaultPath || book.spine?.[0]?.local || book.docs?.[0];
    if (start) await openTopic(start);
  } catch (error) {
    setOverlay(false);
    const message = error?.message || String(error);
    destroySession();
    reader.hidden = true;
    landing.hidden = false;
    showToast(`CHM 打开失败：${message}`, 'error', 8000);
  }
}

pickBtn.addEventListener('click', () => fileInput.click());
anotherBtn.addEventListener('click', () => fileInput.click());
homeBtn.addEventListener('click', goHome);
fileInput.addEventListener('change', () => openFile(fileInput.files?.[0]));

sidebarBtn.addEventListener('click', () => {
  if (window.matchMedia('(max-width: 700px)').matches) {
    sidebar.classList.toggle('mobile-open');
  } else {
    document.body.classList.toggle('sidebar-hidden');
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

tocFilter.addEventListener('input', () => filterList(tocList, tocFilter.value));
indexFilter.addEventListener('input', () => filterList(indexList, indexFilter.value));

prevBtn.addEventListener('click', () => {
  const target = book?.spine?.[currentSpineIndex - 1]?.local;
  if (target) void openTopic(target);
});
nextBtn.addEventListener('click', () => {
  const target = book?.spine?.[currentSpineIndex + 1]?.local;
  if (target) void openTopic(target);
});

encodingSelect.addEventListener('change', () => {
  if (currentPath) void openTopic(currentPath);
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = searchInput.value.trim();
  if (q.length < 2) {
    showToast('请输入至少 2 个字符');
    return;
  }
  if (!client) return;
  searchList.innerHTML = '<p class="empty-note">正在搜索正文…</p>';
  try {
    const hits = await client.search(q, 80);
    searchList.replaceChildren();
    let rendered = 0;
    for (const hit of hits) {
      const matches = Array.isArray(hit.matches) && hit.matches.length ? hit.matches : [{ occurrenceIndex: hit.occurrenceIndex || 0, snippet: hit.snippet || '' }];
      const total = Number.isFinite(hit.occurrenceTotal) ? hit.occurrenceTotal : matches.length;
      for (const match of matches) {
        if (rendered >= 180) break;
        const occurrence = Number.isFinite(match.occurrenceIndex) ? match.occurrenceIndex : 0;
        const button = nodeButton({ name: hit.title || hit.path, local: hit.path });
        button.dataset.searchQuery = q;
        button.dataset.searchOccurrence = String(occurrence);
        const meta = document.createElement('span');
        meta.className = 'match-meta';
        meta.textContent = `第 ${occurrence + 1}/${total} 处`;
        button.append(meta);
        if (match.snippet) {
          const span = document.createElement('span');
          span.className = 'snippet';
          span.textContent = match.snippet;
          button.append(span);
        }
        searchList.append(button);
        rendered += 1;
      }
      if (rendered >= 180) break;
    }
    if (!hits.length) searchList.innerHTML = '<p class="empty-note">没有找到匹配内容。</p>';
  } catch (error) {
    searchList.innerHTML = '<p class="empty-note">搜索失败。</p>';
    showToast(`搜索失败：${error?.message || error}`, 'error');
  }
});

for (const target of [document.body, dropZone]) {
  target.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add('dragging');
  });
  target.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  target.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void openFile(file);
  });
}

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    fileInput.click();
  }
  if (event.key === 'Escape' && !reader.hidden) sidebar.classList.remove('mobile-open');
});

window.addEventListener('beforeunload', destroySession);
