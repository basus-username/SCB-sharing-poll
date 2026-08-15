// POST /api/suggest-options
// Body: { pollTitle, pollSubtitle, existingNames }
// Returns: { suggestions: string[] } or { error }
//
// On-demand brainstorming — NOT a places database, and NOT a per-keystroke
// autocomplete. Gemini has no live knowledge of which restaurants exist
// near you right now, so this is deliberately framed as "give me some
// fresh ideas in the same spirit as what's already here", not "look up a
// real place" — for that, the free local datalist suggestions (built from
// names you've typed before, in index.html) or a real places API are the
// honest tools. Triggered by an explicit "✨ Suggest options" tap only,
// never while typing — the free Gemini tier's daily quota is small (as
// low as ~20 requests/day observed), and a live-typing call would burn
// through it in a single poll.
//
// The Gemini API key lives ONLY here, read from a server-side environment
// variable (GEMINI_API_KEY, set in Vercel project settings) — same key
// already used by generate-name.js, never sent to or readable by the
// browser.

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const MAX_TITLE_LEN = 100;
const MAX_SUBTITLE_LEN = 150;
const MAX_EXISTING = 20;
const MAX_NAME_LEN = 60;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Not configured yet — same graceful-fallback expectation as
    // generate-name.js. The client already handles this by just hiding
    // the suggestion chips and toasting a plain message.
    return res.status(501).json({ error: 'AI suggestions are not configured.' });
  }

  const { pollTitle, pollSubtitle, existingNames } = req.body || {};
  const safeTitle = (pollTitle || '').toString().slice(0, MAX_TITLE_LEN);
  const safeSubtitle = (pollSubtitle || '').toString().slice(0, MAX_SUBTITLE_LEN);
  const safeExisting = Array.isArray(existingNames)
    ? existingNames.slice(0, MAX_EXISTING).map(n => (n || '').toString().slice(0, MAX_NAME_LEN)).filter(Boolean)
    : [];

  if (!safeTitle && !safeExisting.length) {
    return res.status(400).json({ error: 'Add a poll title or at least one option first, so there is something to build on.' });
  }

  const prompt = [
    'You are brainstorming options for a group poll (e.g. "where should we eat", "which date works", "which movie").',
    `Poll title: ${safeTitle || '(untitled)'}`,
    safeSubtitle ? `Poll description: ${safeSubtitle}` : '',
    safeExisting.length ? `Options already added: ${safeExisting.join(', ')}` : '',
    '',
    'Suggest 5 NEW options that fit the same category/spirit as what is already there (or the title, if nothing is added yet). Do not repeat or closely duplicate any option already added.',
    'If this looks like it is asking for real, specific local businesses (a restaurant, a shop) that you cannot actually verify exist, suggest plausible generic categories or well-known chain-style ideas instead of inventing a fake specific name.',
    'Reply with ONLY a JSON array of 5 short strings, nothing else — no markdown, no explanation, no trailing commentary. Example: ["Option A","Option B","Option C","Option D","Option E"]',
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
        }),
      }
    );
    clearTimeout(timeout);

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(502).json({ error: `Gemini request failed (${r.status}): ${errText.slice(0, 200)}` });
    }

    const data = await r.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Gemini sometimes wraps JSON in a markdown fence even when told not
    // to — strip it defensively rather than letting JSON.parse hard-fail.
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let suggestions = [];
    try { suggestions = JSON.parse(text); } catch { suggestions = []; }
    if (!Array.isArray(suggestions)) suggestions = [];
    suggestions = suggestions
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim().slice(0, MAX_NAME_LEN))
      .slice(0, 6);

    if (!suggestions.length) {
      return res.status(200).json({ suggestions: [], error: 'Could not come up with suggestions for this poll.' });
    }
    return res.status(200).json({ suggestions });
  } catch (e) {
    clearTimeout(timeout);
    return res.status(500).json({ error: e.name === 'AbortError' ? 'Timed out' : (e.message || 'Unknown error') });
  }
}
