import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {getAppIconTexture, loadAppIconTextureAsync} from '../store/catalog.ts';
import {VirtualPlayStore} from '../store/VirtualPlayStore.ts';
import {PlayStoreAppItem} from '../types.ts';

type LauncherFilter = 'all' | 'games' | 'google' | 'apps';

export class VRLauncherCard extends xb.UICard {
  private readonly store: VirtualPlayStore;
  private readonly sound: SoundEngine;
  private readonly onLaunchInVR: (app: PlayStoreAppItem) => void;

  private manageMode = false;
  private filter: LauncherFilter = 'all';
  private selectedApp: PlayStoreAppItem | null = null;
  private unsubStore: (() => void) | null = null;

  private summaryText: xb.UIText;
  private statusText: xb.UIText;
  private manageBtn: xb.UIButton;
  private restoreBtn: xb.UIButton;
  private launchSelectedBtn: xb.UIButton;
  private uninstallSelectedBtn: xb.UIButton;
  private pageUpBtn: xb.UIButton;
  private pageDownBtn: xb.UIButton;
  private filterBtns = new Map<LauncherFilter, xb.UIButton>();
  private gridScroll: xb.UIScrollView;

  constructor(
    store: VirtualPlayStore,
    sound: SoundEngine,
    onLaunchInVR: (app: PlayStoreAppItem) => void
  ) {
    const summaryText = new xb.UIText({
      text: '0 VR Apps Installed',
      style: {fontSize: 12, color: '#93c5fd'},
    });

    const manageBtn = new xb.UIButton({
      label: 'Manage Apps',
      icon: 'tune',
      style: {height: 32, fontSize: 12},
    });

    const restoreBtn = new xb.UIButton({
      label: 'Restore',
      icon: 'restore',
      visible: false,
      style: {height: 32, fontSize: 12},
    });

    const filters: Array<{id: LauncherFilter; label: string}> = [
      {id: 'all', label: 'All Installed'},
      {id: 'games', label: 'VR Games'},
      {id: 'google', label: 'Google'},
      {id: 'apps', label: 'Tools & Media'},
    ];
    const filterBtns = new Map<LauncherFilter, xb.UIButton>();
    const filterChildren: xb.UIButton[] = [];
    for (const f of filters) {
      const btn = new xb.UIButton({
        label: f.label,
        style: {flexGrow: 1, height: 30, fontSize: 11.5},
      });
      filterBtns.set(f.id, btn);
      filterChildren.push(btn);
    }

    const gridScroll = new xb.UIScrollView({
      ariaLabel: 'Installed VR applications grid',
      style: {
        width: '100%',
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 240,
        gap: 10,
      },
    });

    const statusText = new xb.UIText({
      text: 'Select any app icon with Gaze or Controller to launch directly in VR.',
      style: {fontSize: 11.5, color: '#34d399', flexGrow: 1, flexShrink: 1},
    });

    const launchSelectedBtn = new xb.UIButton({
      label: 'Launch VR',
      icon: 'vrpano',
      disabled: true,
      style: {height: 32, fontSize: 12},
    });

    const uninstallSelectedBtn = new xb.UIButton({
      label: 'Uninstall',
      icon: 'delete',
      disabled: true,
      style: {height: 32, fontSize: 12},
    });

    const pageUpBtn = new xb.UIButton({
      icon: 'keyboard_arrow_up',
      ariaLabel: 'Scroll launcher up',
      style: {width: 38, height: 32},
    });
    const pageDownBtn = new xb.UIButton({
      icon: 'keyboard_arrow_down',
      ariaLabel: 'Scroll launcher down',
      style: {width: 38, height: 32},
    });

    super({
      size: {width: 0.84, height: 0.74},
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
            gap: 8,
          },
          children: [
            new xb.UIPanel({
              style: {flexDirection: 'row', alignItems: 'center', gap: 8},
              children: [
                new xb.UIIcon({
                  icon: 'apps',
                  style: {width: 26, height: 26, color: '#38bdf8'},
                }),
                new xb.UIPanel({
                  style: {flexDirection: 'column', gap: 1},
                  children: [
                    new xb.UIText({
                      text: 'VR App Launcher',
                      style: {fontSize: 19, fontWeight: 'bold'},
                    }),
                    summaryText,
                  ],
                }),
              ],
            }),
            new xb.UIPanel({
              style: {flexDirection: 'row', gap: 6},
              children: [restoreBtn, manageBtn],
            }),
          ],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 6},
          children: filterChildren,
        }),
        gridScroll,
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            padding: 8,
            backgroundColor: 'rgba(15, 23, 42, 0.78)',
            borderRadius: 12,
          },
          children: [statusText, launchSelectedBtn, uninstallSelectedBtn, pageUpBtn, pageDownBtn],
        }),
      ],
    });

    this.name = 'VR App Launcher card';
    this.store = store;
    this.sound = sound;
    this.onLaunchInVR = onLaunchInVR;
    this.summaryText = summaryText;
    this.statusText = statusText;
    this.manageBtn = manageBtn;
    this.restoreBtn = restoreBtn;
    this.launchSelectedBtn = launchSelectedBtn;
    this.uninstallSelectedBtn = uninstallSelectedBtn;
    this.pageUpBtn = pageUpBtn;
    this.pageDownBtn = pageDownBtn;
    this.filterBtns = filterBtns;
    this.gridScroll = gridScroll;

    this.wireControls();
    this.unsubStore = this.store.subscribeState(() => {
      this.rebuildGrid();
    });
    this.updateFilterStyles();
    this.rebuildGrid();
  }

  private wireControls(): void {
    this.manageBtn.onClick = () => {
      this.sound.playClick();
      this.manageMode = !this.manageMode;
      this.manageBtn.label = this.manageMode ? 'Done' : 'Manage Apps';
      this.manageBtn.icon = this.manageMode ? 'check' : 'tune';
      this.manageBtn.style.backgroundColor = this.manageMode
        ? 'rgba(244, 63, 94, 0.35)'
        : 'rgba(255, 255, 255, 0.08)';
      this.restoreBtn.visible = this.manageMode;
      this.statusText.text = this.manageMode
        ? 'Manage Mode: Gaze/click an app icon to Uninstall or Launch in VR.'
        : 'Launch Mode: Gaze/click any icon to launch directly into VR mode.';
      this.rebuildGrid();
    };

    this.restoreBtn.onClick = () => {
      this.sound.playInstallComplete();
      this.store.restoreDefaultApps();
      this.statusText.text = 'Restored default Google & VR apps.';
    };

    this.launchSelectedBtn.onClick = () => {
      if (!this.selectedApp) return;
      this.sound.playClick();
      this.onLaunchInVR(this.selectedApp);
    };

    this.uninstallSelectedBtn.onClick = () => {
      if (!this.selectedApp) return;
      const app = this.selectedApp;
      this.sound.playClick();
      this.store.uninstallApp(app.id);
      this.selectedApp = null;
      this.syncSelectionBar();
      this.statusText.text = `Uninstalled ${app.title} (${app.sizeMb} MB freed).`;
    };

    this.pageUpBtn.onClick = () => {
      this.sound.playClick();
      this.gridScroll.scrollTop = Math.max(0, this.gridScroll.scrollTop - 210);
    };

    this.pageDownBtn.onClick = () => {
      this.sound.playClick();
      this.gridScroll.scrollTop = this.gridScroll.scrollTop + 210;
    };

    for (const [id, btn] of this.filterBtns.entries()) {
      btn.onClick = () => {
        this.sound.playClick();
        this.filter = id;
        this.gridScroll.scrollTop = 0;
        this.updateFilterStyles();
        this.rebuildGrid();
      };
    }
  }

  private updateFilterStyles(): void {
    for (const [id, btn] of this.filterBtns.entries()) {
      btn.style.backgroundColor =
        id === this.filter ? 'rgba(56, 189, 248, 0.38)' : 'rgba(255, 255, 255, 0.08)';
    }
  }

  private getFilteredInstalledApps(): PlayStoreAppItem[] {
    const allInstalled = this.store.getInstalledApps();
    return allInstalled.filter((app) => {
      if (this.filter === 'all') return true;
      if (this.filter === 'games') {
        return app.category === 'vr-games' || app.category === 'arcade';
      }
      if (this.filter === 'google') {
        return app.category === 'google';
      }
      return app.category === 'apps';
    });
  }

  private syncSelectionBar(): void {
    const app = this.selectedApp;
    this.launchSelectedBtn.disabled = !app;
    this.uninstallSelectedBtn.disabled = !app;
    if (app) {
      this.statusText.text = `${app.title} (${app.sizeMb} MB) • ${app.packageId}`;
    }
  }

  private rebuildGrid(): void {
    for (const child of [...this.gridScroll.children]) {
      this.gridScroll.remove(child);
    }

    const allInstalled = this.store.getInstalledApps();
    const totalMb = allInstalled.reduce((sum, a) => sum + a.sizeMb, 0);
    this.summaryText.text = `${allInstalled.length} VR Apps Installed • ${(totalMb / 1024).toFixed(2)} GB`;

    const apps = this.getFilteredInstalledApps();
    if (this.selectedApp && !allInstalled.some((a) => a.id === this.selectedApp!.id)) {
      this.selectedApp = null;
      this.syncSelectionBar();
    }

    if (apps.length === 0) {
      this.gridScroll.add(
        new xb.UIText({
          text: 'No installed VR apps in this filter. Download from Play Store VR or tap Restore.',
          style: {fontSize: 13.5, opacity: 0.72, textAlign: 'center', padding: 24},
        })
      );
      return;
    }

    const columns = 3;
    for (let i = 0; i < apps.length; i += columns) {
      const slice = apps.slice(i, i + columns);
      const rowChildren: xb.UIElement[] = slice.map((app) => this.createAppTile(app));
      while (rowChildren.length < columns) {
        rowChildren.push(
          new xb.UIPanel({
            style: {flexGrow: 1, flexBasis: 0, height: 10},
          })
        );
      }

      this.gridScroll.add(
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            gap: 10,
            alignItems: 'stretch',
          },
          children: rowChildren,
        })
      );
    }
  }

  private createAppTile(app: PlayStoreAppItem): xb.UIPanel {
    const icon = new xb.UIImage({
      src: getAppIconTexture(app),
      ariaLabel: `${app.title} icon`,
      pointerEvents: 'none',
      style: {width: 58, height: 58, borderRadius: 14, objectFit: 'cover'},
    });
    if (app.iconUrl) {
      loadAppIconTextureAsync(app, (tex) => {
        icon.src = tex;
      });
    }

    const isSelected = this.selectedApp?.id === app.id;
    const shortTitle =
      app.title.length > 15 ? `${app.title.slice(0, 14).trim()}…` : app.title;

    const tileBtn = new xb.UIButton({
      ariaLabel: this.manageMode
        ? `Select ${app.title} to manage or uninstall`
        : `Launch ${app.title} in VR Mode`,
      style: {
        width: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 10,
        borderRadius: 14,
        backgroundColor: isSelected
          ? 'rgba(56, 189, 248, 0.32)'
          : 'rgba(15, 23, 42, 0.76)',
        borderColor: isSelected ? '#38bdf8' : 'rgba(255, 255, 255, 0.08)',
        borderWidth: isSelected ? 2 : 1,
      },
      children: [
        icon,
        new xb.UIText({
          text: shortTitle,
          pointerEvents: 'none',
          style: {fontSize: 12.5, fontWeight: 'bold', textAlign: 'center'},
        }),
        new xb.UIText({
          text: `${app.badge} • ${app.sizeMb}MB`,
          pointerEvents: 'none',
          style: {fontSize: 10, color: '#94a3b8', textAlign: 'center'},
        }),
      ],
      onClick: () => {
        this.sound.playClick();
        this.selectedApp = app;
        this.syncSelectionBar();
        if (this.manageMode) {
          this.rebuildGrid();
        } else {
          this.statusText.text = `Launching ${app.title} directly in VR Mode...`;
          this.onLaunchInVR(app);
        }
      },
    });

    if (!this.manageMode) {
      return new xb.UIPanel({
        style: {flexGrow: 1, flexBasis: 0, flexDirection: 'column'},
        children: [tileBtn],
      });
    }

    const uninstallTileBtn = new xb.UIButton({
      label: 'Uninstall',
      icon: 'delete_outline',
      style: {width: '100%', height: 28, fontSize: 11},
      onClick: () => {
        this.sound.playClick();
        this.store.uninstallApp(app.id);
        this.statusText.text = `Uninstalled ${app.title} (${app.sizeMb} MB freed).`;
      },
    });

    return new xb.UIPanel({
      style: {flexGrow: 1, flexBasis: 0, flexDirection: 'column', gap: 5},
      children: [tileBtn, uninstallTileBtn],
    });
  }

  dispose(): void {
    if (this.unsubStore) {
      this.unsubStore();
      this.unsubStore = null;
    }
    super.dispose();
  }
}
