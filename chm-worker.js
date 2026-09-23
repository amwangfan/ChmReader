
import { ChmFile } from './engine/chm.js';
import { decode, detectEncoding, normalizePath, parseSitemap, flattenIndex, mimeFor } from './engine/codec.js';

let sourceFile = null;
let archive = null;
let book = null;
let encoding = 'utf-8';

function reply(id, ok, payload={}) {
  self.postMessage({ id, ok, ...payload });
}

function readerFor(file, windowSize = 512 * 1024) {
  const fr = new FileReaderSync();
  let cacheStart = -1;
  let cache = null;
  return {
    size: file.size,
    read(offset, length) {
      if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0 || offset + length > file.size) {
        throw new Error(`Invalid file slice: ${offset}+${length}`);
      }
      if (length === 0) return new Uint8Array(0);
      if (length >= windowSize) {
        return new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, offset + length)));
      }
      const hit = cacheStart >= 0 && cache && offset >= cacheStart && offset + length <= cacheStart + cache.length;
      if (!hit) {
        cacheStart = offset;
        cache = new Uint8Array(
          fr.readAsArrayBuffer(file.slice(offset, Math.min(file.size, offset + windowSize)))
        );
      }
      return cache.subarray(offset - cacheStart, offset - cacheStart + length);
    }
  };
}

function asciiz(bytes) {
  if (!bytes?.length) return '';
  const end = bytes.indexOf(0);
  const view = bytes.subarray(0, end < 0 ? bytes.length : end);
  let s='';
  for (let i=0;i<view.length;i++) s += String.fromCharCode(view[i]);
  return s.trim();
}

function findEntry(path) {
  if (!archive || !path) return null;
  const normalized = normalizePath('/', path) || path;
  return archive.resolve(normalized) || archive.resolve(path);
}

function readEntry(path, maxBytes = 256 * 1024 * 1024) {
  const entry = findEntry(path);
  if (!entry) throw new Error(`CHM entry not found: ${path}`);
  if (entry.length > maxBytes) throw new Error(`Entry is too large to preview (${Math.round(entry.length/1048576)} MiB)`);
  return { entry, data: archive.retrieve(entry) };
}

function chooseSitemap(sys, code, ext) {
  const fromSystem = asciiz(sys.get(code));
  if (fromSystem) {
    const p = normalizePath('/', fromSystem);
    if (p && archive.resolve(p)) return p;
  }
  const e = archive.entries.find(x => x.path.toLowerCase().endsWith(ext));
  return e?.path || null;
}

function decodeAsciiz(bytes, charset = 'utf-8') {
  if (!bytes?.length) return '';
  const end = bytes.indexOf(0);
  const view = bytes.subarray(0, end < 0 ? bytes.length : end);
  return decode(view, charset).trim();
}

function chooseDefault(sys, docs, charset, toc = []) {
  // #SYSTEM string fields are encoded with the book code page. Treating
  // them as latin-1 mojibakes Chinese filenames such as 写在前面.html.
  const fromSystem = decodeAsciiz(sys.get(2), charset);
  if (fromSystem) {
    const p = normalizePath('/', fromSystem);
    if (p && archive.resolve(p)) return p;
  }

  // Rule-book CHMs commonly place their real landing page as the first
  // TOC item even when #SYSTEM is missing or malformed. Prefer it.
  const firstToc = flattenToc(toc).find(item => item.local && archive.resolve(item.local));
  if (firstToc?.local) return firstToc.local;

  const candidates=['/index.html','/index.htm','/default.html','/default.htm','/welcome.html','/welcome.htm'];
  for (const p of candidates) if (archive.resolve(p)) return p;
  return docs[0] || null;
}

function flattenToc(tree) {
  const out=[];
  const walk=(nodes,depth=0)=>{
    for(const n of nodes||[]) {
      if(n.local) out.push({name:n.name,local:n.local,depth});
      if(n.children?.length) walk(n.children,depth+1);
    }
  };
  walk(tree);
  return out;
}

function makeFallbackToc(docs) {
  return docs.slice(0, 50000).map((p,i)=>({
    id:i,
    name:(p.split('/').pop()||p).replace(/\.(x?html?|xht)$/i,''),
    local:p,
    locals:[p],
    children:[]
  }));
}

function buildBook(file) {
  const sys = archive.parseSystem();
  const docs = archive.entries
    .filter(e => /^\/(?![#$:])/.test(e.path) && /\.(x?html?|xht)$/i.test(e.path) && e.length > 0)
    .map(e => e.path)
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));

  let sample = null;
  // Use a representative page for charset detection; #SYSTEM default-topic
  // bytes may themselves require that charset, so resolve the final home later.
  for (const p of [docs.find(p => /写在前面|index|default/i.test(p)), docs[0], docs[1]]) {
    if (!p) continue;
    try {
      const e=archive.resolve(p);
      sample=archive.retrieve(e,0,Math.min(e.length,65536));
      break;
    } catch {}
  }
  let lcid = archive.langId & 0xffff;
  const lang = sys.get(4);
  if (lang?.length>=4) lcid=(lang[0] | (lang[1]<<8)) & 0xffff;
  encoding=detectEncoding(sample || new Uint8Array(), lcid);

  const tocPath=chooseSitemap(sys,0,'.hhc');
  const indexPath=chooseSitemap(sys,1,'.hhk');

  let toc=[];
  if(tocPath) {
    try {
      const {data}=readEntry(tocPath, 32*1024*1024);
      toc=parseSitemap(decode(data, detectEncoding(data,lcid) || encoding), tocPath);
    } catch {}
  }
  if(!toc.length) toc=makeFallbackToc(docs);

  let index=[];
  if(indexPath) {
    try {
      const {data}=readEntry(indexPath, 32*1024*1024);
      index=flattenIndex(parseSitemap(decode(data, detectEncoding(data,lcid) || encoding), indexPath));
    } catch {}
  }

  let title = '';
  const titleBytes=sys.get(3);
  if(titleBytes?.length) {
    const end=titleBytes.indexOf(0);
    title=decode(titleBytes.subarray(0,end<0?titleBytes.length:end),encoding).trim();
  }

  const defaultPath=chooseDefault(sys, docs, encoding, toc);
  const spine=flattenToc(toc);
  return {
    title:title || file.name.replace(/\.chm$/i,''),
    encoding,
    toc,
    index,
    docs,
    spine:spine.length ? spine : docs.map((local,i)=>({name:local.split('/').pop(),local,depth:0})),
    defaultPath,
    entryCount:archive.entries.length,
    compression:archive.compressionEnabled,
    fileSize:file.size,
  };
}

async function fullTextSearch(query, limit=100, paths=null) {
  const q=String(query||'').trim().toLocaleLowerCase();
  if(q.length<2) return [];
  const hits=[];
  const docs=Array.isArray(paths) ? paths : book.docs;
  const maxDocs=Math.min(docs.length, 20000);
  const maxMatchesPerPage=60;
  for(let i=0;i<maxDocs && hits.length<limit;i++) {
    const path=docs[i];
    try {
      const e=archive.resolve(path);
      if(!e || e.length>16*1024*1024) continue;
      const bytes=archive.retrieve(e);
      const html=decode(bytes, detectEncoding(bytes, archive.langId) || encoding);
      const titleMatch=html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const pageTitle=(titleMatch?.[1] || '')
        .replace(/<[^>]+>/g,' ')
        .replace(/&nbsp;/gi,' ')
        .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"')
        .replace(/\s+/g,' ').trim();
      // Search only the rendered document body. Searching the whole HTML also
      // matches <title> / metadata in <head>, which makes a result open at the
      // top of the page instead of the actual rule text the user searched for.
      const bodyMatch=html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
      const searchable=bodyMatch?.[1] || html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi,' ');
      const text=searchable
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
        .replace(/<[^>]+>/g,' ')
        .replace(/&nbsp;/gi,' ')
        .replace(/&(?:amp|lt|gt|quot);/gi,' ')
        .replace(/\s+/g,' ');
      const low=text.toLocaleLowerCase();
      const positions=[];
      let from=0;
      while(from<=low.length-q.length) {
        const pos=low.indexOf(q,from);
        if(pos<0) break;
        positions.push(pos);
        from=pos+Math.max(1,q.length);
      }
      if(positions.length) {
        const matches=positions.slice(0,maxMatchesPerPage).map((pos,occurrenceIndex)=>({
          occurrenceIndex,
          snippet:text.slice(Math.max(0,pos-60),pos+q.length+120),
        }));
        hits.push({
          path,
          title:pageTitle || (path.split('/').pop()||path),
          occurrenceTotal:positions.length,
          matches,
        });
      }
      if ((i % 40) === 0) self.postMessage({id:0,ok:true,type:'progress',phase:'search',current:i,total:maxDocs});
    } catch {}
  }
  return hits;
}

self.addEventListener('message', async (event) => {
  const msg=event.data || {};
  const id=msg.id;
  try {
    if(msg.type==='open') {
      sourceFile=msg.file;
      if(!(sourceFile instanceof File)) throw new Error('No CHM File received');
      archive=ChmFile.open(readerFor(sourceFile));
      book=buildBook(sourceFile);
      reply(id,true,{type:'open',book});
      return;
    }
    if(!archive) throw new Error('Open a CHM first');
    if(msg.type==='read') {
      const {entry,data}=readEntry(msg.path, msg.maxBytes || 256*1024*1024);
      const copy=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
      self.postMessage({id,ok:true,type:'read',path:entry.path,mime:mimeFor(entry.path),data:copy},[copy]);
      return;
    }
    if(msg.type==='search') {
      const hits=await fullTextSearch(msg.query,msg.limit||80,msg.paths);
      reply(id,true,{type:'search',hits});
      return;
    }
    if(msg.type==='dropCaches') {
      archive.dropCaches();
      reply(id,true,{type:'dropCaches'});
      return;
    }
    if(msg.type==='close') {
      archive?.dropCaches();
      sourceFile=null; archive=null; book=null;
      reply(id,true,{type:'close'});
      return;
    }
    throw new Error(`Unknown request: ${msg.type}`);
  } catch(err) {
    reply(id,false,{type:msg.type||'error',error:err?.message || String(err)});
  }
});
