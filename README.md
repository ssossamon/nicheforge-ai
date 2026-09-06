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


## v2.1 — Transparent, deterministic scoring engine (Demand/Competition/Momentum/Gap/Monetization/Evidence Confidence)

The old Opportunity Score was one blended formula (`log(views) - saturation
+ freshness`). This breaks it into 6 named, individually-inspectable
components with real weights, shown in a new expandable "Score breakdown"
drawer under every niche scan result:

- **Demand, Competition Opportunity, Momentum, Evidence Confidence** \u2014
  computed purely from real evidence already gathered (views, upload
  cadence, channel-size distribution, breakout videos, sample completeness).
  Every formula is plain-text, visible in the drawer, with the exact real
  inputs used.
- **Content Gap, Monetization Potential** \u2014 these need real judgment (what's
  genuinely uncovered, whether there's buyer intent) that a formula can't
  honestly produce from view counts alone, so they come from the AI
  synthesis call and are always labeled "AI Inference" in the drawer, with
  a one-sentence justification \u2014 never presented as computed.
- **Execution Fit** \u2014 intentionally left unscored. It would need a user's
  own skills/time/resources profile, which NicheForge doesn't collect. Its
  10% weight is redistributed proportionally across the other six
  components rather than guessed \u2014 the drawer shows this reweighting
  explicitly, and unit tests confirm the reweighted percentages always sum
  to exactly 100% regardless of which components are available.

**A real architectural constraint drove a two-stage design.**
`watchlist-recheck.js` runs as a scheduled background job with no AI key
available (BYOK \u2014 there's no per-request key to use), so it can't get
AI-judged Gap/Monetization scores. So there's an **evidence-only** score
(computed the moment evidence is gathered, before any AI call \u2014 this is
what the watchlist background check sees and compares over time) and a
**full** score (interactive scans only, adding the AI's judgment after it
returns). Both are real, meaningful, comparable-over-time numbers; they're
just built from different amounts of available information, which is
exactly what "Evidence Confidence" is meant to capture.

**A caching bug found and fixed during testing**: moving the score-history
append out of the evidence-gathering step (needed since the full score now
depends on the AI response, which comes later) meant a cache hit would
return a *stale* embedded history list \u2014 frozen at the moment it was
cached, missing any point appended by a later fresh scan of the same
query. Fixed by always reading live history on a cache hit instead of
trusting the cached copy. Caught by a full mocked integration test
(fake YouTube + AI responses) that exercises fresh-scan, cache-hit, and
forced-refresh paths end-to-end \u2014 not just the scoring math in isolation.

**Also fixed in passing**: the History modal was reading `h.opportunityScore`,
a field the API has never actually returned (it returns `score`) \u2014 every
entry showed "Score undefined." Unrelated to this work, but trivial and
directly adjacent, so fixed while here.

**Verified**: full mocked integration test covering fresh scan, cache hit,
forced refresh, and the no-AI watchlist path; unit tests on the weighting
math (reweighted shares always sum to 1.0, strong/weak evidence
discriminate sensibly); confirmed zero changes needed in `reports.js`,
`saveToHistory`, or `watchlist-recheck.js` (all consume the score generically
and remain fully compatible); full backend + frontend syntax/style/id
validation.

## v2.7 — Import / Export (JSON or plain text)

New "Import / Export" item in the Tools dropdown, added as a generic
interop point rather than a one-off feature — it accepts JSON or plain
text from *any* outside source (a companion Chrome extension you build
later, a spreadsheet, a text file, another AI tool's output), not a
proprietary format only NicheForge understands.

**Import topics for Batch Scan** — a JSON array of strings, or plain text
with one topic per line (file upload or paste, either works). Parses up
to 5, drops empty lines/non-string entries, fills the Batch Scan
textarea, switches to Batch mode automatically.

**Import a transcript** — a .txt file/paste, or JSON with a
`transcript`, `text`, or `content` field. If it looks like JSON but has
none of those fields, it says so rather than silently dumping raw JSON
into the transcript box. If it looks like JSON but doesn't actually
parse, falls back to treating it as plain text rather than erroring.

**Export History / Watchlist as JSON** — one click, downloads a JSON
file (`exportedAt`, `source`, `type`, your `email`, and the `items`
array) tied to whatever email you're currently scanning with. This is
the summary-level data (query/score/timestamp/etc.), the same shape the
in-app History and Watchlist panels already show — not a full per-scan
evidence+AI dump, since that would mean fetching every single entry
individually. If you need the full write-up for one specific scan, the
existing per-scan PDF export already covers that.

**Verified with real functional tests, not just syntax checks**: 14
parsing cases (JSON arrays, plain text, mixed valid/invalid entries,
the 5-item cap, JSON objects with each of the three transcript field
names, a JSON object with none of them, JSON-looking-but-invalid text
falling back to plain text, empty input) — all passed. Also verified
end-to-end: paste-based import, file-upload-based import (both
topics.json and transcript.txt), the error path when nothing usable is
found, that the nav dropdown still closes correctly when this new item
is clicked (no regression from the v2.5 dropdown work), and the export
flow with a mocked fetch confirming the right endpoint/payload and an
actual download getting triggered with the right filename.

## v2.6 — Added Privacy Policy, Terms of Service, and footer legal links

**What was added:**
- `privacy.html` — new standalone page, brand-matched
- `terms.html` — new standalone page, includes a Refund Policy section (Section 7) since PayPal is used for paid tiers, and an Acceptable Use section
- Footer on the main app now links to both, plus a Refund Policy link (jumps to `terms.html#refunds`) and a Contact link

**Why this matters beyond just "looking complete":** NicheForge uses YouTube API Services, and Google's own developer policies *require* apps using that API to (1) publish a privacy policy disclosing what data is accessed, and (2) reference YouTube's Terms of Service in the app's own terms — verified this against Google's current developer policy docs and a real compliance-violation example before drafting, rather than assuming. Both new pages include the required YouTube ToS / Google Privacy Policy links and disclosure language for this.

**\u26A0\uFE0F Action items before this goes live — I did not invent these, on purpose:**
1. Both pages have a visible disclaimer box up top: this is a draft I wrote to accurately match what NicheForge actually does, not legal advice, and hasn't been reviewed by an attorney. Given real payment processing and email collection, a quick review (a lawyer, or a service like Termly/Rocket Lawyer) is worth it before this is final.
2. Search both pages for `[bracketed placeholders]` — your business/entity name, a real support email, your governing-law state/country, and your actual refund window (I left the refund policy language as a fill-in-the-blank since I don't know what window/conditions you actually want to honor).
3. The footer's "Contact" link currently points at `mailto:REPLACE-WITH-YOUR-SUPPORT-EMAIL` — deliberately obvious so it can't accidentally ship broken or pointing at an email you didn't choose. Swap in whatever inbox you actually want this going to.

## v2.5 — Cleaned up the top nav (was 10 items wrapping onto multiple lines)

The nav bar had grown to 10 items in a fixed 64px-tall bar with no wrap
strategy, on top of adding Competitors and Playbooks in v1.7 with nothing
removed to make room. Individual labels like "How it works" and "Why
trust the data" were wrapping their own text onto 2-3 lines to fit,
looking cramped even on a full-width desktop viewport.

Split the 10 items by what they actually are: 4 marketing anchor-links
(How it works / Why trust the data / Pricing / Activate license) stay
visible in the top-level nav, since they matter to first-time visitors
reading the landing page. The 6 app-tool links (Settings / History /
Watchlist / Reports / Competitors / Playbooks) — all modal-openers for
people already using the app, not landing-page content — now live inside
a single "Tools \u25BE" dropdown. Net: 5 visible top-level items instead of
10, with `white-space:nowrap` added defensively so no individual label
can wrap again regardless of viewport width.

None of the 6 tools' own click handlers were touched — same IDs, same
wiring, just relocated inside the dropdown's markup. Verified this
directly with a jsdom interaction test: dropdown closed by default, opens
on trigger click, toggles closed on a second click, closes on any outside
click, and closing-on-select vs. the original handler firing are both
independently confirmed (clicking "Settings" inside the dropdown closes
the dropdown AND still opens the real Settings modal, checked via its
actual `open` class, not just event flow).

## v2.4 — Fixed: modals with no scroll mechanism could cut off content

**Bug found**: the base `.modal` CSS class had no `max-height` or
`overflow-y` at all — 5 of 12 modals had picked up an ad-hoc
`max-height:85vh;overflow-y:auto;` inline override over time (channel
breakdown, competitors, playbooks, playbook-view), but 7 others, including
Settings, had none. Settings just grew six new weight-adjustment rows in
v2.2, making it tall enough to exceed the viewport on many screens with no
way to scroll and see the rest (Save/Close buttons, bottom rows) — that's
what surfaced this.

**Fixed at the base class**, not by patching Settings alone: added
`max-height:88vh;overflow-y:auto;` to `.modal` itself, so every modal —
the ones that already had their own override, the ones that had none, and
any modal added in the future — gets a safety net by default. Inline
overrides on the 5 modals that already had one still win (CSS specificity),
so nothing changes for them; the fix only helps the 7 that had zero
protection.

**Verified with a real jsdom computed-style check**, not just confirming
the CSS text exists: opened the Settings modal and checked its actual
computed `max-height`/`overflow-y`, confirmed a modal with its own prior
override still resolves identically (no conflict), and confirmed a modal
that previously had zero handling (email capture) now gets the same
protection.

## v2.3 — Ranked opportunity cards (Content/Audience/Product/Offer/Format/Authority/Workflow/Education gaps)

Extends the existing single `contentGap` string (kept, unchanged) with a ranked
list of 3-8 specific opportunity cards, each categorized into one of 8 gap
types from the original upgrade spec: content, audience/problem, product/
feature, offer/pricing, format/platform, authority/proof, workflow/
automation, education. Each card: opportunity, target segment, supporting
evidence, competitor coverage, demand signal, impact/effort/confidence
(each an honest AI judgment, never inflated), risk, recommended format, and
a first validation test — all grounded in the same real evidence already
gathered, no invented numbers.

Learned the lesson from the earlier PDF staleness bug: built the HTML
render and the PDF export **in the same pass** this time, rather than
letting the PDF quietly fall behind again. Both independently verified
with jsdom-based functional tests: correct rendering, correct category
labels, correct badge color-coding (impact/confidence: high=green;
effort: low=green, since less effort is the win), safe handling of empty/
null/sparse card data, and — critically — verified the PDF export doesn't
crash on old saved scans from before this field existed.

Also unit-tested `validateOpportunityCards`'s defensive handling directly:
malformed categories and impact/effort/confidence values safely fall back
to sane defaults, entries missing the required `opportunity` field are
dropped, non-array AI output returns an empty array rather than crashing,
and the list is capped at 8 even if the AI returns more.

## v2.2 — PDF export bug fix (Transcript Playbook) + adjustable score weights

**Bug found and fixed**: `exportPlaybookToPdf` was never updated after v1.9
shipped Transcript Intelligence to the HTML view — it had been silently
stuck at the old v1.8 output (tactics/mechanic/playbook steps only) ever
since, missing summary, chapters, key claims, frameworks, pain points,
hook analysis, persuasion devices, and the fact-check queue entirely.
Fixed, with real clickable YouTube timestamp links now embedded directly
in the PDF (via jsPDF's `link()`), not just the on-screen view. Verified
with a functional test (mocked jsPDF) across full data, pasted-transcript-
with-no-timestamps, old pre-v1.9 saved playbooks (backward compat), and a
20-chapter/15-step document that forces real multi-page pagination —
confirmed `addPage()` actually fires and every real timestamp produces a
correct link, with zero links for entries with no real timing data.

**Adjustable score weights**: users can now tune how much each of the 6
scored components (Demand/Competition Opportunity/Momentum/Gap/
Monetization/Evidence Confidence) counts toward the Overall Opportunity
Score, in Settings — stored in localStorage alongside the existing BYOK
settings (no new backend store needed), sent with each scan request,
validated server-side with `normalizeCustomWeights`. **Bug found during
testing**: an early version merged partial user input (e.g. only one of 6
fields set) with default *fraction*-scale fallback values on a wildly
different numeric scale, catastrophically skewing the result toward
whichever field happened to be provided. Fixed with all-or-nothing
validation. Verified end-to-end with a real jsdom DOM test (not just
backend unit tests) — opened Settings, edited values, watched the live
total update, saved, confirmed localStorage held the right values, reset
worked, and all-zero correctly falls back to defaults.

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
