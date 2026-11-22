import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const PLAY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

interface PlayStoreSearchResult {
  packageId: string;
  title: string;
  developer: string;
  rating: string;
  iconUrl: string;
  summary: string;
  price: string;
  playStoreUrl: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();
}

function toProxiedIconUrl(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  const clean = rawUrl.replace(/=s\d+.*$/, '=s160-rw');
  if (
    clean.startsWith('https://play-lh.googleusercontent.com/') ||
    clean.startsWith('https://lh3.googleusercontent.com/')
  ) {
    return `/api/playstore/icon?url=${encodeURIComponent(clean)}`;
  }
  return '';
}

function parsePlayStoreSearchHtml(html: string): PlayStoreSearchResult[] {
  const results: PlayStoreSearchResult[] = [];
  const seen = new Set<string>();
  const linkRe = /href="\/store\/apps\/details\?id=([a-zA-Z0-9._]+)"/g;

  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const packageId = match[1];
    if (!packageId || seen.has(packageId)) continue;
    seen.add(packageId);

    const start = Math.max(0, match.index - 180);
    const end = Math.min(html.length, match.index + 2800);
    const chunk = html.slice(start, end);

    const rawTitle =
      chunk.match(/class="(?:DdYX5|vWM94c|Epkrse)[^"]*"[^>]*>([^<]+)</)?.[1] ||
      chunk.match(/aria-label="([^"]+)"/)?.[1] ||
      packageId.split('.').pop() ||
      packageId;

    const rawDev =
      chunk.match(/class="(?:wMUdtb|auoIOc)[^"]*"[^>]*>([^<]+)</)?.[1] ||
      chunk.match(/\/store\/apps\/dev[^"]*"[^>]*>(?:<span[^>]*>)?([^<]+)</)?.[1] ||
      'Google Play Developer';

    const rating =
      chunk.match(/aria-label="Rated ([0-9.]+) stars/)?.[1] ||
      chunk.match(/class="w2kbF"[^>]*>([0-9.]+)</)?.[1] ||
      '4.5';

    const rawSummary =
      chunk.match(/class="(?:b8cIId|omXQ6c|N4CjDd)[^"]*"[^>]*>([^<]+)</)?.[1] || '';

    const rawPrice =
      chunk.match(/aria-label="(Free|Buy|\$[0-9.]+)"/)?.[1] ||
      chunk.match(/class="VfPpfd[^"]*"[^>]*>(?:<span[^>]*>)?([^<]+)</)?.[1] ||
      'Free';

    const rawIcon = chunk.match(/https:\/\/play-lh\.googleusercontent\.com\/[a-zA-Z0-9_\-=]+/)?.[0];

    results.push({
      packageId,
      title: decodeHtmlEntities(rawTitle),
      developer: decodeHtmlEntities(rawDev),
      rating,
      iconUrl: toProxiedIconUrl(rawIcon),
      summary: decodeHtmlEntities(rawSummary) || `Android package: ${packageId}`,
      price: decodeHtmlEntities(rawPrice),
      playStoreUrl: `https://play.google.com/store/apps/details?id=${packageId}`,
    });

    if (results.length >= 18) break;
  }

  return results;
}

function parsePlayStoreDetailsHtml(html: string, packageId: string) {
  const rawTitle =
    html.match(/<span[^>]*itemprop="name"[^>]*>([^<]+)<\/span>/)?.[1] ||
    html.match(/<meta property="og:title" content="([^"]+)"/)?.[1]?.replace(
      /\s*-\s*Apps on Google Play$/i,
      ''
    ) ||
    packageId;

  const rawDev =
    html.match(/href="\/store\/apps\/dev[^"]*"[^>]*><span[^>]*>([^<]+)<\/span>/)?.[1] ||
    html.match(/class="Vbfug[^"]*"[^>]*><a[^>]*><span[^>]*>([^<]+)<\/span>/)?.[1] ||
    'Google Play Publisher';

  const rating =
    html.match(/aria-label="Rated ([0-9.]+) stars/)?.[1] ||
    html.match(/class="TT9eCd"[^>]*>([0-9.]+)/)?.[1] ||
    '4.5';

  const downloads =
    html.match(/class="ClM7O"[^>]*>([^<]+)<\/div><div class="g1rdde">Downloads/)?.[1] ||
    '1M+';

  const rawIcon =
    html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ||
    html.match(/https:\/\/play-lh\.googleusercontent\.com\/[a-zA-Z0-9_\-=]+/)?.[0];

  const rawDesc =
    html
      .match(/data-g-id="description"[^>]*>([\s\S]*?)<\/div>/)?.[1]
      ?.replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `Google Play Store package ${packageId}`;

  return {
    packageId,
    title: decodeHtmlEntities(rawTitle),
    developer: decodeHtmlEntities(rawDev),
    rating,
    downloads: decodeHtmlEntities(downloads),
    iconUrl: toProxiedIconUrl(rawIcon),
    description: decodeHtmlEntities(rawDesc).slice(0, 600),
    playStoreUrl: `https://play.google.com/store/apps/details?id=${packageId}`,
  };
}

async function startServer() {
  const app = express();

  app.get('/api/playstore/search', async (req, res) => {
    const query = String(req.query.q ?? '').trim();
    const category = String(req.query.category ?? 'all').toLowerCase();

    let targetUrl = 'https://play.google.com/store/apps?hl=en&gl=US';
    if (query) {
      const cParam = category === 'games' ? 'apps' : 'apps';
      const searchQ = category === 'vr' && !query.toLowerCase().includes('vr') ? `${query} VR` : query;
      targetUrl = `https://play.google.com/store/search?q=${encodeURIComponent(
        searchQ
      )}&c=${cParam}&hl=en&gl=US`;
    } else if (category === 'games') {
      targetUrl = 'https://play.google.com/store/games?hl=en&gl=US';
    } else if (category === 'vr') {
      targetUrl = 'https://play.google.com/store/search?q=VR%20game&c=apps&hl=en&gl=US';
    }

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': PLAY_USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return res.status(502).json({error: `Google Play returned ${response.status}`, url: targetUrl});
      }
      const html = await response.text();
      const results = parsePlayStoreSearchHtml(html);
      return res.json({
        query,
        category,
        url: targetUrl,
        source: 'live-play-store',
        results,
      });
    } catch (err) {
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to reach Google Play Store',
        url: targetUrl,
      });
    }
  });

  app.get('/api/playstore/details', async (req, res) => {
    const id = String(req.query.id ?? '').trim();
    if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) {
      return res.status(400).json({error: 'Invalid Android package ID'});
    }

    const targetUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(
      id
    )}&hl=en&gl=US`;

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': PLAY_USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return res.status(404).json({error: `App not found (${response.status})`, url: targetUrl});
      }
      const html = await response.text();
      const details = parsePlayStoreDetailsHtml(html, id);
      return res.json(details);
    } catch (err) {
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to load Play Store details',
        url: targetUrl,
      });
    }
  });

  app.get('/api/playstore/icon', async (req, res) => {
    const rawUrl = String(req.query.url ?? '');
    if (
      !rawUrl.startsWith('https://play-lh.googleusercontent.com/') &&
      !rawUrl.startsWith('https://lh3.googleusercontent.com/')
    ) {
      return res.status(400).send('Invalid icon host');
    }

    try {
      const upstream = await fetch(rawUrl, {
        headers: {'User-Agent': PLAY_USER_AGENT},
        signal: AbortSignal.timeout(6000),
      });
      if (!upstream.ok) {
        return res.status(upstream.status).end();
      }
      const contentType = upstream.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(buf);
    } catch {
      return res.status(502).end();
    }
  });

  app.get('/api/google/image', async (req, res) => {
    const rawUrl = String(req.query.url ?? '');
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).send('Invalid URL');
    }
    const allowedHosts = new Set([
      'i.ytimg.com',
      'img.youtube.com',
      'yt3.ggpht.com',
      'play-lh.googleusercontent.com',
      'lh3.googleusercontent.com',
      'upload.wikimedia.org',
    ]);
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
      return res.status(400).send('Disallowed image host');
    }
    try {
      const upstream = await fetch(rawUrl, {
        headers: {'User-Agent': PLAY_USER_AGENT},
        signal: AbortSignal.timeout(6000),
      });
      if (!upstream.ok) return res.status(upstream.status).end();
      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      if (!ct.startsWith('image/')) return res.status(400).send('Not an image');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(buf);
    } catch {
      return res.status(502).end();
    }
  });

  app.get('/api/google/youtube', async (req, res) => {
    const q = String(req.query.q ?? 'VR 360 4K immersive').trim() || 'VR 360 4K immersive';
    const targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&gl=US`;
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': PLAY_USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return res.status(502).json({error: `YouTube returned ${response.status}`});
      }
      const html = await response.text();
      const marker = 'var ytInitialData = ';
      const idx = html.indexOf(marker);
      const items: Array<{
        videoId: string;
        title: string;
        channel: string;
        duration: string;
        views: string;
        thumbnailUrl: string;
        watchUrl: string;
      }> = [];

      if (idx !== -1) {
        const jsonStart = idx + marker.length;
        const jsonEnd = html.indexOf(';</script>', jsonStart);
        if (jsonEnd !== -1) {
          const parsed = JSON.parse(html.slice(jsonStart, jsonEnd)) as Record<string, unknown>;
          const stack: unknown[] = [parsed];
          const seenIds = new Set<string>();
          while (stack.length > 0 && items.length < 10) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node)) {
              for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
              continue;
            }
            const obj = node as Record<string, unknown>;
            const vr = obj.videoRenderer as Record<string, unknown> | undefined;
            if (vr && typeof vr.videoId === 'string' && !seenIds.has(vr.videoId)) {
              seenIds.add(vr.videoId);
              const titleObj = vr.title as {runs?: Array<{text?: string}>} | undefined;
              const title = titleObj?.runs?.map((r) => r.text ?? '').join('') || 'YouTube Video';
              const ownerObj = vr.ownerText as {runs?: Array<{text?: string}>} | undefined;
              const channel = ownerObj?.runs?.[0]?.text || 'YouTube Creator';
              const lenObj = vr.lengthText as {simpleText?: string} | undefined;
              const duration = lenObj?.simpleText || 'LIVE';
              const viewObj = vr.shortViewCountText as {simpleText?: string} | undefined;
              const views = viewObj?.simpleText || '';
              const rawThumb = `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`;
              items.push({
                videoId: vr.videoId,
                title: decodeHtmlEntities(title),
                channel: decodeHtmlEntities(channel),
                duration,
                views,
                thumbnailUrl: `/api/google/image?url=${encodeURIComponent(rawThumb)}`,
                watchUrl: `https://www.youtube.com/watch?v=${vr.videoId}`,
              });
              continue;
            }
            for (const val of Object.values(obj)) {
              if (val && typeof val === 'object') stack.push(val);
            }
          }
        }
      }

      return res.json({query: q, url: targetUrl, items});
    } catch (err) {
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to reach YouTube',
      });
    }
  });

  app.get('/api/google/web', async (req, res) => {
    const rawUrl = String(req.query.url ?? '').trim();
    const query = String(req.query.q ?? '').trim();

    if (rawUrl) {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return res.status(400).json({error: 'Invalid URL'});
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return res.status(400).json({error: 'Only HTTP/HTTPS URLs are supported'});
      }
      try {
        const resp = await fetch(rawUrl, {
          headers: {'User-Agent': PLAY_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9'},
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
          return res.status(502).json({error: `Site returned ${resp.status}`});
        }
        const html = await resp.text();
        const title = decodeHtmlEntities(
          html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '') || parsed.hostname
        );
        const desc = decodeHtmlEntities(
          html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || ''
        );
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ');
        const paras: string[] = [];
        const pRe = /<(?:p|h1|h2|h3|li)[^>]*>([\s\S]*?)<\/(?:p|h1|h2|h3|li)>/gi;
        let m: RegExpExecArray | null;
        while ((m = pRe.exec(stripped)) !== null && paras.length < 10) {
          const txt = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
          if (txt.length >= 24) paras.push(txt);
        }
        return res.json({
          mode: 'page',
          url: rawUrl,
          title,
          description: desc,
          paragraphs: paras,
        });
      } catch (err) {
        return res.status(502).json({
          error: err instanceof Error ? err.message : 'Failed to fetch webpage',
        });
      }
    }

    // Live Google News RSS + Wikipedia search
    const rssUrl = query
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
      : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
    try {
      const resp = await fetch(rssUrl, {
        headers: {'User-Agent': PLAY_USER_AGENT},
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        return res.status(502).json({error: `News feed returned ${resp.status}`});
      }
      const xml = await resp.text();
      const items: Array<{title: string; source: string; pubDate: string; link: string}> = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m: RegExpExecArray | null;
      while ((m = itemRe.exec(xml)) !== null && items.length < 8) {
        const block = m[1];
        const title = decodeHtmlEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
        const link = decodeHtmlEntities(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '');
        const pubDate = decodeHtmlEntities(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '');
        const source = decodeHtmlEntities(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || 'Google News');
        if (title) items.push({title, source, pubDate, link});
      }
      return res.json({mode: 'search', query: query || 'Top Headlines', url: rssUrl, items});
    } catch (err) {
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to reach web feed',
      });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');

  if (!isProd || !fs.existsSync(distDir)) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true, hmr: false},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PocketVR Play Hub server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
