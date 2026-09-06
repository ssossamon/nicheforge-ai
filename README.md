# NicheForge AI (v1.0)

Real YouTube search data + your own AI provider (BYOK) → ranked content/niche
opportunities, a content gap callout, and video title ideas for video and
content marketers. Built for lead-list growth: every free scan requires an
email, which is synced to ConvertKit and stored as a backup lead record.

**One-line product statement:** Enter a topic, and NicheForge AI pulls real
YouTube view/upload/channel data for it, scores the opportunity with a
transparent formula, and has your own AI key turn that evidence into ranked
content angles and title ideas — never inventing a statistic that isn't in
the real data.

## What's live right now

- Full frontend (`index.html`) — scan form, email gate, results dossier,
  pricing with PayPal buttons, license activation, FAQ.
- `netlify/functions/niche-scan.js` — real YouTube Data API v3 calls
  (search.list, videos.list, channels.list), a deterministic Opportunity
  Score, and BYOK AI synthesis (OpenAI / Anthropic / Gemini), with real
  error handling for every failure mode (quota, invalid key, malformed AI
  response, etc.) — no mock data anywhere.
- `netlify/functions/capture-lead.js` — ConvertKit v4 sync + Netlify Blobs
  backup so no lead is ever lost even if ConvertKit sync fails.
- `netlify/functions/verify-paypal.js` — server-side PayPal order
  verification (never trusts the client), price-matched per tier, issues a
  real license key and emails it via Resend.
- `netlify/functions/verify-license.js` / `admin-keys.js` — license
  validation and an admin panel (`admin.html`) for bulk key generation and
  CSV export of leads/licenses.
- `netlify/functions/test-ai-key.js` — a real "Test Connection" call to
  whichever AI provider the buyer picks.

## What's NOT wired up yet (needs your credentials)

Nothing is faked to look done — these environment variables are simply
unset until you provide the real accounts/keys:

| Env var | Where to get it | What breaks without it |
|---|---|---|
| `YOUTUBE_API_KEY` | Google Cloud Console → enable "YouTube Data API v3" → API key (free tier: 10,000 units/day) | Every scan fails with a clear "not configured" error |
| `CONVERTKIT_API_KEY` | ConvertKit → Settings → Advanced → API | Leads still save to Netlify Blobs, just don't sync to ConvertKit |
| `CONVERTKIT_TAG_ID` | ConvertKit → Grow → Tags (optional) | Leads sync without a tag applied |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` | developer.paypal.com → your app's Live credentials | Pricing section shows "checkout not configured"; no purchases possible |
| `PAYPAL_ENV` | set to `sandbox` while testing, omit (defaults to `live`) for real sales | — |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Resend dashboard | License keys still issued and shown on-screen, just not emailed |
| `ADMIN_KEY` | any string you choose | Falls back to the owner key value below — set a real one before going live |

## Your owner key

Enter this in the app's "Activate license" box (or the admin panel) to
unlock every tier without going through checkout:

**`NFORGE-ADM-SCOTT-2026`**

This is hardcoded as a safety-net bypass — see the comment above `OWNER_KEY`
in `netlify/functions/_shared/license.js`. It only ever unlocks the literal
owner key string; it does not weaken verification for any buyer-purchased
key.

## Data model (Netlify Blobs stores)

- `nforge-leads` — one record per email: `{email, name, source, espSynced, firstSeenAt, lastSeenAt}`
- `nforge-licenses` — one record per key: `{key, tier, email, name, status, source, createdAt}`
- `nforge-usage` — free-scan counters per email: `{count, lastScanAt}`
- `nforge-scan-cache` — 24h-TTL real-evidence cache keyed by normalized topic (v1.2)
- `nforge-history` — full saved scans keyed by `email::timestamp::rand`, browsable in-app (v1.3, replaces the old lightweight `nforge-scans` log)
- `nforge-score-history` — up to 30 score points per normalized topic, for the trend chart (v1.3)
- `nforge-watchlist` — one record per `email::topic`: `{lastKnownScore, lastCheckedAt, flagged, flagReason}` (v1.3)

## Settings module (v1.1)

The AI provider/key fields moved out of the scan form into a proper **Settings**
modal (nav link, or auto-opens when you try to scan with no key saved). It also
now accepts an **optional personal YouTube Data API key** — leave it blank to
use the shared `YOUTUBE_API_KEY` you set in Netlify, or add your own to use
your own free Google quota instead (this is what lets the owner test heavily
without touching Netlify's dashboard, and later lets any buyer optionally
supply their own quota). Every scan result now labels which key served it
("using your own YouTube key" vs "using the app's shared YouTube key").

## v1.3 — history, real comments, monetization angles, outlines, watchlist

- **Scan history** (`netlify/functions/history.js`) — every successful scan is
  auto-saved per email (`nforge-history` store) and browsable from the new
  "History" nav link: reopen any past scan in full, or delete it.
- **Real viewer comments as evidence** — `scan-core.js` now pulls real top
  comments from the sample's highest-viewed videos (`commentThreads.list`)
  and instructs the AI to ground the content gap in them when present,
  labeling on-screen whether the gap came from comments or from title/view
  patterns.
- **Real YouTube autocomplete signal** — a second, genuinely different
  demand signal (what people actually type before searching), pulled from
  YouTube's own public suggestion endpoint — free, no API key, no quota.
- **Score history + trend chart** — every fresh (non-cached) scan of a topic
  appends to `nforge-score-history`; the dossier renders a real Chart.js
  line chart once a topic has been scanned twice.
- **Monetization angles** — the AI now also returns 2-4 qualitative
  monetization angles (affiliate, digital product, sponsorship, etc.)
  grounded in the real evidence — deliberately never a specific dollar
  figure or RPM estimate, since nothing in the real evidence can honestly
  support one.
- **Video outline generator** (`netlify/functions/generate-outline.js`) — an
  "Outline" button next to every title idea turns it into a structured,
  grounded outline (hook, sections, CTA) using the same real evidence.
- **Watchlist** (`netlify/functions/watchlist.js` +
  `netlify/functions/watchlist-recheck.js`) — star any topic; a scheduled
  daily function (`@daily` in `netlify.toml`) re-checks it with real data
  only (no AI call — it's a background job) and flags a 10+ point score
  move or a new breakout video. No email/push notification yet — flags
  show up next time you open the Watchlist panel.

## v1.2 — batch mode, competitor breakdown, caching, PDF export

No tiers, no gating — every feature below is available to anyone with an AI
key configured (this is a single program, not a tiered product):

- **Scan result caching** — real YouTube evidence is cached per topic for 24
  hours in Blobs (`nforge-scan-cache`). A "Force fresh data" checkbox next
  to the scan button bypasses it when you want a live pull instead.
- **Batch mode** — a "Batch (up to 5)" tab lets you scan up to 5 topics in
  one request (`netlify/functions/batch-scan.js`). Results show a sorted
  comparison table plus each topic's full dossier below it. One topic
  failing (no results, quota, etc.) never kills the rest of the batch.
- **Competitor channel breakdown** — click any channel name in a scan's
  results to open a real-data-only panel (`netlify/functions/channel-breakdown.js`):
  subscriber count, upload frequency, Shorts/long-form split, and top 5
  videos from its most recent uploads. No AI call, no BYOK key required.
- **PDF export** — every dossier has an "Export PDF" button that builds a
  clean report client-side via jsPDF (loaded from cdnjs) — no server-side
  rendering, no extra function.
- The single-scan and batch-scan endpoints now share one engine
  (`netlify/functions/_shared/scan-core.js`) instead of duplicating the
  YouTube-fetching and AI-synthesis logic.

## Privacy

- The buyer's AI API key **and** any personal YouTube key entered in Settings
  are stored only in the browser's local storage and sent per-request to run
  that one scan — neither is ever written to any server-side store.
- Your `YOUTUBE_API_KEY`, `PAYPAL_SECRET`, `RESEND_API_KEY`, and
  `CONVERTKIT_API_KEY` live only as Netlify environment variables and are
  never sent to the browser.
- No analytics/telemetry beyond the lead and license records described
  above, which exist so you can run your own list and support.

## Functional testing checklist

- [ ] `YOUTUBE_API_KEY` set → scan returns real evidence for a common topic
- [ ] Scan with an invalid AI key → clear "key rejected" error, no fake result
- [ ] 4th free scan on the same email → blocked with an upgrade message
- [ ] License key activated → scans no longer count against the free limit
- [ ] PayPal sandbox purchase → license key issued, shown on screen, emailed
- [ ] PayPal amount tampering (manually lower client-sent tier) → rejected server-side
- [ ] Admin panel with wrong admin key → 401, no data shown
- [ ] Admin panel "Generate keys" → keys downloadable as CSV and stored in Blobs
- [ ] Admin panel "Export leads" / "Export licenses" → correct CSV contents
- [ ] Same topic scanned twice within 24h → second run shows "cached result", no extra YouTube quota used
- [ ] "Force fresh data" checked → cache is bypassed, `fromCache` is false
- [ ] Batch of 5 topics, one deliberately nonsense → 4 succeed, 1 shows a per-topic error, batch still completes
- [ ] Click a channel name in results → breakdown panel shows real subscriber/upload/Shorts data
- [ ] "Export PDF" on a dossier → downloads a readable PDF with the same real numbers and AI opportunities shown on screen
- [ ] Run a scan → open History → the scan appears and reopens in full
- [ ] Scan the same topic a 2nd time (skip cache) → a real score-trend chart appears
- [ ] "Add to Watchlist" → topic shows up in the Watchlist panel
- [ ] Click "Outline" on a title idea → a grounded outline appears, "Copy outline" works
- [ ] `watchlist-recheck` scheduled function shows up in Netlify's Functions list with a daily schedule

## Deploying

This is a static site + Netlify Functions — no build step required.
`netlify.toml` publishes the repo root and points `/api/*` at
`/.netlify/functions/*`. Push to a GitHub repo and connect it via Netlify's
GitHub App for continuous deployment, or deploy directly with the Netlify
CLI (`netlify deploy --prod`) from this folder once the env vars above are
set in the Netlify site's dashboard.
