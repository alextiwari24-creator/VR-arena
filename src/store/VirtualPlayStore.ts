import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {VRGameTheater} from '../games/VRGameTheater.ts';
import {
  signInWithGoogle,
  signOutGoogle,
  subscribeGoogleAuth,
} from '../services/googleWorkspaceService.ts';
import {
  BrowserBrowseCategory,
  browserItemToStoreApp,
  searchGooglePlayStore,
} from '../services/playStoreBrowserService.ts';
import {
  AppInstallState,
  PlayStoreAppItem,
  StoreCategory,
} from '../types.ts';
import {
  getAppIconTexture,
  loadAppIconTextureAsync,
  PLAY_STORE_CATALOG,
} from './catalog.ts';

const STORAGE_KEY_INSTALLS = 'pocketvr_installed_apps_v1';
const STORAGE_KEY_CUSTOM = 'pocketvr_custom_apps_v1';
const STORAGE_KEY_UNINSTALLED_DEFAULTS = 'pocketvr_uninstalled_defaults_v1';

interface AppRowBinding {
  app: PlayStoreAppItem;
  row: xb.UIPanel;
  statusText: xb.UIText;
  downloadBtn: xb.UIButton;
  primaryBtn: xb.UIButton;
  progressFill: xb.UIPanel;
  progressTrack: xb.UIPanel;
}

export type InstallTargetMode = 'vr-wrapper' | 'head-gaze' | 'play-market';

export class VirtualPlayStore extends xb.UICard {
  private readonly theater: VRGameTheater;
  private readonly sound: SoundEngine;
  private readonly onLaunchInVRMode?: (app: PlayStoreAppItem) => void;
  private readonly onInspectApp?: (app: PlayStoreAppItem) => void;

  private catalog: PlayStoreAppItem[] = [...PLAY_STORE_CATALOG];
  private installStates = new Map<string, AppInstallState>();
  private uninstalledDefaultIds = new Set<string>();
  private rowBindings = new Map<string, AppRowBinding>();
  private stateListeners = new Set<() => void>();

  private activeCategory: StoreCategory = 'all';
  private installMode: InstallTargetMode = 'vr-wrapper';
  private searchQuery = '';
  private liveFetchSeq = 0;
  private fetchedLiveCount = 0;

  private searchInput: xb.UITextInput;
  private fetchPlayBtn: xb.UIButton;
  private sideloadBtn: xb.UIButton;
  private installModeBtn: xb.UIButton;
  private googleAuthBtn: xb.UIButton;
  private statusBanner: xb.UIText;
  private scrollView: xb.UIScrollView;
  private pageUpBtn: xb.UIButton;
  private pageDownBtn: xb.UIButton;
  private categoryButtons = new Map<StoreCategory, xb.UIButton>();
  private activeInstallIds = new Set<string>();
  private unsubAuth: (() => void) | null = null;
  private isGoogleSignedIn = false;

  constructor(
    theater: VRGameTheater,
    sound: SoundEngine,
    onLaunchInVRMode?: (app: PlayStoreAppItem) => void,
    onInspectApp?: (app: PlayStoreAppItem) => void
  ) {
    const statusBanner = new xb.UIText({
      text: 'Fetching live Google Play Store VR catalog... Gaze Download or Install.',
      style: {fontSize: 12, color: '#38bdf8', textAlign: 'left'},
    });

    const searchInput = new xb.UITextInput({
      ariaLabel: 'Search Play Store VR apps or enter Android package ID',
      placeholder: 'Search Play Store or enter package ID...',
      style: {flexGrow: 1, height: 36, fontSize: 13},
    });

    const fetchPlayBtn = new xb.UIButton({
      label: 'Search Play',
      icon: 'travel_explore',
      style: {height: 36, fontSize: 12.5},
    });

    const sideloadBtn = new xb.UIButton({
      label: 'Add ID',
      icon: 'add_circle',
      style: {height: 36, fontSize: 12.5},
    });

    const googleAuthBtn = new xb.UIButton({
      label: 'Google Sign-In',
      icon: 'account_circle',
      style: {height: 34, fontSize: 12, ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.25)'}},
    });

    const installModeBtn = new xb.UIButton({
      label: 'Option: VR Wrapper',
      icon: 'install_mobile',
      style: {
        height: 34,
        fontSize: 11.5,
        ':hover': {backgroundColor: 'rgba(52, 211, 153, 0.25)'},
      },
    });

    const scrollView = new xb.UIScrollView({
      ariaLabel: 'Play Store app catalog',
      style: {
        width: '100%',
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 220,
        gap: 10,
      },
    });

    const pageUpBtn = new xb.UIButton({
      label: 'Scroll Up',
      icon: 'keyboard_arrow_up',
      style: {
        flexGrow: 1,
        height: 36,
        fontSize: 12,
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.25)'},
      },
    });
    const pageDownBtn = new xb.UIButton({
      label: 'Scroll Down',
      icon: 'keyboard_arrow_down',
      style: {
        flexGrow: 1,
        height: 36,
        fontSize: 12,
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.25)'},
      },
    });

    const categories: Array<{id: StoreCategory; label: string}> = [
      {id: 'all', label: 'All'},
      {id: 'vr-games', label: 'VR Games'},
      {id: 'google', label: 'Google'},
      {id: 'arcade', label: 'Arcade'},
      {id: 'apps', label: 'Apps'},
      {id: 'installed', label: 'Installed'},
    ];
    const categoryButtons = new Map<StoreCategory, xb.UIButton>();
    const categoryRowChildren: xb.UIButton[] = [];
    for (const cat of categories) {
      const btn = new xb.UIButton({
        label: cat.label,
        style: {flexGrow: 1, height: 32, fontSize: 12},
      });
      categoryButtons.set(cat.id, btn);
      categoryRowChildren.push(btn);
    }

    const quickQueries = ['VR Game', 'Minecraft', 'YouTube', 'Fitness VR'];
    const quickSearchRow = new xb.UIPanel({
      style: {width: '100%', flexDirection: 'row', gap: 5},
      children: quickQueries.map(
        (term) =>
          new xb.UIButton({
            label: term,
            style: {flexGrow: 1, height: 28, fontSize: 11},
            onClick: () => {
              this.sound.playClick();
              this.searchInput.value = term;
              this.searchQuery = term.toLowerCase();
              this.rebuildRows();
              void this.fetchDynamicPlayStore(term, 'vr');
            },
          })
      ),
    });

    super({
      size: {width: 0.78, height: 0.76},
      manipulation: true,
      edge: true,
      style: {flexDirection: 'column', gap: 9, padding: 16},
      children: [
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 6,
          },
          children: [
            new xb.UIPanel({
              style: {flexDirection: 'row', alignItems: 'center', gap: 8},
              children: [
                new xb.UIIcon({
                  icon: 'shop',
                  style: {width: 26, height: 26, color: '#34d399'},
                }),
                new xb.UIText({
                  text: 'Google Play VR Storefront',
                  style: {fontSize: 19, fontWeight: 'bold'},
                }),
              ],
            }),
            new xb.UIPanel({
              style: {flexDirection: 'row', gap: 6, alignItems: 'center'},
              children: [installModeBtn, googleAuthBtn],
            }),
          ],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 6, alignItems: 'center'},
          children: [searchInput, fetchPlayBtn, sideloadBtn],
        }),
        quickSearchRow,
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 5},
          children: categoryRowChildren,
        }),
        statusBanner,
        scrollView,
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8, alignItems: 'center'},
          children: [pageUpBtn, pageDownBtn],
        }),
      ],
    });

    this.name = 'Virtual Play Store card';
    this.theater = theater;
    this.sound = sound;
    this.onLaunchInVRMode = onLaunchInVRMode;
    this.onInspectApp = onInspectApp;
    this.searchInput = searchInput;
    this.fetchPlayBtn = fetchPlayBtn;
    this.sideloadBtn = sideloadBtn;
    this.installModeBtn = installModeBtn;
    this.googleAuthBtn = googleAuthBtn;
    this.statusBanner = statusBanner;
    this.scrollView = scrollView;
    this.pageUpBtn = pageUpBtn;
    this.pageDownBtn = pageDownBtn;
    this.categoryButtons = categoryButtons;

    this.loadPersistedState();
    this.wireControls();
    this.rebuildRows();
    this.updateCategoryHighlights();

    this.unsubAuth = subscribeGoogleAuth((snap) => {
      this.isGoogleSignedIn = snap.signedIn;
      if (snap.isSigningIn) {
        this.googleAuthBtn.label = 'Signing in...';
        this.googleAuthBtn.disabled = true;
      } else if (snap.signedIn) {
        this.googleAuthBtn.label = snap.userEmail ? snap.userEmail.split('@')[0] : 'Connected';
        this.googleAuthBtn.icon = 'verified_user';
        this.googleAuthBtn.disabled = false;
        this.statusBanner.text = `Google connected (${snap.userEmail}). Download & Launch VR apps!`;
      } else {
        this.googleAuthBtn.label = 'Google Sign-In';
        this.googleAuthBtn.icon = 'account_circle';
        this.googleAuthBtn.disabled = false;
      }
    });

    // Dynamically fetch curated Google Play Store VR titles on startup
    void this.fetchDynamicPlayStore('VR game', 'vr');
  }

  public subscribeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private emitStateChange(): void {
    for (const listener of this.stateListeners) {
      listener();
    }
  }

  public getInstalledApps(): PlayStoreAppItem[] {
    return this.catalog.filter((app) => {
      const state = this.installStates.get(app.id);
      return state?.stage === 'installed' && app.vrCompatible !== false;
    });
  }

  public getInstallState(appId: string): AppInstallState | undefined {
    return this.installStates.get(appId);
  }

  public uninstallApp(appId: string): boolean {
    const app = this.catalog.find((c) => c.id === appId);
    if (!app) return false;

    this.activeInstallIds.delete(appId);
    this.installStates.delete(appId);
    if (PLAY_STORE_CATALOG.some((base) => base.id === appId)) {
      this.uninstalledDefaultIds.add(appId);
    }

    this.persistState();
    this.syncRowState(appId);
    if (this.activeCategory === 'installed') {
      this.rebuildRows();
    }
    this.statusBanner.text = `Uninstalled ${app.title} (${app.sizeMb} MB freed).`;
    this.emitStateChange();
    return true;
  }

  public restoreDefaultApps(): void {
    this.uninstalledDefaultIds.clear();
    const now = Date.now();
    for (const item of this.catalog) {
      if (item.category === 'google' || item.id === 'cosmic-blaster' || item.id === 'neon-racer') {
        if (!this.installStates.has(item.id)) {
          this.installStates.set(item.id, {
            stage: 'installed',
            progress: 100,
            installedAt: now,
          });
        }
      }
    }
    this.persistState();
    this.rebuildRows();
    this.statusBanner.text = 'Restored all default Google & VR starter apps.';
    this.emitStateChange();
  }

  public getScrollView(): xb.UIScrollView {
    return this.scrollView;
  }

  public openPlayStoreLink(app: PlayStoreAppItem): void {
    this.handleDownloadFromPlayStore(app);
  }

  public launchAppInVR(app: PlayStoreAppItem): void {
    this.statusBanner.text = `Launching ${app.title} into VR Mode...`;
    if (this.onLaunchInVRMode) {
      this.onLaunchInVRMode(app);
    } else {
      this.theater.launchApp(app);
    }
  }

  private loadPersistedState(): void {
    try {
      const uninstalledRaw = localStorage.getItem(STORAGE_KEY_UNINSTALLED_DEFAULTS);
      if (uninstalledRaw) {
        for (const id of JSON.parse(uninstalledRaw) as string[]) {
          this.uninstalledDefaultIds.add(id);
        }
      }

      const customRaw = localStorage.getItem(STORAGE_KEY_CUSTOM);
      if (customRaw) {
        const customItems = JSON.parse(customRaw) as PlayStoreAppItem[];
        for (const item of customItems) {
          if (!this.catalog.some((c) => c.id === item.id)) {
            this.catalog.unshift(item);
          }
        }
      }

      const installRaw = localStorage.getItem(STORAGE_KEY_INSTALLS);
      if (installRaw) {
        const parsed = JSON.parse(installRaw) as Record<string, AppInstallState>;
        for (const [id, st] of Object.entries(parsed)) {
          if (st.stage === 'installed') {
            this.installStates.set(id, st);
          }
        }
      }
    } catch {
      // Ignore storage errors in restricted contexts
    }

    // Pre-install core Google suite & starter VR apps unless explicitly uninstalled by user
    const now = Date.now();
    for (const item of this.catalog) {
      const isStarter =
        item.category === 'google' || item.id === 'cosmic-blaster' || item.id === 'neon-racer';
      if (isStarter && !this.uninstalledDefaultIds.has(item.id)) {
        if (!this.installStates.has(item.id)) {
          this.installStates.set(item.id, {
            stage: 'installed',
            progress: 100,
            installedAt: now,
          });
        }
      }
    }
  }

  private persistState(): void {
    try {
      const installsObj: Record<string, AppInstallState> = {};
      for (const [id, st] of this.installStates.entries()) {
        if (st.stage === 'installed') installsObj[id] = st;
      }
      localStorage.setItem(STORAGE_KEY_INSTALLS, JSON.stringify(installsObj));

      const customOnly = this.catalog.filter(
        (c) => !PLAY_STORE_CATALOG.some((base) => base.id === c.id)
      );
      localStorage.setItem(STORAGE_KEY_CUSTOM, JSON.stringify(customOnly));

      localStorage.setItem(
        STORAGE_KEY_UNINSTALLED_DEFAULTS,
        JSON.stringify([...this.uninstalledDefaultIds])
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  private wireControls(): void {
    this.googleAuthBtn.onClick = () => {
      this.sound.playClick();
      if (this.isGoogleSignedIn) {
        void signOutGoogle().then(() => {
          this.statusBanner.text = 'Signed out of Google Workspace.';
        });
      } else {
        void signInWithGoogle().catch((err) => {
          this.statusBanner.text =
            err instanceof Error ? err.message : 'Use top-right Sign in with Google button.';
        });
      }
    };

    this.searchInput.onInput = (value) => {
      this.searchQuery = value.trim().toLowerCase();
      this.rebuildRows();
    };

    this.searchInput.onSubmit = () => {
      const raw = this.searchInput.value.trim();
      if (!raw) return;
      if (/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(raw) || raw.includes('play.google.com')) {
        this.handleAddCustomPackage();
      } else {
        void this.fetchDynamicPlayStore(raw, 'vr');
      }
    };

    this.fetchPlayBtn.onClick = () => {
      this.sound.playClick();
      const raw = this.searchInput.value.trim() || this.getSuggestedQueryForCategory(this.activeCategory);
      const apiCat: BrowserBrowseCategory =
        this.activeCategory === 'vr-games' || this.activeCategory === 'arcade' ? 'games' : 'vr';
      void this.fetchDynamicPlayStore(raw, apiCat);
    };

    this.sideloadBtn.onClick = () => {
      this.sound.playClick();
      this.handleAddCustomPackage();
    };

    this.pageUpBtn.onClick = () => {
      this.sound.playClick();
      this.scrollView.scrollTop = Math.max(0, this.scrollView.scrollTop - 210);
    };

    this.pageDownBtn.onClick = () => {
      this.sound.playClick();
      this.scrollView.scrollTop = this.scrollView.scrollTop + 210;
    };

    this.installModeBtn.onClick = () => {
      this.sound.playClick();
      const order: InstallTargetMode[] = ['vr-wrapper', 'head-gaze', 'play-market'];
      const next = order[(order.indexOf(this.installMode) + 1) % order.length];
      this.installMode = next;
      this.installModeBtn.label =
        next === 'vr-wrapper'
          ? 'Option: VR Wrapper'
          : next === 'head-gaze'
            ? 'Option: Head-Gaze'
            : 'Option: Play Link';
      this.statusBanner.text =
        next === 'vr-wrapper'
          ? 'Install Option: Wraps Android APK into Stereoscopic VR Theater.'
          : next === 'head-gaze'
            ? 'Install Option: Configures 9-DoF Head-Gaze & Single-Button Control.'
            : 'Install Option: Opens official Google Play Store download directly.';
    };

    for (const [catId, btn] of this.categoryButtons.entries()) {
      btn.onClick = () => {
        this.sound.playClick();
        this.activeCategory = catId;
        this.updateCategoryHighlights();
        this.scrollView.scrollTop = 0;
        this.rebuildRows();
        if (catId === 'vr-games' || catId === 'arcade') {
          void this.fetchDynamicPlayStore('VR game', 'games');
        }
      };
    }
  }

  private getSuggestedQueryForCategory(cat: StoreCategory): string {
    switch (cat) {
      case 'vr-games':
        return 'VR game';
      case 'arcade':
        return 'arcade VR';
      case 'google':
        return 'Google';
      default:
        return 'VR apps';
    }
  }

  public async fetchDynamicPlayStore(
    query: string,
    category: BrowserBrowseCategory = 'vr'
  ): Promise<void> {
    const seq = ++this.liveFetchSeq;
    this.statusBanner.text = `Fetching live Google Play Store results for "${query}"...`;

    const res = await searchGooglePlayStore(query, category);
    if (seq !== this.liveFetchSeq) return;

    let addedCount = 0;
    for (const item of res.results) {
      const converted = browserItemToStoreApp(item);
      if (res.source === 'live-play-store') {
        converted.vrCompatible = true;
      }
      const existing = this.catalog.find(
        (c) => c.packageId.toLowerCase() === converted.packageId.toLowerCase()
      );
      if (existing) {
        if (converted.iconUrl && !existing.iconUrl) {
          existing.iconUrl = converted.iconUrl;
        }
      } else {
        this.catalog.push(converted);
        addedCount += 1;
      }
    }

    if (addedCount > 0) {
      this.fetchedLiveCount += addedCount;
      this.persistState();
    }

    this.rebuildRows();
    this.statusBanner.text =
      res.source === 'live-play-store'
        ? `Live Google Play: ${res.results.length} results (${this.fetchedLiveCount} synced) • Gaze Download or Play!`
        : `Curated Play Store VR catalog ready (${this.catalog.length} apps).`;
  }

  private updateCategoryHighlights(): void {
    for (const [catId, btn] of this.categoryButtons.entries()) {
      const active = catId === this.activeCategory;
      btn.style.backgroundColor = active
        ? 'rgba(56, 189, 248, 0.35)'
        : 'rgba(255, 255, 255, 0.08)';
    }
  }

  private handleAddCustomPackage(): void {
    const raw = this.searchInput.value.trim();
    if (!raw) {
      this.statusBanner.text = 'Type a Play Store link or package ID (e.g. com.mojang.minecraftpe).';
      return;
    }

    let packageId = raw;
    if (raw.includes('id=')) {
      const match = raw.match(/[?&]id=([a-zA-Z0-9._]+)/);
      if (match?.[1]) packageId = match[1];
    } else {
      packageId = raw.replace(/[^a-zA-Z0-9._]/g, '');
      if (!packageId.includes('.')) {
        packageId = `com.playvr.${packageId.toLowerCase()}`;
      }
    }

    const existing = this.catalog.find(
      (c) => c.packageId.toLowerCase() === packageId.toLowerCase()
    );
    if (existing) {
      this.statusBanner.text = `${existing.title} is already in your Play Store list.`;
      return;
    }

    const shortName = packageId.split('.').pop() || 'Android App';
    const title = shortName.charAt(0).toUpperCase() + shortName.slice(1) + ' VR';
    const customApp: PlayStoreAppItem = {
      id: `custom-${Date.now()}`,
      packageId,
      title,
      developer: 'Google Play Package',
      category: 'apps',
      rating: '4.5',
      sizeMb: 75,
      accentColor: '#34d399',
      secondaryColor: '#0f766e',
      badge: 'PLAY PACKAGE',
      description: `Custom Android package (${packageId}) wrapped for Curved VR Theater & Play Store launch.`,
      playStoreUrl: `https://play.google.com/store/apps/details?id=${packageId}`,
      playableMode: 'cinema-deck',
      vrCompatible: true,
    };

    this.catalog.unshift(customApp);
    this.searchInput.value = '';
    this.searchQuery = '';
    this.activeCategory = 'all';
    this.updateCategoryHighlights();
    this.persistState();
    this.rebuildRows();
    this.startInstall(customApp);
  }

  public installOrAddExternalApp(app: PlayStoreAppItem, autoInstall = true): void {
    const existing = this.catalog.find(
      (c) => c.packageId.toLowerCase() === app.packageId.toLowerCase() || c.id === app.id
    );
    const target = existing ?? app;

    if (!existing) {
      this.catalog.unshift(target);
      this.activeCategory = 'all';
      this.updateCategoryHighlights();
      this.persistState();
      this.rebuildRows();
    }

    const state = this.installStates.get(target.id);
    if (state?.stage === 'installed') {
      this.launchAppInVR(target);
      return;
    }

    if (autoInstall && (!state || state.stage === 'idle')) {
      this.startInstall(target);
    }
  }

  private getFilteredApps(): PlayStoreAppItem[] {
    return this.catalog.filter((app) => {
      const state = this.installStates.get(app.id);
      const isInstalled = state?.stage === 'installed';
      if (this.activeCategory === 'installed' && !isInstalled) return false;
      if (
        this.activeCategory !== 'all' &&
        this.activeCategory !== 'installed' &&
        app.category !== this.activeCategory
      ) {
        return false;
      }
      if (this.searchQuery) {
        const hay = `${app.title} ${app.developer} ${app.packageId} ${app.badge} ${app.description}`.toLowerCase();
        if (!hay.includes(this.searchQuery)) return false;
      }
      return true;
    });
  }

  private rebuildRows(): void {
    for (const child of [...this.scrollView.children]) {
      this.scrollView.remove(child);
    }
    this.rowBindings.clear();

    const apps = this.getFilteredApps();
    if (apps.length === 0) {
      this.scrollView.add(
        new xb.UIText({
          text: 'No matching Play Store apps. Tap Search Play to fetch live apps or enter a package ID!',
          style: {fontSize: 14, opacity: 0.72, textAlign: 'center', padding: 18},
        })
      );
      return;
    }

    for (const app of apps) {
      const binding = this.createAppRow(app);
      this.rowBindings.set(app.id, binding);
      this.scrollView.add(binding.row);
      this.syncRowState(app.id);
    }
  }

  private createAppRow(app: PlayStoreAppItem): AppRowBinding {
    const icon = new xb.UIImage({
      src: getAppIconTexture(app),
      ariaLabel: `${app.title} icon`,
      style: {width: 54, height: 54, borderRadius: 12, objectFit: 'cover'},
    });
    if (app.iconUrl) {
      loadAppIconTextureAsync(app, (tex) => {
        icon.src = tex;
      });
    }

    const statusText = new xb.UIText({
      text: `${app.developer} • ★ ${app.rating} • ${app.sizeMb} MB`,
      style: {fontSize: 11.5, opacity: 0.78},
    });

    const progressFill = new xb.UIPanel({
      style: {
        width: '0%',
        height: '100%',
        backgroundColor: app.accentColor,
        borderRadius: 4,
      },
    });
    const progressTrack = new xb.UIPanel({
      visible: false,
      style: {
        width: '100%',
        height: 6,
        backgroundColor: 'rgba(255,255,255,0.12)',
        borderRadius: 4,
        overflow: 'hidden',
      },
      children: [progressFill],
    });

    const infoBtn = new xb.UIButton({
      label: 'Info',
      icon: 'info',
      style: {
        height: 36,
        fontSize: 12,
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.25)'},
      },
      onClick: () => {
        this.sound.playClick();
        this.onInspectApp?.(app);
      },
    });

    const primaryBtn = new xb.UIButton({
      label: 'Install VR',
      icon: 'download',
      style: {
        height: 36,
        fontSize: 12.5,
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.35)'},
      },
      onClick: () => this.handlePrimaryAction(app),
    });

    const downloadBtn = new xb.UIButton({
      label: 'Download',
      icon: 'shop',
      style: {
        height: 36,
        fontSize: 12.5,
        ':hover': {backgroundColor: 'rgba(52, 211, 153, 0.28)'},
      },
      onClick: () => this.handleDownloadFromPlayStore(app),
    });

    const row = new xb.UIPanel({
      style: {
        width: '100%',
        flexDirection: 'column',
        gap: 7,
        padding: 11,
        backgroundColor: 'rgba(15, 23, 42, 0.72)',
        borderRadius: 14,
      },
      children: [
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 11, alignItems: 'center'},
          children: [
            icon,
            new xb.UIPanel({
              style: {
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                flexDirection: 'column',
                gap: 2,
              },
              children: [
                new xb.UIText({
                  text: `${app.title}  [${app.badge}]`,
                  style: {fontSize: 14.5, fontWeight: 'bold'},
                }),
                statusText,
                new xb.UIText({
                  text: app.description,
                  style: {fontSize: 11.5, opacity: 0.7, lineHeight: 1.25},
                }),
              ],
            }),
          ],
        }),
        progressTrack,
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 7, justifyContent: 'flex-end'},
          children: [infoBtn, downloadBtn, primaryBtn],
        }),
      ],
    });

    return {
      app,
      row,
      statusText,
      downloadBtn,
      primaryBtn,
      progressFill,
      progressTrack,
    };
  }

  private handlePrimaryAction(app: PlayStoreAppItem): void {
    this.sound.playClick();
    const state = this.installStates.get(app.id);
    if (state?.stage === 'installed') {
      this.launchAppInVR(app);
    } else if (this.installMode === 'play-market') {
      this.handleDownloadFromPlayStore(app);
    } else if (!state || state.stage === 'idle') {
      this.startInstall(app);
    }
  }

  /**
   * Opens the official Google Play Store download link AND stages the VR wrapper install.
   */
  private handleDownloadFromPlayStore(app: PlayStoreAppItem): void {
    this.sound.playClick();
    const isAndroid = /Android/i.test(navigator.userAgent);
    const targetUrl = isAndroid
      ? `market://details?id=${app.packageId}`
      : app.playStoreUrl;

    this.triggerSafeLink(targetUrl);
    const state = this.installStates.get(app.id);
    if (!state || state.stage === 'idle') {
      this.startInstall(app);
    }
    this.statusBanner.text = `Play Store Download opened for ${app.title} (${app.packageId})`;
  }

  private triggerSafeLink(url: string): void {
    const a = document.createElement('a');
    a.href = url;
    if (!url.startsWith('market://') && !url.startsWith('intent://')) {
      a.target = '_blank';
    }
    a.rel = 'noopener noreferrer';
    a.click();
  }

  private startInstall(app: PlayStoreAppItem): void {
    this.uninstalledDefaultIds.delete(app.id);
    this.installStates.set(app.id, {stage: 'downloading', progress: 2});
    this.activeInstallIds.add(app.id);
    this.statusBanner.text = `Downloading ${app.title} (${app.sizeMb} MB)...`;
    this.syncRowState(app.id);
  }

  private syncRowState(appId: string): void {
    const binding = this.rowBindings.get(appId);
    if (!binding) return;

    const {app, statusText, downloadBtn, primaryBtn, progressTrack, progressFill} = binding;
    const state = this.installStates.get(appId) ?? {stage: 'idle', progress: 0};

    if (state.stage === 'idle') {
      progressTrack.visible = false;
      downloadBtn.label = 'Download';
      primaryBtn.label = 'Add to VR';
      primaryBtn.icon = 'download';
      primaryBtn.disabled = false;
      statusText.text = `${app.developer} • ★ ${app.rating} • ${app.sizeMb} MB`;
    } else if (state.stage === 'downloading') {
      progressTrack.visible = true;
      progressFill.style.width = `${Math.round(state.progress)}%`;
      primaryBtn.label = `${Math.round(state.progress)}%`;
      primaryBtn.icon = 'downloading';
      primaryBtn.disabled = true;
      statusText.text = `Downloading APK from Play Store... ${Math.round(state.progress)}%`;
    } else if (state.stage === 'verifying') {
      progressTrack.visible = true;
      progressFill.style.width = `${Math.round(state.progress)}%`;
      primaryBtn.label = 'Verifying';
      primaryBtn.icon = 'verified_user';
      primaryBtn.disabled = true;
      statusText.text = 'Verifying APK signature & VR head-tracking profile...';
    } else if (state.stage === 'optimizing') {
      progressTrack.visible = true;
      progressFill.style.width = `${Math.round(state.progress)}%`;
      primaryBtn.label = 'VR Wrap';
      primaryBtn.icon = 'vrpano';
      primaryBtn.disabled = true;
      statusText.text = 'Binding 9-DoF Madgwick VR Wrapper...';
    } else {
      progressTrack.visible = false;
      downloadBtn.label = 'Play Store';
      primaryBtn.label = 'Launch VR';
      primaryBtn.icon = 'vrpano';
      primaryBtn.disabled = false;
      statusText.text = `Installed • ${app.packageId} • Ready in Launcher`;
    }
  }

  update(): void {
    if (this.activeInstallIds.size === 0) return;
    const dt = xb.getDeltaTime();

    for (const appId of [...this.activeInstallIds]) {
      const state = this.installStates.get(appId);
      if (!state) {
        this.activeInstallIds.delete(appId);
        continue;
      }

      state.progress = Math.min(100, state.progress + dt * 36);
      if (state.progress < 65) {
        state.stage = 'downloading';
      } else if (state.progress < 85) {
        state.stage = 'verifying';
      } else if (state.progress < 100) {
        state.stage = 'optimizing';
      } else {
        state.stage = 'installed';
        state.installedAt = Date.now();
        this.activeInstallIds.delete(appId);
        this.sound.playInstallComplete();
        const app = this.catalog.find((c) => c.id === appId);
        if (app) {
          this.statusBanner.text = `${app.title} installed! Added to VR Launcher & ready to launch.`;
        }
        this.persistState();
        this.emitStateChange();
      }
      this.syncRowState(appId);
    }
  }

  dispose(): void {
    this.stateListeners.clear();
    if (this.unsubAuth) {
      this.unsubAuth();
      this.unsubAuth = null;
    }
    super.dispose();
  }
}
