
'use strict';

export const MIME = {
  html:'text/html', htm:'text/html', xhtml:'application/xhtml+xml', xht:'application/xhtml+xml',
  css:'text/css', jpg:'image/jpeg', jpeg:'image/jpeg', jpe:'image/jpeg', png:'image/png',
  gif:'image/gif', bmp:'image/bmp', svg:'image/svg+xml', webp:'image/webp', ico:'image/x-icon',
  wav:'audio/wav', mp3:'audio/mpeg', mid:'audio/midi', midi:'audio/midi',
  woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf',
  txt:'text/plain', xml:'text/xml'
};

export function mimeFor(path) {
  const m = /\.([^.?#/]+)(?:[?#]|$)/.exec(path || '');
  return MIME[(m?.[1] || '').toLowerCase()] || 'application/octet-stream';
}

export function normalizePath(base, input) {
  if (input == null) return null;
  let value = String(input).trim().replace(/\\/g, '/');
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const its = value.match(/^(?:ms-its:|mk:@msitstore:|its:)?[^:]*?\.chm::(.*)$/i);
  if (its) value = its[1];
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash);
  const q = value.indexOf('?');
  if (q >= 0) value = value.slice(0, q);
  try { value = decodeURIComponent(value); } catch {}
  if (!value) return null;
  if (/^(?:https?:|mailto:|tel:|ftp:|javascript:|data:|about:|file:|blob:)/i.test(value)) return null;
  if (!value.startsWith('/')) {
    const b = base || '/';
    value = b.slice(0, b.lastIndexOf('/') + 1) + value;
  }
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(part);
  }
  return '/' + parts.join('/');
}

export function fragmentOf(input) {
  const s = String(input || '');
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(i + 1) : '';
}

export function isExternal(input) {
  return /^(?:https?:|mailto:|tel:|ftp:|javascript:|about:|file:|blob:)/i.test(String(input || '').trim());
}

const aliases = {
  gb2312:'gbk','gb-2312':'gbk','x-gbk':'gbk',gbk:'gbk',gb18030:'gb18030',
  big5:'big5','big5-hkscs':'big5',sjis:'shift_jis','shift-jis':'shift_jis',
  shift_jis:'shift_jis',cp932:'shift_jis','windows-31j':'shift_jis',
  'euc-jp':'euc-jp','euc-kr':'euc-kr',cp949:'euc-kr',
  utf8:'utf-8','utf-8':'utf-8',ascii:'windows-1252','us-ascii':'windows-1252',
  latin1:'windows-1252','iso-8859-1':'windows-1252','windows-1252':'windows-1252',
  'windows-1251':'windows-1251','windows-1250':'windows-1250','windows-1253':'windows-1253',
  'windows-1254':'windows-1254','windows-1255':'windows-1255','windows-1256':'windows-1256',
  'windows-874':'windows-874'
};

const lcidMap = {
  0x0804:'gbk',0x1004:'gbk',0x0c04:'big5',0x0404:'big5',0x1404:'big5',
  0x0411:'shift_jis',0x0412:'euc-kr',0x0419:'windows-1251',0x0405:'windows-1250',
  0x040e:'windows-1250',0x0408:'windows-1253',0x041f:'windows-1254',
  0x040d:'windows-1255',0x0401:'windows-1256',0x041e:'windows-874'
};

function canonical(name) {
  return aliases[String(name || '').toLowerCase()] || null;
}

export function detectEncoding(bytes, lcid = 0) {
  if (bytes?.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  let ascii = '';
  const n = Math.min(bytes?.length || 0, 8192);
  for (let i=0;i<n;i++) ascii += String.fromCharCode(bytes[i]);
  const m = ascii.match(/charset\s*=\s*["']?\s*([\w.:-]+)/i);
  const fromMeta = canonical(m?.[1]);
  if (fromMeta) return fromMeta;
  if (bytes) {
    try {
      new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
      if (bytes.some?.(b => b >= 0x80)) return 'utf-8';
    } catch {}
  }
  return lcidMap[lcid & 0xffff] || 'windows-1252';
}

export function decode(bytes, encoding) {
  try { return new TextDecoder(encoding || 'utf-8').decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function decodeEntities(text) {
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',copy:'©',reg:'®',trade:'™'};
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi,(all,body)=>{
    if (body[0]==='#') {
      const cp = body[1].toLowerCase()==='x' ? parseInt(body.slice(2),16) : parseInt(body.slice(1),10);
      try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : all; } catch { return all; }
    }
    return named[body.toLowerCase()] ?? all;
  });
}

function attrs(body) {
  const out={};
  const re=/([a-z_][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m=re.exec(body))) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

export function parseSitemap(text, basePath='/') {
  const root={name:'',local:null,children:[]};
  const stack=[root];
  let last=null, collecting=null, id=0;
  const tagRe=/<\s*(\/?)\s*([a-z][a-z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let m;
  while ((m=tagRe.exec(text))) {
    const closing=!!m[1], tag=m[2].toLowerCase(), body=m[3]||'';
    if (['ul','menu','dir'].includes(tag)) {
      if (!closing) { stack.push(last || stack[stack.length-1]); last=null; }
      else if (stack.length>1) last=stack.pop();
    } else if (tag==='object') {
      if (!closing) {
        const a=attrs(body);
        collecting=/text\/sitemap/i.test(a.type||'') ? [] : null;
      } else if (collecting) {
        let name='', local='', locals=[];
        for (const [k,v] of collecting) {
          if (k==='name' && !name) name=v;
          if (k==='local') { if(!local)local=v; locals.push(v); }
        }
        if (name || local) {
          const node={id:id++,name:(name||local||'(untitled)').trim(),local:normalizePath(basePath,local),locals:locals.map(v=>normalizePath(basePath,v)).filter(Boolean),children:[]};
          stack[stack.length-1].children.push(node); last=node;
        }
        collecting=null;
      }
    } else if (tag==='param' && collecting && !closing) {
      const a=attrs(body);
      if (a.name) collecting.push([a.name.toLowerCase(),a.value||'']);
    }
  }
  return root.children;
}

export function flattenIndex(tree) {
  const out=[];
  const walk=(n,prefix='')=>{
    const label=prefix ? `${prefix}, ${n.name}` : n.name;
    const targets=(n.locals?.length ? n.locals : n.local ? [n.local] : []).filter(Boolean);
    if (targets.length) out.push({name:label,targets});
    for (const c of n.children||[]) walk(c,label);
  };
  for (const n of tree||[]) walk(n);
  return out.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}));
}
