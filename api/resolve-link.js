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
  'x', 'threads', 'youtube', 'whatsapp', 'telegram', 'snapchat', 'google maps', 'maps', 'google'
];

// Google actively rate-limits/blocks automated fetches of maps.google.com
// content pages (the "unusual traffic from your computer network" wall).
// If we ever land on one of those, we must NOT try to extract a name from
// it — anything pulled from that page is garbage (and was the cause of
// the broken/overflowing "name" bug).
const BLOCK_MARKERS = [
  'unusual traffic', 'automated queries', 'recaptcha', 'our systems have detected',
];

function isGoogleMapsUrl(u) {
  return /google\.[a-z.]+\/maps/i.test(u) || /goo\.gl\/maps/i.test(u) || /maps\.app\.goo\.gl/i.test(u);
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

// Google embeds a place's permanent internal ID right in the share-link
// URL as a hex pair after "!1s" (e.g. "!1s0x304ac3...:0xb68766a4c03b4d8b").
// The SECOND hex number there is the place's CID, and "https://maps.google.com/?cid=<decimal>"
// is Google's own official short permalink format for that exact place —
// same destination as the long link, just without any of the tracking
// params (utm_source, g_ep, skid, etc). Pure string parsing, no network
// call, no API key, so this costs nothing and never fails silently.
function extractGoogleCid(u) {
  const m = u.match(/!1s0x[0-9a-f]+:0x([0-9a-f]+)/i);
  if (!m) return null;
  try { return BigInt('0x' + m[1]).toString(10); } catch { return null; }
}

// Always returns a clean link — a CID permalink when one can be extracted
// (the accurate, canonical case), otherwise falls back to just the
// readable place-path portion of the URL with the data-blob/tracking
// query string cut off entirely. Either way, nothing with "?utm_source"
// or "&g_ep=…" ever reaches the option's saved link.
function cleanGoogleMapsUrl(u) {
  const cid = extractGoogleCid(u);
  if (cid) return `https://maps.google.com/?cid=${cid}`;
  return u.split('?')[0].split('/data=')[0];
}

// Well-established tracking/analytics query params — NOT a functional
// allowlist, so anything not on this list is left alone. Deliberately
// conservative: better to leave a param we're unsure about than strip
// something a site actually needs to resolve correctly (e.g. YouTube's
// "v", Amazon's product path segments, etc. are never touched since
// they're not query params to begin with).
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_reader',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'ttclid',
  'igshid', 'igsh', 'mibextid',
  'si', 'feature',
  'ref', 'ref_src', 'ref_url',
  'mc_cid', 'mc_eid', 'spm',
  'share_id', 'is_copy_url', 'is_from_webapp', 'sender_device', 'share_app_id',
  '_ga', '_gl', 'trk', 'trkcampaign'
]);
function sanitizeShareUrl(u) {
  if (isGoogleMapsUrl(u)) return cleanGoogleMapsUrl(u);
  try {
    const parsed = new URL(u);
    let changed = false;
    Array.from(parsed.searchParams.keys()).forEach((key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase())) { parsed.searchParams.delete(key); changed = true; }
    });
    return changed ? parsed.toString() : u;
  } catch {
    return u; // not a parseable absolute URL — leave untouched rather than risk mangling it
  }
}

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Missing url.' });
  }
  const trimmed = url.trim();

  /* ---------- Google Maps: never fetch page content ----------
     Maps share links almost always already carry the place name right in
     the URL (e.g. /maps/place/Entopia+by+Penang+Butterfly+Farm/...), so we
     parse that directly with zero network calls — this is also the only
     reliable path, since Google blocks server-side fetches of the actual
     maps content page with a captcha wall. Short links (maps.app.goo.gl)
     don't carry the name, so for those only, we resolve the redirect —
     and only the redirect, never the page body Google would block. */
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
      } catch (e) {
        return res.status(500).json({ error: `Couldn't follow that Maps link (${e.name === 'AbortError' ? 'timed out' : e.message || 'network error'}) — type the name in below.` });
      }
    }

    if (!name) {
      return res.status(404).json({ error: "Couldn't read a name from that Maps link — type it in below." });
    }
    return res.status(200).json({ name, resolvedUrl: cleanGoogleMapsUrl(finalUrl) });
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
      name = name.replace(/\s*[-·|]\s*(Google Maps|Instagram|Facebook)\s*$/i, '').trim();
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

    res.status(200).json({ name, resolvedUrl: sanitizeShareUrl(finalUrl), image: image || null });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError'
      ? 'Link took too long to load (timed out after 8s).'
      : `Could not read that link (${err.message || 'unknown network error'}).`;
    res.status(500).json({ error: msg });
  }
}
