import { ChmFile } from '../engine/chm.js';
import { decode, detectEncoding } from '../engine/codec.js';
import { clearBookPages, putPageBatch, putTermBatch, makeTermRecord, patchBookRecord } from './library.js';

function readerFor(file, windowSize = 512 * 1024) {
  const fr = new FileReaderSync();
  let cacheStart = -1;
  let cache = null;
  return {
    size: file.size,
    read(offset, length) {
      if (length === 0) return new Uint8Array(0);
      if (length >= windowSize) return new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, offset + length)));
      const hit = cacheStart >= 0 && cache && offset >= cacheStart && offset + length <= cacheStart + cache.length;
      if (!hit) {
        cacheStart = offset;
        cache = new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, Math.min(file.size, offset + windowSize))));
      }
      return cache.subarray(offset - cacheStart, offset - cacheStart + length);
    },
  };
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } });
}

function stripTags(html) {
  return decodeEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/dt|\/dd)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attrValue(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function extractTerms(bookId, path, html, pageTitle, globalSeen) {
  const rows = [];
  const seen = new Set();
  const add = (label, anchor = '', source = '正文术语', tag = '') => {
    const clean = stripTags(label).replace(/\s+/g, ' ').trim();
    if (clean.length < 2 || clean.length > 70) return;
    const lowerTag = String(tag || '').toLowerCase();
    const bilingual = /[\u3400-\u9fff]/u.test(clean) && /[A-Za-z]/.test(clean);
    const punctuationCount = (clean.match(/[。！？!?；;]/g) || []).length;
    if (punctuationCount > 1) return;
    if (lowerTag && !lowerTag.startsWith('h') && lowerTag !== 'dt' && !bilingual && clean.length > 18) return;
    if (lowerTag === 'dt' && clean.length > 36) return;
    const globalKey = clean.toLocaleLowerCase();
    if (globalSeen?.has(globalKey)) return;
    const key = `${globalKey}|${anchor}`;
    if (seen.has(key)) return;
    seen.add(key);
    globalSeen?.add(globalKey);
    const row = makeTermRecord(bookId, { label: clean, path, anchor, source, searchText: clean });
    if (row) rows.push(row);
  };
  if (pageTitle) add(pageTitle, '', '页面标题', 'h1');
  const patterns = [
    /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    /<(strong|b|dt)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) && rows.length < 40) {
      const attrs = match[2] || '';
      let anchor = attrValue(attrs, 'id') || attrValue(attrs, 'name');
      if (!anchor) {
        const innerAnchor = match[3].match(/<a\b([^>]*)>/i);
        if (innerAnchor) anchor = attrValue(innerAnchor[1], 'id') || attrValue(innerAnchor[1], 'name');
      }
      add(match[3], anchor, '正文术语', match[1]);
    }
  }
  return rows;
}

async function build({ file, bookId, encoding, docs }) {
  if (!(file instanceof File)) throw new Error('缺少规则书文件');
  const archive = ChmFile.open(readerFor(file));
  const paths = Array.isArray(docs) && docs.length ? docs : archive.entries.filter(e => /\.(?:x?html?|xht)$/i.test(e.path) && e.length > 0).map(e => e.path);
  const total = Math.min(paths.length, 20000);
  await clearBookPages(bookId);
  await patchBookRecord(bookId, { indexState: 'building', indexDone: 0, indexTotal: total, indexError: '' });

  const pages = [];
  const terms = [];
  const globalTerms = new Set();
  for (let i = 0; i < total; i += 1) {
    const path = paths[i];
    try {
      const entry = archive.resolve(path);
      if (!entry || entry.length > 16 * 1024 * 1024) continue;
      const bytes = archive.retrieve(entry);
      const html = decode(bytes, detectEncoding(bytes, archive.langId) || encoding || 'utf-8');
      const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const title = stripTags(titleMatch?.[1] || '') || (path.split('/').pop() || path);
      const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
      const body = bodyMatch?.[1] || html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
      const text = stripTags(body).slice(0, 2_000_000);
      pages.push({ bookId, path, title, text });
      terms.push(...extractTerms(bookId, path, body, title, globalTerms));
    } catch {}

    if (pages.length >= 24 || i === total - 1) {
      await putPageBatch(pages.splice(0));
      await putTermBatch(terms.splice(0));
    }
    if (i % 20 === 0 || i === total - 1) {
      const done = i + 1;
      const percent = total ? Math.round((done / total) * 100) : 100;
      self.postMessage({ type: 'progress', bookId, done, total, percent });
      if (i % 100 === 0 || i === total - 1) await patchBookRecord(bookId, { indexState: 'building', indexDone: done, indexTotal: total });
    }
  }
  archive.dropCaches();
  await patchBookRecord(bookId, { indexState: 'ready', indexDone: total, indexTotal: total, indexUpdated: Date.now(), indexError: '' });
  self.postMessage({ type: 'done', bookId, done: total, total, percent: 100 });
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'build') return;
  build(msg).catch(async (error) => {
    try { await patchBookRecord(msg.bookId, { indexState: 'error', indexError: error?.message || String(error) }); } catch {}
    self.postMessage({ type: 'error', bookId: msg.bookId, error: error?.message || String(error) });
  });
});
