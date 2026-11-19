// Phase 2 — PageSpeed Insights run
// Calls the PSI v5 API for every URL in data/urls.csv, for mobile and desktop.
// - max 4 requests in flight, pause between batches
// - up to 3 retries with exponential backoff (longer on HTTP 429)
// - each raw JSON response saved to data/raw/{strategy}/{slug}.json; existing
//   files are skipped, so the run resumes where it stopped
// - failures appended to data/errors.csv (the run never stops on a failure)
//
// The API key is read from process.env.PSI_API_KEY and sent in the
// X-Goog-Api-Key header, so it never appears in a URL, log or file.
//
// Usage:  node --env-file-if-exists=.env scripts/run-pagespeed.mjs [--strategy=mobile|desktop] [--limit=N]
import { readFile, writeFile, mkdir, appendFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CONCURRENCY = 4;
const BATCH_PAUSE_MS = 2000;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 180_000;

const KEY = process.env.PSI_API_KEY;
if (!KEY) {
  console.error('PSI_API_KEY is not set. Put it in .env (PSI_API_KEY=...) or the environment.');
  process.exit(1);
}
const scrub = (s) => String(s).split(KEY).join('[REDACTED]');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]),
);
const strategies = args.strategy ? [args.strategy] : ['mobile', 'desktop'];
const limit = args.limit ? Number(args.limit) : Infinity;

export const slugFor = (url) => {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, '');
  return p ? p.replace(/[^a-z0-9-]+/gi, '__') : 'home';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const urls = (await readFile(join(DATA, 'urls.csv'), 'utf8'))
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => l.split(',')[0])
  .slice(0, limit);

const errorsFile = join(DATA, 'errors.csv');
if (!(await exists(errorsFile))) await writeFile(errorsFile, 'timestamp,url,strategy,attempts,http_status,error\n');
const logError = (url, strategy, attempts, status, msg) =>
  appendFile(
    errorsFile,
    [new Date().toISOString(), url, strategy, attempts, status, scrub(msg).slice(0, 500)].map(csvCell).join(',') + '\n',
  );

async function callPsi(url, strategy) {
  const qs = new URLSearchParams({ url, strategy, category: 'performance' });
  let lastStatus = 0;
  let lastErr = '';
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const r = await fetch(`${ENDPOINT}?${qs}`, {
        headers: { 'X-Goog-Api-Key': KEY },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      lastStatus = r.status;
      const body = await r.text();
      if (r.ok) {
        const json = JSON.parse(body);
        const rt = json.lighthouseResult?.runtimeError;
        if (!rt || rt.code === 'NO_ERROR') return { ok: true, json, attempts: attempt };
        lastErr = `Lighthouse runtimeError ${rt.code}: ${rt.message}`;
        if (attempt > MAX_RETRIES) return { ok: false, json, attempts: attempt, status: lastStatus, error: lastErr };
      } else {
        let msg = body;
        try { msg = JSON.parse(body).error?.message || body; } catch {}
        lastErr = `HTTP ${r.status}: ${msg}`;
        // 4xx other than 429/408 won't succeed on retry
        if (r.status >= 400 && r.status < 500 && ![408, 429].includes(r.status)) break;
      }
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS / 1000}s` : e.message;
    }
    if (attempt <= MAX_RETRIES) {
      const base = lastStatus === 429 ? 30_000 : 4_000;
      await sleep(base * 2 ** (attempt - 1) + Math.random() * 1000);
    }
  }
  return { ok: false, attempts: MAX_RETRIES + 1, status: lastStatus, error: lastErr };
}

for (const strategy of strategies) {
  const dir = join(DATA, 'raw', strategy);
  await mkdir(dir, { recursive: true });
  const todo = [];
  for (const url of urls) if (!(await exists(join(dir, `${slugFor(url)}.json`)))) todo.push(url);
  console.log(`[${strategy}] ${urls.length - todo.length} already done, ${todo.length} to fetch`);

  let done = 0, failed = 0;
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (url) => {
        const res = await callPsi(url, strategy);
        if (res.ok) {
          await writeFile(join(dir, `${slugFor(url)}.json`), JSON.stringify(res.json));
          done++;
        } else {
          failed++;
          await logError(url, strategy, res.attempts, res.status ?? '', res.error);
          console.log(`  FAIL ${url} — ${scrub(res.error)}`);
        }
      }),
    );
    const n = done + failed;
    const rate = (Date.now() - t0) / n;
    console.log(
      `[${strategy}] ${n}/${todo.length} (ok ${done}, failed ${failed}) — ETA ${Math.round(((todo.length - n) * rate) / 60000)} min`,
    );
    if (i + CONCURRENCY < todo.length) await sleep(BATCH_PAUSE_MS);
  }
  console.log(`[${strategy}] finished: ok ${done}, failed ${failed}`);
}
