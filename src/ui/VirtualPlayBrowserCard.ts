import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {VRGameTheater} from '../games/VRGameTheater.ts';
import {
  BrowserBrowseCategory,
  browserItemToStoreApp,
  fetchGooglePlayDetails,
  searchGooglePlayStore,
} from '../services/playStoreBrowserService.ts';
import {getAppIconTexture} from '../store/catalog.ts';
import {VirtualPlayStore} from '../store/VirtualPlayStore.ts';
import {PlayBrowserDetail, PlayBrowserItem} from '../types.ts';

interface BrowserHistoryEntry {
  kind: 'list' | 'detail';
  query: string;
  category: BrowserBrowseCategory;
  item?: PlayBrowserItem;
}

export class VirtualPlayBrowserCard extends xb.UICard {
  private readonly store: VirtualPlayStore;
  private readonly theater: VRGameTheater;
  private readonly sound: SoundEngine;

  private backBtn: xb.UIButton;
  private forwardBtn: xb.UIButton;
  private reloadBtn: xb.UIButton;
  private homeBtn: xb.UIButton;
  private keyboardToggleBtn: xb.UIButton;
  private mirrorScreenBtn: xb.UIButton;

  private urlText: xb.UIText;
  private statusText: xb.UIText;
  private searchInput: xb.UITextInput;
  private searchBtn: xb.UIButton;

  private tabHomeBtn: xb.UIButton;
  private tabGamesBtn: xb.UIButton;
  private tabVrBtn: xb.UIButton;
  private keyboardPanel: xb.UIPanel;
  private viewport: xb.UIScrollView;

  private history: BrowserHistoryEntry[] = [];
  private historyIdx = -1;
  private keyboardVisible = false;
  private mirrorToScreen = false;
  private navSeq = 0;

  private currentResults: PlayBrowserItem[] = [];
  private currentDetail: PlayBrowserDetail | null = null;
  private currentUrl = 'https://play.google.com/store/apps';

  constructor(store: VirtualPlayStore, theater: VRGameTheater, sound: SoundEngine) {
    const backBtn = new xb.UIButton({
      icon: 'arrow_back',
      ariaLabel: 'Browser back',
      disabled: true,
      style: {height: 30, minWidth: 34},
    });
    const forwardBtn = new xb.UIButton({
      icon: 'arrow_forward',
      ariaLabel: 'Browser forward',
      disabled: true,
      style: {height: 30, minWidth: 34},
    });
    const reloadBtn = new xb.UIButton({
      icon: 'refresh',
      ariaLabel: 'Reload Play Store page',
      style: {height: 30, minWidth: 34},
    });
    const homeBtn = new xb.UIButton({
      icon: 'home',
      ariaLabel: 'Play Store Home',
      style: {height: 30, minWidth: 34},
    });
    const urlText = new xb.UIText({
      text: 'https://play.google.com/store/apps',
      style: {
        flexGrow: 1,
        flexShrink: 1,
        fontSize: 11.5,
        color: '#93c5fd',
        overflow: 'hidden',
      },
    });
    const keyboardToggleBtn = new xb.UIButton({
      label: 'Keys',
      icon: 'keyboard',
      style: {height: 30, fontSize: 11},
    });
    const mirrorScreenBtn = new xb.UIButton({
      label: 'IMAX',
      icon: 'tv',
      style: {height: 30, fontSize: 11},
    });

    const searchInput = new xb.UITextInput({
      ariaLabel: 'Search Google Play Store apps and games',
      placeholder: 'Search Google Play apps & games (e.g. Minecraft, Roblox)...',
      style: {flexGrow: 1, height: 34, fontSize: 13},
    });
    const searchBtn = new xb.UIButton({
      label: 'Search',
      icon: 'search',
      style: {height: 34, fontSize: 12.5},
    });

    const tabHomeBtn = new xb.UIButton({
      label: 'For You',
      style: {flexGrow: 1, height: 28, fontSize: 11.5},
    });
    const tabGamesBtn = new xb.UIButton({
      label: 'Top Games',
      style: {flexGrow: 1, height: 28, fontSize: 11.5},
    });
    const tabVrBtn = new xb.UIButton({
      label: 'VR Picks',
      style: {flexGrow: 1, height: 28, fontSize: 11.5},
    });

    const quickTerms = ['Minecraft', 'Roblox', 'Spotify', 'YouTube', 'Chess'];
    const quickButtons = quickTerms.map(
      (term) =>
        new xb.UIButton({
          label: term,
          style: {flexGrow: 1, height: 26, fontSize: 11},
          onClick: () => {
            this.sound.playClick();
            this.searchInput.value = term;
            void this.navigateToSearch(term, 'all');
          },
        })
    );

    const statusText = new xb.UIText({
      text: 'VR Play Store Browser ready — Search or gaze any app to inspect & install.',
      style: {fontSize: 11.5, color: '#34d399'},
    });

    const keyRows: string[][] = [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
      ['z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
    ];

    const keyRowPanels = keyRows.map(
      (chars) =>
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 3},
          children: chars.map(
            (ch) =>
              new xb.UIButton({
                label: ch === '⌫' ? 'DEL' : ch.toUpperCase(),
                style: {flexGrow: 1, height: 26, fontSize: 11},
                onClick: () => {
                  this.sound.playClick();
                  const cur = this.searchInput.value || '';
                  if (ch === '⌫') {
                    this.searchInput.value = cur.slice(0, -1);
                  } else {
                    this.searchInput.value = cur + ch;
                  }
                },
              })
          ),
        })
    );

    const keyboardActionRow = new xb.UIPanel({
      style: {width: '100%', flexDirection: 'row', gap: 4},
      children: [
        new xb.UIButton({
          label: 'Space',
          style: {flexGrow: 2, height: 26, fontSize: 11},
          onClick: () => {
            this.sound.playClick();
            this.searchInput.value = (this.searchInput.value || '') + ' ';
          },
        }),
        new xb.UIButton({
          label: 'Clear',
          style: {flexGrow: 1, height: 26, fontSize: 11},
          onClick: () => {
            this.sound.playClick();
            this.searchInput.value = '';
          },
        }),
        new xb.UIButton({
          label: 'Go Search',
          icon: 'search',
          style: {flexGrow: 2, height: 26, fontSize: 11},
          onClick: () => {
            this.sound.playClick();
            void this.navigateToSearch(this.searchInput.value.trim(), 'all');
          },
        }),
      ],
    });

    const keyboardPanel = new xb.UIPanel({
      visible: false,
      style: {
        width: '100%',
        flexDirection: 'column',
        gap: 3,
        padding: 6,
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        borderRadius: 10,
      },
      children: [...keyRowPanels, keyboardActionRow],
    });

    const viewport = new xb.UIScrollView({
      ariaLabel: 'Virtual Play Store Browser Viewport',
      style: {
        width: '100%',
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 220,
        gap: 8,
      },
    });

    super({
      size: {width: 0.9, height: 0.74},
      manipulation: true,
      edge: true,
      style: {flexDirection: 'column', gap: 7, padding: 14},
      children: [
        // 1. Browser Title + Navigation Bar
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            padding: 5,
            backgroundColor: 'rgba(15, 23, 42, 0.85)',
            borderRadius: 10,
          },
          children: [
            backBtn,
            forwardBtn,
            reloadBtn,
            homeBtn,
            new xb.UIIcon({
              icon: 'lock',
              style: {width: 15, height: 15, color: '#34d399'},
            }),
            urlText,
            keyboardToggleBtn,
            mirrorScreenBtn,
          ],
        }),
        // 2. Search Omnibox
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 6, alignItems: 'center'},
          children: [searchInput, searchBtn],
        }),
        // 3. Play Store Tabs
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 5},
          children: [tabHomeBtn, tabGamesBtn, tabVrBtn],
        }),
        // 4. Quick Search Chips
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 4},
          children: quickButtons,
        }),
        keyboardPanel,
        statusText,
        viewport,
      ],
    });

    this.name = 'Virtual Play Store Browser';
    this.store = store;
    this.theater = theater;
    this.sound = sound;
    this.backBtn = backBtn;
    this.forwardBtn = forwardBtn;
    this.reloadBtn = reloadBtn;
    this.homeBtn = homeBtn;
    this.keyboardToggleBtn = keyboardToggleBtn;
    this.mirrorScreenBtn = mirrorScreenBtn;
    this.urlText = urlText;
    this.statusText = statusText;
    this.searchInput = searchInput;
    this.searchBtn = searchBtn;
    this.tabHomeBtn = tabHomeBtn;
    this.tabGamesBtn = tabGamesBtn;
    this.tabVrBtn = tabVrBtn;
    this.keyboardPanel = keyboardPanel;
    this.viewport = viewport;

    this.wireControls();
    void this.navigateHome();
  }

  public getScrollView(): xb.UIScrollView {
    return this.viewport;
  }

  private wireControls(): void {
    this.backBtn.onClick = () => {
      this.sound.playClick();
      if (this.historyIdx > 0) {
        this.historyIdx -= 1;
        void this.loadHistoryEntry(this.history[this.historyIdx]);
      }
    };

    this.forwardBtn.onClick = () => {
      this.sound.playClick();
      if (this.historyIdx < this.history.length - 1) {
        this.historyIdx += 1;
        void this.loadHistoryEntry(this.history[this.historyIdx]);
      }
    };

    this.reloadBtn.onClick = () => {
      this.sound.playClick();
      const entry = this.history[this.historyIdx];
      if (entry) {
        void this.loadHistoryEntry(entry);
      } else {
        void this.navigateHome();
      }
    };

    this.homeBtn.onClick = () => {
      this.sound.playClick();
      void this.navigateHome();
    };

    this.keyboardToggleBtn.onClick = () => {
      this.sound.playClick();
      this.keyboardVisible = !this.keyboardVisible;
      this.keyboardPanel.visible = this.keyboardVisible;
      this.keyboardToggleBtn.label = this.keyboardVisible ? 'Hide Keys' : 'Keys';
    };

    this.mirrorScreenBtn.onClick = () => {
      this.sound.playClick();
      this.mirrorToScreen = !this.mirrorToScreen;
      this.mirrorScreenBtn.label = this.mirrorToScreen ? 'IMAX: ON' : 'IMAX';
      if (this.mirrorToScreen) {
        this.syncTheaterMirror();
      } else if (this.theater.getMode() === 'play-browser') {
        this.theater.exitToHub();
      }
    };

    this.searchInput.onSubmit = (val) => {
      void this.navigateToSearch(val.trim(), 'all');
    };

    this.searchBtn.onClick = () => {
      this.sound.playClick();
      void this.navigateToSearch(this.searchInput.value.trim(), 'all');
    };

    this.tabHomeBtn.onClick = () => {
      this.sound.playClick();
      void this.navigateToSearch('', 'all');
    };

    this.tabGamesBtn.onClick = () => {
      this.sound.playClick();
      void this.navigateToSearch('', 'games');
    };

    this.tabVrBtn.onClick = () => {
      this.sound.playClick();
      void this.navigateToSearch('VR', 'vr');
    };
  }

  public async navigateHome(): Promise<void> {
    this.searchInput.value = '';
    await this.navigateToSearch('', 'all');
  }

  public async navigateToSearch(
    query: string,
    category: BrowserBrowseCategory
  ): Promise<void> {
    const entry: BrowserHistoryEntry = {kind: 'list', query, category};
    this.pushHistory(entry);
    await this.loadHistoryEntry(entry);
  }

  public async openAppPage(item: PlayBrowserItem): Promise<void> {
    const entry: BrowserHistoryEntry = {
      kind: 'detail',
      query: item.title,
      category: 'all',
      item,
    };
    this.pushHistory(entry);
    await this.loadHistoryEntry(entry);
  }

  private pushHistory(entry: BrowserHistoryEntry): void {
    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(entry);
    this.historyIdx = this.history.length - 1;
    this.updateNavButtons();
  }

  private updateNavButtons(): void {
    this.backBtn.disabled = this.historyIdx <= 0;
    this.forwardBtn.disabled = this.historyIdx >= this.history.length - 1;
  }

  private async loadHistoryEntry(entry: BrowserHistoryEntry): Promise<void> {
    const seq = ++this.navSeq;
    this.updateNavButtons();
    this.clearViewport();
    this.viewport.add(
      new xb.UIText({
        text:
          entry.kind === 'detail'
            ? `Loading Google Play Store page for ${entry.item?.title ?? entry.query}...`
            : `Searching Google Play Store${entry.query ? ` for "${entry.query}"` : ''}...`,
        style: {fontSize: 14, color: '#38bdf8', textAlign: 'center', padding: 20},
      })
    );

    if (entry.kind === 'detail' && entry.item) {
      this.currentUrl = entry.item.playStoreUrl;
      this.urlText.text = this.currentUrl;
      this.statusText.text = `Fetching live Play Store details for ${entry.item.packageId}...`;

      const detail = await fetchGooglePlayDetails(entry.item);
      if (seq !== this.navSeq) return;

      this.currentDetail = detail;
      this.statusText.text = `Play Store App Page • ${detail.packageId}`;
      this.renderDetailView(detail);
      if (this.mirrorToScreen) this.syncTheaterMirror();
      return;
    }

    this.currentDetail = null;
    const response = await searchGooglePlayStore(entry.query, entry.category);
    if (seq !== this.navSeq) return;

    this.currentUrl = response.url;
    this.urlText.text = response.url;
    this.currentResults = response.results;
    this.statusText.text =
      response.source === 'live-play-store'
        ? `Live Google Play Store • ${response.results.length} results found`
        : `Offline Catalog Mode • ${response.results.length} apps matching`;

    this.renderResultsList(response.results);
    if (this.mirrorToScreen) this.syncTheaterMirror();
  }

  private syncTheaterMirror(): void {
    if (this.currentDetail) {
      this.theater.showBrowserState({
        url: this.currentDetail.playStoreUrl,
        heading: `${this.currentDetail.title} — ${this.currentDetail.developer}`,
        summary: `★ ${this.currentDetail.rating} • ${this.currentDetail.downloads} • ${this.currentDetail.description.slice(0, 140)}`,
        items: [
          {title: 'Package ID', meta: this.currentDetail.packageId},
          {title: 'Price', meta: this.currentDetail.price || 'Free'},
        ],
      });
      return;
    }

    this.theater.showBrowserState({
      url: this.currentUrl,
      heading: 'Google Play Store VR Browser',
      summary: this.statusText.text,
      items: this.currentResults.slice(0, 5).map((r) => ({
        title: r.title,
        meta: `${r.developer} • ★ ${r.rating}`,
      })),
    });
  }

  private clearViewport(): void {
    for (const child of [...this.viewport.children]) {
      this.viewport.remove(child);
    }
  }

  private renderResultsList(items: PlayBrowserItem[]): void {
    this.clearViewport();
    if (items.length === 0) {
      this.viewport.add(
        new xb.UIText({
          text: 'No matching Play Store apps or games found. Try another keyword or tap Keys.',
          style: {fontSize: 13.5, opacity: 0.78, textAlign: 'center', padding: 20},
        })
      );
      return;
    }

    for (const item of items) {
      const storeApp = browserItemToStoreApp(item);
      const icon = new xb.UIImage({
        src: item.iconUrl || getAppIconTexture(storeApp),
        ariaLabel: `${item.title} icon`,
        style: {width: 50, height: 50, borderRadius: 11, objectFit: 'cover'},
      });

      const openBtn = new xb.UIButton({
        label: 'Open Page',
        icon: 'open_in_browser',
        style: {height: 30, fontSize: 11.5},
        onClick: () => {
          this.sound.playClick();
          void this.openAppPage(item);
        },
      });

      const installBtn = new xb.UIButton({
        label: 'Install VR',
        icon: 'download',
        style: {height: 30, fontSize: 11.5},
        onClick: () => {
          this.sound.playClick();
          this.store.installOrAddExternalApp(storeApp, true);
          this.statusText.text = `Added & installing ${item.title} in Play Store VR!`;
        },
      });

      const row = new xb.UIPanel({
        style: {
          width: '100%',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          padding: 9,
          backgroundColor: 'rgba(15, 23, 42, 0.72)',
          borderRadius: 12,
        },
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
                text: item.title,
                style: {fontSize: 14, fontWeight: 'bold'},
              }),
              new xb.UIText({
                text: `${item.developer} • ★ ${item.rating || '4.5'} • ${item.price || 'Free'}`,
                style: {fontSize: 11.5, color: '#94a3b8'},
              }),
              new xb.UIText({
                text: item.packageId,
                style: {fontSize: 10.5, color: '#64748b'},
              }),
            ],
          }),
          new xb.UIPanel({
            style: {flexDirection: 'row', gap: 5},
            children: [openBtn, installBtn],
          }),
        ],
      });
      this.viewport.add(row);
    }
  }

  private renderDetailView(detail: PlayBrowserDetail): void {
    this.clearViewport();
    const storeApp = browserItemToStoreApp(detail);

    const heroIcon = new xb.UIImage({
      src: detail.iconUrl || getAppIconTexture(storeApp),
      ariaLabel: `${detail.title} icon`,
      style: {width: 72, height: 72, borderRadius: 16, objectFit: 'cover'},
    });

    const installBtn = new xb.UIButton({
      label: 'Install in PocketVR',
      icon: 'download',
      style: {flexGrow: 1, height: 36, fontSize: 12.5},
      onClick: () => {
        this.sound.playClick();
        this.store.installOrAddExternalApp(storeApp, true);
        this.statusText.text = `Installing ${detail.title} (${detail.packageId}) into VR Hub!`;
      },
    });

    const playWebBtn = new xb.UIButton({
      label: 'Open on Play Store',
      icon: 'open_in_new',
      style: {flexGrow: 1, height: 36, fontSize: 12.5},
      onClick: () => {
        this.sound.playClick();
        const isAndroid = /Android/i.test(navigator.userAgent);
        const target = isAndroid
          ? `market://details?id=${detail.packageId}`
          : detail.playStoreUrl;
        const a = document.createElement('a');
        a.href = target;
        if (!target.startsWith('market://')) {
          a.target = '_blank';
        }
        a.rel = 'noopener noreferrer';
        a.click();
      },
    });

    const backResultsBtn = new xb.UIButton({
      label: 'Back to Results',
      icon: 'arrow_back',
      style: {height: 32, fontSize: 12},
      onClick: () => {
        this.sound.playClick();
        if (this.historyIdx > 0) {
          this.historyIdx -= 1;
          void this.loadHistoryEntry(this.history[this.historyIdx]);
        } else {
          void this.navigateHome();
        }
      },
    });

    const card = new xb.UIPanel({
      style: {
        width: '100%',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        backgroundColor: 'rgba(15, 23, 42, 0.8)',
        borderRadius: 14,
      },
      children: [
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 12, alignItems: 'center'},
          children: [
            heroIcon,
            new xb.UIPanel({
              style: {
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                flexDirection: 'column',
                gap: 4,
              },
              children: [
                new xb.UIText({
                  text: detail.title,
                  style: {fontSize: 18, fontWeight: 'bold'},
                }),
                new xb.UIText({
                  text: `${detail.developer} • ${detail.packageId}`,
                  style: {fontSize: 12, color: '#38bdf8'},
                }),
                new xb.UIText({
                  text: `★ ${detail.rating} • ${detail.downloads} downloads • ${detail.price || 'Free'}`,
                  style: {fontSize: 12, color: '#cbd5e1'},
                }),
              ],
            }),
          ],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [installBtn, playWebBtn],
        }),
        new xb.UIText({
          text: detail.description || 'No additional description available.',
          style: {fontSize: 12.5, lineHeight: 1.35, color: '#e2e8f0'},
        }),
        backResultsBtn,
      ],
    });

    this.viewport.add(card);
  }
}
