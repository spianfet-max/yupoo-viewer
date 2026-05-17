# Yupoo Viewer 🖼️

A clean, fast gallery viewer for Yupoo stores. Paste any Yupoo URL — get a
beautiful, clutter-free gallery with contact info, sharing, and direct downloads.

## Features

| Feature | Detail |
|---|---|
| 📦 Album browser | Thumbnail grid for all store albums |
| 🖼️ Photo gallery | Masonry grid with lazy loading |
| 🔍 Lightbox | Full-screen viewer with keyboard nav (←/→/Esc) |
| ⬇️ Download | Single photo download via server proxy |
| 📋 Copy all URLs | Bulk-copy all image URLs in one click |
| 👤 Contact card | Auto-extracts WeChat, WhatsApp, Telegram, Email, QQ, Instagram |
| 🔗 Share | Native share sheet — WhatsApp, Telegram, Twitter, copy link |
| ⚡ Caching | 5-min server-side cache — zero repeat fetches |
| 🌐 Deep links | `?url=` query param — shareable viewer URLs |

## Quick Start (local)

```bash
npm install
npm start
# → http://localhost:3000
```

For dev with auto-reload:
```bash
npm install -g nodemon   # once
npm run dev
```

## Deploy to Render (free)

1. Push this folder to a **GitHub repo**
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Render auto-detects `render.yaml` — just click **Deploy**
5. Your app is live at `https://your-app.onrender.com`

> **Free tier note:** Render free web services sleep after 15 min of
> inactivity and take ~30 s to cold-start. To prevent this, add a free
> [UptimeRobot](https://uptimerobot.com) monitor that pings `/health` every 5 min.

## URL formats supported

```
https://seller.yupoo.com
https://seller.yupoo.com/albums
https://seller.yupoo.com/albums/ALBUMID
https://www.yupoo.com/photos/seller/
https://www.yupoo.com/photos/seller/albums/ALBUMID
seller.yupoo.com   (no https)
```

## Sharing

Every page generates a `?url=` deep-link that opens the viewer directly to
the same store or album. Great for forwarding to customers or teammates.

## Stack

- **Backend:** Node.js + Express + Cheerio + Axios
- **Frontend:** Vanilla JS / CSS — zero frameworks, zero build step
- **Cache:** node-cache (in-memory, 5 min TTL)
- **AI tokens used:** 0 (pure scraping)
