# darkroomagency.com — JavaScript performance audit

A site-wide audit of JavaScript cost on https://www.darkroomagency.com/, built from
PageSpeed Insights (Lighthouse) lab runs for every indexable URL, mobile and desktop.

**Open the report:** double-click `site/index.html` (it's self-contained; no server needed).

## Folder structure

```
scripts/
  discover-urls.mjs   Phase 1 – robots.txt + sitemap → validated, de-duplicated URL list
  run-pagespeed.mjs   Phase 2 – PSI API calls (mobile + desktop), resumable
  analyze.mjs         Phase 3 – aggregates raw Lighthouse JSON into summary + CSV
  vendors.mjs         vendor lookup (domain → vendor, purpose, default verdict, owner)
  build-site.mjs      Phase 4–5 – derives recommendations and writes site/index.html
data/
  urls.csv            url, template (pages in scope)
  urls-excluded.csv   sitemap entries left out and why (redirects, noindex, …)
  raw/{mobile,desktop}/{slug}.json   raw PSI responses  (git-ignored)
  errors.csv          failed calls after retries        (git-ignored)
  summary.json        all aggregates used by the report
  scripts.csv         one row per script × strategy
  recommendations.json  the generated action plan
site/
  template.html       report template (edit layout here)
  index.html          generated report (data inlined)
  scripts.csv         copy of data/scripts.csv for the download link
```

## Requirements

- Node.js 20.6+ (uses built-in `fetch` and `--env-file`). No npm packages.
- A PageSpeed Insights API key (Google Cloud console → APIs & Services → Credentials,
  with the PageSpeed Insights API enabled).

## Re-running the audit

1. Put the key in a `.env` file in this folder (git-ignored), or set it in your environment:

   ```
   PSI_API_KEY=your_key_here
   ```

   The scripts read it from `process.env.PSI_API_KEY` and send it in the
   `X-Goog-Api-Key` header, so it never appears in URLs, logs or output files.

2. Run the phases:

   ```powershell
   node scripts/discover-urls.mjs
   node --env-file-if-exists=.env scripts/run-pagespeed.mjs
   node scripts/analyze.mjs
   node scripts/build-site.mjs
   ```

   - `run-pagespeed.mjs` skips any URL that already has a file in `data/raw/{strategy}/`,
     so it can be stopped and restarted. **For a fresh audit, delete `data/raw/` first.**
   - Options: `--strategy=mobile|desktop` to run one strategy, `--limit=N` for a test run.
   - Concurrency is 4 with a 2 s pause between batches and up to 3 retries with exponential
     backoff (30 s+ after HTTP 429). A full run (≈475 URLs × 2) takes about 2 hours and uses
     ≈950 of the API's 25,000 daily queries.
   - To retry failures, just run it again — failed URLs have no raw file and get fetched.
   - `node scripts/analyze.mjs --strategies=mobile` builds a mobile-only report (the current
     edition: the desktop run was stopped at 87 of 475 pages). To add desktop later, run
     `node --env-file-if-exists=.env scripts/run-pagespeed.mjs --strategy=desktop` (it resumes),
     then `node scripts/analyze.mjs` and `node scripts/build-site.mjs`.

## How the numbers are produced

- **Templates** are assigned from the URL path (`discover-urls.mjs → template()`).
- **Script aggregation** merges a script's URLs across pages by origin + path (query strings
  dropped, except GTM/gtag container ids). "Site-wide" = loads on ≥ 90 % of analysed pages.
- **Unused bytes** come from `unused-javascript`; **CPU** from `bootup-time`;
  **main-thread time per vendor** from `third-parties-insight`.
- **Blocking time per script/vendor** is derived: the sum of (long-task duration − 50 ms)
  for long tasks attributed to that script in `long-tasks`. Lighthouse 13 no longer reports
  per-vendor blocking time directly.
- **Impact** in the action plan: `share of pages × (unused KB ÷ 50 + blocking ms ÷ 50 +
  CPU ms ÷ 150)`; High ≥ 2, Medium ≥ 0.75. Quick wins = low effort and medium/high impact.
- **Vendors** are identified from Lighthouse's entity list and `scripts/vendors.mjs`.
  Anything not identifiable from its URL is labelled `[UNKNOWN – TO VERIFY]`.

## Limitations

- Lab data: one simulated load per URL from Google's servers. Scores vary between runs
  (often ±5–10 points), so read averages and patterns rather than single URLs.
- Lighthouse doesn't scroll, click or accept cookies, so scripts loaded on interaction
  or after consent are under-counted.
- Field data (CrUX) is mostly origin-level for this site; URL-level data exists only for
  higher-traffic pages.
- Savings are Lighthouse estimates, not measured before/after results. Re-run the audit
  after each fix to measure it.
