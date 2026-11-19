// Phase 1 — URL discovery
// Reads robots.txt + sitemap(s) (following sitemap indexes), validates each URL
// (status, redirects, content-type, meta robots, canonical), groups by template
// and writes data/urls.csv + data/urls-excluded.csv.
//
// Usage: node scripts/discover-urls.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const ORIGIN = 'https://www.darkroomagency.com';
const UA = 'Mozilla/5.0 (compatible; js-perf-audit/1.0)';
const CONCURRENCY = 6;

const get = (url, opts = {}) =>
  fetch(url, { headers: { 'user-agent': UA }, redirect: 'manual', ...opts });

async function text(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

const locs = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}>[\\s\\S]*?<loc>\\s*([^<\\s]+)\\s*</loc>`, 'g'))].map((m) =>
    m[1].replace(/&amp;/g, '&'),
  );

async function collectSitemaps() {
  const robots = await text(`${ORIGIN}/robots.txt`);
  const fromRobots = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const queue = [...new Set([`${ORIGIN}/sitemap.xml`, ...fromRobots])];
  const seen = new Set();
  const pageUrls = [];
  while (queue.length) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    const xml = await text(sm);
    queue.push(...locs(xml, 'sitemap')); // sitemap index children
    pageUrls.push(...locs(xml, 'url'));
  }
  return { sitemaps: [...seen], pageUrls };
}

function normalize(u) {
  const url = new URL(u);
  url.hash = '';
  url.search = '';
  let p = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.origin}${p}`;
}

function template(u) {
  const p = new URL(u).pathname;
  if (p === '/') return 'homepage';
  if (p === '/services') return 'services-hub';
  if (p.startsWith('/services/')) return 'service';
  if (p === '/case-studies') return 'case-studies-hub';
  if (p.startsWith('/case-studies/')) return 'case-study';
  if (p === '/observatory') return 'observatory-listing';
  if (p.startsWith('/observatory/topics/')) return 'observatory-topic';
  if (p.startsWith('/observatory/')) return 'observatory-article';
  if (p.startsWith('/observatory-authors/')) return 'observatory-author';
  if (p.startsWith('/location/')) return 'location';
  if (p === '/merch' || p.startsWith('/merch/')) return 'merch';
  if (['/about', '/process', '/careers'].includes(p)) return 'company';
  if (p === '/book-a-call') return 'book-a-call';
  return 'other';
}

async function check(u) {
  const out = { url: u, status: 0, location: '', contentType: '', robots: '', canonical: '' };
  try {
    const r = await get(u);
    out.status = r.status;
    out.location = r.headers.get('location') || '';
    out.contentType = r.headers.get('content-type') || '';
    out.robots = r.headers.get('x-robots-tag') || '';
    if (r.status === 200 && out.contentType.includes('text/html')) {
      const html = await r.text();
      const m = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i);
      if (m) out.robots += ' ' + (m[0].match(/content=["']([^"']*)/i)?.[1] || '');
      const c = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
      if (c) out.canonical = c[0].match(/href=["']([^"']*)/i)?.[1] || '';
    } else {
      await r.body?.cancel();
    }
  } catch (e) {
    out.error = String(e.message || e);
  }
  return out;
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        res[idx] = await fn(items[idx]);
      }
    }),
  );
  return res;
}

const csv = (rows) =>
  rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';

const { sitemaps, pageUrls } = await collectSitemaps();
const raw = pageUrls.length;
const unique = [...new Set(pageUrls.map(normalize))].filter((u) => u.startsWith(ORIGIN));
const nonHtmlExt = /\.(pdf|jpe?g|png|gif|webp|svg|xml|txt|zip|mp4|json)$/i;

console.log(`Sitemaps: ${sitemaps.join(', ')}`);
console.log(`Raw <loc> entries: ${raw}; unique after normalisation: ${unique.length}`);

const checks = await pool(unique.filter((u) => !nonHtmlExt.test(u)), CONCURRENCY, check);
const included = [];
const excluded = unique.filter((u) => nonHtmlExt.test(u)).map((u) => [u, 'non-HTML extension']);
for (const c of checks) {
  let reason = '';
  if (c.error) reason = `fetch error: ${c.error}`;
  else if (c.status >= 300 && c.status < 400) reason = `redirect ${c.status} -> ${c.location}`;
  else if (c.status !== 200) reason = `HTTP ${c.status}`;
  else if (!c.contentType.includes('text/html')) reason = `content-type ${c.contentType}`;
  else if (/noindex/i.test(c.robots)) reason = `noindex (${c.robots.trim()})`;
  else if (c.canonical && normalize(new URL(c.canonical, c.url).href) !== c.url)
    reason = `canonicalised to ${c.canonical}`;
  if (reason) excluded.push([c.url, reason]);
  else included.push([c.url, template(c.url)]);
}

included.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
await mkdir(DATA, { recursive: true });
await writeFile(join(DATA, 'urls.csv'), csv([['url', 'template'], ...included]));
await writeFile(join(DATA, 'urls-excluded.csv'), csv([['url', 'reason'], ...excluded]));

const counts = {};
for (const [, t] of included) counts[t] = (counts[t] || 0) + 1;
console.log(`\nIncluded: ${included.length}  Excluded: ${excluded.length}`);
console.table(counts);
if (excluded.length) console.log('Excluded:\n' + excluded.map((e) => `  ${e[0]}  — ${e[1]}`).join('\n'));
