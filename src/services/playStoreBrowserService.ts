import {PLAY_STORE_CATALOG} from '../store/catalog.ts';
import {PlayBrowserDetail, PlayBrowserItem, PlayStoreAppItem} from '../types.ts';

export type BrowserBrowseCategory = 'all' | 'games' | 'vr';

export interface PlayBrowserSearchResponse {
  query: string;
  category: BrowserBrowseCategory;
  url: string;
  source: 'live-play-store' | 'catalog-fallback';
  results: PlayBrowserItem[];
  error?: string;
}

export async function searchGooglePlayStore(
  query: string,
  category: BrowserBrowseCategory = 'all'
): Promise<PlayBrowserSearchResponse> {
  const cleanQ = query.trim();
  const params = new URLSearchParams();
  if (cleanQ) params.set('q', cleanQ);
  params.set('category', category);

  try {
    const res = await fetch(`/api/playstore/search?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      query: string;
      url: string;
      source?: string;
      results?: PlayBrowserItem[];
    };
    const results = data.results ?? [];
    if (results.length > 0) {
      return {
        query: cleanQ,
        category,
        url: data.url,
        source: 'live-play-store',
        results,
      };
    }
  } catch {
    // Fallback to local Play Store catalog search if live Play Store is unreachable
  }

  const lower = cleanQ.toLowerCase();
  const fallback: PlayBrowserItem[] = PLAY_STORE_CATALOG.filter((app) => {
    if (category === 'games' && app.category !== 'vr-games' && app.category !== 'arcade') {
      return false;
    }
    if (!lower) return true;
    return `${app.title} ${app.developer} ${app.packageId} ${app.description}`
      .toLowerCase()
      .includes(lower);
  }).map((app) => ({
    packageId: app.packageId,
    title: app.title,
    developer: app.developer,
    rating: app.rating,
    iconUrl: '',
    summary: app.description,
    price: 'Free',
    playStoreUrl: app.playStoreUrl,
  }));

  return {
    query: cleanQ,
    category,
    url: cleanQ
      ? `https://play.google.com/store/search?q=${encodeURIComponent(cleanQ)}&c=apps`
      : 'https://play.google.com/store/apps',
    source: 'catalog-fallback',
    results: fallback,
  };
}

export async function fetchGooglePlayDetails(
  item: PlayBrowserItem
): Promise<PlayBrowserDetail> {
  try {
    const res = await fetch(
      `/api/playstore/details?id=${encodeURIComponent(item.packageId)}`
    );
    if (res.ok) {
      const data = (await res.json()) as Partial<PlayBrowserDetail>;
      return {
        packageId: item.packageId,
        title: data.title || item.title,
        developer: data.developer || item.developer,
        rating: data.rating || item.rating || '4.5',
        downloads: data.downloads || '1M+',
        iconUrl: data.iconUrl || item.iconUrl,
        summary: item.summary,
        price: item.price || 'Free',
        description: data.description || item.summary,
        playStoreUrl: data.playStoreUrl || item.playStoreUrl,
      };
    }
  } catch {
    // Fallback to summary info
  }

  return {
    ...item,
    downloads: '1M+',
    description: item.summary,
  };
}

export function browserItemToStoreApp(item: PlayBrowserItem): PlayStoreAppItem {
  const existing = PLAY_STORE_CATALOG.find(
    (c) => c.packageId.toLowerCase() === item.packageId.toLowerCase()
  );
  if (existing) return existing;

  const isGame = /game|craft|roblox|racer|shooter|subwaysurf|vr|quest|play/i.test(
    `${item.title} ${item.summary} ${item.packageId}`
  );

  return {
    id: `play-${item.packageId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    packageId: item.packageId,
    title: item.title,
    developer: item.developer,
    category: isGame ? 'vr-games' : 'apps',
    rating: item.rating || '4.5',
    sizeMb: 68,
    accentColor: isGame ? '#38bdf8' : '#34d399',
    secondaryColor: isGame ? '#6366f1' : '#0f766e',
    badge: isGame ? 'PLAY VR' : 'PLAY STORE',
    description: item.summary || `Google Play package (${item.packageId})`,
    playStoreUrl: item.playStoreUrl,
    playableMode: isGame ? 'cosmic-blaster' : 'cinema-deck',
    vrCompatible: true,
    iconUrl: item.iconUrl || undefined,
    webUrl: item.playStoreUrl,
  };
}
