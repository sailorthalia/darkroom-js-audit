// Phase 3 — Analysis
// Reads every raw PSI response in data/raw/{mobile,desktop}/ and writes:
//   data/summary.json  — run metadata, per-page rows, template and site aggregates,
//                        per-script and per-entity aggregates, other JS audits
//   data/scripts.csv   — one row per script x strategy
//
// Usage: node scripts/analyze.mjs
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDORS } from './vendors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
// --strategies=mobile limits the report to one strategy (e.g. when the desktop run was not completed)
const strategiesArg = process.argv.find((a) => a.startsWith('--strategies='))?.split('=')[1];
const STRATEGIES = strategiesArg ? strategiesArg.split(',').filter((s) => ['mobile', 'desktop'].includes(s)) : ['mobile', 'desktop'];
if (!STRATEGIES.length) { console.error('No valid strategy in --strategies (use mobile, desktop or mobile,desktop)'); process.exit(1); }
const SITE_WIDE_SHARE = 0.9; // a script on >=90% of analysed pages is treated as global-template

const slugFor = (url) => {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, '');
  return p ? p.replace(/[^a-z0-9-]+/gi, '__') : 'home';
};
const r1 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const r3 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 1000) / 1000);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// Lab thresholds (web.dev / Lighthouse). TBT is the lab proxy for INP.
export const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  tbt: { good: 200, poor: 600, unit: 'ms', label: 'Total Blocking Time' },
  cls: { good: 0.1, poor: 0.25, unit: '', label: 'Cumulative Layout Shift' },
  fcp: { good: 1800, poor: 3000, unit: 'ms', label: 'First Contentful Paint' },
  si: { good: 3400, poor: 5800, unit: 'ms', label: 'Speed Index' },
  tti: { good: 3800, poor: 7300, unit: 'ms', label: 'Time to Interactive' },
};
const rate = (metric, v) => (v == null ? null : v <= THRESHOLDS[metric].good ? 'good' : v <= THRESHOLDS[metric].poor ? 'ni' : 'poor');

// Stable key for a script URL: drop query strings except GTM/gtag container ids,
// which identify genuinely different containers.
function scriptKey(u) {
  try {
    const url = new URL(u);
    if (/googletagmanager\.com$/.test(url.hostname)) {
      const id = url.searchParams.get('id');
      return `${url.origin}${url.pathname}${id ? `?id=${id}` : ''}`;
    }
    if (/connect\.facebook\.net$/.test(url.hostname) && url.pathname.startsWith('/signals/config/'))
      return `${url.origin}/signals/config/{pixel-id}`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return u; // e.g. "Unattributable"
  }
}

const urlRows = (await readFile(join(DATA, 'urls.csv'), 'utf8')).trim().split('\n').slice(1).map((l) => l.split(','));
const templateOf = Object.fromEntries(urlRows);

let errorRows = [];
try {
  errorRows = (await readFile(join(DATA, 'errors.csv'), 'utf8')).trim().split('\n').slice(1).filter(Boolean);
} catch {}

const pages = []; // one row per url x strategy
const scripts = {}; // `${strategy}|${key}` -> aggregate
const entities = {}; // `${strategy}|${name}` -> aggregate
const otherAudits = { legacy: {}, duplicated: {}, unminified: {}, renderBlocking: {} };
const missing = Object.fromEntries(STRATEGIES.map((s) => [s, []]));
const meta = { lighthouseVersions: new Set(), fetchTimes: [], userAgents: {}, benchmarkIndex: {} };

function entityFor(url, ents) {
  try {
    const origin = new URL(url).origin;
    return ents.find((e) => e.origins?.includes(origin)) || null;
  } catch {
    return null;
  }
}

for (const strategy of STRATEGIES) {
  const dir = join(DATA, 'raw', strategy);
  let files = [];
  try { files = new Set(await readdir(dir)); } catch { files = new Set(); }

  for (const [url, template] of urlRows) {
    const f = `${slugFor(url)}.json`;
    if (!files.has(f)) { missing[strategy].push(url); continue; }
    const j = JSON.parse(await readFile(join(dir, f), 'utf8'));
    const lh = j.lighthouseResult;
    if (!lh || (lh.runtimeError && lh.runtimeError.code !== 'NO_ERROR')) { missing[strategy].push(url); continue; }
    const A = lh.audits;
    const ents = lh.entities || [];
    meta.lighthouseVersions.add(lh.lighthouseVersion);
    meta.fetchTimes.push(lh.fetchTime);
    meta.userAgents[strategy] = lh.environment?.networkUserAgent;
    (meta.benchmarkIndex[strategy] ||= []).push(lh.environment?.benchmarkIndex);

    // ---- metrics
    const num = (k) => A[k]?.numericValue ?? null;
    const scriptReqs = (A['network-requests']?.details?.items || []).filter((i) => i.resourceType === 'Script');
    // "own" = first party or the site platform (Framer) — everything else counts as third party
    const fp = (u) => {
      if (entityFor(u, ents)?.isFirstParty) return true;
      try {
        const h = new URL(u).hostname;
        return VENDORS.some((v) => v.platform && v.hosts.some((x) => h === x || h.endsWith('.' + x)));
      } catch { return false; }
    };
    const jsBytes = scriptReqs.reduce((s, i) => s + (i.transferSize || 0), 0);
    const jsBytes3p = scriptReqs.filter((i) => !fp(i.url)).reduce((s, i) => s + (i.transferSize || 0), 0);
    const mtwb = Object.fromEntries((A['mainthread-work-breakdown']?.details?.items || []).map((i) => [i.group, i.duration]));
    const field = j.loadingExperience?.metrics
      ? {
          scope: j.loadingExperience.origin_fallback ? 'origin' : 'url',
          overall: j.loadingExperience.overall_category,
          lcp: j.loadingExperience.metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
          inp: j.loadingExperience.metrics.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
          cls: j.loadingExperience.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
            ? j.loadingExperience.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
          fcp: j.loadingExperience.metrics.FIRST_CONTENTFUL_PAINT_MS?.percentile ?? null,
          ttfb: j.loadingExperience.metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile ?? null,
          categories: Object.fromEntries(Object.entries(j.loadingExperience.metrics).map(([k, v]) => [k, v.category])),
        }
      : null;
    if (!meta.originField && j.originLoadingExperience?.metrics) meta.originField = { [strategy]: j.originLoadingExperience };
    else if (j.originLoadingExperience?.metrics && !meta.originField[strategy]) meta.originField[strategy] = j.originLoadingExperience;

    // long tasks -> derived blocking time per script (sum of duration - 50ms)
    const ltByScript = {};
    for (const t of A['long-tasks']?.details?.items || []) {
      const k = scriptKey(t.url);
      ltByScript[k] = (ltByScript[k] || 0) + Math.max(0, t.duration - 50);
    }

    // LCP breakdown (Lighthouse 13 insight): subparts + the LCP element
    const lcpItems = A['lcp-breakdown-insight']?.details?.items || [];
    const lcpParts = Object.fromEntries((lcpItems.find((i) => i.type === 'table')?.items || []).map((i) => [i.subpart, i.duration]));
    const lcpNode = lcpItems.find((i) => i.type === 'node');
    const lcpSnippet = lcpNode?.snippet || '';
    const lcpTag = (lcpSnippet.match(/^<([a-z0-9-]+)/i)?.[1] || '').toLowerCase();
    // Framer "appear" animations leave inline opacity/transform styles on the element
    const lcpAnimated = /style="[^"]*(opacity|transform)\s*:/i.test(lcpSnippet);

    // Google tag ids loaded more than once on the same page
    const tagIds = {};
    let dupTagExtraBytes = 0;
    for (const r of scriptReqs) {
      const m = r.url.match(/googletagmanager\.com\/(?:gtag\/js|gtm\.js)\?id=([A-Z0-9-]+)/i);
      if (!m) continue;
      tagIds[m[1]] = (tagIds[m[1]] || 0) + 1;
      if (tagIds[m[1]] > 1) dupTagExtraBytes += r.transferSize || 0; // bytes of every copy after the first
    }
    const dupTags = Object.entries(tagIds).filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
    const editorBarReqs = scriptReqs.filter((r) => /framer\.com\/(edit|bootstrap)|app\.framerstatic\.com/.test(r.url));

    pages.push({
      url, template, strategy,
      lcpTtfb: r1(lcpParts.timeToFirstByte), lcpLoadDelay: r1(lcpParts.resourceLoadDelay), lcpLoadDuration: r1(lcpParts.resourceLoadDuration),
      lcpRenderDelay: r1(lcpParts.elementRenderDelay), lcpTag, lcpAnimated, lcpLabel: (lcpNode?.nodeLabel || '').slice(0, 120),
      googleTagIds: Object.keys(tagIds), dupTags, dupTagExtraBytes,
      editorBarRequests: editorBarReqs.length, editorBarBytes: editorBarReqs.reduce((s, r) => s + (r.transferSize || 0), 0),
      score: lh.categories.performance.score != null ? Math.round(lh.categories.performance.score * 100) : null,
      lcp: r1(num('largest-contentful-paint')), tbt: r1(num('total-blocking-time')), cls: r3(num('cumulative-layout-shift')),
      fcp: r1(num('first-contentful-paint')), si: r1(num('speed-index')), tti: r1(num('interactive')),
      ttfb: r1(A.metrics?.details?.items?.[0]?.timeToFirstByte),
      bootup: r1(num('bootup-time')),
      scriptEval: r1(mtwb.scriptEvaluation), scriptParse: r1(mtwb.scriptParseCompile), mainThread: r1(num('mainthread-work-breakdown')),
      unusedJsBytes: (A['unused-javascript']?.details?.items || []).reduce((s, i) => s + i.wastedBytes, 0),
      unusedJsMs: num('unused-javascript'),
      totalBytes: num('total-byte-weight'), jsBytes, jsBytes3p, jsRequests: scriptReqs.length,
      requests: (A['network-requests']?.details?.items || []).length,
      domSize: num('dom-size-insight') ?? num('dom-size'),
      longTasks: (A['long-tasks']?.details?.items || []).length,
      legacyBytes: num('legacy-javascript-insight') ?? num('legacy-javascript') ?? 0,
      duplicatedBytes: A['duplicated-javascript-insight']?.details?.debugData?.wastedBytes ?? num('duplicated-javascript') ?? 0,
      renderBlocking: (A['render-blocking-insight'] || A['render-blocking-resources'])?.details?.items?.length ?? 0,
      field,
    });

    // ---- per-script aggregate
    const touch = (key, ent) => {
      const id = `${strategy}|${key}`;
      return (scripts[id] ||= {
        strategy, key, entity: ent?.name || null, firstParty: !!ent?.isFirstParty, category: ent?.category || null,
        pages: new Set(), templates: {}, transfer: [], wasted: [], total: [], bootTotal: [], bootScript: [], bootParse: [], blocking: [], exampleUrl: null,
      });
    };
    const seenOnPage = new Set();
    for (const req of scriptReqs) {
      const k = scriptKey(req.url);
      const s = touch(k, entityFor(req.url, ents));
      s.exampleUrl ||= req.url;
      if (!seenOnPage.has(k)) {
        seenOnPage.add(k);
        s.pages.add(url);
        s.templates[template] = (s.templates[template] || 0) + 1;
        s._pageTransfer = 0;
      }
      s.transfer.push({ url, bytes: req.transferSize || 0 });
    }
    for (const i of A['unused-javascript']?.details?.items || []) {
      const s = touch(scriptKey(i.url), entityFor(i.url, ents));
      s.wasted.push(i.wastedBytes);
      s.total.push(i.totalBytes);
    }
    for (const i of A['bootup-time']?.details?.items || []) {
      if (i.url === url || i.url === lh.finalDisplayedUrl) continue; // the HTML document itself
      const s = touch(scriptKey(i.url), entityFor(i.url, ents));
      s.bootTotal.push(i.total);
      s.bootScript.push(i.scripting);
      s.bootParse.push(i.scriptParseCompile);
    }
    for (const [k, ms] of Object.entries(ltByScript)) {
      const s = scripts[`${strategy}|${k}`];
      if (s) s.blocking.push(ms);
    }

    // ---- per-entity aggregate (third-parties-insight)
    for (const e of (A['third-parties-insight'] || A['third-party-summary'])?.details?.items || []) {
      const name = typeof e.entity === 'string' ? e.entity : e.entity?.text;
      const ent = ents.find((x) => x.name === name);
      const id = `${strategy}|${name}`;
      const agg = (entities[id] ||= {
        strategy, name, category: ent?.category || null, homepage: ent?.homepage || null,
        isUnrecognized: !!ent?.isUnrecognized, firstParty: !!ent?.isFirstParty, origins: new Set(),
        pages: new Set(), templates: {}, transfer: [], mainThread: [], blocking: [],
      });
      (ent?.origins || []).forEach((o) => agg.origins.add(o));
      agg.pages.add(url);
      agg.templates[template] = (agg.templates[template] || 0) + 1;
      agg.transfer.push(e.transferSize || 0);
      agg.mainThread.push(e.mainThreadTime || 0);
      if (e.blockingTime != null) agg.blocking.push(e.blockingTime);
      else {
        // derive from long tasks attributed to this entity's origins
        let b = 0;
        for (const [k, ms] of Object.entries(ltByScript)) {
          try { if (ent?.origins?.includes(new URL(k.replace('{pixel-id}', 'x')).origin)) b += ms; } catch {}
        }
        agg.blocking.push(b);
      }
    }

    // ---- other JS audits
    const collect = (bucket, auditIds, bytesKey = 'wastedBytes') => {
      const a = auditIds.map((id) => A[id]).find(Boolean);
      for (const i of a?.details?.items || []) {
        const k = i.url ? scriptKey(i.url) : i.source || 'unknown';
        const id = `${strategy}|${k}`;
        const b = (otherAudits[bucket][id] ||= { strategy, key: k, pages: new Set(), bytes: [], ms: [], signals: new Set() });
        b.pages.add(url);
        if (i[bytesKey] != null) b.bytes.push(i[bytesKey]);
        if (i.wastedMs != null) b.ms.push(i.wastedMs);
        for (const s of i.subItems?.items || []) if (s.signal) b.signals.add(s.signal);
      }
    };
    collect('legacy', ['legacy-javascript-insight', 'legacy-javascript']);
    collect('duplicated', ['duplicated-javascript-insight', 'duplicated-javascript']);
    collect('unminified', ['unminified-javascript']);
    collect('renderBlocking', ['render-blocking-insight', 'render-blocking-resources'], 'totalBytes');
  }
}

// ---------- aggregate
const analysedCount = Object.fromEntries(STRATEGIES.map((s) => [s, pages.filter((p) => p.strategy === s).length]));
const templateCounts = {};
for (const [, t] of urlRows) templateCounts[t] = (templateCounts[t] || 0) + 1;

const vendorInfo = (entityName, key) => {
  const host = (() => { try { return new URL(key).hostname; } catch { return ''; } })();
  return VENDORS.find((v) => (entityName && v.entities?.includes(entityName)) || (host && v.hosts?.some((h) => host === h || host.endsWith('.' + h)))) || null;
};

const scriptList = Object.values(scripts).map((s) => {
  const n = analysedCount[s.strategy] || 1;
  const v = vendorInfo(s.entity, s.key);
  const transferPerPage = {};
  for (const t of s.transfer) transferPerPage[t.url] = (transferPerPage[t.url] || 0) + t.bytes;
  const tp = Object.values(transferPerPage);
  return {
    strategy: s.strategy,
    script: s.key,
    exampleUrl: s.exampleUrl || s.key,
    entity: s.entity,
    vendor: v?.vendor || (s.firstParty ? 'darkroomagency.com (first party)' : s.entity ? `${s.entity}` : '[UNKNOWN – TO VERIFY]'),
    vendorKnown: !!v || s.firstParty,
    purpose: v?.purpose || (s.firstParty ? 'first-party inline/document script' : '[UNKNOWN – TO VERIFY]'),
    firstParty: s.firstParty,
    category: v?.category || s.category,
    pagesLoaded: s.pages.size,
    pagesShare: r3(s.pages.size / n),
    siteWide: s.pages.size / n >= SITE_WIDE_SHARE,
    templates: s.templates,
    avgTransferBytes: Math.round(avg(tp) || 0),
    pagesFlaggedUnused: s.wasted.length,
    avgWastedBytes: Math.round(avg(s.wasted) || 0),
    totalWastedBytes: s.wasted.reduce((a, b) => a + b, 0),
    avgUnusedPct: s.total.length ? r1((s.wasted.reduce((a, b) => a + b, 0) / s.total.reduce((a, b) => a + b, 0)) * 100) : null,
    avgBootupMs: r1(avg(s.bootTotal)),
    avgScriptingMs: r1(avg(s.bootScript)),
    avgParseCompileMs: r1(avg(s.bootParse)),
    pagesWithLongTasks: s.blocking.length,
    avgBlockingMs: r1(s.blocking.length ? s.blocking.reduce((a, b) => a + b, 0) / s.pages.size || 0 : 0),
  };
}).filter((s) => s.pagesLoaded || s.pagesFlaggedUnused || s.avgBootupMs);

const entityList = Object.values(entities).map((e) => {
  const n = analysedCount[e.strategy] || 1;
  const v = vendorInfo(e.name, [...e.origins][0] || '');
  return {
    strategy: e.strategy, entity: e.name,
    vendor: v?.vendor || (e.isUnrecognized && !e.firstParty ? '[UNKNOWN – TO VERIFY]' : e.name),
    purpose: v?.purpose || '[UNKNOWN – TO VERIFY]',
    category: v?.category || e.category,
    verdict: v?.verdict || 'confirm with the team',
    owner: v?.owner || '[UNKNOWN – TO VERIFY]',
    firstParty: e.firstParty, platform: !!v?.platform,
    origins: [...e.origins],
    pagesLoaded: e.pages.size, pagesShare: r3(e.pages.size / n), siteWide: e.pages.size / n >= SITE_WIDE_SHARE,
    templates: e.templates,
    avgTransferBytes: Math.round(avg(e.transfer)), totalTransferBytes: e.transfer.reduce((a, b) => a + b, 0),
    avgMainThreadMs: r1(avg(e.mainThread)), avgBlockingMs: r1(avg(e.blocking)),
    blockingSource: 'derived from long-tasks (duration − 50 ms) — Lighthouse 13 no longer reports per-entity blocking time',
  };
}).sort((a, b) => b.avgMainThreadMs - a.avgMainThreadMs);

const flatOther = Object.fromEntries(
  Object.entries(otherAudits).map(([k, m]) => [
    k,
    Object.values(m).map((b) => ({
      strategy: b.strategy, script: b.key, pages: b.pages.size,
      avgBytes: Math.round(avg(b.bytes) || 0), avgMs: r1(avg(b.ms)), signals: [...b.signals],
    })).sort((a, b) => b.pages * b.avgBytes - a.pages * a.avgBytes),
  ]),
);

const metricKeys = ['score', 'lcp', 'tbt', 'cls', 'fcp', 'si', 'tti'];
function summarise(rows) {
  const o = { pages: rows.length };
  for (const k of [...metricKeys, 'bootup', 'scriptEval', 'unusedJsBytes', 'jsBytes', 'jsBytes3p', 'totalBytes', 'domSize', 'longTasks', 'legacyBytes']) {
    const xs = rows.map((r) => r[k]).filter((x) => x != null);
    o[k] = { avg: r3(avg(xs)), median: r3(median(xs)), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null };
  }
  for (const k of ['lcp', 'tbt', 'cls', 'fcp', 'si', 'tti']) {
    const d = { good: 0, ni: 0, poor: 0 };
    rows.forEach((r) => { const c = rate(k, r[k]); if (c) d[c]++; });
    o[k].dist = d;
  }
  return o;
}

const site = {};
const byTemplate = {};
for (const s of STRATEGIES) {
  const rows = pages.filter((p) => p.strategy === s);
  site[s] = summarise(rows);
  byTemplate[s] = Object.fromEntries(
    Object.keys(templateCounts).map((t) => [t, summarise(rows.filter((r) => r.template === t))]).filter(([, v]) => v.pages),
  );
}

// Cross-page signals used by the recommendations
const signals = {};
for (const s of STRATEGIES) {
  const rows = pages.filter((p) => p.strategy === s);
  const n = rows.length || 1;
  const dupCounts = {};
  rows.forEach((p) => p.dupTags.forEach((d) => { const id = d.split('×')[0]; dupCounts[id] = (dupCounts[id] || 0) + 1; }));
  const tagIdPages = {};
  rows.forEach((p) => p.googleTagIds.forEach((id) => (tagIdPages[id] = (tagIdPages[id] || 0) + 1)));
  const withLcp = rows.filter((p) => p.lcp != null);
  const tags = {};
  rows.forEach((p) => (tags[p.lcpTag || 'unknown'] = (tags[p.lcpTag || 'unknown'] || 0) + 1));
  signals[s] = {
    pages: rows.length,
    duplicateGoogleTags: dupCounts,
    avgDuplicateTagExtraBytes: Math.round(avg(rows.filter((p) => p.dupTags.length).map((p) => p.dupTagExtraBytes)) || 0),
    avgOwnJsBytes: Math.round(avg(rows.map((p) => p.jsBytes - p.jsBytes3p)) || 0),
    googleTagIdPages: tagIdPages,
    editorBarPages: rows.filter((p) => p.editorBarRequests > 0).length,
    avgEditorBarBytes: Math.round(avg(rows.filter((p) => p.editorBarRequests).map((p) => p.editorBarBytes)) || 0),
    avgEditorBarRequests: r1(avg(rows.filter((p) => p.editorBarRequests).map((p) => p.editorBarRequests))),
    lcpTags: tags,
    lcpAnimatedPages: rows.filter((p) => p.lcpAnimated).length,
    avgLcpRenderDelay: r1(avg(withLcp.map((p) => p.lcpRenderDelay).filter((x) => x != null))),
    medianLcpRenderDelay: r1(median(withLcp.map((p) => p.lcpRenderDelay).filter((x) => x != null))),
    avgLcpRenderDelayShare: r3(avg(withLcp.filter((p) => p.lcpRenderDelay != null && p.lcp).map((p) => p.lcpRenderDelay / p.lcp))),
    avgLcpTtfb: r1(avg(withLcp.map((p) => p.lcpTtfb).filter((x) => x != null))),
    avg3pShareOfJsBytes: r3(avg(rows.filter((p) => p.jsBytes).map((p) => p.jsBytes3p / p.jsBytes))),
  };
}

const failed = missing;
const fetchTimes = meta.fetchTimes.sort();
const summary = {
  generatedAt: new Date().toISOString(),
  source: 'PageSpeed Insights API v5 (runPagespeed), category=performance',
  lighthouseVersions: [...meta.lighthouseVersions],
  runWindow: { first: fetchTimes[0], last: fetchTimes.at(-1) },
  userAgents: meta.userAgents,
  benchmarkIndexMedian: Object.fromEntries(Object.entries(meta.benchmarkIndex).map(([k, v]) => [k, median(v)])),
  urlsInScope: urlRows.length,
  strategies: STRATEGIES,
  templateCounts,
  analysed: analysedCount,
  failed,
  errorLogLines: errorRows.length,
  siteWideThreshold: SITE_WIDE_SHARE,
  thresholds: THRESHOLDS,
  originField: meta.originField || null,
  site,
  signals,
  byTemplate,
  entities: entityList,
  scripts: scriptList.sort((a, b) => b.totalWastedBytes - a.totalWastedBytes),
  otherAudits: flatOther,
  pages,
};

await writeFile(join(DATA, 'summary.json'), JSON.stringify(summary, null, 1));

const cols = ['strategy', 'script', 'vendor', 'purpose', 'firstParty', 'category', 'pagesLoaded', 'pagesShare', 'siteWide',
  'avgTransferBytes', 'pagesFlaggedUnused', 'avgWastedBytes', 'totalWastedBytes', 'avgUnusedPct', 'avgBootupMs',
  'avgScriptingMs', 'avgParseCompileMs', 'pagesWithLongTasks', 'avgBlockingMs', 'templates'];
await writeFile(
  join(DATA, 'scripts.csv'),
  [cols.join(','), ...summary.scripts.map((s) => cols.map((c) => csvCell(c === 'templates' ? Object.entries(s.templates).map(([k, v]) => `${k}:${v}`).join(' ') : s[c])).join(','))].join('\n') + '\n',
);

console.log(`Analysed: ${STRATEGIES.map((s) => `${s} ${analysedCount[s]}`).join(', ')} of ${urlRows.length}`);
console.log(`Missing: ${STRATEGIES.map((s) => `${s} ${missing[s].length}`).join(', ')}`);
console.log(`Scripts: ${scriptList.length}  Entities: ${entityList.length}`);
for (const s of STRATEGIES) console.log(`${s}: avg score ${site[s].score.avg}, LCP ${site[s].lcp.avg}, TBT ${site[s].tbt.avg}, CLS ${site[s].cls.avg}`);
