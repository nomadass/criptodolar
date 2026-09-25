// scripts/fetch-news.js
// Junta titulares de RSS (economía/dólar Argentina + cripto), arma una mezcla
// de 6 noticias, y guarda el resultado en news.json en la raíz del repo.
// No usa dependencias externas: parsea el XML con expresiones regulares
// simples (suficiente para RSS estándar) y usa fetch nativo de Node 20+.

const fs = require('fs');
const path = require('path');

const ECONOMY_SOURCES = [
  { name: 'Perfil', url: 'https://www.perfil.com/feed/economia' },
];

const CRYPTO_SOURCES = [
  { name: 'CriptoNoticias', url: 'https://www.criptonoticias.com/feed/' },
];

const TARGET_TOTAL = 6;
const USER_AGENT = 'Mozilla/5.0 (compatible; CriptoDolarNewsBot/1.0; +https://criptodolar.digital)';

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(re);
  return match ? match[1].trim() : null;
}

function decodeEntities(str) {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
  let s = str.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (e) => named[e]);
  s = s.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return s;
}

function stripCdata(str) {
  const m = str.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : str;
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanText(str) {
  if (!str) return '';
  return decodeEntities(stripCdata(str).trim()).trim();
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const rawTitle = extractTag(block, 'title');
    const rawLink = extractTag(block, 'link');
    const rawDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'published');
    const rawDesc = extractTag(block, 'description') || extractTag(block, 'content:encoded');

    const title = cleanText(rawTitle);
    const link = cleanText(rawLink);
    if (!title || !link) continue;

    const pubDate = rawDate ? new Date(rawDate) : new Date(0);
    let summaryFull = stripHtml(cleanText(rawDesc || ''));
    // WordPress agrega "La entrada X se publicó primero en Y." al final de la descripción; lo recortamos.
    summaryFull = summaryFull.replace(/\s*La entrada .*? se publicó primero en .*?\.?\s*$/i, '').trim();
    // Algunos medios (Perfil, etc.) dejan un "Leer más" colgado al final; lo recortamos también.
    summaryFull = summaryFull.replace(/\s*(Leer más|Read more)\.?\s*$/i, '').trim();
    const summary = summaryFull.length > 160 ? summaryFull.slice(0, 157).trim() + '…' : summaryFull;

    items.push({ title, link, pubDate: isNaN(pubDate) ? new Date(0) : pubDate, summary });
  }
  return items;
}

async function fetchFeed(source) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRss(xml).map((item) => ({ ...item, source: source.name }));
    console.log(`OK  ${source.name}: ${items.length} items`);
    return items;
  } catch (err) {
    console.error(`FALLÓ ${source.name} (${source.url}): ${err.message}`);
    return [];
  }
}

async function fetchCategory(sources) {
  const results = await Promise.all(sources.map(fetchFeed));
  return results
    .flat()
    .sort((a, b) => b.pubDate - a.pubDate);
}

function dedupeByTitle(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

(async () => {
  const [economyItemsRaw, cryptoItemsRaw] = await Promise.all([
    fetchCategory(ECONOMY_SOURCES),
    fetchCategory(CRYPTO_SOURCES),
  ]);

  const economyItems = dedupeByTitle(economyItemsRaw);
  const cryptoItems = dedupeByTitle(cryptoItemsRaw);

  // Mezcla pareja: mitad economía/dólar, mitad cripto. Si a una categoría le
  // faltan notas (feed caído, etc.), se completa con la otra para llegar a 6.
  const half = Math.ceil(TARGET_TOTAL / 2);
  let economyPick = economyItems.slice(0, half);
  let cryptoPick = cryptoItems.slice(0, TARGET_TOTAL - economyPick.length);

  if (economyPick.length + cryptoPick.length < TARGET_TOTAL) {
    const missing = TARGET_TOTAL - economyPick.length - cryptoPick.length;
    economyPick = economyPick.concat(economyItems.slice(economyPick.length, economyPick.length + missing));
  }
  if (economyPick.length + cryptoPick.length < TARGET_TOTAL) {
    const missing = TARGET_TOTAL - economyPick.length - cryptoPick.length;
    cryptoPick = cryptoPick.concat(cryptoItems.slice(cryptoPick.length, cryptoPick.length + missing));
  }

  // Intercalar economía / cripto para que la mezcla se note en el orden.
  const merged = [];
  const maxLen = Math.max(economyPick.length, cryptoPick.length);
  for (let i = 0; i < maxLen; i++) {
    if (economyPick[i]) merged.push(economyPick[i]);
    if (cryptoPick[i]) merged.push(cryptoPick[i]);
  }

  const finalItems = merged.slice(0, TARGET_TOTAL).map((item) => ({
    title: item.title,
    link: item.link,
    source: item.source,
    summary: item.summary,
    pubDate: item.pubDate.toISOString(),
  }));

  const output = {
    updatedAt: new Date().toISOString(),
    items: finalItems,
  };

  const outPath = path.join(__dirname, '..', 'news.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`Guardadas ${finalItems.length} noticias en ${outPath}`);

  if (finalItems.length === 0) {
    console.error('Advertencia: no se obtuvo ninguna noticia de ningún feed.');
  }
})();
