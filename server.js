'use strict';

const express    = require('express');
const axios      = require('axios');
const cheerio    = require('cheerio');
const NodeCache  = require('node-cache');
const compression = require('compression');
const path       = require('path');

const app   = express();
const PORT  = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

// ─── HTTP client ────────────────────────────────────────────────────────────

const http = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Referer':         'https://www.yupoo.com/',
  },
});

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── URL helpers ─────────────────────────────────────────────────────────────

/**
 * Normalize any Yupoo-related URL to a canonical base + album info.
 * Supported formats:
 *   https://username.yupoo.com/
 *   https://username.yupoo.com/albums
 *   https://username.yupoo.com/albums/ALBUMID
 *   https://www.yupoo.com/photos/username/
 *   https://www.yupoo.com/photos/username/albums/ALBUMID
 *   username.yupoo.com  (no scheme)
 */
function parseUrl(raw) {
  if (!raw) return null;
  const url = raw.trim().startsWith('http') ? raw.trim() : `https://${raw.trim()}`;
  try {
    const u        = new URL(url);
    const hostname = u.hostname.toLowerCase();
    const path     = u.pathname;

    // www.yupoo.com/photos/username/...
    if (hostname === 'www.yupoo.com' || hostname === 'yupoo.com') {
      const m = path.match(/\/photos\/([^\/]+)(?:\/albums\/([^\/]+))?/);
      if (!m) return null;
      return {
        username:  m[1],
        albumId:   m[2] || null,
        storeUrl:  `https://${m[1]}.yupoo.com`,
        albumUrl:  m[2] ? `https://${m[1]}.yupoo.com/albums/${m[2]}` : null,
        type:      m[2] ? 'album' : 'store',
      };
    }

    // username.yupoo.com  OR  username.x.yupoo.com  (premium domains)
    if (hostname.endsWith('.yupoo.com')) {
      const username = hostname.split('.')[0];          // "kd220" from "kd220.x.yupoo.com"
      const base     = `https://${hostname}`;           // preserve full hostname
      const m        = path.match(/\/albums\/([^\/]+)/);
      const albumId  = m ? m[1] : null;
      return {
        username,
        albumId,
        storeUrl: base,
        albumUrl: albumId ? `${base}/albums/${albumId}` : null,
        type:     albumId ? 'album' : 'store',
      };
    }

    return null;
  } catch (_) {
    return null;
  }
}

function upgradeImageUrl(src) {
  if (!src) return src;
  // Replace known size tokens with 'huge' for maximum resolution
  return src.replace(/\/(small|medium|thumb|square|avatar)(\/|\.\w{2,5})/gi,
                     (_, _size, after) => `/huge${after}`);
}

function thumbnailUrl(src) {
  if (!src) return src;
  return src.replace(/\/(huge|large|original)(\/|\.\w{2,5})/gi,
                     (_, _size, after) => `/medium${after}`);
}

// Route all Yupoo images through our server to bypass hotlink protection
function proxyImg(src) {
  if (!src || !src.startsWith('http')) return '';
  return `/proxy/image?url=${encodeURIComponent(src)}`;
}

// ─── Scraping helpers ────────────────────────────────────────────────────────

/** Extract contact details from raw HTML/text */
function extractContact(html) {
  const text = html;
  const contact = {};

  const patterns = [
    { key: 'wechat',    label: 'WeChat',    rx: /(?:wechat|微信号?|wx|v信|vx)[：:\s]*([A-Za-z0-9_\-\.]{4,30})/i },
    { key: 'whatsapp',  label: 'WhatsApp',  rx: /(?:whatsapp|wa)[：:\s]*\+?([0-9\s\-]{8,20})/i },
    { key: 'telegram',  label: 'Telegram',  rx: /(?:telegram|tg|电报)[：:\s]*@?([A-Za-z0-9_]{5,32})/i },
    { key: 'instagram', label: 'Instagram', rx: /(?:instagram|ins|ig)[：:\s]*@?([A-Za-z0-9_\.]{3,30})/i },
    { key: 'email',     label: 'Email',     rx: /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i },
    { key: 'qq',        label: 'QQ',        rx: /(?:qq)[：:\s]*([0-9]{5,12})/i },
    { key: 'weidian',   label: 'Weidian',   rx: /(?:weidian|微店|wd)[：:\s]*(https?:\/\/[^\s"<>]*weidian[^\s"<>]*|[0-9]{7,12})/i },
    { key: 'taobao',    label: 'Taobao',    rx: /(?:taobao|淘宝|tb)[：:\s]*(https?:\/\/[^\s"<>]+)/i },
    { key: '1688',      label: '1688',      rx: /(?:1688)[：:\s]*(https?:\/\/[^\s"<>]+)/i },
  ];

  // Also scan raw HTML for full URLs
  const wdUrl = html.match(/https?:\/\/(?:shop\.|m\.)?weidian\.com\/[^\s"<>?#]+/i);
  if (wdUrl && !contact.weidian) contact.weidian = { label: 'Weidian', value: wdUrl[0] };
  const tbUrl = html.match(/https?:\/\/[^\s"<>]*(?:taobao\.com\/shop|tb\.cn)[^\s"<>]*/i);
  if (tbUrl && !contact.taobao) contact.taobao = { label: 'Taobao', value: tbUrl[0] };

  for (const p of patterns) {
    const m = text.match(p.rx);
    if (m) contact[p.key] = { label: p.label, value: m[1].trim() };
  }

  return contact;
}

/** Parse album cards from a store page — tries 3 strategies */
function parseAlbums($, username, rawHtml) {
  const albums = [];
  const seen   = new Set();

  // Strategy 1: <a href="/albums/ID"> links
  $('a').each((_, el) => {
    const $el  = $(el);
    const href = ($el.attr('href') || '').split('?')[0];
    if (!href.match(/\/albums\/[^\/]+/) || seen.has(href)) return;
    seen.add(href);

    const albumUrl = href.startsWith('http')
      ? href : `https://${username}.yupoo.com${href}`;

    const $img  = $el.find('img').first();
    let   thumb = $img.attr('data-src') || $img.attr('data-original') || $img.attr('src') || '';
    if (thumb && !thumb.startsWith('http')) thumb = '';

    const $card = $el.closest('[class*="album"], li, div');
    const title = $card.find('[class*="name"], [class*="title"]').first().text().trim()
               || $el.attr('title') || $img.attr('alt') || 'Album';
    const count = $card.find('[class*="count"]').first().text().trim() || '';

    albums.push({ url: albumUrl, thumbnail: proxyImg(thumbnailUrl(thumb)), title: title || 'Album', count });
  });

  // Strategy 2: regex scan raw HTML for any album IDs not already found
  if (rawHtml) {
    const idMatches = [...rawHtml.matchAll(/\/albums\/([a-zA-Z0-9]{4,})/g)];
    [...new Set(idMatches.map(m => m[1]))].forEach(id => {
      const href = `/albums/${id}`;
      if (seen.has(href)) return;
      seen.add(href);
      albums.push({
        url:       `https://${username}.yupoo.com/albums/${id}`,
        thumbnail: '',
        title:     `Album ${id}`,
        count:     '',
      });
    });
  }

  return albums;
}

/** Parse photo grid from an album page */
function parsePhotos($) {
  const photos = [];
  const seen   = new Set();

  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('data-original')
             || $el.attr('data-src')
             || $el.attr('src')
             || '';

    if (!src || !src.includes('photo.yupoo.com') || seen.has(src)) return;
    seen.add(src);

    // Skip tiny icons
    const w = parseInt($el.attr('data-width') || $el.attr('width') || '500');
    if (w > 0 && w < 80) return;

    const thumbSrc = thumbnailUrl(src);
    const fullSrc  = upgradeImageUrl(src);
    photos.push({
      thumbnail: proxyImg(thumbSrc),
      full:      proxyImg(fullSrc),
      width:     $el.attr('data-width')  || '',
      height:    $el.attr('data-height') || '',
      alt:       $el.attr('alt') || '',
    });
  });

  return photos;
}

/** Detect whether there are more pages and return total */
function parsePagination($) {
  let total = 1;
  let current = 1;
  $('[class*="pager"], [class*="pagination"], [class*="page"]').find('a, span').each((_, el) => {
    const n = parseInt($(el).text());
    if (!isNaN(n) && n > total) total = n;
  });
  const cur = $('[class*="current"], .active').filter((_, el) => !isNaN(parseInt($(el).text()))).first().text();
  if (cur) current = parseInt(cur) || 1;
  return { total, current };
}

// ─── API: resolve a URL ───────────────────────────────────────────────────────

app.get('/api/resolve', async (req, res) => {
  const info = parseUrl(req.query.url);
  if (!info) return res.status(400).json({ error: 'Invalid Yupoo URL' });
  res.json(info);
});

// ─── API: store (albums + profile) ──────────────────────────────────────────

app.get('/api/store', async (req, res) => {
  const { url } = req.query;
  const info    = parseUrl(url);
  if (!info) return res.status(400).json({ error: 'Invalid Yupoo URL' });

  const cacheKey = `store:${info.username}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { data: html } = await http.get(`${info.storeUrl}/albums`, {
      headers: { Referer: info.storeUrl },
    });

    const $ = cheerio.load(html);

    const name        = $('meta[property="og:title"]').attr('content')
                     || $('title').text().split('|')[0].trim()
                     || info.username;
    const description = $('meta[property="og:description"]').attr('content')
                     || $('[class*="intro"], [class*="desc"], [class*="about"]').first().text().trim()
                     || '';
    const avatar      = $('meta[property="og:image"]').attr('content')
                     || $('[class*="avatar"] img, [class*="profile"] img').first().attr('src')
                     || '';
    const contact     = extractContact(html);
    const albums      = parseAlbums($, info.username, html);

    const payload = { username: info.username, name, description, avatar, contact, albums };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('store error', err.message);
    res.status(500).json({ error: `Could not fetch store: ${err.message}` });
  }
});

// ─── API: album photos (paginated) ──────────────────────────────────────────

/** Try multiple URL variants until one returns 200 */
async function fetchWithFallback(albumUrl, storeUrl, page) {
  const rawBase = albumUrl.split('?')[0].replace(/\/$/, '');

  // Candidates in priority order
  const candidates = page > 1
    ? [`${rawBase}?page=${page}`, `${rawBase}/${page}`]
    : [rawBase, `${rawBase}/`, `${rawBase}?page=1`];

  const headers = {
    Referer:  storeUrl || 'https://www.yupoo.com/',
    Cookie:   '',         // empty but present — avoids some bot checks
    'Sec-Fetch-Dest':  'document',
    'Sec-Fetch-Mode':  'navigate',
    'Sec-Fetch-Site':  'same-origin',
    'Upgrade-Insecure-Requests': '1',
  };

  let lastErr;
  for (const u of candidates) {
    try {
      console.log('trying', u);
      const res = await http.get(u, { headers });
      return res.data;
    } catch (err) {
      lastErr = err;
      if (err.response?.status !== 404) break; // only retry on 404
    }
  }
  throw lastErr;
}

app.get('/api/album', async (req, res) => {
  const { url, page = 1 } = req.query;
  const info = parseUrl(url);
  if (!info || !info.albumUrl) return res.status(400).json({ error: 'Invalid album URL — make sure it contains /albums/ID' });

  const cacheKey = `album:${info.albumUrl}:${page}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const html = await fetchWithFallback(info.albumUrl, info.storeUrl, Number(page));

    const $ = cheerio.load(html);

    const title = $('h1, [class*="album-name"], [class*="albumname"]').first().text().trim()
               || $('meta[property="og:title"]').attr('content')?.split('|')[0].trim()
               || 'Album';

    const photos     = parsePhotos($);
    const pagination = parsePagination($);

    // Also grab store-level contact from sidebar if present
    const contact = extractContact(html);

    const payload = {
      title,
      albumUrl: info.albumUrl,
      storeUrl: info.storeUrl,
      username: info.username,
      page:     Number(page),
      pagination,
      photos,
      contact,
    };

    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('album error', err.message);
    res.status(500).json({ error: `Could not fetch album: ${err.message}` });
  }
});

// ─── Proxy: pipe Yupoo images for download (avoids CORS on fetch) ────────────

app.get('/proxy/image', async (req, res) => {
  const { url, dl } = req.query;
  // Allow any yupoo CDN domain
  if (!url || !/yupoo\.com/i.test(url)) {
    return res.status(400).json({ error: 'Only yupoo.com images allowed' });
  }
  try {
    const upstream = await http.get(url, {
      responseType: 'stream',
      headers: {
        Referer:  'https://www.yupoo.com/',
        Origin:   'https://www.yupoo.com',
      },
    });
    const ct = upstream.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // Only force download when dl=1 is passed
    if (dl === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="photo.jpg"');
    }
    upstream.data.pipe(res);
  } catch (err) {
    console.error('proxy error', err.message);
    // Return a 1x1 transparent gif so the <img> tag doesn't break layout
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
    res.setHeader('Content-Type','image/gif');
    res.setHeader('Cache-Control','no-store');
    res.end(gif);
  }
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true }));

// ─── SPA fallback ────────────────────────────────────────────────────────────

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  Yupoo Viewer running → http://localhost:${PORT}`);
});
