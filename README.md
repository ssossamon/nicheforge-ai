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

## Fixed bugs worth knowing about (v1.3.1–v1.3.6)

Three real, previously-invisible production bugs were found and fixed while
building History/Watchlist. Worth understanding since they explain some
behavior you'll still see:

**1. Blobs wasn't connecting at all (fixed).** Classic Netlify Functions
(`exports.handler`) run in "Lambda compatibility mode," where `@netlify/blobs`
does NOT get its context auto-injected. Every function that touches storage
now calls `connectLambda(event)` first — without it, every read/write
silently failed with `MissingBlobsEnvironmentError`, meaning leads/licenses
may not have saved at all before this fix.

**2. `list()` returns keys in raw/decoded form, but `get()` needs the exact
encoded string used at write time (fixed).** Any key built from an email or
topic (which contain `@`, spaces, etc.) is now URL-encoded via `http.safeKey()`
before being used to `set`/`get`/`delete`. But `store.list()` always hands
back the *decoded* key regardless of how it was written — so every place that
lists keys and then re-fetches by `item.key` (History, Watchlist, the
scheduled recheck, admin lead export) now re-derives the correctly-encoded
key from the raw one `list()` returns, rather than using `item.key` directly.
This was a genuine gap in how the two operations represent the same key, not
a mistake in our original key design.

**3. Blobs is eventually consistent, up to 60 seconds (accepted, not a bug).**
Netlify's own documented figure for write/delete propagation. In practice:
add or remove something in History/Watchlist and it may not reflect in the
very next request — it'll show up (or disappear) within about a minute.
`consistency: 'strong'` would fix this, but it requires an `uncachedEdgeURL`
that `connectLambda()`'s context doesn't provide — getting it would mean
switching to direct Netlify-API-token access just for this, which is more
infrastructure than a single-user tool needs.


## v2.0 — Transcript Intelligence extended to Analyze URL (video + pasted script)

v1.9 only reached the dedicated Transcript Playbook tool. Analyze URL's
video and pasted-transcript/script analysis had their own, separate,
much shallower transcript handling — `analyze-content.js` had a third
copy of AI-provider dispatch and was still using the old flat-text
`fetchTranscript` (no timestamps at all). Same depth now applies there
too, not just in one tool.

**Refactor first**: the real-timestamp marker system (chunk a transcript
into ~20s windows with real `[T=M:SS]` markers, force the AI to cite one
rather than invent a time, snap whatever it returns to the nearest real
marker) moved out of `playbook-core.js` and into `content-analysis.js` —
`buildMarkedTranscript`/`snapTimestamp`/`withRealTimestamp`/`noTimestamp`
are now shared, not implemented twice. `playbook-core.js` exports
`applyRealTimestamps` so the same field-grounding logic (chapters/
keyClaims/painPoints/hookAnalysis) isn't a third copy in
`analyze-content.js` either.

**gatherVideoEvidence** (used only by Analyze URL) now calls
`fetchTranscriptWithTimestamps` instead of the flat version — verified
this was its only caller before changing the shape of `evidence.transcript`
from a string to a `{segments, fullText}` object.

**runVideoAi** (Analyze URL \u2192 paste a video URL) now builds the same
marked transcript and asks for the same fields \u2014 summary, chapters, key
claims, frameworks/tools, pain points, desired outcomes, hook analysis,
persuasion devices, fact-check queue \u2014 grounded with real
`youtube.com/watch?v=ID&t=Ns` timestamps, alongside its existing
whatIsWorking/spinOffIdeas/monetizationAngles fields (kept, not replaced).
When a video has no captions, these fields are explicitly told to stay
null/empty rather than inventing transcript-derived content.

**runTranscriptAi** (Analyze URL \u2192 paste a script) gets the same field
set minus real timestamps (there's no real timing data for pasted text,
same honesty rule as the Playbook's own pasted-transcript path), sitting
alongside the existing scriptQualityScore/hookAssessment/structureNotes
coaching fields.

**Frontend**: both `renderVideoAnalysis` and `renderTranscriptAnalysis`
now call the same `buildTranscriptIntelligenceHtml` component the
Playbook uses \u2014 confirmed by inspection that none of its CSS classes
depend on being wrapped in the Playbook's own container, so it drops
into the existing dossier layout cleanly with no new CSS needed.

## v1.9 — Transcript Intelligence: real timestamps, not AI-guessed ones

A user-supplied upgrade spec ("NicheForge AI TranscriptIQ Opportunity
Intelligence Upgrade Prompt") asked for a much larger rearchitecture — a
persistent multi-project workspace, 9 report tabs, 12 new data entities, a
staged resumable pipeline, file uploads, a different color palette, and a
full nav overhaul. That's a multi-week rewrite, not a patch, and the
palette/nav it specifies contradicts NicheForge's own established navy/
paper/brass identity. Rather than touch everything shallowly, this pass
targets the single most bounded, highest-leverage piece the spec calls
"Transcript Intelligence" — the part of the complaint ("doesn't give output
like TranscriptIQ") that's most directly fixable without a rewrite.

**The real fix**: YouTube's public caption track already includes a
`start`/`dur` time for every line — the existing `fetchTranscript` in
`content-analysis.js` was silently discarding all of it and flattening
everything to plain text. New `fetchTranscriptWithTimestamps` preserves it.

**How chapters/claims/pain points get REAL timestamps, not invented ones**:
the transcript is chunked into ~20-second windows, each tagged with its
real `[T=M:SS]` marker, and the AI is instructed to cite one of those exact
markers — never invent a time. Whatever it returns is then snapped to the
nearest actual marker (`playbook-core.js`'s `snapTimestamp`) before being
shown, so a displayed time is always grounded in a real transcript position,
even if the model's citation was a few seconds off. For a real video, each
timestamp becomes a genuine `youtube.com/watch?v=ID&t=Ns` link that jumps
to that exact moment. Pasted transcripts (no real timing data) correctly
get no timestamps at all rather than fabricated ones.

**New output** (Transcript Playbook, now section 1 of the document, before
tactics/mechanic/playbook): summary, real-timestamped chapters, key claims,
frameworks & processes, tools & resources, audience pain points (severity-
coded low/medium/high), desired outcomes, hook analysis, persuasion
devices, and a fact-check queue for claims worth independently verifying.

**Verified**: unit-tested the windowing/snapping logic directly (correct
20-second buckets, correct nearest-marker resolution, correctly returns
null for unparseable AI timestamps rather than guessing) before wiring it
into the live pipeline. Full backend + frontend validation and deploy
confirmed no regression to any other feature.

**Not done in this pass** (from the upgrade spec): persistent project
workspace, deterministic 8-component scoring engine with configurable
weights, competitor scorecards/positioning maps, cross-source synthesis,
Asset Studio, file-upload ingestion (TXT/MD/CSV/JSON/VTT/SRT), playlist
import, agency white-label, and the proposed nav/palette overhaul (kept
NicheForge's own navy/paper/brass identity instead). These remain real,
valuable, and buildable — just not in one pass alongside everything else.

## v1.7 — Competitor Analysis + Transcript Playbook, merged natively

Two modules originally built as a separate app (RivalPulse AI, which stays
live as its own product) are now native NicheForge features — same license
system, same 3-free-scans quota, same navy/paper/brass dossier UI, same
History/Reports integration, not a bolted-on second product.

**Competitor Analysis** (new mode tab, alongside Single/Batch/Analyze URL):
enter your business + up to 5 named competitors, RivalPulse-style real page
fetching grounds per-competitor positioning/pricing, and the AI produces
the full TranscriptIQ-depth report — SWOT, position score breakdown, market
trends, TAM, go-to-market strategy, niche/keyword analysis, prioritized
recommendations, pricing intelligence. Saved as a trackable "watch"
(`nforge-competitor-watches`) and checked daily for real page changes
(`competitor-recheck.js`, scheduled) — alerts (`nforge-competitor-alerts`)
store real before/after text, with the AI summary generated on-demand
(the scheduled job has no BYOK key to call an AI with, so it only does
free, factual content-hash diffing; summarizing what changed happens live
in the browser using the user's own key). Reachable via the new
"Competitors" nav link (Tracked/Alerts tabs).

**Transcript Playbook** (new mode tab): paste a YouTube URL (reuses the
existing `content-analysis.js` real transcript fetch — no new fetching
logic) or a transcript directly, and get three things: the specific
tactics actually evidenced in the transcript ("how did they do that"), the
generalized transferable mechanic separated from their specific brand/copy
("how can you do that" — same mechanic-vs-proprietary-asset discipline as
the tool-upgrade-prompt-builder skill), and a numbered, executable SOP with
time estimates, success metrics, and pitfalls. Saved playbooks
(`nforge-playbooks`) are reachable via the new "Playbooks" nav link and
copyable as plain text for handing to a team.

Both modules feed the existing History/Reports system: `scan-core.js`'s
`saveToHistory` now recognizes `competitivePositionScore`, and `reports.js`
correctly labels competitor items (not mislabeled as "Opportunity Score")
and folds real competitor names into the Reports competitive-landscape
section alongside niche-scan-derived channels.

## v1.6 — reports go beyond hooks: calendar, outlines, competitive landscape

The Reports module now produces a genuine two-tier deliverable instead of a
thin synthesis wrapper:

**Executive summary (1-page)**: overview, priority order, a **content
calendar** (every item assigned a day offset + Short/Long-form format, the
AI spreads them out and prioritizes higher-scored/fresher items for earlier
days), cross-cutting themes, a **consolidated monetization roadmap** (one
sequenced plan across the whole set, not each item's angles repeated), and
recommended next actions.

**Detailed appendix**: **full outlines** (hook, sections, CTA) auto-generated
for the top 3 items per the AI's own priority ranking — reuses the same
engine as the standalone "Outline" button (`generate-outline.js` now
exports `callAiForOutline`/`buildOutlineSystemPrompt` for this); a
**competitive landscape** section aggregating which channels appear across
multiple included items plus every real breakout video found; a **keyword
appendix** of deduped real YouTube autocomplete suggestions across all
items (video and channel evidence gathering now also fetch autocomplete
suggestions, keyed off title, so every content type can contribute here);
and the full per-item list.

Both the in-app viewer and the PDF export follow this same structure. The
competitive landscape and keyword appendix are pure data aggregation — no
AI involved — while the calendar and monetization roadmap are additional
fields on the same executive-summary AI call (not extra calls), and the
outlines are up to 3 extra AI calls per report.

## v1.5 — Reports module

A new "Reports" nav link compiles multiple History items (any mix of niche
scans, video analyses, channel analyses, transcript reviews) into one named,
persisted report (`netlify/functions/reports.js`, `nforge-reports` store):

- **Build a report**: check off up to 12 History items, give it a title,
  generate. An AI executive summary ties them together — a priority-ranked
  list citing each item's real score, cross-cutting themes that genuinely
  appear in 2+ items, and recommended next actions. The AI is only ever
  shown each item's already-computed score/evidence and is instructed never
  to invent a new number.
- **My reports**: list, reopen, or delete saved reports. Each report is a
  self-contained snapshot (it embeds the items' data at generation time), so
  it stays intact even if the original History entries are later deleted.
- **Export PDF**: a full report — overview, priority order, themes, next
  actions, and the item list — exports client-side via the same jsPDF setup
  as single-dossier exports.

This also required generalizing History itself: it previously only saved
niche scans. `saveToHistory()` now takes a `contentType` and normalizes
whichever score field a given content type uses (Opportunity/Video
Performance/Channel Health/Script Quality) into one `score` field, and
`analyze-content.js` now saves every video/channel/transcript analysis to
History too (it previously didn't save anything, and was also missing the
`connectLambda()` call it now needs).

## v1.4 — content analyzer: video/channel URLs, Shorts, transcripts

A third "Analyze URL" tab accepts a pasted YouTube video URL (including
Shorts), a channel URL/@handle, or raw transcript/script text — and
auto-detects which one it is (`_shared/content-analysis.js`).

- **Video URL/Short** → real stats (views, likes, comments), real transcript
  via YouTube's public caption endpoint (no OAuth needed, not every video
  has one), real top comments, and a **Video Performance Score** (0-100,
  transparent formula: view velocity + performance vs. the channel's own
  recent average + engagement rate). AI analysis is grounded in the real
  transcript when available, title/description/comments when not — the UI
  states which.
- **Channel URL/@handle** → resolves handles, `/user/`, and `/c/` URLs to a
  channel ID, then reuses the same real-data engine as the existing
  competitor breakdown, now also surfaced as a standalone analysis with a
  **Channel Health Score** (0-100: upload cadence + recent performance trend
  + views-to-subscribers ratio).
- **Pasted transcript/script** → no real YouTube data exists for
  unpublished text, so this is clearly labeled as an AI structural estimate:
  a **Script Quality Score** with an explicit rationale saying it's an
  estimate, not a measured or predicted outcome.

`channel-breakdown.js` was refactored to share its fetching logic with the
new analyzer (`gatherChannelEvidence` now lives in `_shared/content-analysis.js`)
rather than duplicating it — the existing "click a channel in scan results"
breakdown modal also now shows the new Channel Health Score.

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
