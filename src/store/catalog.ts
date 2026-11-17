import * as THREE from 'three';
import {PlayStoreAppItem} from '../types.ts';

export const PLAY_STORE_CATALOG: PlayStoreAppItem[] = [
  // Real Google Workspace Live API Apps (Pre-Installed)
  {
    id: 'google-gmail',
    packageId: 'com.google.android.gm',
    title: 'Gmail',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.4',
    sizeMb: 48,
    accentColor: '#EA4335',
    secondaryColor: '#C5221F',
    badge: 'GOOGLE LIVE',
    description:
      'Read your real Gmail inbox subjects, senders, and snippets directly on the Curved VR Screen.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.gm',
    playableMode: 'google-workspace',
    googleService: 'gmail',
    webUrl: 'https://mail.google.com',
  },
  {
    id: 'google-drive',
    packageId: 'com.google.android.apps.docs',
    title: 'Google Drive',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.5',
    sizeMb: 54,
    accentColor: '#34A853',
    secondaryColor: '#1E8E3E',
    badge: 'GOOGLE LIVE',
    description:
      'Browse your live Google Drive cloud files, folders, and recent timestamps inside VR.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.apps.docs',
    playableMode: 'google-workspace',
    googleService: 'drive',
    webUrl: 'https://drive.google.com',
  },
  {
    id: 'google-calendar',
    packageId: 'com.google.android.calendar',
    title: 'Google Calendar',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.6',
    sizeMb: 36,
    accentColor: '#4285F4',
    secondaryColor: '#1A73E8',
    badge: 'GOOGLE LIVE',
    description:
      'View your real upcoming meetings, schedules, and event locations on the spatial theater screen.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.calendar',
    playableMode: 'google-workspace',
    googleService: 'calendar',
    webUrl: 'https://calendar.google.com',
  },
  {
    id: 'google-docs',
    packageId: 'com.google.android.apps.docs.editors.docs',
    title: 'Google Docs',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.5',
    sizeMb: 62,
    accentColor: '#4285F4',
    secondaryColor: '#1967D2',
    badge: 'GOOGLE LIVE',
    description:
      'Open recent Google Docs files and preview live document text inside the VR reading deck.',
    playStoreUrl:
      'https://play.google.com/store/apps/details?id=com.google.android.apps.docs.editors.docs',
    playableMode: 'google-workspace',
    googleService: 'docs',
    webUrl: 'https://docs.google.com',
  },
  {
    id: 'google-sheets',
    packageId: 'com.google.android.apps.docs.editors.sheets',
    title: 'Google Sheets',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.4',
    sizeMb: 64,
    accentColor: '#0F9D58',
    secondaryColor: '#137333',
    badge: 'GOOGLE LIVE',
    description:
      'Inspect your real Google Sheets workbooks and sheet tabs on the wide IMAX VR canvas.',
    playStoreUrl:
      'https://play.google.com/store/apps/details?id=com.google.android.apps.docs.editors.sheets',
    playableMode: 'google-workspace',
    googleService: 'sheets',
    webUrl: 'https://sheets.google.com',
  },
  {
    id: 'google-slides',
    packageId: 'com.google.android.apps.docs.editors.slides',
    title: 'Google Slides',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.4',
    sizeMb: 61,
    accentColor: '#FBBC04',
    secondaryColor: '#E37400',
    badge: 'GOOGLE LIVE',
    description:
      'Preview your Google Slides presentations and slide counts in a theater-scale VR presentation room.',
    playStoreUrl:
      'https://play.google.com/store/apps/details?id=com.google.android.apps.docs.editors.slides',
    playableMode: 'google-workspace',
    googleService: 'slides',
    webUrl: 'https://slides.google.com',
  },
  {
    id: 'google-tasks',
    packageId: 'com.google.android.apps.tasks',
    title: 'Google Tasks',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.7',
    sizeMb: 19,
    accentColor: '#4285F4',
    secondaryColor: '#174EA6',
    badge: 'GOOGLE LIVE',
    description:
      'Check off and track your live Google Tasks to-do list and due dates in VR.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.apps.tasks',
    playableMode: 'google-workspace',
    googleService: 'tasks',
    webUrl: 'https://tasks.google.com',
  },
  {
    id: 'google-contacts',
    packageId: 'com.google.android.contacts',
    title: 'Google Contacts',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.5',
    sizeMb: 24,
    accentColor: '#1A73E8',
    secondaryColor: '#185ABC',
    badge: 'GOOGLE LIVE',
    description:
      'Browse your live saved Google Contacts, email addresses, and phone numbers in spatial view.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.contacts',
    playableMode: 'google-workspace',
    googleService: 'contacts',
    webUrl: 'https://contacts.google.com',
  },

  // Real Android Google Suite Apps (Pre-Installed)
  {
    id: 'google-youtube',
    packageId: 'com.google.android.youtube',
    title: 'YouTube',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.4',
    sizeMb: 92,
    accentColor: '#FF0000',
    secondaryColor: '#B31412',
    badge: 'GOOGLE APP',
    description:
      'Watch 360° VR videos & channels or launch the native YouTube Android app directly from the hub.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.youtube',
    playableMode: 'google-suite-launch',
    googleService: 'youtube',
    webUrl: 'https://www.youtube.com',
  },
  {
    id: 'google-maps',
    packageId: 'com.google.android.apps.maps',
    title: 'Google Maps',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.3',
    sizeMb: 108,
    accentColor: '#34A853',
    secondaryColor: '#4285F4',
    badge: 'GOOGLE APP',
    description:
      'Explore Street View & live navigation paired with your phone compass heading and Maps Android launcher.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.apps.maps',
    playableMode: 'google-suite-launch',
    googleService: 'maps',
    webUrl: 'https://maps.google.com',
  },
  {
    id: 'google-chrome',
    packageId: 'com.android.chrome',
    title: 'Google Chrome',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.3',
    sizeMb: 118,
    accentColor: '#4285F4',
    secondaryColor: '#EA4335',
    badge: 'GOOGLE APP',
    description:
      'WebXR & spatial web browser ready inside VR or launchable directly on Android.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.android.chrome',
    playableMode: 'google-suite-launch',
    googleService: 'chrome',
    webUrl: 'https://www.google.com',
  },
  {
    id: 'google-photos',
    packageId: 'com.google.android.apps.photos',
    title: 'Google Photos',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.6',
    sizeMb: 86,
    accentColor: '#FBBC04',
    secondaryColor: '#34A853',
    badge: 'GOOGLE APP',
    description:
      'Cinema-sized photo memories viewer and direct launcher for the Google Photos Android package.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.apps.photos',
    playableMode: 'google-suite-launch',
    googleService: 'photos',
    webUrl: 'https://photos.google.com',
  },
  {
    id: 'google-meet',
    packageId: 'com.google.android.apps.tachyon',
    title: 'Google Meet',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.5',
    sizeMb: 74,
    accentColor: '#00897B',
    secondaryColor: '#4285F4',
    badge: 'GOOGLE APP',
    description:
      'Launch Google Meet video calls or open your virtual meeting room straight from the VR deck.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.apps.tachyon',
    playableMode: 'google-suite-launch',
    googleService: 'meet',
    webUrl: 'https://meet.google.com',
  },
  {
    id: 'google-earth',
    packageId: 'com.google.earth',
    title: 'Google Earth',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.4',
    sizeMb: 58,
    accentColor: '#1A73E8',
    secondaryColor: '#0B8043',
    badge: 'GOOGLE APP',
    description:
      'Fly around the globe in 3D VR with compass orientation or open Google Earth on Android.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.earth',
    playableMode: 'google-suite-launch',
    googleService: 'earth',
    webUrl: 'https://earth.google.com',
  },
  {
    id: 'google-play-games',
    packageId: 'com.google.android.play.games',
    title: 'Google Play Games',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.3',
    sizeMb: 44,
    accentColor: '#0F9D58',
    secondaryColor: '#1E8E3E',
    badge: 'GOOGLE APP',
    description:
      'Manage your Google Play Games achievements, arcade titles, and gamer profile in VR.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.play.games',
    playableMode: 'google-suite-launch',
    googleService: 'play-games',
    webUrl: 'https://play.google.com/store/games',
  },
  {
    id: 'google-tv',
    packageId: 'com.google.android.videos',
    title: 'Google TV',
    developer: 'Google LLC',
    category: 'google',
    rating: '4.3',
    sizeMb: 49,
    accentColor: '#4285F4',
    secondaryColor: '#9334E6',
    badge: 'GOOGLE APP',
    description:
      'Dim the VR theater lounge for movies & shows or open Google TV on your Android device.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.videos',
    playableMode: 'google-suite-launch',
    googleService: 'google-tv',
    webUrl: 'https://tv.google.com',
  },

  // Built-In VR Games & Play Store Experiences
  {
    id: 'cosmic-blaster',
    packageId: 'com.pocketvr.cosmicblaster',
    title: 'Cosmic Blaster 360 VR',
    developer: 'Nebula Forge Studios',
    category: 'vr-games',
    rating: '4.8',
    sizeMb: 64,
    accentColor: '#38bdf8',
    secondaryColor: '#6366f1',
    badge: '360° HEAD-AIM',
    description:
      'Turn your head 360° using phone compass & tilt sensors to lock onto incoming drones and asteroids. Dwell, nod, or tap to fire plasma bolts.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.pocketvr.cosmicblaster',
    playableMode: 'cosmic-blaster',
    requiresCompass: true,
  },
  {
    id: 'neon-racer',
    packageId: 'com.synthwave.neonhorizonvr',
    title: 'Neon Horizon Racer VR',
    developer: 'TurboGrid Interactive',
    category: 'arcade',
    rating: '4.7',
    sizeMb: 88,
    accentColor: '#f472b6',
    secondaryColor: '#a855f7',
    badge: 'TILT STEER',
    description:
      'High-speed synthwave highway racer on the giant curved VR theater screen. Lean your head left/right to weave through neon gates.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.synthwave.neonhorizonvr',
    playableMode: 'neon-racer',
  },
  {
    id: 'cinema-4k',
    packageId: 'com.pocketvr.cinema4k',
    title: 'Pocket Cinema Theater',
    developer: 'Lumen Optics Lab',
    category: 'apps',
    rating: '4.9',
    sizeMb: 42,
    accentColor: '#fbbf24',
    secondaryColor: '#f97316',
    badge: 'IMAX VR',
    description:
      'Transform the room into a dimmed private IMAX VR theater with adjustable screen size, curvature, and ambient glow for Android media & apps.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.pocketvr.cinema4k',
    playableMode: 'cinema-deck',
  },
  {
    id: 'starlight-saber',
    packageId: 'com.arcade.starlightsaber',
    title: 'Starlight Defense VR',
    developer: 'PulseByte Games',
    category: 'vr-games',
    rating: '4.6',
    sizeMb: 112,
    accentColor: '#34d399',
    secondaryColor: '#059669',
    badge: 'COMPASS 3DoF',
    description:
      'Zero-gyro-friendly 360° orbital defense arena calibrated for magnetometer + accelerometer sensor fusion on budget Android phones.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.arcade.starlightsaber',
    playableMode: 'cosmic-blaster',
    requiresCompass: true,
  },
  {
    id: 'retro-synth',
    packageId: 'com.retro.outrunarcade',
    title: 'Outrun Drift Arcade',
    developer: 'BitWave Labs',
    category: 'arcade',
    rating: '4.5',
    sizeMb: 51,
    accentColor: '#22d3ee',
    secondaryColor: '#0284c7',
    badge: '60 FPS LITE',
    description:
      'Ultra-lightweight arcade VR drift racer tuned to run smoothly at 60 FPS on entry-level Android GPUs and Cardboard headsets.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.retro.outrunarcade',
    playableMode: 'neon-racer',
  },
  {
    id: 'android-deck',
    packageId: 'com.android.vrappspace',
    title: 'Android App Mirror Deck',
    developer: 'SpatialBridge OS',
    category: 'apps',
    rating: '4.7',
    sizeMb: 29,
    accentColor: '#a78bfa',
    secondaryColor: '#4f46e5',
    badge: 'PLAY LAUNCHER',
    description:
      'Launch and inspect any installed Android package inside a floating spatial viewport or open its Play Store listing directly.',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.android.vrappspace',
    playableMode: 'cinema-deck',
  },
];

const iconCache = new Map<string, THREE.Texture>();
const MAX_PROC_ICONS = 32;
let activeIconResolution = 128;

export function setCatalogTextureResolution(size: 128 | 256): void {
  if (activeIconResolution === size) return;
  activeIconResolution = size;
}

const GOOGLE_GLYPH_MAP: Record<string, string> = {
  gmail: 'M',
  drive: '▲',
  calendar: '31',
  docs: '≡',
  sheets: '⊞',
  slides: '▣',
  tasks: '✓',
  contacts: '👤',
  youtube: '▶',
  maps: '⌖',
  chrome: '◎',
  photos: '✿',
  meet: '📹',
  earth: '🌐',
  'play-games': '🎮',
  'google-tv': '📺',
};

/**
 * Generates a crisp procedural Play Store / Google app icon texture on an HTML5 canvas
 * at tier-adaptive POT resolution (128x128 on low-end / balanced GPUs -> 75% less VRAM)
 * with LRU eviction and mipmap suppression for fixed UI panels.
 */
export function getAppIconTexture(app: PlayStoreAppItem): THREE.Texture {
  const cached = iconCache.get(app.id);
  if (cached) {
    // Touch LRU order
    iconCache.delete(app.id);
    iconCache.set(app.id, cached);
    return cached;
  }

  const size = activeIconResolution;
  const s = size / 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.save();
    ctx.scale(s, s);
    if (app.category === 'google') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 256, 256);

      const googleColors = ['#EA4335', '#4285F4', '#34A853', '#FBBC04'];
      const r = 98;
      ctx.lineWidth = 14;
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = googleColors[i];
        ctx.beginPath();
        ctx.arc(128, 128, r, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
        ctx.stroke();
      }

      const grad = ctx.createLinearGradient(52, 52, 204, 204);
      grad.addColorStop(0, app.accentColor);
      grad.addColorStop(1, app.secondaryColor);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(128, 128, 72, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 64px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const glyph = (app.googleService && GOOGLE_GLYPH_MAP[app.googleService]) || 'G';
      ctx.fillText(glyph, 128, 132);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 256, 256);
      grad.addColorStop(0, app.accentColor);
      grad.addColorStop(1, app.secondaryColor);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);

      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 2;
      for (let i = 32; i < 256; i += 48) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 256);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(256, i);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(10, 15, 30, 0.35)';
      ctx.beginPath();
      ctx.arc(128, 128, 76, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(128, 128, 76, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 54px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initials = app.title
        .split(' ')
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('');
      ctx.fillText(initials || 'VR', 128, 130);
    }
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  if (iconCache.size >= MAX_PROC_ICONS) {
    const oldestKey = iconCache.keys().next().value;
    if (oldestKey) {
      iconCache.get(oldestKey)?.dispose();
      iconCache.delete(oldestKey);
    }
  }
  iconCache.set(app.id, texture);
  return texture;
}

const remoteIconCache = new Map<string, THREE.Texture>();
const MAX_REMOTE_ICONS = 20;
const textureLoader = new THREE.TextureLoader();

/**
 * Loads a proxied real Google Play Store icon into a Three.js Texture when available,
 * enforcing bounded LRU caching and mipmap suppression to keep mobile VRAM low.
 */
export function loadAppIconTextureAsync(
  app: PlayStoreAppItem,
  onLoaded: (texture: THREE.Texture) => void
): void {
  if (!app.iconUrl) return;
  const cached = remoteIconCache.get(app.iconUrl);
  if (cached) {
    remoteIconCache.delete(app.iconUrl);
    remoteIconCache.set(app.iconUrl, cached);
    onLoaded(cached);
    return;
  }

  textureLoader.load(
    app.iconUrl,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;

      if (remoteIconCache.size >= MAX_REMOTE_ICONS) {
        const oldestUrl = remoteIconCache.keys().next().value;
        if (oldestUrl) {
          remoteIconCache.get(oldestUrl)?.dispose();
          remoteIconCache.delete(oldestUrl);
        }
      }
      remoteIconCache.set(app.iconUrl!, tex);
      onLoaded(tex);
    },
    undefined,
    () => {
      // Keep procedural canvas fallback texture silently
    }
  );
}

/**
 * Aggressively trims cached remote and procedural icon textures under memory pressure
 * or when uninstalling apps from the VR launcher.
 */
export function trimCatalogTextureCache(aggressive = false): number {
  let disposed = 0;
  const targetRemote = aggressive ? 4 : Math.floor(MAX_REMOTE_ICONS / 2);
  while (remoteIconCache.size > targetRemote) {
    const oldest = remoteIconCache.keys().next().value;
    if (!oldest) break;
    remoteIconCache.get(oldest)?.dispose();
    remoteIconCache.delete(oldest);
    disposed += 1;
  }
  if (aggressive) {
    while (iconCache.size > 10) {
      const oldest = iconCache.keys().next().value;
      if (!oldest) break;
      iconCache.get(oldest)?.dispose();
      iconCache.delete(oldest);
      disposed += 1;
    }
  }
  return disposed;
}

export function getCatalogTextureStats(): {proceduralCount: number; remoteCount: number} {
  return {
    proceduralCount: iconCache.size,
    remoteCount: remoteIconCache.size,
  };
}

export function disposeCatalogTextures(): void {
  for (const tex of iconCache.values()) {
    tex.dispose();
  }
  iconCache.clear();
  for (const tex of remoteIconCache.values()) {
    tex.dispose();
  }
  remoteIconCache.clear();
}
