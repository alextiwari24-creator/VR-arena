import {getApps, initializeApp} from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import {GoogleAppKind} from '../types.ts';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

let auth: ReturnType<typeof getAuth> | null = null;
try {
  const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
} catch {
  auth = null;
}

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}

// Strict in-memory token cache (never stored in localStorage or sessionStorage)
let cachedAccessToken: string | null = null;
let isSigningIn = false;
let currentUser: User | null = null;
let needsAuth = true;
let lastAuthError = '';

export interface GoogleAuthSnapshot {
  signedIn: boolean;
  needsAuth: boolean;
  isSigningIn: boolean;
  userEmail: string;
  userName: string;
  errorMessage: string;
}

export interface WorkspaceFeedItem {
  title: string;
  detail: string;
  meta?: string;
  fullText?: string;
  linkUrl?: string;
  tableRows?: string[][];
  imageUrl?: string;
  videoId?: string;
}

export interface WorkspaceFeedResult {
  kind: GoogleAppKind;
  headline: string;
  subtitle: string;
  items: WorkspaceFeedItem[];
  requiresAuth: boolean;
  error?: string;
  fetchedAt: number;
  selectedLinkUrl?: string;
}

type AuthListener = (snapshot: GoogleAuthSnapshot) => void;
const listeners = new Set<AuthListener>();
let authListenerInitialized = false;

function notifyListeners(): void {
  const snap = getGoogleAuthSnapshot();
  for (const listener of listeners) {
    listener(snap);
  }
}

export function getGoogleAuthSnapshot(): GoogleAuthSnapshot {
  return {
    signedIn: Boolean(currentUser && cachedAccessToken),
    needsAuth,
    isSigningIn,
    userEmail: currentUser?.email ?? '',
    userName: currentUser?.displayName ?? '',
    errorMessage: lastAuthError,
  };
}

export function subscribeGoogleAuth(listener: AuthListener): () => void {
  ensureAuthInitialized();
  listeners.add(listener);
  listener(getGoogleAuthSnapshot());
  return () => {
    listeners.delete(listener);
  };
}

export function ensureAuthInitialized(): void {
  if (authListenerInitialized) return;
  authListenerInitialized = true;
  if (!auth) {
    needsAuth = true;
    notifyListeners();
    return;
  }

  try {
    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      if (user) {
        if (cachedAccessToken) {
          needsAuth = false;
        } else if (!isSigningIn) {
          cachedAccessToken = null;
          needsAuth = true;
        }
      } else {
        cachedAccessToken = null;
        needsAuth = true;
      }
      notifyListeners();
    });
  } catch {
    needsAuth = true;
    notifyListeners();
  }
}

export async function signInWithGoogle(): Promise<{
  user: User;
  accessToken: string;
} | null> {
  ensureAuthInitialized();
  if (!auth) {
    throw new Error('Google sign-in unavailable in this browser environment.');
  }
  if (isSigningIn) return null;

  try {
    isSigningIn = true;
    lastAuthError = '';
    notifyListeners();

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google sign-in did not return an API access token.');
    }

    cachedAccessToken = credential.accessToken;
    currentUser = result.user;
    needsAuth = false;
    notifyListeners();
    return {user: result.user, accessToken: cachedAccessToken};
  } catch (err) {
    lastAuthError = err instanceof Error ? err.message : 'Google sign-in failed.';
    needsAuth = !cachedAccessToken;
    notifyListeners();
    throw err;
  } finally {
    isSigningIn = false;
    notifyListeners();
  }
}

export async function signOutGoogle(): Promise<void> {
  cachedAccessToken = null;
  needsAuth = true;
  lastAuthError = '';
  if (auth) {
    await auth.signOut();
  }
  notifyListeners();
}

export function getAccessToken(): string | null {
  return cachedAccessToken;
}

async function fetchGoogleJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    cachedAccessToken = null;
    needsAuth = true;
    notifyListeners();
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Google permission required (${res.status}). Sign in again to refresh Workspace access. ${errText.slice(0, 80)}`
    );
  }
  if (!res.ok) {
    throw new Error(`Google API error (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function fetchGoogleWorkspaceFeed(
  kind: GoogleAppKind
): Promise<WorkspaceFeedResult> {
  const token = cachedAccessToken;
  if (!token) {
    needsAuth = true;
    notifyListeners();
    return {
      kind,
      headline: `${kind.toUpperCase()} — Sign In Required`,
      subtitle: 'Connect your Google account to view real live data in VR.',
      items: [],
      requiresAuth: true,
      fetchedAt: Date.now(),
    };
  }

  try {
    switch (kind) {
      case 'gmail':
        return await fetchGmailFeed(token);
      case 'drive':
        return await fetchDriveFeed(token);
      case 'calendar':
        return await fetchCalendarFeed(token);
      case 'docs':
        return await fetchDocsFeed(token);
      case 'sheets':
        return await fetchSheetsFeed(token);
      case 'slides':
        return await fetchSlidesFeed(token);
      case 'tasks':
        return await fetchTasksFeed(token);
      case 'contacts':
        return await fetchContactsFeed(token);
      default:
        return {
          kind,
          headline: `${kind.toUpperCase()}`,
          subtitle: 'Installed Android Google App',
          items: [],
          requiresAuth: false,
          fetchedAt: Date.now(),
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load Google data.';
    return {
      kind,
      headline: `${kind.toUpperCase()} — Sync Notice`,
      subtitle: msg,
      items: [],
      requiresAuth: !cachedAccessToken,
      error: msg,
      fetchedAt: Date.now(),
    };
  }
}

async function fetchGmailFeed(token: string): Promise<WorkspaceFeedResult> {
  const list = await fetchGoogleJson<{messages?: Array<{id: string}>}>(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=8',
    token
  );
  const ids = (list.messages ?? []).slice(0, 6).map((m) => m.id);
  const items: WorkspaceFeedItem[] = [];

  if (ids.length > 0) {
    const details = await Promise.all(
      ids.map((id) =>
        fetchGoogleJson<{
          id: string;
          snippet?: string;
          labelIds?: string[];
          payload?: {headers?: Array<{name: string; value: string}>};
        }>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
            id
          )}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          token
        )
      )
    );
    for (const msg of details) {
      const headers = msg.payload?.headers ?? [];
      const subject =
        headers.find((h) => h.name.toLowerCase() === 'subject')?.value || '(No Subject)';
      const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value || 'Unknown Sender';
      const dateRaw = headers.find((h) => h.name.toLowerCase() === 'date')?.value || '';
      const unread = msg.labelIds?.includes('UNREAD') ? 'UNREAD • ' : '';
      const cleanFrom = from.replace(/<.*?>/g, '').trim();
      items.push({
        title: `${unread}${subject}`,
        detail: msg.snippet || '',
        meta: cleanFrom,
        fullText: `From: ${from}\nDate: ${dateRaw}\n\n${msg.snippet || ''}`,
        linkUrl: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(msg.id)}`,
      });
    }
  }

  return {
    kind: 'gmail',
    headline: 'Gmail Inbox (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • ${items.length} recent messages`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0]?.linkUrl ?? 'https://mail.google.com',
  };
}

async function fetchDriveFeed(token: string): Promise<WorkspaceFeedResult> {
  const data = await fetchGoogleJson<{
    files?: Array<{
      id: string;
      name: string;
      mimeType: string;
      modifiedTime?: string;
      size?: string;
      webViewLink?: string;
    }>;
  }>(
    'https://www.googleapis.com/drive/v3/files?pageSize=8&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)',
    token
  );
  const items: WorkspaceFeedItem[] = (data.files ?? []).map((f) => {
    const typeLabel = f.mimeType.split('.').pop()?.toUpperCase() || 'FILE';
    const dateLabel = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '';
    const sizeKb = f.size ? ` • ${Math.max(1, Math.round(Number(f.size) / 1024))} KB` : '';
    return {
      title: f.name,
      detail: `Type: ${typeLabel}${sizeKb}`,
      meta: dateLabel,
      fullText: `File: ${f.name}\nMIME: ${f.mimeType}\nUpdated: ${dateLabel || 'Recent'}${sizeKb}`,
      linkUrl: f.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view`,
    };
  });

  return {
    kind: 'drive',
    headline: 'Google Drive (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • Recent files`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0]?.linkUrl ?? 'https://drive.google.com',
  };
}

async function fetchCalendarFeed(token: string): Promise<WorkspaceFeedResult> {
  const nowIso = encodeURIComponent(new Date().toISOString());
  const data = await fetchGoogleJson<{
    items?: Array<{
      summary?: string;
      location?: string;
      description?: string;
      hangoutLink?: string;
      htmlLink?: string;
      start?: {dateTime?: string; date?: string};
      end?: {dateTime?: string; date?: string};
    }>;
  }>(
    `https://www.calendar.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${nowIso}&maxResults=8&singleEvents=true&orderBy=startTime`,
    token
  ).catch(() =>
    fetchGoogleJson<{
      items?: Array<{
        summary?: string;
        location?: string;
        description?: string;
        hangoutLink?: string;
        htmlLink?: string;
        start?: {dateTime?: string; date?: string};
        end?: {dateTime?: string; date?: string};
      }>;
    }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${nowIso}&maxResults=8&singleEvents=true&orderBy=startTime`,
      token
    )
  );

  const items: WorkspaceFeedItem[] = (data.items ?? []).map((ev) => {
    const startRaw = ev.start?.dateTime || ev.start?.date || '';
    const when = startRaw ? new Date(startRaw).toLocaleString() : 'Scheduled';
    const meetNote = ev.hangoutLink ? `Meet: ${ev.hangoutLink}` : '';
    return {
      title: ev.summary || '(Untitled Event)',
      detail: ev.location ? `Location: ${ev.location}` : meetNote || when,
      meta: when,
      fullText: [
        `When: ${when}`,
        ev.location ? `Where: ${ev.location}` : '',
        meetNote,
        ev.description ? ev.description.replace(/<[^>]+>/g, ' ').slice(0, 260) : '',
      ]
        .filter(Boolean)
        .join('\n'),
      linkUrl: ev.hangoutLink || ev.htmlLink || 'https://calendar.google.com',
    };
  });

  return {
    kind: 'calendar',
    headline: 'Google Calendar (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • Upcoming events`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0]?.linkUrl ?? 'https://calendar.google.com',
  };
}

async function fetchDocsFeed(token: string): Promise<WorkspaceFeedResult> {
  const q = encodeURIComponent(
    "mimeType='application/vnd.google-apps.document' and trashed=false"
  );
  const list = await fetchGoogleJson<{
    files?: Array<{id: string; name: string; modifiedTime?: string; webViewLink?: string}>;
  }>(
    `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=6&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,webViewLink)`,
    token
  );

  const files = list.files ?? [];
  const items: WorkspaceFeedItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let excerpt = f.modifiedTime
      ? `Updated ${new Date(f.modifiedTime).toLocaleDateString()}`
      : 'Google Docs Document';
    let fullText = excerpt;

    if (i < 2) {
      try {
        const doc = await fetchGoogleJson<{
          body?: {
            content?: Array<{
              paragraph?: {elements?: Array<{textRun?: {content?: string}}>};
            }>;
          };
        }>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(f.id)}`, token);
        const text = (doc.body?.content ?? [])
          .flatMap((c) => c.paragraph?.elements ?? [])
          .map((el) => el.textRun?.content ?? '')
          .join('')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (text) {
          excerpt = text.replace(/\s+/g, ' ').slice(0, 96);
          fullText = text.slice(0, 900);
        }
      } catch {
        // Keep modified date fallback if doc read fails
      }
    }

    items.push({
      title: f.name,
      detail: excerpt,
      meta: 'DOCS',
      fullText,
      linkUrl: f.webViewLink || `https://docs.google.com/document/d/${encodeURIComponent(f.id)}/edit`,
    });
  }

  return {
    kind: 'docs',
    headline: 'Google Docs (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • Recent documents`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0]?.linkUrl ?? 'https://docs.google.com',
  };
}

async function fetchSheetsFeed(token: string): Promise<WorkspaceFeedResult> {
  const q = encodeURIComponent(
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
  );
  const list = await fetchGoogleJson<{
    files?: Array<{id: string; name: string; modifiedTime?: string; webViewLink?: string}>;
  }>(
    `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=6&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,webViewLink)`,
    token
  );

  const files = list.files ?? [];
  const items: WorkspaceFeedItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let detail = f.modifiedTime
      ? `Modified ${new Date(f.modifiedTime).toLocaleDateString()}`
      : 'Google Spreadsheet';
    let tableRows: string[][] | undefined;

    if (i === 0) {
      try {
        const sheet = await fetchGoogleJson<{
          sheets?: Array<{properties?: {title?: string}}>;
        }>(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
            f.id
          )}?fields=properties.title,sheets.properties.title`,
          token
        );
        const firstTab = sheet.sheets?.[0]?.properties?.title;
        const tabNames = (sheet.sheets ?? [])
          .map((s) => s.properties?.title)
          .filter(Boolean)
          .join(', ');
        if (tabNames) {
          detail = `Tabs: ${tabNames}`;
        }
        if (firstTab) {
          const valRes = await fetchGoogleJson<{values?: string[][]}>(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
              f.id
            )}/values/${encodeURIComponent(`${firstTab}!A1:E7`)}`,
            token
          );
          if (valRes.values && valRes.values.length > 0) {
            tableRows = valRes.values;
          }
        }
      } catch {
        // Keep fallback
      }
    }

    items.push({
      title: f.name,
      detail,
      meta: 'SHEETS',
      tableRows,
      linkUrl:
        f.webViewLink || `https://docs.google.com/spreadsheets/d/${encodeURIComponent(f.id)}/edit`,
    });
  }

  return {
    kind: 'sheets',
    headline: 'Google Sheets (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • Recent spreadsheets`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0]?.linkUrl ?? 'https://sheets.google.com',
  };
}

async function fetchSlidesFeed(token: string): Promise<WorkspaceFeedResult> {
  const q = encodeURIComponent(
    "mimeType='application/vnd.google-apps.presentation' and trashed=false"
  );
  const list = await fetchGoogleJson<{
    files?: Array<{id: string; name: string; modifiedTime?: string; webViewLink?: string}>;
  }>(
    `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=6&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,webViewLink)`,
    token
  );

  const files = list.files ?? [];
  const items: WorkspaceFeedItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let detail = f.modifiedTime
      ? `Updated ${new Date(f.modifiedTime).toLocaleDateString()}`
      : 'Google Presentation';
    let fullText = detail;

    if (i === 0) {
      try {
        const pres = await fetchGoogleJson<{
          slides?: Array<{
            objectId?: string;
            pageElements?: Array<{
              shape?: {
                text?: {
                  textElements?: Array<{textRun?: {content?: string}}>;
                };
              };
            }>;
          }>;
        }>(
          `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(
            f.id
          )}?fields=title,slides(objectId,pageElements.shape.text.textElements.textRun.content)`,
          token
        );
        if (pres.slides) {
          detail = `${pres.slides.length} slides ready in VR`;
          const slideSummaries = pres.slides.slice(0, 6).map((s, idx) => {
            const text = (s.pageElements ?? [])
              .flatMap((el) => el.shape?.text?.textElements ?? [])
              .map((te) => te.textRun?.content ?? '')
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            return `Slide ${idx + 1}: ${text || '(Visual Slide)'}`;
          });
          fullText = slideSummaries.join('\n');
        }
      } catch {
        // Keep fallback
      }
    }

    items.push({
      title: f.name,
      detail,
      meta: 'SLIDES',
      fullText,
      linkUrl:
        f.webViewLink || `https://docs.google.com/presentation/d/${encodeURIComponent(f.id)}/edit`,
    });
  }

  return {
    kind: 'slides',
    headline: 'Google Slides (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • Presentations`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: items[0]?.linkUrl ?? 'https://slides.google.com',
  };
}

async function fetchTasksFeed(token: string): Promise<WorkspaceFeedResult> {
  const data = await fetchGoogleJson<{
    items?: Array<{title?: string; status?: string; due?: string; notes?: string}>;
  }>(
    'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?maxResults=10&showCompleted=true',
    token
  );

  const items: WorkspaceFeedItem[] = (data.items ?? [])
    .filter((t) => Boolean(t.title))
    .map((t) => ({
      title: `${t.status === 'completed' ? '✓' : '○'} ${t.title ?? 'Task'}`,
      detail: t.due
        ? `Due: ${new Date(t.due).toLocaleDateString()}`
        : t.notes || t.status || 'needsAction',
      meta: t.status === 'completed' ? 'DONE' : 'OPEN',
      fullText: [t.title, t.notes, t.due ? `Due ${new Date(t.due).toLocaleString()}` : '']
        .filter(Boolean)
        .join('\n'),
      linkUrl: 'https://tasks.google.com',
    }));

  return {
    kind: 'tasks',
    headline: 'Google Tasks (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • Task checklist`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: 'https://tasks.google.com',
  };
}

async function fetchContactsFeed(token: string): Promise<WorkspaceFeedResult> {
  const data = await fetchGoogleJson<{
    connections?: Array<{
      names?: Array<{displayName?: string}>;
      emailAddresses?: Array<{value?: string}>;
      phoneNumbers?: Array<{value?: string}>;
      organizations?: Array<{name?: string; title?: string}>;
    }>;
  }>(
    'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations&pageSize=8',
    token
  );

  const items: WorkspaceFeedItem[] = (data.connections ?? []).map((p) => {
    const name = p.names?.[0]?.displayName || 'Unnamed Contact';
    const email = p.emailAddresses?.[0]?.value || '';
    const phone = p.phoneNumbers?.[0]?.value || '';
    const org = p.organizations?.[0]?.name || '';
    return {
      title: name,
      detail: [email, phone, org].filter(Boolean).join(' • ') || 'Google Contact',
      meta: 'CONTACT',
      fullText: [name, email && `Email: ${email}`, phone && `Phone: ${phone}`, org && `Org: ${org}`]
        .filter(Boolean)
        .join('\n'),
      linkUrl: 'https://contacts.google.com',
    };
  });

  return {
    kind: 'contacts',
    headline: 'Google Contacts (Live)',
    subtitle: `${currentUser?.email ?? 'Google Account'} • Saved people`,
    items,
    requiresAuth: false,
    fetchedAt: Date.now(),
    selectedLinkUrl: 'https://contacts.google.com',
  };
}

export async function fetchCalendarMeetMeetings(): Promise<WorkspaceFeedItem[]> {
  const token = cachedAccessToken;
  if (!token) return [];
  const nowIso = encodeURIComponent(new Date().toISOString());
  const data = await fetchGoogleJson<{
    items?: Array<{
      summary?: string;
      hangoutLink?: string;
      htmlLink?: string;
      start?: {dateTime?: string; date?: string};
    }>;
  }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${nowIso}&maxResults=10&singleEvents=true&orderBy=startTime`,
    token
  );

  return (data.items ?? [])
    .filter((ev) => Boolean(ev.hangoutLink))
    .map((ev) => {
      const startRaw = ev.start?.dateTime || ev.start?.date || '';
      const when = startRaw ? new Date(startRaw).toLocaleString() : 'Upcoming';
      return {
        title: ev.summary || 'Google Meet Video Call',
        detail: ev.hangoutLink || '',
        meta: when,
        linkUrl: ev.hangoutLink || ev.htmlLink || 'https://meet.google.com',
      };
    });
}
