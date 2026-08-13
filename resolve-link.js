// /api/resolve-link?url=<pasted link>
// Follows the link (including short/redirect links) and pulls a name from
// the resolved page. No API key involved — this just reads the page the
// way a browser would.
//
// Known limitation: Instagram, XHS/小红书, TikTok and similar apps render
// their real content client-side via JS. The raw server HTML for those
// only ever contains a generic app-shell title (e.g. "Instagram", "小红书"),
// never the actual post/place name — there's no free/no-signup way around
// this without their paid developer APIs. So instead of silently filling
// in that generic string, we detect it and report a clean failure so the
// caller can prompt for manual entry.
const GENERIC_TITLES = [
  'instagram', 'xhs', '小红书', 'rednote', 'tiktok', 'facebook', 'twitter',
  'x', 'threads', 'youtube', 'whatsapp', 'telegram', 'snapchat', 'google maps',
  'maps', 'google', 'google search',
];

// Google actively rate-limits/blocks automated fetches of maps.google.com
// content pages (the "unusual traffic from your computer network" wall).
// If we ever land on one of those, we must NOT try to extract a name from
// it — anything pulled from that page is garbage (and was the cause of
// the broken/overflowing "name" bug).
const BLOCK_MARKERS = [
  'unusual traffic', 'automated queries', 'recaptcha', 'our systems have detected',
  'before you continue to google', 'consent.google.com',
];

function isGoogleMapsUrl(u) {
  return /google\.[a-z.]+\/maps/i.test(u) || /goo\.gl\/maps/i.test(u) || /maps\.app\.goo\.gl/i.test(u);
}

// The search term is right there in the URL's ?q= param — reading it
// needs zero network calls, and (unlike fetching the results page) it can
// never come back as a generic/stripped title, which is what caused every
// pasted Google Search link to show up as the option name "Google Search".
function isGoogleSearchUrl(u) {
  return /^https?:\/\/(www\.)?google\.[a-z.]+\/search(\?|$)/i.test(u);
}
function extractSearchQueryFromUrl(u) {
  try {
    const q = new URL(u).searchParams.get('q');
    return q ? q.trim() : null;
  } catch { return null; }
}

function isGenericAppShell(name) {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  return GENERIC_TITLES.some(g => n === g || n === g + ' ');
}

function looksBlocked(html) {
  const h = (html || '').slice(0, 4000).toLowerCase();
  return BLOCK_MARKERS.some(m => h.includes(m));
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isUrlLike(s) {
  return /^https?:\/\//i.test(s.trim()) || /^www\./i.test(s.trim());
}

// Final safety net: a resolved "name" must actually look like a short
// name — never a raw link, never something absurdly long. This is what
// stops garbage (like a whole URL) from ever reaching the option name
// field or the status text, where it would overflow the card.
function cleanName(raw) {
  if (!raw) return null;
  let name = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (isUrlLike(name)) return null;
  if (name.length > 70) name = name.slice(0, 70).trim() + '…';
  return name;
}

function extractMetaContent(html, property) {
  const re1 = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i');
  const re3 = new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
  const re4 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i');
  const m = html.match(re1) || html.match(re2) || html.match(re3) || html.match(re4);
  return m ? m[1].trim() : null;
}

// Any run of "+" that survived to here is a leftover URL-encoding artifact
// (Google Maps uses "+" in place of spaces inside path segments and some
// query params), never a real character in a place name — so once we've
// pulled a candidate name out of the URL, always flatten "+" back to a
// space as a final safety net, on top of the per-pattern replace below.
function despacePlus(s) {
  return s ? s.replace(/\+/g, ' ') : s;
}

function extractPlaceNameFromMapsUrl(u) {
  try {
    // Saved/tapped place: /maps/place/<name>/@lat,lng,...
    const placeMatch = u.match(/\/maps\/place\/([^/@]+)/);
    if (placeMatch) {
      return decodeURIComponent(despacePlus(placeMatch[1])).split(',')[0].trim();
    }
    // Typed search result: /maps/search/<name>/@lat,lng,... or /maps/search/?q=<name>
    const searchMatch = u.match(/\/maps\/search\/([^/@?]+)/);
    if (searchMatch) {
      return decodeURIComponent(despacePlus(searchMatch[1])).split(',')[0].trim();
    }
    // Directions link with a named destination segment: /maps/dir/.../<name>/@lat,lng,...
    const dirMatch = u.match(/\/maps\/dir\/(?:[^/]*\/)*([^/@]+)\/@/);
    if (dirMatch && !/^-?\d+\.\d+,-?\d+\.\d+$/.test(dirMatch[1])) {
      return decodeURIComponent(despacePlus(dirMatch[1])).split(',')[0].trim();
    }
    // Query-string based links: ?q=, ?query=, ?destination=, ?daddr=, ?saddr=
    const qMatch = u.match(/[?&](?:q|query|destination|daddr|saddr)=([^&]+)/);
    if (qMatch) {
      return decodeURIComponent(despacePlus(qMatch[1])).split(',')[0].trim();
    }
  } catch { /* malformed URI component — ignore, caller handles null */ }
  return null;
}

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Missing url.' });
  }
  const trimmed = url.trim();

  /* ---------- Google Maps ----------
     Maps share links usually carry the place name right in the URL (e.g.
     /maps/place/Entopia+by+Penang+Butterfly+Farm/...), so we try parsing
     that first with zero network calls. Short links (maps.app.goo.gl)
     don't carry the name in the path, so for those we follow the redirect
     and re-parse the final URL. If even that has no readable name segment
     (common for "starred place" / cid-only share links), we fall back to
     reading the page's own title/og:title from the response we already
     fetched — but only when the page isn't Google's "unusual traffic"
     captcha wall, since anything pulled from that wall is garbage, not a
     place name. */
  if (isGoogleMapsUrl(trimmed)) {
    let name = cleanName(despacePlus(extractPlaceNameFromMapsUrl(trimmed)));
    let finalUrl = trimmed;

    if (!name) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const r = await fetch(trimmed, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        });
        clearTimeout(timeout);
        finalUrl = r.url || trimmed;
        name = cleanName(despacePlus(extractPlaceNameFromMapsUrl(finalUrl)));

        if (!name) {
          const html = await r.text();
          if (!looksBlocked(html)) {
            let titleName = extractMetaContent(html, 'og:title');
            if (!titleName) {
              const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
              if (titleMatch) titleName = titleMatch[1].trim();
            }
            if (titleName) titleName = titleName.replace(/\s*[-·|]\s*Google Maps\s*$/i, '').trim();
            titleName = cleanName(titleName);
            if (!isGenericAppShell(titleName)) name = titleName;
          }
        }
      } catch (e) {
        return res.status(500).json({ error: `Couldn't follow that Maps link (${e.name === 'AbortError' ? 'timed out' : e.message || 'network error'}) — type the name in below.` });
      }
    }

    if (!name) {
      return res.status(404).json({ error: "Couldn't read a name from that Maps link — type it in below." });
    }
    return res.status(200).json({ name, resolvedUrl: finalUrl });
  }

  /* ---------- Google Search ---------- */
  if (isGoogleSearchUrl(trimmed)) {
    const name = cleanName(extractSearchQueryFromUrl(trimmed));
    if (!name) {
      return res.status(404).json({ error: "Couldn't read a search term from that link — type it in below." });
    }
    return res.status(200).json({ name, resolvedUrl: trimmed });
  }

  /* ---------- everything else: normal page fetch + og:title ---------- */
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch(trimmed, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    const finalUrl = r.url || trimmed;
    const html = await r.text();

    if (looksBlocked(html)) {
      return res.status(404).json({ error: "That site blocked automatic reading — type the name in below." });
    }

    let name = extractMetaContent(html, 'og:title');
    if (!name) name = extractMetaContent(html, 'twitter:title');

    if (!name) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) name = titleMatch[1].trim();
    }

    if (name) {
      name = name.replace(/\s*[-·|]\s*(Google Maps|Google Search|Instagram|Facebook)\s*$/i, '').trim();
    }

    name = cleanName(name);

    if (isGenericAppShell(name)) {
      name = null;
    }

    if (!name) {
      return res.status(404).json({ error: 'Could not find a name in that link — type it in below.' });
    }

    // Best-effort photo thumbnail for ordinary sites (articles, restaurant
    // pages, blogs, etc). Not attempted for Maps/IG/XHS/TikTok — those never
    // reach this branch, and the frontend shows a platform icon instead.
    let image = extractMetaContent(html, 'og:image') || extractMetaContent(html, 'twitter:image');
    if (image) {
      image = decodeHtmlEntities(image);
      try { image = new URL(image, finalUrl).href; } // resolve relative paths
      catch { image = null; }
    }

    res.status(200).json({ name, resolvedUrl: finalUrl, image: image || null });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError'
      ? 'Link took too long to load (timed out after 8s).'
      : `Could not read that link (${err.message || 'unknown network error'}).`;
    res.status(500).json({ error: msg });
  }
}
