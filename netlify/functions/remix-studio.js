// NicheForge AI v3.0 — abstract-pattern generation plus code-enforced originality checks.
const http = require('./_shared/http');
const core = require('./_shared/scan-core');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return http.json(200, {});
  if (event.httpMethod !== 'POST') return http.fail(405, 'method_not_allowed', 'Use POST.');
  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return http.fail(400, 'bad_json', 'The request body was not valid JSON.'); }
  if (!http.validEmail(String(p.email || ''))) return http.fail(400, 'missing_email', 'A valid email is required.');
  const provider = String(p.aiProvider || '').toLowerCase(), apiKey = String(p.aiApiKey || '');
  if (!provider || !apiKey) return http.fail(400, 'missing_ai_key', 'Add your AI provider and key in Settings first.');
  const pattern = p.pattern && typeof p.pattern === 'object' ? p.pattern : {}, dna = p.creatorDNA && typeof p.creatorDNA === 'object' ? p.creatorDNA : {};
  if (!Object.keys(pattern).length) return http.fail(400, 'missing_pattern', 'Analyze a 2026 video or import a Tube Remix analysis first.');
  const system = 'You are NicheForge Pattern-to-Production Studio. Create original YouTube packaging from an ABSTRACT pattern and Creator DNA. Never reconstruct the source or invent credentials, results, or numbers. Request missing proof. Return STRICT JSON only: ' +
    '{"transferability":{"score":number,"label":"High"|"Medium"|"Low","reasons":[string],"dependencies":[string]},"angle":string,"titles":[{"text":string,"mechanism":string}],"description":string,"tags":[string],"thumbnail":{"concept":string,"overlayText":string,"composition":string,"colorDirection":string,"imagePrompt":string},"script":{"format":string,"beats":[{"label":string,"purpose":string,"seconds":number,"retentionMove":string}]},"proofRequired":[string],"qualityNotes":[string]}. Exactly 6 distinct titles, each 15-70 characters. Thumbnail overlay is at most 4 words. Transferability is 0-100 and penalizes dependence on fame, credentials, unusual access, production complexity, or timing.';
  const user = 'ABSTRACT PATTERN:\n' + JSON.stringify(pattern).slice(0, 12000) + '\n\nCREATOR DNA:\n' + JSON.stringify(dna).slice(0, 6000) + '\n\nTARGET TOPIC: ' + String(p.topic || '').slice(0, 500) + '\nCREATOR OWN TAKE: ' + String(p.myTake || '').slice(0, 3000);
  let raw; try { raw = await callAi(provider, apiKey, String(p.aiModel || ''), system, user); } catch (e) { return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message || 'The AI request failed.'); }
  let result; try { result = JSON.parse(String(raw).replace(/```json/gi, '').replace(/```/g, '').trim()); } catch (e) { return http.fail(502, 'ai_response_not_json', 'The AI returned malformed output. Try again or change models.'); }
  result = normalize(result);
  const sourceText = [String(p.sourceTitle || ''), String(p.sourceTranscript || '').slice(0, 30000)].join('\n');
  return http.json(200, { success: true, studio: result, originality: similarityGuard(sourceText, flatten(result)), evidencePolicy: '2026-only' });
};

async function callAi(provider, key, model, system, user) {
  let res;
  if (provider === 'openai') { res = await core.fetchJson('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.7, response_format: { type: 'json_object' } }) }); check(res, provider); return res.data.choices[0].message.content; }
  if (provider === 'anthropic') { res = await core.fetchJson('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 3000, system: system, messages: [{ role: 'user', content: user }] }) }); check(res, provider); return res.data.content[0].text; }
  if (provider === 'gemini') { res = await core.fetchJson('https://generativelanguage.googleapis.com/v1beta/models/' + (model || 'gemini-2.0-flash') + ':generateContent?key=' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.7 } }) }); check(res, provider); return res.data.candidates[0].content.parts[0].text; }
  const e = new Error('Unsupported AI provider.'); e.statusCode = 400; e.code = 'unsupported_ai_provider'; throw e;
}
function check(res, provider) { if (res.status >= 200 && res.status < 300) return; const e = new Error(provider + ' returned HTTP ' + res.status + '.'); e.statusCode = res.status; e.code = provider + '_error'; throw e; }
function clean(s) { return String(s || '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim(); }
function normalize(r) {
  r = r && typeof r === 'object' ? r : {}; r.transferability = r.transferability && typeof r.transferability === 'object' ? r.transferability : {};
  r.transferability.score = Math.max(0, Math.min(100, Math.round(Number(r.transferability.score) || 0)));
  r.transferability.label = ['High', 'Medium', 'Low'].indexOf(r.transferability.label) >= 0 ? r.transferability.label : (r.transferability.score >= 70 ? 'High' : r.transferability.score >= 45 ? 'Medium' : 'Low');
  r.transferability.reasons = Array.isArray(r.transferability.reasons) ? r.transferability.reasons.map(clean).slice(0, 5) : []; r.transferability.dependencies = Array.isArray(r.transferability.dependencies) ? r.transferability.dependencies.map(clean).slice(0, 5) : [];
  const seen = {}; r.titles = (Array.isArray(r.titles) ? r.titles : []).map(function (t) { return { text: clean(t.text || t), mechanism: clean(t.mechanism) }; }).filter(function (t) { const k = t.text.toLowerCase(); if (!t.text || seen[k]) return false; seen[k] = true; return true; }).map(function (t) { t.length = t.text.length; t.fits = t.length >= 15 && t.length <= 70; return t; }).slice(0, 6);
  r.tags = (Array.isArray(r.tags) ? r.tags : []).map(clean).filter(Boolean).slice(0, 8); r.thumbnail = r.thumbnail && typeof r.thumbnail === 'object' ? r.thumbnail : {}; r.thumbnail.overlayText = clean(r.thumbnail.overlayText).split(/\s+/).slice(0, 4).join(' ');
  r.script = r.script && typeof r.script === 'object' ? r.script : { beats: [] }; r.script.beats = (Array.isArray(r.script.beats) ? r.script.beats : []).map(function (b) { return { label: clean(b.label), purpose: clean(b.purpose), seconds: Math.max(0, Math.round(Number(b.seconds) || 0)), retentionMove: clean(b.retentionMove) }; }); r.script.runtimeSeconds = r.script.beats.reduce(function (n, b) { return n + b.seconds; }, 0);
  r.proofRequired = Array.isArray(r.proofRequired) ? r.proofRequired.map(clean).slice(0, 6) : []; r.qualityNotes = Array.isArray(r.qualityNotes) ? r.qualityNotes.map(clean).slice(0, 6) : []; return r;
}
function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2; }); }
function longestRun(a, b) { const A = words(a), B = words(b); let best = 0; for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) { let n = 0; while (A[i + n] && A[i + n] === B[j + n]) n++; if (n > best) best = n; } return best; }
function similarityGuard(source, generated) { const A = new Set(words(source)), B = new Set(words(generated)); let same = 0; B.forEach(function (w) { if (A.has(w)) same++; }); const union = A.size + B.size - same, overlap = union ? same / union : 0, run = longestRun(source, generated); const level = overlap >= 0.6 || run >= 8 ? 'red' : overlap >= 0.45 || run >= 6 ? 'amber' : 'green'; return { level: level, passed: level !== 'red', overlapPercent: Math.round(overlap * 100), longestSharedPhraseWords: run, reason: level === 'red' ? 'Output is too close to the source. Regenerate with a different angle.' : 'Machine originality checks passed.' }; }
function flatten(r) { return JSON.stringify({ titles: r.titles, description: r.description, thumbnail: r.thumbnail, script: r.script }); }
