// Phase 4 + 5 — Recommendations and landing page
// Reads data/summary.json, derives the executive summary and the prioritised
// action plan (every number is read from the PageSpeed data), and writes a
// single self-contained site/index.html plus site/scripts.csv.
//
// Usage: node scripts/build-site.mjs
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = JSON.parse(await readFile(join(ROOT, 'data', 'summary.json'), 'utf8'));
const M = 'mobile', D = 'desktop';
const HAS_D = (S.strategies || [M, D]).includes(D) && S.analysed.desktop > 0;

// ---------- formatting
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pct = (x) => `${Math.round(x * 100)}%`;
const n = (x) => Math.round(x).toLocaleString('en-US');

// ---------- lookups
const scripts = (strategy, re) => S.scripts.filter((s) => s.strategy === strategy && re.test(s.script));
const entity = (strategy, name) => S.entities.find((e) => e.strategy === strategy && e.entity === name);
const pagesOf = (strategy) => S.pages.filter((p) => p.strategy === strategy);
const N = { mobile: S.analysed.mobile, desktop: S.analysed.desktop };
function combine(rows, strategy) {
  // per-page cost of a group of scripts that load together
  return {
    pages: Math.max(0, ...rows.map((r) => r.pagesLoaded)),
    share: Math.max(0, ...rows.map((r) => r.pagesLoaded)) / (N[strategy] || 1),
    transfer: rows.reduce((a, r) => a + r.avgTransferBytes * (r.pagesLoaded / Math.max(1, ...rows.map((x) => x.pagesLoaded))), 0),
    wasted: rows.reduce((a, r) => a + r.avgWastedBytes * (r.pagesFlaggedUnused / Math.max(1, ...rows.map((x) => x.pagesLoaded))), 0),
    cpu: rows.reduce((a, r) => a + (r.avgBootupMs || 0) * (r.pagesLoaded / Math.max(1, ...rows.map((x) => x.pagesLoaded))), 0),
    blocking: rows.reduce((a, r) => a + (r.avgBlockingMs || 0), 0),
  };
}

// Impact rule (documented on the page): weighs pages affected, wasted bytes and main-thread cost.
// points = share of pages × (wasted KB / 50 + blocking ms / 50 + cpu ms / 150)
function impactOf({ share, wasted = 0, blocking = 0, cpu = 0 }) {
  const pts = share * (wasted / 1024 / 50 + blocking / 50 + cpu / 150);
  return { level: pts >= 2 ? 'High' : pts >= 0.75 ? 'Medium' : 'Low', pts: Math.round(pts * 100) / 100 };
}

const plan = { quick: [], major: [], nice: [] };
const exec = [];
const add = (bucket, item) => plan[bucket].push(item);

// =====================================================================
// 1. Duplicate Google tags
const dupIds = Object.entries(S.signals[M].duplicateGoogleTags).sort((a, b) => b[1] - a[1]);
if (dupIds.length) {
  const [id, pagesDup] = dupIds[0];
  const rows = scripts(M, new RegExp(`googletagmanager\\.com/gtag/js\\?id=${id}`));
  const one = rows[0];
  const extra = S.signals[M].avgDuplicateTagExtraBytes;
  // the duplicate costs its own transfer + roughly half the combined cpu / blocking of both copies
  const im = impactOf({ share: pagesDup / N[M], wasted: extra, cpu: (one.avgBootupMs || 0) / 2, blocking: (one.avgBlockingMs || 0) / 2 });
  add('quick', {
    title: `stop loading the google ads tag ${id} twice`,
    impact: im.level, impactPts: im.pts, effort: 'Low', owner: 'marketing / tag-manager owner + developer',
    metrics: ['tbt', 'lcp', 'js weight'],
    issue: `the gtag.js library for ${id} is requested twice on the same page: once from a hard-coded snippet and once more by google tag manager (the second copy carries gtm’s “&cx=c&gtm=…” parameters). the browser downloads, parses and runs the same library twice.`,
    evidence: [
      `${id} loaded more than once on ${pagesDup} of ${N[M]} mobile pages (${pct(pagesDup / N[M])})${HAS_D ? `; desktop: ${S.signals[D].duplicateGoogleTags[id] ?? 0} of ${N[D]}` : ''}.`,
      `the second copy adds ${kb(extra)} of transfer per page on average (mobile, measured from the network log).`,
      `both copies together (mobile, per page): ${kb(one.avgTransferBytes)} transfer, ${kb(one.avgWastedBytes)} flagged unused, ${one.avgBootupMs != null ? ms(one.avgBootupMs) : '—'} cpu, ${ms(one.avgBlockingMs || 0)} blocking.`,
      `removing one copy saves ~${kb(extra)} per page view and roughly half of that cpu time — estimate.`,
    ],
    fix: `keep a single copy. because gtm already loads ${id}, delete the hard-coded gtag snippet for ${id} from framer → site settings → custom code (head), and keep the google ads / google tag configured inside gtm. while there, check whether the ga4 tag that is also hard-coded can move into gtm so all google tags load through one container.`,
    code: `<!-- framer → site settings → custom code → <head> -->
<!-- REMOVE this block: gtm already loads ${id} -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${id}');
</script>
<!-- KEEP the gtm container snippet; configure ${id} as a
     "google tag" / "google ads conversion" tag inside GTM-… -->`,
    risk: `google ads conversion tracking and remarketing depend on this tag. confirm with the team first: check which copy fires the conversion events, then verify in gtm preview and google tag assistant that conversions still record before publishing.`,
  });
}

// =====================================================================
// 2. Delay marketing pixels (Meta, Vector, HubSpot) until after load
const fb = combine(scripts(M, /connect\.facebook\.net/), M);
const vec = combine(scripts(M, /vector\.co/), M);
const fbE = entity(M, 'Facebook'), vecE = entity(M, 'vector.co'), hsE = entity(M, 'Hubspot');
{
  const share = Math.max(fb.share, vec.share);
  const im = impactOf({ share, wasted: fb.wasted + vec.wasted, blocking: (fbE?.avgBlockingMs || 0) + (vecE?.avgBlockingMs || 0), cpu: (fbE?.avgMainThreadMs || 0) + (vecE?.avgMainThreadMs || 0) });
  add('quick', {
    title: 'remove the vector pixel and fire the meta pixel after the page has loaded',
    impact: im.level, impactPts: im.pts, effort: 'Low', owner: 'marketing (gtm owner) + framer site editor',
    metrics: ['tbt', 'inp', 'lcp'],
    issue: 'the meta pixel and the vector pixel start downloading and executing while the page is still rendering. their work competes with framer’s own javascript for the main thread on a slow phone, which pushes back interactivity and the largest paint. they are loaded from two different places, so the fix has two parts. the team has decided to remove vector rather than defer it.',
    evidence: [
      fbE ? `meta (connect.facebook.net): on ${fbE.pagesLoaded} of ${N[M]} pages, avg ${kb(fbE.avgTransferBytes)} transfer, ${ms(fbE.avgMainThreadMs)} main-thread and ${ms(fbE.avgBlockingMs)} blocking per page (mobile).` : null,
      vecE ? `vector (cdn.vector.co/pixel.js): on ${vecE.pagesLoaded} of ${N[M]} pages, avg ${kb(vecE.avgTransferBytes)} transfer, ${ms(vecE.avgMainThreadMs)} main-thread and ${ms(vecE.avgBlockingMs)} blocking per page (mobile).` : null,
      `lighthouse flags ${kb(fb.wasted + vec.wasted)} of that code as unused during the page load (avg per page, mobile).`,
      'where each one is loaded (checked in the live page source and the published gtm container, not from pagespeed data): the meta pixel (570736630527046) is a tag inside gtm-kk9p2zg. vector is not in gtm. it is hard-coded in framer → site settings → custom code, in the snippet placed at the end of <head>, which also holds the gtm loader, a google-site-verification meta tag and the organisation schema.',
    ].filter(Boolean),
    fix: 'vector (in framer), remove: the team has decided to remove vector. open site settings → custom code, find the end-of-<head> snippet that starts with “<!-- Google Tag Manager -->”, and delete only the vector <script> block (the one that starts with “(function(){ function drDenied()” and ends with “vector.load(…); })();</script>”). keep the gtm loader, the google-site-verification meta tag and the organisation schema in that snippet untouched, then publish. meta (in gtm), defer: add the small script below to framer’s custom code (end of <body>) so it pushes a “page_idle” event once the page has loaded, then move the meta pixel tag in gtm from the “all pages / page view” trigger to a custom event trigger named “page_idle”. it still fires on every page view, just after the page is usable.',
    code: `<!-- 1. framer → site settings → custom code → end of <head> snippet -->
<!-- delete only this block; keep gtm, the verification meta tag and the schema -->
<script>
(function(){
  function drDenied(){ ... }
  if (drDenied()) return;
  !function(e,r){ ... i.src="https://cdn.vector.co/pixel.js"; ... }(window,document);
  vector.load("b2a50759-7547-4b2b-9861-b362bf585b99");
})();
</script>

<!-- 2. framer → site settings → custom code → end of <body> (new snippet) -->
<!-- pushes an "idle" event for gtm once the page has finished loading -->
<script>
window.addEventListener('load', function () {
  (window.requestIdleCallback || function (cb) { setTimeout(cb, 1); })(function () {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: 'page_idle' });
  }, { timeout: 3000 });
});
</script>

// 3. gtm: triggers → new → custom event → event name "page_idle"
//    meta pixel tag: replace the "all pages" trigger with "page_idle"`,
    risk: 'removing vector stops its company-identification data and any audiences built from it; make sure whoever uses vector (sales / growth) knows the date it goes. delete the vector block only, not the whole snippet: deleting the snippet would also remove gtm, the site-verification tag and the schema. after publishing, check devtools → network for “vector” (there should be no requests). firing meta later can slightly lower recorded page views for visitors who leave within the first seconds, so watch event counts in meta events manager for a week after the change.',
  });
}

// =====================================================================
// 3. HubSpot loader (chat, banner, analytics, ads pixel)
const hsRows = scripts(M, /hs-scripts|hs-analytics|hs-banner|hsadspixel|usemessages/);
const chatE = entity(M, 'usemessages.com');
if (hsE || chatE) {
  const hsAll = combine(hsRows, M);
  const im = impactOf({ share: hsAll.share, wasted: hsAll.wasted, blocking: (hsE?.avgBlockingMs || 0) + (chatE?.avgBlockingMs || 0), cpu: (hsE?.avgMainThreadMs || 0) + (chatE?.avgMainThreadMs || 0) });
  add(im.level === 'High' ? 'quick' : 'nice', {
    title: 'load the hubspot chat widget only when someone wants to chat',
    impact: im.level, impactPts: im.pts, effort: 'Low', owner: 'developer + marketing (hubspot owner)',
    metrics: ['tbt', 'inp'],
    issue: 'the hubspot tracking loader pulls in four more scripts on every page: the chat widget, the cookie banner, analytics and the ads pixel. the chat widget is needed only by the few visitors who open it.',
    evidence: [
      ...hsRows.map((r) => `${r.script.replace('https://', '')}: on ${r.pagesLoaded} pages, avg ${kb(r.avgTransferBytes)}, ${r.avgBootupMs != null ? ms(r.avgBootupMs) : '—'} cpu per page (mobile).`),
      hsE ? `hubspot entity total: ${ms(hsE.avgMainThreadMs)} main-thread per page; chat widget (usemessages.com): ${chatE ? ms(chatE.avgMainThreadMs) : '—'}.` : null,
    ].filter(Boolean),
    fix: 'tell hubspot not to load the chat widget immediately and load it on the first interaction (or when a “chat with us” button is clicked). keep the analytics and cookie banner as they are.',
    code: `<!-- before the hubspot loader (js.hs-scripts.com/4521931.js) -->
<script>
  window.hsConversationsSettings = { loadImmediately: false };
  const loadChat = () => {
    window.HubSpotConversations?.widget?.load();
    ['pointerdown','keydown','scroll'].forEach(e => removeEventListener(e, loadChat));
  };
  window.hsConversationsOnReady = [() => {
    ['pointerdown','keydown','scroll'].forEach(e =>
      addEventListener(e, loadChat, { once: true, passive: true }));
  }];
</script>`,
    risk: 'chat is a sales channel and hs-banner.com is the hubspot cookie-consent banner. confirm with the team first. do not delay the consent banner (that can conflict with consent requirements); only the chat widget is changed here.',
  });
}

// =====================================================================
// 4. Framer appear animations on the LCP element
{
  const sm = S.signals[M], sd = HAS_D ? S.signals[D] : null;
  const share = sm.lcpAnimatedPages / N[M];
  const lcpPoor = S.site[M].lcp.dist.poor;
  const textLcp = (sm.lcpTags.h1 || 0) + (sm.lcpTags.h2 || 0) + (sm.lcpTags.p || 0) + (sm.lcpTags.div || 0) + (sm.lcpTags.span || 0);
  const animatedByTpl = {};
  pagesOf(M).filter((p) => p.lcpAnimated).forEach((p) => (animatedByTpl[p.template] = (animatedByTpl[p.template] || 0) + 1));
  const tplList = Object.entries(animatedByTpl).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t.replace(/-/g, ' ')} (${c})`).join(', ');
  add(share >= 0.15 ? 'quick' : 'nice', {
    title: 'show the hero headline and image without waiting for an animation',
    impact: share >= 0.3 ? 'High' : share >= 0.1 ? 'Medium' : 'Low', impactPts: null, effort: share >= 0.15 ? 'Low' : 'Low', owner: 'developer / framer designer',
    metrics: ['lcp'],
    issue: `on many pages the largest element above the fold (usually the h1 or hero image) uses a framer “appear” effect. it starts invisible or offset and only reaches its final state after framer’s javascript has downloaded, run and animated it, so the largest contentful paint waits for javascript.`,
    evidence: [
      `${sm.lcpAnimatedPages} of ${N[M]} mobile pages (${pct(share)})${sd ? ` and ${sd.lcpAnimatedPages} of ${N[D]} desktop pages` : ''} have an lcp element still carrying framer’s inline opacity/transform animation styles.`,
      `most affected templates (mobile): ${tplList || '—'}.`,
      `lcp element type on mobile: ${Object.entries(sm.lcpTags).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${c}`).join(', ')} — ${textLcp} pages have text as the largest element.`,
      `average lab lcp ${ms(S.site[M].lcp.avg)} on mobile; ${lcpPoor} of ${N[M]} pages are in google’s “poor” band (> 4 s).`,
      `the observed (unthrottled) element render delay averages ${ms(sm.avgLcpRenderDelay)} on mobile — the time between the page being able to paint the element and actually painting it.`,
    ],
    fix: 'in framer, remove the appear effect (or set its initial opacity to 100% and animate only position) on the hero h1, hero image and any element above the fold on mobile breakpoints. keep entrance animations for content further down the page.',
    code: `/* if an appear effect has to stay, animate only transform,
   never start the hero at opacity 0. in framer:
   hero h1 → effects → appear → opacity: 1 (start) → 1 (end)
                              → offset y: 12 → 0            */

/* equivalent css for a code component / override */
.hero-title { opacity: 1; animation: rise .4s ease-out both; }
@keyframes rise { from { transform: translateY(12px); } to { transform: none; } }`,
    risk: 'purely visual — no tracking impact. check with design that the hero still feels right without the fade.',
  });
}

// =====================================================================
// 5. Vimeo embeds → facade
const vimeoE = entity(M, 'Vimeo');
if (vimeoE) {
  const vRows = scripts(M, /vimeocdn\.com|player\.vimeo\.com|vimeo\.com/);
  const vC = combine(vRows, M);
  const tpl = Object.entries(vimeoE.templates).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t.replace(/-/g, ' ')} ${c}`).join(', ');
  const im = impactOf({ share: vimeoE.pagesShare, wasted: vC.wasted, blocking: vimeoE.avgBlockingMs, cpu: vimeoE.avgMainThreadMs });
  add(im.level === 'High' ? 'quick' : 'major', {
    title: 'replace vimeo players with a lightweight poster until played',
    impact: im.level === 'Low' && vimeoE.avgMainThreadMs > 100 ? 'Medium' : im.level, impactPts: im.pts, effort: 'Medium', owner: 'developer',
    metrics: ['tbt', 'lcp', 'page weight'],
    issue: 'pages with video embed the full vimeo player (iframe + player javascript + the video stream) on load, even before the visitor scrolls to it or presses play.',
    evidence: [
      `vimeo loads on ${vimeoE.pagesLoaded} of ${N[M]} mobile pages (${tpl}).`,
      `on those pages it averages ${kb(vimeoE.avgTransferBytes)} transfer (player code plus video bytes), ${ms(vimeoE.avgMainThreadMs)} main-thread and ${ms(vimeoE.avgBlockingMs)} blocking (mobile).`,
      ...vRows.slice(0, 3).map((r) => `${r.script.replace('https://', '')}: avg ${kb(r.avgTransferBytes)}, ${kb(r.avgWastedBytes)} unused, ${r.avgBootupMs != null ? ms(r.avgBootupMs) : '—'} cpu.`),
    ],
    fix: 'in the custom “darkroomvimeo” framer component, render a poster image (vimeo thumbnail or a static frame) with a play button, and only inject the vimeo iframe on click. for decorative autoplay loops, use a muted self-hosted mp4 with preload="none" that starts when it scrolls into view.',
    code: `// DarkroomVimeo code component — facade pattern
export default function VimeoFacade({ id, poster, title }) {
  const [play, setPlay] = React.useState(false)
  if (play) return (
    <iframe src={\`https://player.vimeo.com/video/\${id}?autoplay=1\`}
      allow="autoplay; fullscreen" title={title} loading="lazy"
      style={{ width: "100%", aspectRatio: "16/9", border: 0 }} />)
  return (
    <button onClick={() => setPlay(true)} aria-label={\`play \${title}\`}
      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}>
      <img src={poster} alt="" loading="lazy" style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover" }} />
    </button>)
}`,
    risk: 'no tracking impact. if any video is meant to autoplay as a hero background, keep autoplay but switch to a lightweight muted mp4; confirm the intent with design/content.',
  });
}

// =====================================================================
// 6. Framer runtime weight
{
  const fr = entity(M, 'Framer CDN');
  const core = scripts(M, /framerusercontent\.com\/sites\/[^/]+\/(react|framer|motion|toplevel-deps|shared-lib|shared|script_main)\./);
  const top = [...scripts(M, /framerusercontent\.com/)].sort((a, b) => (b.avgBootupMs || 0) - (a.avgBootupMs || 0)).slice(0, 4);
  const coreC = combine(core, M);
  if (fr) {
    const im = impactOf({ share: fr.pagesShare, wasted: coreC.wasted, blocking: fr.avgBlockingMs, cpu: fr.avgMainThreadMs });
    add('major', {
      title: 'slim down framer’s own javascript: fewer effects and heavy components',
      impact: im.level, impactPts: im.pts, effort: 'High', owner: 'developer / framer designer',
      metrics: ['tbt', 'lcp', 'tti'],
      issue: 'framer ships react, its animation library (motion) and a bundle per component on every page. it is the largest single source of main-thread work. the platform code itself can’t be removed or self-hosted, but how much of it runs depends on how pages are built: scroll and appear effects, code components, and elements hidden per breakpoint still being rendered.',
      evidence: [
        `framer javascript: ${kb(S.signals[M].avgOwnJsBytes)} of script transfer and ${ms(fr.avgMainThreadMs)} main-thread work per page on mobile, on ${fr.pagesLoaded} of ${N[M]} pages.`,
        ...top.map((r) => `${r.script.split('/').pop()}: ${ms(r.avgBootupMs || 0)} cpu, ${kb(r.avgWastedBytes)} unused of ${kb(r.avgTransferBytes)} (avg, mobile, ${r.pagesLoaded} pages).`),
        `core framer bundles flagged unused: ${kb(coreC.wasted)} per page (lighthouse estimate).`,
      ],
      fix: 'audit the master components used site-wide (nav, footer, hero, cta blocks): remove scroll-linked and appear effects that aren’t essential, replace layers hidden on mobile with breakpoint-specific variants instead of hidden copies, and check custom code components (e.g. liquidgradient, darkroomvimeo) for heavy work on load. re-test the homepage, one case study and one article after each change.',
      code: null,
      risk: 'design-led change — no tracking impact, but it changes how pages feel. agree with design which effects are brand-critical before removing them.',
    });
  }
}

// =====================================================================
// 7. GTM container hygiene
{
  const gtm = scripts(M, /gtm\.js\?id=/);
  const ga4 = scripts(M, /gtag\/js\?id=G-/);
  if (gtm.length) {
    const g = gtm[0];
    const im = impactOf({ share: g.pagesShare, wasted: g.avgWastedBytes + (ga4[0]?.avgWastedBytes || 0), blocking: (g.avgBlockingMs || 0) + (ga4[0]?.avgBlockingMs || 0), cpu: (g.avgBootupMs || 0) + (ga4[0]?.avgBootupMs || 0) });
    add('major', {
      title: 'clean up the tag manager container and load google analytics through it',
      impact: im.level, impactPts: im.pts, effort: 'Medium', owner: 'marketing / tag-manager owner',
      metrics: ['tbt', 'js weight'],
      issue: 'the gtm container and the separately hard-coded ga4 library are among the heaviest scripts on every page, and most of their code is unused during the page load. old or paused tags, unused variables and duplicated google tags all make the container larger.',
      evidence: [
        `${g.script.replace('https://www.', '')}: avg ${kb(g.avgTransferBytes)}, ${kb(g.avgWastedBytes)} unused (${g.avgUnusedPct}%), ${ms(g.avgBootupMs || 0)} cpu per page, on ${g.pagesLoaded} of ${N[M]} pages (mobile).`,
        ...ga4.map((r) => `${r.script.replace('https://www.', '')} (hard-coded): avg ${kb(r.avgTransferBytes)}, ${kb(r.avgWastedBytes)} unused, ${ms(r.avgBootupMs || 0)} cpu per page.`),
      ],
      fix: 'export the container and review every tag: delete paused or legacy tags, remove unused custom html tags and variables, and set triggers so page-specific tags (e.g. form or booking conversions) fire only on the pages that need them. then configure ga4 as a google tag inside gtm and remove the hard-coded ga4 snippet from framer custom code.',
      code: `// fire page-specific tags only where needed
// gtm → trigger → page view → "some page views"
//   page path  matches regex  ^/book-a-call
// attach booking / form conversion tags to this trigger`,
      risk: 'every tag in the container may be used for reporting or ad attribution. confirm with the team first, use gtm’s workspace + preview mode, and keep a container export as a rollback.',
    });
  }
}

// =====================================================================
// 8. Framer editor bar on the live site
{
  const sm = S.signals[M];
  if (sm.editorBarPages) {
    add('nice', {
      title: 'turn off framer’s on-page editor bar for visitors',
      impact: 'Low', impactPts: null, effort: 'Low', owner: 'developer / framer admin',
      metrics: ['requests'],
      issue: 'every page also requests framer’s editor-bar scripts (framer.com/edit/init.mjs, framer.com/bootstrap…js, app.framerstatic.com/editorbar…). they are used for editing the site from the browser and add requests for normal visitors.',
      evidence: [
        `editor-bar scripts load on ${sm.editorBarPages} of ${N[M]} mobile pages: ${sm.avgEditorBarRequests} requests, ${kb(sm.avgEditorBarBytes)} per page.`,
      ],
      fix: 'in framer’s site settings, switch off the on-page editing / editor bar option for the published site, then republish and confirm the requests are gone.',
      code: null,
      risk: 'content editors who use on-page editing would lose that shortcut. confirm with whoever maintains the site.',
    });
  }
}

// =====================================================================
// 9. Legacy JS in vendor scripts
{
  const leg = S.otherAudits.legacy.filter((l) => l.strategy === M);
  if (leg.length) {
    add('nice', {
      title: 'ask vendors for modern builds of their scripts',
      impact: 'Low', impactPts: null, effort: 'Low', owner: 'marketing (vendor contact)',
      metrics: ['js weight'],
      issue: 'some third-party scripts still ship polyfills and old-browser transforms that modern browsers don’t need. you can’t change vendor code, but you can ask, or prefer vendors that ship modern bundles.',
      evidence: leg.slice(0, 4).map((l) => `${l.script.replace('https://', '')}: ~${kb(l.avgBytes)} of legacy code on ${l.pages} pages (e.g. ${l.signals.slice(0, 3).join(', ')}).`),
      fix: 'no site change needed; raise it with the vendor. treat it as a tie-breaker when reviewing tools.',
      code: null,
      risk: null,
    });
  }
}

// =====================================================================
// 10. Unknown endpoints
{
  const unk = S.entities.filter((e) => e.strategy === M && e.vendor.includes('UNKNOWN'));
  if (unk.length) {
    add('nice', {
      title: 'identify the unlabelled tracking endpoint',
      impact: 'Low', impactPts: null, effort: 'Low', owner: 'developer + marketing',
      metrics: ['governance'],
      issue: 'at least one script sends data to a domain that lighthouse can’t attribute to a known vendor. it costs almost nothing in performance, but every tool on the site should have a known owner.',
      evidence: unk.map((u) => `${u.origins.join(', ').replace(/https:\/\//g, '')}: on ${u.pagesLoaded} of ${N[M]} pages, ${kb(u.avgTransferBytes)} per page. [UNKNOWN – TO VERIFY]`),
      fix: 'search the gtm container and framer custom code for this host to find which tag calls it, then record its owner and purpose.',
      code: null,
      risk: 'confirm with the team first — do not block it until its owner is known.',
    });
  }
}

// ---------- order buckets by impact
const rank = { High: 3, Medium: 2, Low: 1 };
const effortRank = { Low: 1, Medium: 2, High: 3 };
// Bucket by one rule: low impact → nice-to-have; otherwise low effort → quick win, else major project
const all = [...plan.quick, ...plan.major, ...plan.nice];
for (const k of Object.keys(plan)) plan[k] = [];
for (const it of all) plan[it.impact === 'Low' ? 'nice' : it.effort === 'Low' ? 'quick' : 'major'].push(it);
for (const k of Object.keys(plan)) plan[k].sort((a, b) => rank[b.impact] - rank[a.impact] || effortRank[a.effort] - effortRank[b.effort] || (b.impactPts || 0) - (a.impactPts || 0));

// =====================================================================
// Executive summary
{
  const sm = S.site[M], sd = HAS_D ? S.site[D] : null;
  const lcpBad = sm.lcp.dist.poor + sm.lcp.dist.ni;
  exec.push({
    stat: sd ? `${Math.round(sm.score.avg)} / ${Math.round(sd.score.avg)}` : `${Math.round(sm.score.avg)}/100`,
    title: sd ? 'mobile vs desktop score' : 'average mobile score',
    text: `the average page scores ${Math.round(sm.score.avg)} out of 100 on a mid-range phone${sd ? ` and ${Math.round(sd.score.avg)} on desktop` : ''}. ${pct(lcpBad / N[M])} of pages are slower than google’s 2.5-second target for showing their main content on mobile.`,
  });
  const sig = S.signals[M];
  exec.push({
    stat: pct(sig.avg3pShareOfJsBytes),
    title: 'of the javascript is third-party',
    text: `of the ${kb(sm.jsBytes.avg)} of javascript a typical page downloads on mobile, about ${pct(sig.avg3pShareOfJsBytes)} comes from marketing, analytics and video tools rather than the site itself. most of it loads while the page is still being drawn.`,
  });
  const dup = Object.entries(sig.duplicateGoogleTags)[0];
  if (dup) {
    exec.push({
      stat: '2×', title: 'google ads tag loaded twice',
      text: `the same google ads tag is downloaded twice on ${pct(dup[1] / N[M])} of pages, about ${kb(sig.avgDuplicateTagExtraBytes)} extra each time. removing the duplicate is a small change; conversion tracking just needs to be re-checked afterwards.`,
    });
  }
  if (sig.lcpAnimatedPages / N[M] >= 0.1) {
    exec.push({
      stat: pct(sig.lcpAnimatedPages / N[M]),
      title: 'of pages fade in their hero',
      text: `on ${sig.lcpAnimatedPages} of ${N[M]} pages the biggest element at the top of the screen is animated in by javascript, so visitors wait for scripts before they see the headline or hero image.`,
    });
  } else {
    const tbt = sm.tbt;
    exec.push({
      stat: ms(tbt.avg),
      title: 'page frozen by javascript',
      text: `on a typical phone the page is too busy running javascript to respond to taps for about ${ms(tbt.avg)} while loading (total blocking time; google’s target is under 200 ms). ${tbt.dist.poor} of ${N[M]} pages are over 600 ms, which google rates “poor”.`,
    });
  }
  const fr = entity(M, 'Framer CDN'), gt = entity(M, 'Google Tag Manager'), fbE2 = entity(M, 'Facebook');
  if (fr && gt) {
    exec.push({
      stat: ms(fr.avgMainThreadMs + gt.avgMainThreadMs + (fbE2?.avgMainThreadMs || 0)),
      title: 'of processor work per page',
      text: `framer’s own code (${ms(fr.avgMainThreadMs)}), google’s tags (${ms(gt.avgMainThreadMs)}) and the meta pixel (${ms(fbE2?.avgMainThreadMs || 0)}) are the biggest consumers of a phone’s processor on each page load (lab, slowed-down mobile cpu).`,
    });
  }
  const tpls = Object.entries(S.byTemplate[M]).filter(([, v]) => v.pages >= 3).sort((a, b) => a[1].score.avg - b[1].score.avg);
  if (tpls.length) {
    const [wt, wv] = tpls[0], [bt, bv] = tpls.at(-1);
    exec.push({
      stat: `${Math.round(wv.score.avg)}`, title: `worst template: ${wt.replace(/-/g, ' ')}`,
      text: `${wt.replace(/-/g, ' ')} pages (${wv.pages}) average ${Math.round(wv.score.avg)} on mobile, against ${Math.round(bv.score.avg)} for ${bt.replace(/-/g, ' ')} pages. fixes in the shared site template help every page type at once.`,
    });
  }
}

const RECS = {
  exec: exec.slice(0, 6),
  plan: [
    { group: 'quick wins', blurb: 'high impact, low effort — do these first', items: plan.quick },
    { group: 'major projects', blurb: 'high impact, more effort or coordination', items: plan.major },
    { group: 'nice-to-haves', blurb: 'smaller gains or housekeeping', items: plan.nice },
  ].filter((g) => g.items.length),
  impactRule: 'points = share of pages affected × (unused kb ÷ 50 + blocking ms ÷ 50 + cpu ms ÷ 150); high ≥ 2, medium ≥ 0.75',
};
await writeFile(join(ROOT, 'data', 'recommendations.json'), JSON.stringify(RECS, null, 1));

// ---------- page
const tpl = await readFile(join(ROOT, 'site', 'template.html'), 'utf8');
const slim = { ...S, pages: S.pages.map(({ field, ...p }) => ({ ...p, fieldScope: field?.scope ?? null })) };
const safe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const html = tpl.replace('<!--DATA-->', `<script>window.AUDIT=${safe(slim)};window.RECS=${safe(RECS)};</script>`);
await writeFile(join(ROOT, 'site', 'index.html'), html);
await copyFile(join(ROOT, 'data', 'scripts.csv'), join(ROOT, 'site', 'scripts.csv'));
console.log(`site/index.html written (${Math.round(html.length / 1024)} KB) — ${RECS.exec.length} findings, ${plan.quick.length + plan.major.length + plan.nice.length} recommendations`);
for (const g of RECS.plan) console.log(`  ${g.group}: ${g.items.map((i) => `${i.title} [${i.impact}/${i.effort}${i.impactPts != null ? ' ' + i.impactPts : ''}]`).join(' | ')}`);
