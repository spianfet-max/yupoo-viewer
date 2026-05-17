'use strict';

const express     = require('express');
const axios       = require('axios');
const cheerio     = require('cheerio');
const NodeCache   = require('node-cache');
const compression = require('compression');
const path        = require('path');

const app   = express();
const PORT  = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ── HTTP client ──────────────────────────────────────────────────────────────
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
    'Upgrade-Insecure-Requests': '1',
  },
});

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── URL parsing ──────────────────────────────────────────────────────────────
function parseUrl(raw) {
  if (!raw) return null;
  const url = raw.trim().startsWith('http') ? raw.trim() : 'https://' + raw.trim();
  try {
    const u        = new URL(url);
    const hostname = u.hostname.toLowerCase();
    const pathname = u.pathname;
    if (hostname === 'www.yupoo.com' || hostname === 'yupoo.com') {
      const m = pathname.match(/\/photos\/([^\/]+)(?:\/albums\/([^\/]+))?/);
      if (!m) return null;
      return { username: m[1], albumId: m[2]||null,
        storeUrl: `https://${m[1]}.yupoo.com`,
        albumUrl: m[2] ? `https://${m[1]}.yupoo.com/albums/${m[2]}` : null,
        type: m[2] ? 'album' : 'store' };
    }
    if (hostname.endsWith('.yupoo.com')) {
      const username = hostname.split('.')[0];
      const base     = `https://${hostname}`;
      const m        = pathname.match(/\/albums\/([^\/]+)/);
      const albumId  = m ? m[1] : null;
      return { username, albumId, storeUrl: base,
        albumUrl: albumId ? `${base}/albums/${albumId}` : null,
        type: albumId ? 'album' : 'store' };
    }
    return null;
  } catch (_) { return null; }
}

// ── Image helpers ────────────────────────────────────────────────────────────
function proxyImg(src) {
  if (!src || !src.startsWith('http')) return '';
  return '/proxy/image?url=' + encodeURIComponent(src);
}
function upgradeImg(src) {
  if (!src) return src;
  return src.replace(/\/(small|medium|thumb|square|avatar)(\/|\.\w{2,5})/gi, '/huge$2');
}
function thumbImg(src) {
  if (!src) return src;
  return src.replace(/\/(huge|large|original)(\/|\.\w{2,5})/gi, '/medium$2');
}

// ── Extractors ───────────────────────────────────────────────────────────────
function extractContact(html) {
  const contact = {};
  const patterns = [
    { key: 'wechat',    label: 'WeChat',    rx: /(?:wechat|微信号?|wx|v信|vx)[：:\s]*([A-Za-z0-9_\-\.]{4,30})/i },
    { key: 'whatsapp',  label: 'WhatsApp',  rx: /(?:whatsapp|wa)[：:\s]*\+?([0-9\s\-]{8,20})/i },
    { key: 'telegram',  label: 'Telegram',  rx: /(?:telegram|tg|电报)[：:\s]*@?([A-Za-z0-9_]{5,32})/i },
    { key: 'instagram', label: 'Instagram', rx: /(?:instagram|ins|ig)[：:\s]*@?([A-Za-z0-9_\.]{3,30})/i },
    { key: 'email',     label: 'Email',     rx: /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i },
    { key: 'qq',        label: 'QQ',        rx: /(?:qq)[：:\s]*([0-9]{5,12})/i },
  ];
  for (const p of patterns) {
    const m = html.match(p.rx);
    if (m) contact[p.key] = { label: p.label, value: m[1].trim() };
  }
  // Full URL scan for store-level shop links
  const wdUrl = html.match(/https?:\/\/(?:shop\.|m\.)?weidian\.com\/[^\s"<>?#]+/i);
  if (wdUrl) contact.weidian = { label: 'Weidian Store', value: wdUrl[0] };
  const tbUrl = html.match(/https?:\/\/[^\s"<>]*(?:taobao\.com\/shop|tb\.cn)[^\s"<>]*/i);
  if (tbUrl) contact.taobao = { label: 'Taobao Store', value: tbUrl[0] };
  return contact;
}

/** Extract per-item buy links embedded in an album page */
function extractShopLinks(html) {
  const links = [];
  const seen  = new Set();
  const add = (platform, url, icon) => {
    const clean = url.split('"')[0].split("'")[0].split('<')[0];
    if (!seen.has(clean)) { seen.add(clean); links.push({ platform, url: clean, icon }); }
  };
  // Weidian item
  for (const m of html.matchAll(/https?:\/\/(?:weidian\.com|shop\.weidian\.com)\/item\.html\?[^\s"'<>]*/gi)) add('Weidian', m[0], '🛒');
  // Taobao item
  for (const m of html.matchAll(/https?:\/\/item\.taobao\.com\/item\.htm\?[^\s"'<>]*/gi)) add('Taobao', m[0], '🛍️');
  // 1688 item
  for (const m of html.matchAll(/https?:\/\/detail\.1688\.com\/offer\/[^\s"'<>]*/gi)) add('1688', m[0], '🏭');
  // Short taobao/tb links
  for (const m of html.matchAll(/https?:\/\/(?:m\.tb\.cn|s\.tb\.cn|u\.tb\.cn)\/[^\s"'<>]*/gi)) add('Taobao', m[0], '🛍️');
  return links;
}

/** Parse album cards — 2 strategies */
function parseAlbums($, username, rawHtml) {
  const albums = [];
  const seen   = new Set();
  $('a').each((_, el) => {
    const $el  = $(el);
    const href = ($el.attr('href') || '').split('?')[0];
    if (!href.match(/\/albums\/[^\/]+/) || seen.has(href)) return;
    seen.add(href);
    const albumUrl = href.startsWith('http') ? href : `https://${username}.x.yupoo.com${href}`;
    // Try to get the real base from the store's domain
    const $img  = $el.find('img').first();
    // Try every lazy-load attribute Yupoo might use
    let   thumb = $img.attr('data-original') || $img.attr('data-src') || $img.attr('data-lazy')
               || $img.attr('data-url') || $img.attr('data-original-src') || $img.attr('src') || '';
    // Also check CSS background on wrapper divs
    if (!thumb || !thumb.startsWith('http')) {
      const bgEl = $el.find('[style*="background"]').first();
      const bgStyle = bgEl.attr('style') || '';
      const bgMatch = bgStyle.match(/url\(['"]?(https?[^'")\s]+)['"]?\)/i);
      if (bgMatch) thumb = bgMatch[1];
    }
    if (thumb && !thumb.startsWith('http')) thumb = '';
    const $card = $el.closest('[class*="album"], li, div');
    const title = $card.find('[class*="name"],[class*="title"]').first().text().trim()
               || $el.attr('title') || $img.attr('alt') || 'Album';
    const count = $card.find('[class*="count"]').first().text().trim() || '';
    albums.push({ url: albumUrl, thumbnail: thumbImg(thumb)||thumb, title: title||'Album', count });
  });
  // Regex fallback for album IDs
  if (rawHtml) {
    for (const m of rawHtml.matchAll(/\/albums\/([a-zA-Z0-9]{4,})/g)) {
      const href = '/albums/' + m[1];
      if (seen.has(href)) continue;
      seen.add(href);
    }
  }
  return albums;
}

/** Parse photos from an album page */
function parsePhotos($) {
  const photos = [];
  const seen   = new Set();
  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('data-original') || $el.attr('data-src') || $el.attr('src') || '';
    if (!src || !src.includes('photo.yupoo.com') || seen.has(src)) return;
    seen.add(src);
    const w = parseInt($el.attr('data-width') || $el.attr('width') || '500');
    if (w > 0 && w < 80) return;
    const thumbSrc = thumbImg(src) || src;
    const fullSrc  = upgradeImg(src) || src;
    photos.push({
      thumbnail: thumbSrc,   // direct URL — no proxy, loads with no-referrer
      full:      fullSrc,    // direct URL — no proxy
      dl:        proxyImg(fullSrc), // proxy only for forced download
      width:     $el.attr('data-width')  || '',
      height:    $el.attr('data-height') || '',
    });
  });
  return photos;
}

function parsePagination($) {
  let total = 1;
  $('[class*="pager"],[class*="pagination"],[class*="page"]').find('a,span').each((_, el) => {
    const n = parseInt($(el).text());
    if (!isNaN(n) && n > total) total = n;
  });
  return { total };
}

/** Fetch with fallback variants */
async function fetchHtml(targetUrl, referer) {
  const base  = targetUrl.split('?')[0].replace(/\/$/, '');
  const query = targetUrl.includes('?') ? '?' + targetUrl.split('?')[1] : '';
  const candidates = [
    base + query,
    base,
    base + '/',
  ];
  const headers = {
    Referer: referer || 'https://www.yupoo.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
  };
  let lastErr;
  for (const u of candidates) {
    try {
      console.log('[fetch]', u);
      const res = await http.get(u, { headers });
      return res.data;
    } catch (err) {
      lastErr = err;
      if (err.response?.status !== 404) break;
    }
  }
  throw lastErr;
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/resolve', (req, res) => {
  const info = parseUrl(req.query.url);
  if (!info) return res.status(400).json({ error: 'Invalid Yupoo URL' });
  res.json(info);
});

/** Page 1 of store — fast load (profile + first batch of albums) */
app.get('/api/store', async (req, res) => {
  const { url } = req.query;
  const info    = parseUrl(url);
  if (!info) return res.status(400).json({ error: 'Invalid URL' });

  const cacheKey = `store:${info.storeUrl}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const html = await fetchHtml(`${info.storeUrl}/albums`, info.storeUrl);
    const $    = cheerio.load(html);
    const name = $('meta[property="og:title"]').attr('content') || $('title').text().split('|')[0].trim() || info.username;
    const desc = $('meta[property="og:description"]').attr('content') || $('[class*="intro"],[class*="desc"]').first().text().trim() || '';
    const avatar = $('meta[property="og:image"]').attr('content') || $('[class*="avatar"] img').first().attr('src') || '';
    const contact = extractContact(html);
    const albums  = parseAlbums($, info.username, html);
    const pagination = parsePagination($);
    const payload = { username: info.username, storeUrl: info.storeUrl, name, desc, avatar, contact, albums, totalAlbumPages: pagination.total };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('store error', err.message);
    res.status(500).json({ error: 'Could not load store: ' + err.message });
  }
});

/** Additional pages of albums (called by frontend to load all albums) */
app.get('/api/albums', async (req, res) => {
  const { url, page = 2 } = req.query;
  const info = parseUrl(url);
  if (!info) return res.status(400).json({ error: 'Invalid URL' });

  const cacheKey = `albums:${info.storeUrl}:${page}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const html = await fetchHtml(`${info.storeUrl}/albums?page=${page}`, info.storeUrl);
    const $    = cheerio.load(html);
    const albums = parseAlbums($, info.username, html);
    const pagination = parsePagination($);
    const payload = { albums, pagination: { total: pagination.total, current: Number(page) } };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Album photos + shop links */
app.get('/api/album', async (req, res) => {
  const { url, page = 1 } = req.query;
  const info = parseUrl(url);
  if (!info || !info.albumUrl) return res.status(400).json({ error: 'Invalid album URL' });

  const cacheKey = `album:${info.albumUrl}:${page}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const fetchUrl = Number(page) > 1 ? `${info.albumUrl}?page=${page}` : info.albumUrl;
    const html     = await fetchHtml(fetchUrl, info.storeUrl);
    const $        = cheerio.load(html);
    const title    = $('h1,[class*="album-name"],[class*="albumname"]').first().text().trim()
                  || $('meta[property="og:title"]').attr('content')?.split('|')[0].trim()
                  || 'Album';
    const photos     = parsePhotos($);
    const pagination = parsePagination($);
    const contact    = extractContact(html);
    const shopLinks  = extractShopLinks(html);
    const payload = { title, albumUrl: info.albumUrl, storeUrl: info.storeUrl, username: info.username,
      page: Number(page), pagination, photos, contact, shopLinks };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('album error', err.message);
    res.status(500).json({ error: 'Could not load album: ' + err.message });
  }
});


/** Lightweight: fetch only the og:image / first photo from an album page */
app.get('/api/album-thumb', async (req, res) => {
  const { url } = req.query;
  const info = parseUrl(url);
  if (!info || !info.albumUrl) return res.json({ thumb: '' });

  const cacheKey = `thumb:${info.albumUrl}`;
  const cached   = cache.get(cacheKey);
  if (cached !== undefined) return res.json({ thumb: cached });

  try {
    const html = await fetchHtml(info.albumUrl, info.storeUrl);
    // og:image is fastest
    const ogM  = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    // fallback: first photo.yupoo.com URL
    const phM  = html.match(/https?:\/\/photo\.yupoo\.com\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i);
    const thumb = (ogM && ogM[1]) || (phM && phM[0]) || '';
    cache.set(cacheKey, thumb);
    res.json({ thumb });
  } catch (_) {
    cache.set(cacheKey, '');
    res.json({ thumb: '' });
  }
});

/** Image proxy (bypasses hotlink protection) */
app.get('/proxy/image', async (req, res) => {
  const { url, dl } = req.query;
  if (!url || !/yupoo\.com/i.test(url)) return res.status(400).json({ error: 'Only yupoo.com images' });
  try {
    const up = await http.get(url, { responseType: 'stream', headers: { Referer: 'https://www.yupoo.com/', Origin: 'https://www.yupoo.com' } });
    res.setHeader('Content-Type', up.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (dl === '1') res.setHeader('Content-Disposition', 'attachment; filename="photo.jpg"');
    up.data.pipe(res);
  } catch (_) {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.end(gif);
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('✅  http://localhost:' + PORT));
