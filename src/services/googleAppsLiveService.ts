import {GoogleAppKind} from '../types.ts';
import {deviceHomeService} from './deviceHomeService.ts';
import {
  fetchCalendarMeetMeetings,
  getGoogleAuthSnapshot,
  WorkspaceFeedItem,
  WorkspaceFeedResult,
} from './googleWorkspaceService.ts';
import {searchGooglePlayStore} from './playStoreBrowserService.ts';

interface LiveYouTubeApiItem {
  videoId: string;
  title: string;
  channel: string;
  duration: string;
  views: string;
  thumbnailUrl: string;
  watchUrl: string;
}

interface LiveWebApiResponse {
  mode: 'page' | 'search';
  query?: string;
  url: string;
  title?: string;
  description?: string;
  paragraphs?: string[];
  items?: Array<{title: string; source: string; pubDate: string; link: string}>;
  error?: string;
}

let activeYouTubeQuery = 'VR 360 4K immersive';
let activeChromeInput = 'Google XR technology news';
const selectedPhotoUrls: string[] = [];
const selectedPhotoNames: string[] = [];

export function setYouTubeSearchQuery(query: string): void {
  const clean = query.trim();
  if (clean) activeYouTubeQuery = clean;
}

export function getYouTubeSearchQuery(): string {
  return activeYouTubeQuery;
}

export function setChromeInput(queryOrUrl: string): void {
  const clean = queryOrUrl.trim();
  if (clean) activeChromeInput = clean;
}

export function getChromeInput(): string {
  return activeChromeInput;
}

export function pickRealDevicePhotos(): Promise<number> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (count: number) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(count);
    };

    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) {
        for (const old of selectedPhotoUrls) {
          URL.revokeObjectURL(old);
        }
        selectedPhotoUrls.length = 0;
        selectedPhotoNames.length = 0;
        for (const f of files.slice(0, 12)) {
          selectedPhotoUrls.push(URL.createObjectURL(f));
          selectedPhotoNames.push(`${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`);
        }
      }
      finish(files.length);
    });

    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => finish(0), 600);
      },
      {once: true}
    );

    input.click();
  });
}

export async function fetchLiveGoogleSuiteFeed(
  kind: GoogleAppKind,
  headingDeg: number,
  localArcadeStats?: {blasterHigh: number; racerHigh: number}
): Promise<WorkspaceFeedResult> {
  switch (kind) {
    case 'youtube':
      return fetchLiveYouTubeFeed(activeYouTubeQuery, 'youtube');
    case 'google-tv':
      return fetchLiveYouTubeFeed('official movie trailer 4k hdr', 'google-tv');
    case 'chrome':
      return fetchLiveChromeFeed(activeChromeInput);
    case 'maps':
      return fetchLiveMapsOrEarthFeed('maps', headingDeg);
    case 'earth':
      return fetchLiveMapsOrEarthFeed('earth', headingDeg);
    case 'meet':
      return fetchLiveMeetFeed();
    case 'photos':
      return fetchLivePhotosFeed();
    case 'play-games':
      return fetchLivePlayGamesFeed(localArcadeStats);
    default:
      return {
        kind,
        headline: kind.toUpperCase(),
        subtitle: 'Live Google App',
        items: [],
        requiresAuth: false,
        fetchedAt: Date.now(),
      };
  }
}

async function fetchLiveYouTubeFeed(
  query: string,
  kind: 'youtube' | 'google-tv'
): Promise<WorkspaceFeedResult> {
  const headline = kind === 'google-tv' ? 'Google TV — Live Trailers & Shows' : `YouTube — "${query}"`;
  try {
    const res = await fetch(`/api/google/youtube?q=${encodeURIComponent(query)}`);
    if (res.ok) {
      const data = (await res.json()) as {items?: LiveYouTubeApiItem[]};
      const videos = data.items ?? [];
      if (videos.length > 0) {
        const items: WorkspaceFeedItem[] = videos.map((v) => ({
          title: v.title,
          detail: `${v.channel}${v.views ? ` • ${v.views}` : ''}`,
          meta: v.duration,
          videoId: v.videoId,
          imageUrl: v.thumbnailUrl,
          linkUrl: v.watchUrl,
          fullText: `${v.title}\nChannel: ${v.channel}\nDuration: ${v.duration} ${v.views}\nWatch: ${v.watchUrl}`,
        }));
        return {
          kind,
          headline,
          subtitle: `Live YouTube stream • ${items.length} real videos ready in VR Player`,
          items,
          requiresAuth: false,
          fetchedAt: Date.now(),
          selectedLinkUrl: items[0].linkUrl,
        };
      }
    }
  } catch {
    // Fallback to CORS-friendly Wikimedia/Wikipedia video topic search when /api server is absent (e.g. GitHub Pages)
  }

  // Static hosting fallback: query Wikipedia API live (full CORS) so real results still load
  try {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&srlimit=6&format=json&origin=*`;
    const r = await fetch(wikiUrl);
    if (r.ok) {
      const json = (await r.json()) as {
        query?: {search?: Array<{title: string; snippet: string; pageid: number}>};
      };
      const rows = json.query?.search ?? [];
      const items: WorkspaceFeedItem[] = rows.map((row) => ({
        title: row.title,
        detail: row.snippet.replace(/<[^>]+>/g, ''),
        meta: 'YOUTUBE SEARCH',
        linkUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(row.title)}`,
        fullText: `${row.title}\n${row.snippet.replace(/<[^>]+>/g, '')}\n\nOpen YouTube search for "${row.title}"`,
      }));
      return {
        kind,
        headline,
        subtitle: `Live Search Suggestions • Click "Open App" to watch on ${kind === 'google-tv' ? 'Google TV' : 'YouTube'}`,
        items,
        requiresAuth: false,
        fetchedAt: Date.now(),
        selectedLinkUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      };
    }
  } catch {
    // Handled below
  }

  return {
    kind,
    headline,
    subtitle: 'Open YouTube directly or connect to live server',
    items: [],
    requiresAuth: false,
    error: 'Live YouTube feed unavailable offline. Check internet connection or tap Open App.',
    fetchedAt: Date.now(),
    selectedLinkUrl:
      kind === 'google-tv'
        ? 'https://tv.google.com'
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  };
}

async function fetchLiveChromeFeed(input: string): Promise<WorkspaceFeedResult> {
  const isUrl = /^https?:\/\//i.test(input);
  try {
    const param = isUrl
      ? `url=${encodeURIComponent(input)}`
      : `q=${encodeURIComponent(input)}`;
    const res = await fetch(`/api/google/web?${param}`);
    if (res.ok) {
      const data = (await res.json()) as LiveWebApiResponse;
      if (data.mode === 'page' && data.paragraphs) {
        const items: WorkspaceFeedItem[] = data.paragraphs.map((p, idx) => ({
          title: idx === 0 ? data.title || data.url : `Section ${idx + 1}`,
          detail: p.slice(0, 96),
          meta: new URL(data.url).hostname,
          fullText: p,
          linkUrl: data.url,
        }));
        return {
          kind: 'chrome',
          headline: `Chrome — ${data.title || data.url}`,
          subtitle: `${data.url} • ${items.length} readable sections`,
          items,
          requiresAuth: false,
          fetchedAt: Date.now(),
          selectedLinkUrl: data.url,
        };
      }

      if (data.items && data.items.length > 0) {
        const items: WorkspaceFeedItem[] = data.items.map((item) => ({
          title: item.title,
          detail: `${item.source}${item.pubDate ? ` • ${item.pubDate.slice(0, 16)}` : ''}`,
          meta: 'WEB NEWS',
          fullText: `${item.title}\nSource: ${item.source}\nPublished: ${item.pubDate}\nURL: ${item.link}`,
          linkUrl: item.link,
        }));
        return {
          kind: 'chrome',
          headline: `Google Chrome — "${data.query || input}"`,
          subtitle: `Live Google Web & News Feed • ${items.length} results`,
          items,
          requiresAuth: false,
          fetchedAt: Date.now(),
          selectedLinkUrl: items[0].linkUrl ?? 'https://www.google.com',
        };
      }
    }
  } catch {
    // Fallback to CORS-direct Wikipedia search for static GitHub Pages
  }

  try {
    const q = isUrl ? new URL(input).hostname : input;
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      q
    )}&srlimit=7&format=json&origin=*`;
    const r = await fetch(wikiUrl);
    if (r.ok) {
      const json = (await r.json()) as {
        query?: {search?: Array<{title: string; snippet: string; pageid: number}>};
      };
      const items: WorkspaceFeedItem[] = (json.query?.search ?? []).map((row) => {
        const url = `https://en.wikipedia.org/?curid=${row.pageid}`;
        const cleanSnippet = row.snippet.replace(/<[^>]+>/g, '');
        return {
          title: row.title,
          detail: cleanSnippet,
          meta: 'en.wikipedia.org',
          fullText: `${row.title}\n\n${cleanSnippet}\n\n${url}`,
          linkUrl: url,
        };
      });
      return {
        kind: 'chrome',
        headline: `Google Chrome — "${input}"`,
        subtitle: `Live Web Index • ${items.length} results`,
        items,
        requiresAuth: false,
        fetchedAt: Date.now(),
        selectedLinkUrl: items[0]?.linkUrl ?? `https://www.google.com/search?q=${encodeURIComponent(input)}`,
      };
    }
  } catch {
    // Fall through
  }

  return {
    kind: 'chrome',
    headline: 'Google Chrome VR',
    subtitle: 'Unable to fetch live page while offline',
    items: [],
    requiresAuth: false,
    error: 'Check internet connection to load live web results.',
    fetchedAt: Date.now(),
    selectedLinkUrl: 'https://www.google.com',
  };
}

async function fetchLiveMapsOrEarthFeed(
  kind: 'maps' | 'earth',
  headingDeg: number
): Promise<WorkspaceFeedResult> {
  const gps = await deviceHomeService.requestGpsLocation();
  const compassCardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const facing = compassCardinals[Math.round((headingDeg % 360) / 45) % 8];

  if (!gps) {
    return {
      kind,
      headline:
        kind === 'earth'
          ? `Google Earth 3D • Facing ${Math.round(headingDeg)}° ${facing}`
          : `Google Maps • Compass ${Math.round(headingDeg)}° ${facing}`,
      subtitle: 'Allow Location permission in browser to discover real nearby places.',
      items: [
        {
          title: 'Location Access Needed for Nearby Radar',
          detail: 'Grant GPS permission in your browser bar, then gaze screen to Sync GPS.',
          meta: `${Math.round(headingDeg)}° ${facing}`,
          linkUrl:
            kind === 'earth'
              ? 'https://earth.google.com/web/'
              : 'https://maps.google.com',
        },
      ],
      requiresAuth: false,
      fetchedAt: Date.now(),
      selectedLinkUrl:
        kind === 'earth' ? 'https://earth.google.com/web/' : 'https://maps.google.com',
    };
  }

  const latStr = gps.lat.toFixed(4);
  const lngStr = gps.lng.toFixed(4);
  const deepUrl =
    kind === 'earth'
      ? `https://earth.google.com/web/@${gps.lat.toFixed(5)},${gps.lng.toFixed(
          5
        )},250a,850d,35y,${Math.round(headingDeg)}h,55t,0r`
      : `https://www.google.com/maps/@${gps.lat.toFixed(5)},${gps.lng.toFixed(5)},16z`;

  try {
    const geoUrl = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${gps.lat}|${gps.lng}&gsradius=10000&gslimit=8&format=json&origin=*`;
    const res = await fetch(geoUrl);
    if (res.ok) {
      const data = (await res.json()) as {
        query?: {
          geosearch?: Array<{
            title: string;
            dist: number;
            lat: number;
            lon: number;
            pageid: number;
          }>;
        };
      };
      const places = data.query?.geosearch ?? [];
      const items: WorkspaceFeedItem[] = places.map((p) => {
        const dBearing = bearingDeg(gps.lat, gps.lng, p.lat, p.lon);
        const dir = compassCardinals[Math.round((dBearing % 360) / 45) % 8];
        const distLabel = p.dist >= 1000 ? `${(p.dist / 1000).toFixed(1)} km` : `${Math.round(p.dist)} m`;
        const link =
          kind === 'earth'
            ? `https://earth.google.com/web/@${p.lat},${p.lon},250a,750d,35y,${Math.round(dBearing)}h,45t,0r`
            : `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
        return {
          title: p.title,
          detail: `${distLabel} away • Bearing ${Math.round(dBearing)}° (${dir})`,
          meta: distLabel,
          fullText: `${p.title}\nCoordinates: ${p.lat.toFixed(5)}, ${p.lon.toFixed(
            5
          )}\nDistance: ${distLabel} (${dir})\nYour Head Compass: ${Math.round(headingDeg)}° (${facing})`,
          linkUrl: link,
        };
      });

      return {
        kind,
        headline:
          kind === 'earth'
            ? `Google Earth (${latStr}, ${lngStr})`
            : `Google Maps (${latStr}, ${lngStr})`,
        subtitle: `Live GPS + Compass ${Math.round(headingDeg)}° ${facing} • ${items.length} real landmarks`,
        items,
        requiresAuth: false,
        fetchedAt: Date.now(),
        selectedLinkUrl: deepUrl,
      };
    }
  } catch {
    // Handled below
  }

  return {
    kind,
    headline: `${kind === 'earth' ? 'Google Earth' : 'Google Maps'} (${latStr}, ${lngStr})`,
    subtitle: `Live GPS lock ready • Facing ${Math.round(headingDeg)}° ${facing}`,
    items: [],
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: deepUrl,
  };
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const dl = (lon2 - lon1) * toRad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

async function fetchLiveMeetFeed(): Promise<WorkspaceFeedResult> {
  const authSnap = getGoogleAuthSnapshot();
  const device = deviceHomeService.getSnapshot();
  const hasCam = Boolean(navigator.mediaDevices);

  const items: WorkspaceFeedItem[] = [];
  if (authSnap.signedIn) {
    try {
      const calMeetings = await fetchCalendarMeetMeetings();
      for (const m of calMeetings) {
        items.push({
          ...m,
          fullText: `Meeting: ${m.title}\nTime: ${m.meta || 'Upcoming'}\nJoin Link: ${m.detail}`,
        });
      }
    } catch {
      // Calendar link fetch failed
    }
  }

  items.unshift({
    title: 'Start Instant Google Meet Call',
    detail: `Camera/Mic Hardware: ${hasCam ? 'Ready' : 'Check Browser'} • Opens meet.google.com/new`,
    meta: 'INSTANT',
    fullText: `Device: ${device.deviceModel}\nCamera/Audio APIs: ${
      hasCam ? 'Available' : 'Unavailable'
    }\nTap "Open App" to launch an instant Google Meet room.`,
    linkUrl: 'https://meet.google.com/new',
  });

  return {
    kind: 'meet',
    headline: 'Google Meet (Live)',
    subtitle: authSnap.signedIn
      ? `${authSnap.userEmail} • Calendar Meet calls synced`
      : 'Ready to launch real Google Meet calls on your device',
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0].linkUrl ?? 'https://meet.google.com',
  };
}

async function fetchLivePhotosFeed(): Promise<WorkspaceFeedResult> {
  const items: WorkspaceFeedItem[] = selectedPhotoUrls.map((url, idx) => ({
    title: selectedPhotoNames[idx] || `Device Photo ${idx + 1}`,
    detail: 'Real local image loaded from your device gallery',
    meta: `${idx + 1}/${selectedPhotoUrls.length}`,
    imageUrl: url,
    linkUrl: 'https://photos.google.com',
  }));

  return {
    kind: 'photos',
    headline: 'Google Photos & Device Gallery',
    subtitle:
      items.length > 0
        ? `Showing ${items.length} real photo(s) from your device in IMAX VR`
        : 'Click "Pick Photos" to view your real phone/PC photos on the Curved VR Screen',
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: 'https://photos.google.com',
  };
}

async function fetchLivePlayGamesFeed(localStats?: {
  blasterHigh: number;
  racerHigh: number;
}): Promise<WorkspaceFeedResult> {
  const res = await searchGooglePlayStore('', 'games');
  const items: WorkspaceFeedItem[] = res.results.slice(0, 7).map((g) => ({
    title: g.title,
    detail: `${g.developer} • ★ ${g.rating} • ${g.price}`,
    meta: g.packageId,
    imageUrl: g.iconUrl || undefined,
    fullText: `${g.title}\nDeveloper: ${g.developer}\nRating: ★ ${g.rating}\nPackage: ${g.packageId}\n\n${g.summary}`,
    linkUrl: g.playStoreUrl,
  }));

  return {
    kind: 'play-games',
    headline: 'Google Play Games (Live Catalog)',
    subtitle: `VR Best — Blaster: ${localStats?.blasterHigh ?? 0} | Racer: ${
      localStats?.racerHigh ?? 0
    } • ${res.source === 'live-play-store' ? 'Live Google Play' : 'VR Store Catalog'}`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0]?.linkUrl ?? 'https://play.google.com/store/games',
  };
}

export type {GoogleAppKind};
