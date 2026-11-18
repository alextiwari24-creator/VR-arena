import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {
  getAppIconTexture,
  loadAppIconTextureAsync,
  PLAY_STORE_CATALOG,
} from '../store/catalog.ts';
import {VirtualPlayStore} from '../store/VirtualPlayStore.ts';
import {PlayStoreAppItem} from '../types.ts';

/**
 * Spatial App Inspector & Information Display (`xb.UICard`).
 * Uses `VisibilityTransition` to present high-legibility VR app details,
 * installation progress, VR head-control hints, and large launch/install buttons.
 */
export class AppInfoCard extends xb.UICard {
  private readonly store: VirtualPlayStore;
  private readonly sound: SoundEngine;
  private readonly onLaunchInVR: (app: PlayStoreAppItem) => void;
  private readonly transition = new xb.VisibilityTransition({duration: 0.24});

  private currentApp: PlayStoreAppItem = PLAY_STORE_CATALOG[0];
  private isOpen = false;
  private unsubStore: (() => void) | null = null;
  private pollTimer = 0;

  private iconImage: xb.UIImage;
  private titleText: xb.UIText;
  private metaText: xb.UIText;
  private packageText: xb.UIText;
  private descText: xb.UIText;
  private vrControlsText: xb.UIText;
  private statusText: xb.UIText;
  private progressTrack: xb.UIPanel;
  private progressFill: xb.UIPanel;

  private primaryBtn: xb.UIButton;
  private playStoreBtn: xb.UIButton;
  private uninstallBtn: xb.UIButton;
  private closeBtn: xb.UIButton;

  constructor(
    store: VirtualPlayStore,
    sound: SoundEngine,
    onLaunchInVR: (app: PlayStoreAppItem) => void
  ) {
    const iconImage = new xb.UIImage({
      src: getAppIconTexture(PLAY_STORE_CATALOG[0]),
      ariaLabel: 'Selected app icon',
      pointerEvents: 'none',
      style: {width: 68, height: 68, borderRadius: 16, objectFit: 'cover'},
    });

    const titleText = new xb.UIText({
      text: PLAY_STORE_CATALOG[0].title,
      style: {fontSize: 20, fontWeight: 'bold'},
    });
    const metaText = new xb.UIText({
      text: `${PLAY_STORE_CATALOG[0].developer} • ★ ${PLAY_STORE_CATALOG[0].rating} • ${PLAY_STORE_CATALOG[0].sizeMb} MB`,
      style: {fontSize: 12.5, color: '#93c5fd'},
    });
    const packageText = new xb.UIText({
      text: PLAY_STORE_CATALOG[0].packageId,
      style: {fontSize: 11, color: '#64748b'},
    });
    const descText = new xb.UIText({
      text: PLAY_STORE_CATALOG[0].description,
      style: {fontSize: 13, lineHeight: 1.35, color: '#e2e8f0'},
    });
    const vrControlsText = new xb.UIText({
      text: 'VR Controls: Head Gaze 1s / Space / Nod to interact • Shake / Esc to exit',
      style: {fontSize: 12, color: '#a78bfa', lineHeight: 1.3},
    });
    const statusText = new xb.UIText({
      text: 'Ready to launch in VR mode.',
      style: {fontSize: 12.5, fontWeight: 'bold', color: '#34d399'},
    });

    const progressFill = new xb.UIPanel({
      style: {
        width: '0%',
        height: '100%',
        backgroundColor: '#38bdf8',
        borderRadius: 4,
      },
    });
    const progressTrack = new xb.UIPanel({
      visible: false,
      style: {
        width: '100%',
        height: 8,
        backgroundColor: 'rgba(255, 255, 255, 0.14)',
        borderRadius: 4,
        overflow: 'hidden',
      },
      children: [progressFill],
    });

    const primaryBtn = new xb.UIButton({
      label: 'Launch in VR',
      icon: 'vrpano',
      style: {
        flexGrow: 2,
        height: 40,
        fontSize: 13,
        backgroundColor: 'rgba(56, 189, 248, 0.35)',
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.55)'},
      },
    });
    const playStoreBtn = new xb.UIButton({
      label: 'Play Store',
      icon: 'shop',
      style: {
        flexGrow: 1,
        height: 40,
        fontSize: 12.5,
        ':hover': {backgroundColor: 'rgba(52, 211, 153, 0.3)'},
      },
    });
    const uninstallBtn = new xb.UIButton({
      label: 'Uninstall',
      icon: 'delete_outline',
      visible: false,
      style: {
        flexGrow: 1,
        height: 40,
        fontSize: 12.5,
        backgroundColor: 'rgba(244, 63, 94, 0.25)',
        ':hover': {backgroundColor: 'rgba(244, 63, 94, 0.45)'},
      },
    });
    const closeBtn = new xb.UIButton({
      label: 'Close',
      icon: 'close',
      ariaLabel: 'Close app details',
      style: {
        height: 36,
        minWidth: 92,
        fontSize: 12,
        ':hover': {backgroundColor: 'rgba(255, 255, 255, 0.2)'},
      },
    });

    super({
      size: {width: 0.72, height: 'auto'},
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 10,
        padding: 16,
        borderRadius: 22,
      },
      children: [
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          },
          children: [
            new xb.UIPanel({
              style: {flexDirection: 'row', alignItems: 'center', gap: 8},
              children: [
                new xb.UIIcon({
                  icon: 'info',
                  style: {width: 24, height: 24, color: '#38bdf8'},
                }),
                new xb.UIText({
                  text: 'Spatial App Inspector',
                  style: {fontSize: 17, fontWeight: 'bold'},
                }),
              ],
            }),
            closeBtn,
          ],
        }),
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            gap: 12,
            alignItems: 'center',
            padding: 10,
            backgroundColor: 'rgba(15, 23, 42, 0.78)',
            borderRadius: 14,
          },
          children: [
            iconImage,
            new xb.UIPanel({
              style: {flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: 'column', gap: 3},
              children: [titleText, metaText, packageText],
            }),
          ],
        }),
        descText,
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'column',
            gap: 6,
            padding: 10,
            backgroundColor: 'rgba(15, 23, 42, 0.72)',
            borderRadius: 12,
          },
          children: [vrControlsText, statusText, progressTrack],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [primaryBtn, playStoreBtn, uninstallBtn],
        }),
      ],
    });

    this.name = 'Spatial App Inspector Card';
    this.store = store;
    this.sound = sound;
    this.onLaunchInVR = onLaunchInVR;
    this.iconImage = iconImage;
    this.titleText = titleText;
    this.metaText = metaText;
    this.packageText = packageText;
    this.descText = descText;
    this.vrControlsText = vrControlsText;
    this.statusText = statusText;
    this.progressTrack = progressTrack;
    this.progressFill = progressFill;
    this.primaryBtn = primaryBtn;
    this.playStoreBtn = playStoreBtn;
    this.uninstallBtn = uninstallBtn;
    this.closeBtn = closeBtn;

    this.add(this.transition);
    this.visible = false;

    this.wireActions();
    this.unsubStore = this.store.subscribeState(() => {
      if (this.isOpen) {
        this.syncInstallState();
      }
    });
  }

  private wireActions(): void {
    this.primaryBtn.onClick = () => {
      this.sound.playClick();
      const state = this.store.getInstallState(this.currentApp.id);
      if (state?.stage === 'installed') {
        this.onLaunchInVR(this.currentApp);
      } else if (!state || state.stage === 'idle') {
        this.store.installOrAddExternalApp(this.currentApp, true);
        this.syncInstallState();
      }
    };

    this.playStoreBtn.onClick = () => {
      this.sound.playClick();
      this.store.openPlayStoreLink(this.currentApp);
    };

    this.uninstallBtn.onClick = () => {
      this.sound.playClick();
      this.store.uninstallApp(this.currentApp.id);
      this.syncInstallState();
    };

    this.closeBtn.onClick = () => {
      this.sound.playClick();
      this.close();
    };
  }

  public showApp(app: PlayStoreAppItem): void {
    this.currentApp = app;
    this.isOpen = true;

    this.iconImage.src = getAppIconTexture(app);
    if (app.iconUrl) {
      loadAppIconTextureAsync(app, (tex) => {
        if (this.currentApp.id === app.id) {
          this.iconImage.src = tex;
        }
      });
    }

    this.titleText.text = `${app.title}  [${app.badge}]`;
    this.metaText.text = `${app.developer} • ★ ${app.rating} • ${app.sizeMb} MB • ${app.category.toUpperCase()}`;
    this.packageText.text = app.packageId;
    this.descText.text = app.description;
    this.vrControlsText.text = this.getControlHintForApp(app);

    this.syncInstallState();
    this.transition.show();
  }

  public close(): boolean {
    if (!this.isOpen && !this.visible) return false;
    this.isOpen = false;
    this.transition.hide();
    return true;
  }

  public isShowing(): boolean {
    return this.isOpen || this.visible;
  }

  private getControlHintForApp(app: PlayStoreAppItem): string {
    switch (app.playableMode) {
      case 'cosmic-blaster':
        return 'VR Controls: 360° Head-Aim Lock + Space / Nod / Gaze 0.4s to Fire Plasma';
      case 'neon-racer':
        return 'VR Controls: Tilt Head Left/Right to Steer • Walk/Run for Speed • Jump/Space = Boost';
      case 'cinema-deck':
        return 'VR Controls: Gaze Curved Screen or Space/Tap for Play/Pause • Walk/Run Ambient Deck';
      case 'google-workspace':
        return 'VR Controls: Live Google OAuth Sync • Gaze Screen or Space to Refresh Workspace';
      case 'google-suite-launch':
        return 'VR Controls: Instant Web App Bridge + Curved VR Theater Launch';
      case 'play-browser':
        return 'VR Controls: Full Play Store Search, Detail Pages & Gaze Keyboard';
      default:
        return 'VR Controls: Head Gaze 1s / Space / Tap to Select • Shake / Esc to Exit';
    }
  }

  private syncInstallState(): void {
    const app = this.currentApp;
    const state = this.store.getInstallState(app.id);

    if (!state || state.stage === 'idle') {
      this.progressTrack.visible = false;
      this.primaryBtn.label = 'Install in VR';
      this.primaryBtn.icon = 'download';
      this.primaryBtn.disabled = false;
      this.uninstallBtn.visible = false;
      this.statusText.text = `Not installed (${app.sizeMb} MB) • Ready to download & wrap for VR.`;
      this.statusText.style.color = '#93c5fd';
    } else if (state.stage !== 'installed') {
      this.progressTrack.visible = true;
      this.progressFill.style.width = `${Math.round(state.progress)}%`;
      this.primaryBtn.label = `Installing ${Math.round(state.progress)}%`;
      this.primaryBtn.icon = 'downloading';
      this.primaryBtn.disabled = true;
      this.uninstallBtn.visible = false;
      this.statusText.text =
        state.stage === 'downloading'
          ? `Downloading APK from Play Store... ${Math.round(state.progress)}%`
          : state.stage === 'verifying'
            ? 'Verifying APK signature & 9-DoF VR profile...'
            : 'Binding Cardboard/WebXR VR Wrapper...';
      this.statusText.style.color = '#fbbf24';
    } else {
      this.progressTrack.visible = false;
      this.primaryBtn.label = 'Launch in VR';
      this.primaryBtn.icon = 'vrpano';
      this.primaryBtn.disabled = false;
      this.uninstallBtn.visible = true;
      this.statusText.text = 'Installed in VR Launcher • Ready for Stereoscopic Launch!';
      this.statusText.style.color = '#34d399';
    }
  }

  update(): void {
    super.update();
    if (!this.isOpen) return;
    const state = this.store.getInstallState(this.currentApp.id);
    if (state && state.stage !== 'idle' && state.stage !== 'installed') {
      this.pollTimer += xb.getDeltaTime();
      if (this.pollTimer >= 0.08) {
        this.pollTimer = 0;
        this.syncInstallState();
      }
    }
  }

  dispose(): void {
    if (this.unsubStore) {
      this.unsubStore();
      this.unsubStore = null;
    }
    super.dispose();
  }
}
