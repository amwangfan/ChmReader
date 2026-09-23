const DB_NAME = 'ruledesk-library-v1';
const DB_VERSION = 2;

let dbPromise = null;

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

export function openLibraryDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: ['bookId', 'path'] });
        pages.createIndex('byBook', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('terms')) {
        const terms = db.createObjectStore('terms', { keyPath: ['bookId', 'termId'] });
        terms.createIndex('byBook', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'bookId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开 RuleDesk 本地书架'));
  });
  return dbPromise;
}

export async function listBooks() {
  const db = await openLibraryDB();
  const tx = db.transaction('books', 'readonly');
  const rows = await requestAsPromise(tx.objectStore('books').getAll());
  await transactionDone(tx);
  return rows.sort((a, b) => (b.lastOpened || b.addedAt || 0) - (a.lastOpened || a.addedAt || 0));
}

export async function getBookRecord(id) {
  const db = await openLibraryDB();
  const tx = db.transaction('books', 'readonly');
  const row = await requestAsPromise(tx.objectStore('books').get(id));
  await transactionDone(tx);
  return row || null;
}

export async function putBookRecord(record) {
  const db = await openLibraryDB();
  const tx = db.transaction('books', 'readwrite');
  tx.objectStore('books').put(record);
  await transactionDone(tx);
  return record;
}

export async function patchBookRecord(id, patch) {
  const old = await getBookRecord(id);
  if (!old) return null;
  const next = { ...old, ...patch, id };
  await putBookRecord(next);
  return next;
}

export async function putBookFile(bookId, file) {
  if (!bookId || !(file instanceof Blob)) throw new Error('无法保存规则书文件');
  const db = await openLibraryDB();
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').put({
    bookId,
    blob: file,
    name: file.name || 'rules.chm',
    type: file.type || 'application/vnd.ms-htmlhelp',
    lastModified: Number(file.lastModified || Date.now()),
    size: Number(file.size || 0),
  });
  await transactionDone(tx);
}

export async function getBookFile(bookId) {
  const db = await openLibraryDB();
  const tx = db.transaction('files', 'readonly');
  const row = await requestAsPromise(tx.objectStore('files').get(bookId));
  await transactionDone(tx);
  if (!row?.blob) return null;
  return row.blob instanceof File ? row.blob : new File([row.blob], row.name || 'rules.chm', {
    type: row.type || 'application/vnd.ms-htmlhelp',
    lastModified: row.lastModified || Date.now(),
  });
}

export async function deleteBookFile(bookId) {
  const db = await openLibraryDB();
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').delete(bookId);
  await transactionDone(tx);
}

async function deleteByBookIndex(store, bookId) {
  const index = store.index('byBook');
  await new Promise((resolve, reject) => {
    const req = index.openKeyCursor(IDBKeyRange.only(bookId));
    req.onerror = () => reject(req.error || new Error('删除索引失败'));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}


export async function clearBookPages(bookId) {
  const db = await openLibraryDB();
  const tx = db.transaction('pages', 'readwrite');
  await deleteByBookIndex(tx.objectStore('pages'), bookId);
  await transactionDone(tx);
}

export async function clearBookIndex(bookId) {
  const db = await openLibraryDB();
  const tx = db.transaction(['pages', 'terms'], 'readwrite');
  await Promise.all([
    deleteByBookIndex(tx.objectStore('pages'), bookId),
    deleteByBookIndex(tx.objectStore('terms'), bookId),
  ]);
  await transactionDone(tx);
}

export async function deleteBookData(bookId) {
  const db = await openLibraryDB();
  const tx = db.transaction(['books', 'pages', 'terms', 'files'], 'readwrite');
  tx.objectStore('books').delete(bookId);
  tx.objectStore('files').delete(bookId);
  await Promise.all([
    deleteByBookIndex(tx.objectStore('pages'), bookId),
    deleteByBookIndex(tx.objectStore('terms'), bookId),
  ]);
  await transactionDone(tx);
}

export async function putPageBatch(rows) {
  if (!rows?.length) return;
  const db = await openLibraryDB();
  const tx = db.transaction('pages', 'readwrite');
  const store = tx.objectStore('pages');
  for (const row of rows) store.put(row);
  await transactionDone(tx);
}

export async function putTermBatch(rows) {
  if (!rows?.length) return;
  const db = await openLibraryDB();
  const tx = db.transaction('terms', 'readwrite');
  const store = tx.objectStore('terms');
  for (const row of rows) store.put(row);
  await transactionDone(tx);
}

export async function getAllTerms() {
  const db = await openLibraryDB();
  const tx = db.transaction('terms', 'readonly');
  const rows = await requestAsPromise(tx.objectStore('terms').getAll());
  await transactionDone(tx);
  return rows;
}

export async function countPages(bookId) {
  const db = await openLibraryDB();
  const tx = db.transaction('pages', 'readonly');
  const count = await requestAsPromise(tx.objectStore('pages').index('byBook').count(IDBKeyRange.only(bookId)));
  await transactionDone(tx);
  return count;
}

export function normalizeSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\u00a0·•・—–_\-\/\\:：,，.。;；!！?？'"“”‘’()（）\[\]【】<>《》]+/g, '');
}

const PINYIN_BOUNDARIES = ['阿','八','嚓','咑','妸','发','旮','哈','讥','咔','垃','妈','拏','噢','妑','七','呥','仨','他','屲','夕','丫','帀'];
const PINYIN_INITIALS = 'ABCDEFGHJKLMNOPQRSTWXYZ'.split('');
const pinyinCollator = (() => {
  try { return new Intl.Collator('zh-CN-u-co-pinyin'); } catch { return null; }
})();

function chineseInitial(ch) {
  if (!pinyinCollator || !/[\u3400-\u9fff]/u.test(ch)) return '';
  let result = '';
  for (let i = 0; i < PINYIN_BOUNDARIES.length; i += 1) {
    if (pinyinCollator.compare(ch, PINYIN_BOUNDARIES[i]) >= 0) result = PINYIN_INITIALS[i] || '';
    else break;
  }
  return result.toLocaleLowerCase();
}

export function pinyinInitials(value) {
  let out = '';
  for (const ch of String(value || '')) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch.toLocaleLowerCase();
    else out += chineseInitial(ch);
  }
  return out;
}

const BUILTIN_ALIASES = [
  { test: /(?:借机攻击|机会攻击)/i, keys: ['opportunityattack', 'opportunity', 'oa'] },
  { test: /倒地/i, keys: ['prone'] },
  { test: /(?:擒抱|受擒)/i, keys: ['grapple', 'grappled'] },
  { test: /震慑/i, keys: ['stunned', 'stun'] },
  { test: /昏迷/i, keys: ['unconscious'] },
  { test: /失能/i, keys: ['incapacitated'] },
  { test: /束缚/i, keys: ['restrained'] },
  { test: /隐形/i, keys: ['invisible'] },
  { test: /魅惑/i, keys: ['charmed'] },
  { test: /恐慌|恐惧/i, keys: ['frightened'] },
  { test: /中毒/i, keys: ['poisoned'] },
];

export function makeSearchKeys(label) {
  const raw = String(label || '').trim();
  const keys = new Set();
  const normalized = normalizeSearch(raw);
  if (normalized) keys.add(normalized);
  const initials = pinyinInitials(raw);
  if (initials && initials !== normalized) keys.add(initials);
  const english = raw.match(/[A-Za-z][A-Za-z'’ -]{1,80}/g) || [];
  for (const word of english) {
    const key = normalizeSearch(word);
    if (key) keys.add(key);
  }
  for (const alias of BUILTIN_ALIASES) if (alias.test.test(raw)) for (const key of alias.keys) keys.add(normalizeSearch(key));
  return [...keys].filter(Boolean);
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function makeTermRecord(bookId, { label, path, anchor = '', source = '术语', searchText = '' }) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  if (!text || !path) return null;
  return {
    bookId,
    termId: hashString(`${path}|${anchor}|${source}|${text}`),
    label: text.slice(0, 220),
    path,
    anchor: anchor || '',
    source,
    keys: makeSearchKeys(text),
    searchText: searchText || text,
  };
}

export async function seedBookTerms(bookId, book) {
  const rows = [];
  const seen = new Set();
  const add = (label, path, source) => {
    const row = makeTermRecord(bookId, { label, path, source });
    if (!row) return;
    const key = `${row.path.toLocaleLowerCase()}|${row.label.toLocaleLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  for (const item of book?.spine || []) add(item.name || item.local, item.local, '目录');
  for (const item of book?.index || []) add(item.name, item.targets?.[0], '索引');
  await putTermBatch(rows);
  return rows.length;
}

function snippetsFor(text, query, max = 4) {
  const out = [];
  const low = text.toLocaleLowerCase();
  const q = query.toLocaleLowerCase();
  let from = 0;
  while (out.length < max) {
    const pos = low.indexOf(q, from);
    if (pos < 0) break;
    out.push({ occurrenceIndex: out.length, snippet: text.slice(Math.max(0, pos - 55), Math.min(text.length, pos + q.length + 115)).trim() });
    from = pos + Math.max(1, q.length);
  }
  return out;
}

export async function searchLibraryPages(query, bookIds, limit = 120) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (q.length < 2) return [];
  const ids = Array.isArray(bookIds) ? bookIds : [];
  const db = await openLibraryDB();
  const results = [];
  for (const bookId of ids) {
    if (results.length >= limit) break;
    const tx = db.transaction('pages', 'readonly');
    const index = tx.objectStore('pages').index('byBook');
    await new Promise((resolve, reject) => {
      const req = index.openCursor(IDBKeyRange.only(bookId));
      req.onerror = () => reject(req.error || new Error('读取本地索引失败'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || results.length >= limit) { resolve(); return; }
        const row = cursor.value;
        const searchable = String(row.text || '').toLocaleLowerCase();
        if (searchable.includes(q)) {
          const matches = snippetsFor(row.text || searchable, q, 6);
          results.push({ bookId, path: row.path, title: row.title, occurrenceTotal: row.occurrenceTotal?.[q] || matches.length, matches });
        }
        cursor.continue();
      };
    });
    await transactionDone(tx);
  }
  return results;
}
