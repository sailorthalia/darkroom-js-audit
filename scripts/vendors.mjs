// Vendor lookup used by analyze.mjs.
// Matched by the Lighthouse entity name or by script hostname. Only vendors that
// can be identified with confidence from the URL are listed; anything else is
// reported as "[UNKNOWN – TO VERIFY]".
//
// verdict: keep | defer | lazy-load | remove | confirm with the team
// platform: true = part of the site's own runtime (not removable)
export const VENDORS = [
  {
    vendor: 'Framer (site platform)', entities: ['Framer CDN', 'framer.com'],
    hosts: ['framerusercontent.com', 'framer.com', 'framerstatic.com', 'events.framer.com'],
    purpose: 'The site builder runtime: React, Framer Motion animations, page bundles, plus Framer page-view events',
    category: 'platform', verdict: 'keep (optimise inside Framer)', owner: 'developer / Framer site builder', platform: true,
  },
  {
    vendor: 'Google Tag Manager / gtag.js', entities: ['Google Tag Manager'], hosts: ['googletagmanager.com'],
    purpose: 'Tag manager container plus gtag.js libraries for Google Analytics 4 and Google Ads',
    category: 'tag-manager', verdict: 'defer & consolidate (confirm with the team)', owner: 'marketing / tag-manager owner',
  },
  {
    vendor: 'Google Analytics', entities: ['Google Analytics'], hosts: ['google-analytics.com', 'analytics.google.com'],
    purpose: 'GA4 measurement hits', category: 'analytics', verdict: 'keep (confirm with the team)', owner: 'marketing / analytics',
  },
  {
    vendor: 'Google Ads / DoubleClick', entities: ['Google/Doubleclick Ads'], hosts: ['doubleclick.net', 'googleadservices.com', 'googlesyndication.com'],
    purpose: 'Google Ads conversion and remarketing tags', category: 'advertising', verdict: 'confirm with the team', owner: 'marketing / paid media',
  },
  {
    vendor: 'Meta (Facebook Pixel)', entities: ['Facebook'], hosts: ['connect.facebook.net', 'facebook.com', 'facebook.net'],
    purpose: 'Meta Pixel: ad conversion tracking and audiences', category: 'advertising', verdict: 'defer (confirm with the team)', owner: 'marketing / paid media',
  },
  {
    vendor: 'HubSpot', entities: ['Hubspot', 'HubSpot'], hosts: ['hs-analytics.net', 'hs-scripts.com', 'hsforms.net', 'hsforms.com', 'hubspot.com', 'hs-banner.com', 'hscollectedforms.net', 'hsadspixel.net', 'hubapi.com'],
    purpose: 'HubSpot tracking code, forms and CRM analytics', category: 'marketing', verdict: 'defer (confirm with the team)', owner: 'marketing / CRM owner',
  },
  {
    vendor: 'HubSpot Conversations (chat widget)', entities: ['usemessages.com'], hosts: ['usemessages.com'],
    purpose: 'HubSpot live-chat / chatbot widget loader', category: 'customer-success', verdict: 'lazy-load on interaction (confirm with the team)', owner: 'marketing / sales',
  },
  {
    vendor: 'Vector (vector.co)', entities: ['vector.co'], hosts: ['vector.co'],
    purpose: 'Vector B2B visitor-identification / intent ad pixel', category: 'advertising', verdict: 'remove (team decision)', owner: 'marketing / growth',
  },
  {
    vendor: 'LinkedIn Insight Tag', entities: ['LinkedIn', 'LinkedIn Ads'], hosts: ['licdn.com', 'linkedin.com', 'ads.linkedin.com', 'px.ads.linkedin.com'],
    purpose: 'LinkedIn conversion tracking and retargeting', category: 'advertising', verdict: 'defer (confirm with the team)', owner: 'marketing / paid media',
  },
  {
    vendor: 'TikTok Pixel', entities: ['TikTok'], hosts: ['analytics.tiktok.com', 'tiktok.com'],
    purpose: 'TikTok ads conversion pixel', category: 'advertising', verdict: 'defer (confirm with the team)', owner: 'marketing / paid media',
  },
  {
    vendor: 'YouTube', entities: ['YouTube'], hosts: ['youtube.com', 'ytimg.com', 'youtube-nocookie.com', 'googlevideo.com'],
    purpose: 'Embedded YouTube video player', category: 'video', verdict: 'facade (lazy-load on click)', owner: 'developer / content',
  },
  {
    vendor: 'Vimeo', entities: ['Vimeo'], hosts: ['vimeo.com', 'vimeocdn.com'],
    purpose: 'Embedded Vimeo video player', category: 'video', verdict: 'facade (lazy-load on click)', owner: 'developer / content',
  },
  {
    vendor: 'Calendly', entities: ['Calendly'], hosts: ['calendly.com'],
    purpose: 'Calendly booking widget', category: 'utility', verdict: 'lazy-load on visibility', owner: 'developer / sales',
  },
  {
    vendor: 'Google Fonts', entities: ['Google Fonts'], hosts: ['fonts.googleapis.com', 'fonts.gstatic.com'],
    purpose: 'Web font delivery', category: 'cdn', verdict: 'self-host', owner: 'developer',
  },
  {
    vendor: 'Microsoft Clarity', entities: ['Microsoft Clarity'], hosts: ['clarity.ms'],
    purpose: 'Session recording and heatmaps', category: 'analytics', verdict: 'defer (confirm with the team)', owner: 'marketing / CRO',
  },
  {
    vendor: 'Hotjar', entities: ['Hotjar'], hosts: ['hotjar.com', 'hotjar.io'],
    purpose: 'Session recording and heatmaps', category: 'analytics', verdict: 'defer (confirm with the team)', owner: 'marketing / CRO',
  },
  {
    vendor: 'Reddit Pixel', entities: ['Reddit'], hosts: ['redditstatic.com', 'reddit.com'],
    purpose: 'Reddit ads conversion pixel', category: 'advertising', verdict: 'defer (confirm with the team)', owner: 'marketing / paid media',
  },
  {
    vendor: 'X (Twitter) Pixel', entities: ['Twitter', 'X'], hosts: ['static.ads-twitter.com', 'ads-twitter.com', 't.co'],
    purpose: 'X ads conversion pixel', category: 'advertising', verdict: 'defer (confirm with the team)', owner: 'marketing / paid media',
  },
];
