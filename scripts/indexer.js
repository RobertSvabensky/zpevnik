 // Node skript: projde /songs a vytvoří data/songs.json
 import { readdir, readFile, writeFile } from 'node:fs/promises';
 import path from 'node:path';
 
 const GP_RX = /\.(gp|gp3|gp4|gp5|gpx|musicxml|xml)$/i;
 const CP_RX = /\.(pro|cho)$/i;
const BOOK_RX = /^\{book:\s*(.*?)\s*(?:=|\|)\s*(.*?)\s*\}$/i;
 
 function parseName(name){
   const base = name.replace(/\.(.*)$/, '');
   const m = base.match(/^(\d{1,4})-(.+)$/);
   let number = null, rest = base;
  if (m){ number = Number(m[1]); rest = m[2]; }
   const parts = rest.split('-');
   const titleGuess = parts.join(' ').trim();
   const id = base.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
   return { id, number, titleGuess };
 }
 
 function parseChordProMeta(text){
   const meta = {};
 const books = {};
   for (const line of text.split(/\r?\n/)) {
     const m = line.match(/^\{(\w+)\s*:\s*(.*?)\s*\}$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2];
      if (key === 'book') {
        const bm = val.match(BOOK_RX);
        const name = (bm?.[1] ?? '').trim();
        const num  = Number((bm?.[2] ?? '').trim());
        if (name && Number.isFinite(num)) books[name] = num;
      } else if (key === 'songbook') {
        const parts = val.split('|');
        const name = (parts[0]||'').trim();
        const num  = Number((parts[1]||'').trim());
        if (name && Number.isFinite(num)) books[name] = num;
      } else {
        meta[key] = val;
      }
    }
    if (Object.keys(meta).length >= 3 && Object.keys(books).length >= 1) break;
  }
  return {
    title: meta.title,
    author: meta.artist || meta.composer,
    key: meta.key,
    number: meta.number ? Number(meta.number) : null,
    books
  };
}

async function loadExistingIndex(){
  try{
    const txt = await readFile('data/songs.json', 'utf8');
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  }catch{
    return [];
   }
 }
 
 const files = (await readdir('songs', {withFileTypes:true}))
   .filter(d => d.isFile())
   .map(d => d.name)
   .filter(n => GP_RX.test(n) || CP_RX.test(n));
 
 const items = [];
const existingByFile = new Map();
for (const prev of await loadExistingIndex()){
  if (prev && prev.file) existingByFile.set(prev.file, prev);
}

 for (const f of files){
   const filePath = path.join('songs', f);
   const metaName = parseName(f);
   let title = metaName.titleGuess;
   let author = '';
   let type = GP_RX.test(f) ? 'score' : 'chordpro';
  let number = metaName.number;
  let books = {};

  const prev = existingByFile.get(filePath) || {};
  let id = prev.id || metaName.id;
 
   if (CP_RX.test(f)){
     try{
       const txt = await readFile(filePath, 'utf8');
       const m = parseChordProMeta(txt);
       if (m.title) title = m.title;
       if (m.author) author = m.author;
      if (m.number != null) number = m.number;
      if (m.books && Object.keys(m.books).length) books = m.books;
     }catch(e){}
   }

  if (!Object.keys(books).length && prev.books && typeof prev.books === 'object'){
    books = prev.books;
  }
  if (prev.title && !title) title = prev.title;
  if (prev.author && !author) author = prev.author;
  if (prev.number != null && number == null) number = prev.number;
  if (prev.type) type = prev.type;

   items.push({

    id,
    number,
     title,
     author,
     file: filePath,

    type,
    ...(Object.keys(books).length ? { books } : {})
   });
 }
 
 items.sort((a,b)=>(a.number??99999)-(b.number??99999) || a.title.localeCompare(b.title));
 await writeFile('data/songs.json', JSON.stringify(items, null, 2));
 console.log(`Index hotov: ${items.length} položek`);
