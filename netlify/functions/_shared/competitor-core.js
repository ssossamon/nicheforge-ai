// NicheForge AI — competitor-core.js (v1.0)
//
// Every fact this app shows about a competitor comes from a page RivalPulse
// actually fetched, or is clearly labeled as an AI estimate. No invented
// visitor counts, funding figures, or market-share numbers — if it isn't on
// the page and isn't a labeled estimate, it isn't shown.

const crypto = require('crypto');
const scanCore = require('./scan-core');

// ===========================================================================
// Real page fetching
// ===========================================================================

async function fetchCompetitorPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RivalPulseAI/1.0; +https://rivalpulse.ai)' },
      redirect: 'follow'
    });
    if (!res.ok) {
      return { url: url, fetched: false, error: 'Page returned HTTP ' + res.status, text: null, title: null, fetchedAt: new Date().toISOString() };
    }
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : null;

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return {
      url: url,
      fetched: true,
      error: null,
      title: title,
      text: text.slice(0, 8000),
      contentHash: crypto.createHash('sha256').update(text).digest('hex'),
      fetchedAt: new Date().toISOString()
    };
  } catch (e) {
    return { url: url, fetched: false, error: 'Could not reach that URL: ' + e.message, text: null, title: null, fetchedAt: new Date().toISOString() };
  }
}

// ===========================================================================
// Shared provider dispatch — same BYOK pattern used across the rest of the
// product line (OpenAI / Anthropic / Gemini, caller-supplied key).
// ===========================================================================

async function callAi(provider, apiKey, model, systemPrompt, userPrompt, requiredFields) {
  let rawText;
  if (provider === 'openai') {
    const res = await scanCore.fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.5,
        response_format: { type: 'json_object' }
      })
    });
    throwIfBad(res.status, provider);
    rawText = res.data.choices[0].message.content;
  } else if (provider === 'anthropic') {
    const res = await scanCore.fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    throwIfBad(res.status, provider);
    rawText = res.data.content[0].text;
  } else if (provider === 'gemini') {
    const modelName = model || 'gemini-2.0-flash';
    const res = await scanCore.fetchJson(
      'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.5 }
        })
      }
    );
    throwIfBad(res.status, provider);
    rawText = res.data.candidates[0].content.parts[0].text;
  } else {
    const err = new Error('Unsupported AI provider: ' + provider);
    err.statusCode = 400;
    err.code = 'unsupported_ai_provider';
    throw err;
  }

  const cleaned = String(rawText).replace(/```json/gi, '').replace(/```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const err = new Error('The AI returned a response that was not valid JSON.');
    err.statusCode = 502;
    err.code = 'ai_response_not_json';
    err.whatToDoNext = 'Try again, or switch to a different model.';
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
  for (const field of requiredFields || []) {
    if (!parsed || parsed[field] === undefined) {
      const err = new Error('The AI response was missing the expected "' + field + '" field.');
      err.statusCode = 502;
      err.code = 'ai_response_malformed';
      err.whatToDoNext = 'Try again, or switch to a different model.';
      err.rawResponse = cleaned.slice(0, 4000);
      throw err;
    }
  }
  return parsed;
}

function throwIfBad(status, provider) {
  if (status >= 200 && status < 300) return;
  const err = new Error();
  err.statusCode = status;
  if (status === 401 || status === 403) {
    err.code = provider + '_invalid_key';
    err.message = 'Your ' + provider + ' API key was rejected.';
    err.whatToDoNext = 'Check the key in Settings.';
  } else if (status === 429) {
    err.code = provider + '_rate_limited';
    err.message = 'Your ' + provider + ' account is rate-limited or out of quota.';
  } else {
    err.code = provider + '_error';
    err.message = 'The ' + provider + ' API returned HTTP ' + status + '.';
  }
  throw err;
}

// ===========================================================================
// Core analysis — grounded ONLY in real fetched page content. The AI is
// told explicitly to write "not visible on page" rather than guess.
// ===========================================================================

async function runCompetitorAnalysis(provider, apiKey, model, business, competitorPages) {
  const systemPrompt =
    'You are a senior competitive intelligence and market strategy analyst. You are given a business description and ' +
    'the REAL, ACTUALLY-FETCHED homepage/pricing-page text of one or more named competitors. Use two kinds of input: ' +
    '(1) the real fetched competitor text — ground positioning, visible pricing, and messaging in that text specifically, ' +
    'and say "not visible on page" rather than invent a price or stat the page doesn\u2019t show; ' +
    '(2) your own broad market/industry knowledge and analytical judgment for everything the page text can\u2019t tell you ' +
    '(market trends, TAM, search volume, keyword difficulty, go-to-market strategy, scoring) — this is expected, ' +
    'labeled analysis and estimation, not a claim of verified fact. Be specific and data-driven throughout. ' +
    'Respond with STRICT JSON only, no markdown fences, matching exactly:\n\n' +
    '{"perCompetitor":[{"name":string,"url":string,"positioning":string,"visiblePricing":string,' +
    '"messagingThemes":[string,string],"apparentStrengths":[string,string,string],"gapsOrWeaknesses":[string,string,string],' +
    '"estimatedMarketPosition":string}],\n' +
    '"swot":{"strengths":[string,string,string,string],"weaknesses":[string,string,string,string],' +
    '"opportunities":[string,string,string,string],"threats":[string,string,string,string]},\n' +
    '"competitivePositionScore":number,\n' +
    '"scoreBreakdown":{"differentiation":number,"competitiveIntensity":number,"marketTiming":number,"executionReadiness":number},\n' +
    '"marketTrends":[{"trend":string,"impact":"positive"|"negative"|"neutral","description":string}],\n' +
    '"tamEstimate":string,\n' +
    '"goToMarket":[string,string,string,string,string],\n' +
    '"verdict":string,\n' +
    '"nicheAnalysis":{"competitionLevel":"low"|"medium"|"high","competitionScore":number,' +
    '"monthlySearches":number,"monthlySearchesLabel":string,"keywordDifficulty":number,' +
    '"nicheSaturation":"emerging"|"growing"|"saturated"|"declining","opportunityWindow":string,' +
    '"successLikelihood":"low"|"medium"|"high"|"very_high","successScore":number,"successRationale":string,' +
    '"barrierToEntry":"low"|"medium"|"high","monetizationPotential":"low"|"medium"|"high"|"very_high",' +
    '"targetKeywords":[{"keyword":string,"monthlySearches":number,"difficulty":number,"intent":"informational"|"commercial"|"transactional"}]},\n' +
    '"advancedRecommendations":[{"category":"positioning"|"acquisition"|"retention"|"pricing"|"content"|"partnerships",' +
    '"priority":"critical"|"high"|"medium","title":string,"description":string,"expectedImpact":string,' +
    '"timeframe":"immediate"|"30-days"|"90-days"|"6-months"}],\n' +
    '"pricingIntelligence":{"recommendedModel":string,"priceAnchors":[{"tier":string,"price":string,"features":[string,string,string]}],' +
    '"competitorAvgPrice":string,"willingnessToPay":string}}\n\n' +
    'Provide 4 items in each SWOT list, 4 market trends, 5 go-to-market strategies, 5 target keywords, and 6 advanced recommendations. ' +
    '"competitivePositionScore" (0-100) and everything in "scoreBreakdown" (each 0-25) are your own analytical estimate — ' +
    'realistic and data-driven, not inflated for its own sake. "visiblePricing" must say "Not visible on the fetched page" ' +
    'when the real text doesn\u2019t show pricing — never invent a number there specifically, since that one claims to be page-sourced.';

  const competitorBlocks = competitorPages
    .map(function (c, i) {
      if (!c.fetched) {
        return (i + 1) + '. ' + c.name + ' (' + c.url + ') \u2014 COULD NOT BE FETCHED (' + c.error + '). Analyze from general market knowledge of this competitor if you recognize them, otherwise note the gap.';
      }
      return (
        (i + 1) + '. ' + c.name + ' (' + c.url + ')\n' +
        'Page title: ' + (c.title || '(none found)') + '\n' +
        'Real page text (truncated): ' + c.text.slice(0, 3000)
      );
    })
    .join('\n\n');

  const userPrompt =
    'MY BUSINESS: ' + business.name + '\n' +
    'Description: ' + business.description + '\n\n' +
    'NAMED COMPETITORS:\n\n' + competitorBlocks + '\n\n' +
    'Produce the full JSON report described in your instructions, grounding per-competitor page-specific claims in the real text above, ' +
    'and using your market expertise for the broader analysis sections.';

  const result = await callAi(provider, apiKey, model, systemPrompt, userPrompt, ['perCompetitor', 'competitivePositionScore', 'swot']);
  if (!Array.isArray(result.perCompetitor)) result.perCompetitor = [];
  if (!Array.isArray(result.marketTrends)) result.marketTrends = [];
  if (!Array.isArray(result.goToMarket)) result.goToMarket = [];
  if (!Array.isArray(result.advancedRecommendations)) result.advancedRecommendations = [];
  if (!result.swot) result.swot = { strengths: [], weaknesses: [], opportunities: [], threats: [] };
  if (!result.nicheAnalysis) result.nicheAnalysis = {};
  if (!Array.isArray(result.nicheAnalysis.targetKeywords)) result.nicheAnalysis.targetKeywords = [];
  if (!result.pricingIntelligence) result.pricingIntelligence = { priceAnchors: [] };
  if (!Array.isArray(result.pricingIntelligence.priceAnchors)) result.pricingIntelligence.priceAnchors = [];
  result.competitivePositionScore = Math.max(0, Math.min(100, Math.round(Number(result.competitivePositionScore) || 0)));
  return result;
}

// ===========================================================================
// Change summary — used by the scheduled recheck when a real content-hash
// change is detected. Grounded in the actual before/after text, not guessed.
// ===========================================================================

async function summarizeChange(provider, apiKey, model, competitorName, oldText, newText) {
  const systemPrompt =
    'You are told the REAL before-and-after text of one competitor\u2019s webpage, because it changed. Summarize ONLY what ' +
    'actually appears different between the two versions — new pricing, new messaging, new features mentioned, a design ' +
    'change is not something you can see from text, so ignore that. Never invent a change that is not evidenced by the text. ' +
    'Respond with STRICT JSON only: {"summary":string,"changeType":"pricing"|"messaging"|"feature"|"other"|"minor"}.';
  const userPrompt =
    'COMPETITOR: ' + competitorName + '\n\n' +
    'OLD TEXT (truncated):\n' + oldText.slice(0, 3000) + '\n\n' +
    'NEW TEXT (truncated):\n' + newText.slice(0, 3000) + '\n\n' +
    'Produce the JSON described in your instructions.';
  return callAi(provider, apiKey, model, systemPrompt, userPrompt, ['summary']);
}

module.exports = {
  fetchCompetitorPage: fetchCompetitorPage,
  runCompetitorAnalysis: runCompetitorAnalysis,
  summarizeChange: summarizeChange,
  callAi: callAi
};
