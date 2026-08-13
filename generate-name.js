// POST /api/generate-name
// Body: { url, platformLabel, context }
// Returns: { name } or { error }
//
// Turns a generic result — a bare "Google Search", "Instagram", "XHS" —
// into a real, readable name using whatever signal is available: the URL
// itself (query params/slugs sometimes carry a real name), and any nearby
// chat caption text the person pasted alongside the link.
//
// The Gemini API key lives ONLY here, read from a server-side environment
// variable (GEMINI_API_KEY, set in Vercel project settings) — it is never
// sent to, or readable by, the browser. The client only ever talks to this
// endpoint, never to Gemini directly.

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const MAX_CONTEXT_LEN = 200;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Not configured yet — this is expected until an API key is added to
    // Vercel's env vars, and the client already falls back gracefully.
    return res.status(501).json({ error: 'AI naming is not configured.' });
  }

  const { url, platformLabel, context } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url.' });
  }
  const safeContext = (context || '').toString().slice(0, MAX_CONTEXT_LEN);
  const safePlatform = (platformLabel || '').toString().slice(0, 60);

  const prompt = [
    'You are naming an option in a group poll (e.g. "where should we eat", "which date works").',
    `Link: ${url}`,
    safePlatform ? `The link is from: ${safePlatform}` : '',
    safeContext ? `A friend's chat message near this link said: "${safeContext}"` : '',
    '',
    'Give the short, real name of the specific place/thing/event this link points to — e.g. a restaurant name, a shop name, an event name — using the URL and the chat message as clues.',
    'Reply with ONLY the name, nothing else: no quotes, no explanation, no punctuation at the end, max 6 words.',
    `If you genuinely cannot tell what this is, reply with exactly: ${safePlatform || 'Link'}`,
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
          generationConfig: { maxOutputTokens: 30, temperature: 0.2 },
        }),
      }
    );
    clearTimeout(timeout);

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(502).json({ error: `Gemini request failed (${r.status}): ${errText.slice(0, 200)}` });
    }

    const data = await r.json();
    let name = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    name = name.trim().replace(/^["'“”]+|["'“”]+$/g, '');
    if (!name) {
      return res.status(200).json({ name: safePlatform || null });
    }
    return res.status(200).json({ name });
  } catch (e) {
    clearTimeout(timeout);
    return res.status(500).json({ error: e.name === 'AbortError' ? 'Timed out' : (e.message || 'Unknown error') });
  }
}
