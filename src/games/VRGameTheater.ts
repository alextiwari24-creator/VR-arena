import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {VRLoungeEnvironment} from '../environment/VRLoungeEnvironment.ts';
import {SensorFusionTracker} from '../sensors/SensorFusionTracker.ts';
import {
  deviceHomeService,
  DeviceStatusSnapshot,
} from '../services/deviceHomeService.ts';
import {
  fetchLiveGoogleSuiteFeed,
  getChromeInput,
  getYouTubeSearchQuery,
  pickRealDevicePhotos,
  setChromeInput,
  setYouTubeSearchQuery,
} from '../services/googleAppsLiveService.ts';
import {
  fetchGoogleWorkspaceFeed,
  getGoogleAuthSnapshot,
  signInWithGoogle,
  subscribeGoogleAuth,
  WorkspaceFeedItem,
  WorkspaceFeedResult,
} from '../services/googleWorkspaceService.ts';
import {PLAY_STORE_CATALOG} from '../store/catalog.ts';
import {PlayableModeId, PlayStoreAppItem} from '../types.ts';
import {
  closeYouTubePlayerOverlay,
  openExternalUrlSafely,
  openLiveSearchPromptModal,
  openYouTubePlayerOverlay,
} from '../ui/youtubePlayerOverlay.ts';

interface SpaceTarget {
  lod: THREE.LOD;
  angle: number;
  elevation: number;
  distance: number;
  speed: number;
  hp: number;
  active: boolean;
}

interface LaserBolt {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  active: boolean;
}

interface RacerObstacle {
  lane: number; // -1..1
  z: number; // 0 (horizon) .. 1 (player)
  isOrb: boolean;
  isHighGate: boolean; // Overhead laser beam cleared by crouching/ducking
  active: boolean;
}

interface DroneHazard {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  active: boolean;
}

const LOGICAL_W = 1024;
const LOGICAL_H = 512;
const TARGET_POOL_SIZE = 14;
const BOLT_POOL_SIZE = 24;
const HAZARD_POOL_SIZE = 6;
const OBSTACLE_POOL_SIZE = 32;
const BOLT_Z_AXIS = new THREE.Vector3(0, 0, 1);

export class VRGameTheater extends xb.Script {
  private readonly env: VRLoungeEnvironment;
  private readonly sensors: SensorFusionTracker;
  private readonly sound: SoundEngine;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private screenTexture: THREE.CanvasTexture;
  private canvasScale = 0.75; // Adapted dynamically: 0.5 Eco, 0.75 Balanced, 1.0 High

  // Pre-cached gradients (eliminates per-frame CanvasGradient heap churn)
  private gradientCache = new Map<string, CanvasGradient>();

  private activeApp: PlayStoreAppItem | null = null;
  private mode: 'hub' | PlayableModeId = 'hub';
  private score = 0;
  private highScore = 0;
  private blasterHighScore = 0;
  private racerHighScore = 0;
  private wave = 1;
  private cinemaPlaying = true;
  private cinemaDimmed = false;

  // Device Home Screen & Interactive Curved Screen state
  private installedAppsProvider: (() => PlayStoreAppItem[]) | null = null;
  private appLauncher: ((app: PlayStoreAppItem) => void) | null = null;
  private homeAppPage = 0;
  private mirrorAsWallpaper = false;
  private screenHitboxes: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    onClick: () => void;
  }> = [];
  private hoveredScreenBoxId: string | null = null;
  private readonly _hitLocalScratch = new THREE.Vector3();

  // Google Workspace & Live Google Apps state
  private workspaceFeed: WorkspaceFeedResult | null = null;
  private workspaceLoading = false;
  private selectedItemIndex = 0;
  private unsubAuth: (() => void) | null = null;
  private imageCache = new Map<
    string,
    {img: HTMLImageElement; loaded: boolean; failed: boolean}
  >();

  // Virtual Play Browser theater mirror state
  private browserState: {
    url: string;
    heading: string;
    summary: string;
    items: Array<{title: string; meta: string}>;
  } | null = null;

  // Cosmic Blaster 3D pre-allocated object pools (zero GC during gameplay)
  private gameGroup = new THREE.Group();
  private targetPool: SpaceTarget[] = [];
  private activeTargetCount = 0;
  private boltPool: LaserBolt[] = [];
  private spawnTimer = 0;
  private targetGeo = new THREE.OctahedronGeometry(0.18, 0);
  private targetRingGeo = new THREE.TorusGeometry(0.24, 0.022, 6, 18);
  private boltGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.35, 6);
  private boltMat = new THREE.MeshBasicMaterial({color: 0x38bdf8});
  private targetMat = new THREE.MeshStandardMaterial({
    color: 0xf43f5e,
    emissive: 0xe11d48,
    emissiveIntensity: 1.4,
    roughness: 0.25,
    metalness: 0.5,
  });
  private targetLowMat = new THREE.MeshBasicMaterial({color: 0xf43f5e});
  private targetRingMat = new THREE.MeshBasicMaterial({color: 0x38bdf8});

  // Neon Racer pre-allocated obstacle pool (zero GC)
  private racerX = 0; // -1..1
  private racerSpeed = 0.72;
  private racerRoadScroll = 0;
  private racerObstaclePool: RacerObstacle[] = [];
  private racerSpawnTimer = 0;
  private racerFlash = 0;
  private racerJumpY = 0;
  private racerJumpVelY = 0;
  private racerAirborne = false;
  private racerBannerText = '';
  private racerBannerTimer = 0;

  // Cosmic Blaster drone plasma hazards & Jump Shockwave (zero GC)
  private hazardPool: DroneHazard[] = [];
  private hazardGeo = new THREE.SphereGeometry(0.085, 8, 6);
  private hazardMat = new THREE.MeshBasicMaterial({color: 0xfbbf24});
  private hazardTimer = 1.6;
  private shockwaveGeo = new THREE.TorusGeometry(0.6, 0.045, 6, 24);
  private shockwaveMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.85,
  });
  private shockwaveRing!: THREE.Mesh;
  private shockwaveTimer = 0;
  private blasterBannerText = '';
  private blasterBannerTimer = 0;

  // Live Back-Camera / IMU Locomotion mirror
  private liveLocoState: 'idle' | 'walk' | 'run' | 'jump' | 'crouch' = 'idle';
  private liveMoveDirection: 'forward' | 'backward' = 'forward';
  private liveCrouching = false;
  private liveSpeedMps = 0;
  private liveJumpHeightM = 0;

  // Reusable scratch vectors (zero GC in loop)
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();
  private readonly _camPosScratch = new THREE.Vector3();
  private readonly _quat = new THREE.Quaternion();
  private drawTimer = 0;
  private elapsed = 0;
  private screenRedrawHz = 20;
  private maxBlasterTargets = 9;

  private onSessionChange?: (app: PlayStoreAppItem | null, score: number) => void;

  constructor(
    env: VRLoungeEnvironment,
    sensors: SensorFusionTracker,
    sound: SoundEngine,
    onSessionChange?: (app: PlayStoreAppItem | null, score: number) => void
  ) {
    super();
    this.env = env;
    this.sensors = sensors;
    this.sound = sound;
    this.onSessionChange = onSessionChange;

    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(LOGICAL_W * this.canvasScale);
    this.canvas.height = Math.round(LOGICAL_H * this.canvasScale);
    this.ctx = this.canvas.getContext('2d', {alpha: false});
    this.screenTexture = new THREE.CanvasTexture(this.canvas);
    this.screenTexture.colorSpace = THREE.SRGBColorSpace;
    this.screenTexture.generateMipmaps = false;
    this.screenTexture.minFilter = THREE.LinearFilter;
    this.screenTexture.magFilter = THREE.LinearFilter;

    this.initPools();
  }

  private initPools(): void {
    this.boltGeo.rotateX(Math.PI / 2);

    for (let i = 0; i < TARGET_POOL_SIZE; i++) {
      const lod = new THREE.LOD();
      lod.xb = {pointerEvents: 'none'};
      lod.visible = false;

      const highGroup = new THREE.Group();
      const core = new THREE.Mesh(this.targetGeo, this.targetMat);
      const ring = new THREE.Mesh(this.targetRingGeo, this.targetRingMat);
      ring.rotation.x = Math.PI / 3;
      highGroup.add(core, ring);

      const farProxy = new THREE.Mesh(this.targetGeo, this.targetLowMat);

      lod.addLevel(highGroup, 0);
      lod.addLevel(farProxy, 3.6);

      this.gameGroup.add(lod);
      this.targetPool.push({
        lod,
        angle: 0,
        elevation: 1.5,
        distance: 3.0,
        speed: 0.3,
        hp: 1,
        active: false,
      });
    }

    for (let i = 0; i < BOLT_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.boltGeo, this.boltMat);
      mesh.xb = {pointerEvents: 'none'};
      mesh.visible = false;
      this.gameGroup.add(mesh);
      this.boltPool.push({
        mesh,
        velocity: new THREE.Vector3(),
        life: 0,
        active: false,
      });
    }

    for (let i = 0; i < HAZARD_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.hazardGeo, this.hazardMat);
      mesh.xb = {pointerEvents: 'none'};
      mesh.visible = false;
      this.gameGroup.add(mesh);
      this.hazardPool.push({
        mesh,
        velocity: new THREE.Vector3(),
        life: 0,
        active: false,
      });
    }

    this.shockwaveGeo.rotateX(Math.PI / 2);
    this.shockwaveRing = new THREE.Mesh(this.shockwaveGeo, this.shockwaveMat);
    this.shockwaveRing.xb = {pointerEvents: 'none'};
    this.shockwaveRing.visible = false;
    this.gameGroup.add(this.shockwaveRing);

    for (let i = 0; i < OBSTACLE_POOL_SIZE; i++) {
      this.racerObstaclePool.push({
        lane: 0,
        z: 0,
        isOrb: false,
        isHighGate: false,
        active: false,
      });
    }
  }

  init(): void {
    this.add(this.gameGroup);

    if (this.env.screenMesh) {
      const oldMap = this.env.screenMesh.material.map;
      this.env.screenMesh.material.map = this.screenTexture;
      this.env.screenMesh.material.needsUpdate = true;
      oldMap?.dispose();
    }

    this.unsubAuth = subscribeGoogleAuth((snap) => {
      if (snap.signedIn && this.activeApp?.googleService) {
        if (this.mode === 'google-workspace') {
          void this.refreshWorkspaceApp();
        } else if (this.mode === 'google-suite-launch' && this.activeApp.googleService === 'meet') {
          void this.refreshGoogleSuiteApp();
        }
      }
    });

    this.drawScreen();
  }

  public setInstalledAppsProvider(provider: () => PlayStoreAppItem[]): void {
    this.installedAppsProvider = provider;
  }

  public setAppLauncher(launcher: (app: PlayStoreAppItem) => void): void {
    this.appLauncher = launcher;
  }

  public setHomeAppPage(page: number): void {
    const apps = this.installedAppsProvider?.() ?? PLAY_STORE_CATALOG;
    const totalPages = Math.max(1, Math.ceil(apps.length / 8));
    this.homeAppPage = ((page % totalPages) + totalPages) % totalPages;
    this.drawScreen();
  }

  getGameGroup(): THREE.Group {
    return this.gameGroup;
  }

  public setQualityProfile(
    screenRedrawHz: number,
    maxBlasterTargets: number,
    screenResolutionScale = 0.75
  ): void {
    this.screenRedrawHz = Math.max(8, screenRedrawHz);
    this.maxBlasterTargets = Math.max(4, Math.min(TARGET_POOL_SIZE, maxBlasterTargets));

    const clampedScale = THREE.MathUtils.clamp(screenResolutionScale, 0.5, 1.0);
    if (Math.abs(clampedScale - this.canvasScale) > 0.05) {
      this.canvasScale = clampedScale;
      const nextW = Math.round(LOGICAL_W * clampedScale);
      const nextH = Math.round(LOGICAL_H * clampedScale);
      this.canvas.width = nextW;
      this.canvas.height = nextH;
      this.gradientCache.clear();
      // Re-create texture when backing store dimensions change
      const nextTex = new THREE.CanvasTexture(this.canvas);
      nextTex.colorSpace = THREE.SRGBColorSpace;
      nextTex.generateMipmaps = false;
      nextTex.minFilter = THREE.LinearFilter;
      nextTex.magFilter = THREE.LinearFilter;
      const prevTex = this.screenTexture;
      this.screenTexture = nextTex;
      if (this.env.screenMesh) {
        this.env.screenMesh.material.map = nextTex;
        this.env.screenMesh.material.needsUpdate = true;
      }
      prevTex.dispose();
      this.drawScreen();
    }
  }

  launchApp(app: PlayStoreAppItem): void {
    this.stopCurrentGame();
    this.activeApp = app;
    this.mode = app.playableMode;
    this.score = 0;
    this.wave = 1;
    this.selectedItemIndex = 0;
    this.workspaceFeed = null;
    this.env.setAccentColor(app.accentColor);

    if (this.mode === 'cosmic-blaster') {
      this.env.setTheaterDim(0.7);
      this.hazardTimer = 1.4;
      this.shockwaveTimer = 0;
      this.blasterBannerText = 'WALK / RUN / JUMP / CROUCH LIVE!';
      this.blasterBannerTimer = 2.2;
      this.spawnWaveTargets(5);
    } else if (this.mode === 'neon-racer') {
      this.env.setTheaterDim(0.55);
      this.racerX = 0;
      this.racerSpeed = 0.72;
      this.racerJumpY = 0;
      this.racerJumpVelY = 0;
      this.racerAirborne = false;
      this.racerBannerText = 'WALK / RUN / JUMP / DUCK / TURN!';
      this.racerBannerTimer = 2.4;
      for (let i = 0; i < this.racerObstaclePool.length; i++) {
        this.racerObstaclePool[i].active = false;
      }
    } else if (this.mode === 'google-workspace') {
      this.env.setTheaterDim(0.6);
      void this.refreshWorkspaceApp();
    } else if (this.mode === 'google-suite-launch') {
      this.cinemaPlaying = true;
      this.env.setTheaterDim(0.65);
      void this.refreshGoogleSuiteApp();
    } else if (this.mode === 'control-scheme') {
      this.env.setTheaterDim(0.35);
    } else {
      this.cinemaPlaying = true;
      this.cinemaDimmed = true;
      this.env.setTheaterDim(0.85);
    }

    this.sound.playInstallComplete();
    this.drawScreen();
    this.onSessionChange?.(this.activeApp, this.score);
  }

  showControlSchemeGuide(): void {
    this.stopCurrentGame();
    this.activeApp = {
      id: 'sensor-control-scheme',
      packageId: 'com.pocketvr.sensorcontrols',
      title: 'Phone-Sensor VR Control Scheme',
      developer: 'PocketVR OS',
      category: 'apps',
      rating: '5.0',
      sizeMb: 1,
      accentColor: '#38bdf8',
      secondaryColor: '#818cf8',
      badge: 'SENSOR CONTROLS',
      description: '360° Head Gaze + Compass + Gyro + Accel control scheme.',
      playStoreUrl: 'https://play.google.com/store',
      playableMode: 'control-scheme',
    };
    this.mode = 'control-scheme';
    this.env.setAccentColor('#38bdf8');
    this.env.setTheaterDim(0.35);
    this.sound.playClick();
    this.drawScreen();
    this.onSessionChange?.(this.activeApp, 0);
  }

  showBrowserState(state: {
    url: string;
    heading: string;
    summary: string;
    items: Array<{title: string; meta: string}>;
  }): void {
    this.stopCurrentGame();
    this.browserState = state;
    this.activeApp = {
      id: 'play-browser-mirror',
      packageId: 'com.android.vending',
      title: 'Play Store VR Browser',
      developer: 'Google LLC',
      category: 'google',
      rating: '4.9',
      sizeMb: 28,
      accentColor: '#34d399',
      secondaryColor: '#38bdf8',
      badge: 'BROWSER',
      description: state.summary,
      playStoreUrl: state.url,
      playableMode: 'play-browser',
    };
    this.mode = 'play-browser';
    this.env.setAccentColor('#34d399');
    this.env.setTheaterDim(0.35);
    this.drawScreen();
    this.onSessionChange?.(this.activeApp, 0);
  }

  async refreshWorkspaceApp(): Promise<void> {
    const svc = this.activeApp?.googleService;
    if (!svc) return;
    this.workspaceLoading = true;
    this.drawScreen();
    try {
      this.workspaceFeed = await fetchGoogleWorkspaceFeed(svc);
      if (this.workspaceFeed.items.length > 0) {
        this.selectedItemIndex = Math.min(
          this.selectedItemIndex,
          this.workspaceFeed.items.length - 1
        );
      } else {
        this.selectedItemIndex = 0;
      }
    } finally {
      this.workspaceLoading = false;
      this.drawScreen();
    }
  }

  async refreshGoogleSuiteApp(): Promise<void> {
    const svc = this.activeApp?.googleService;
    if (!svc) return;
    this.workspaceLoading = true;
    this.drawScreen();
    try {
      const heading = this.sensors.getTelemetry().compassHeadingDeg;
      this.workspaceFeed = await fetchLiveGoogleSuiteFeed(svc, heading, {
        blasterHigh: this.blasterHighScore,
        racerHigh: this.racerHighScore,
      });
      if (this.workspaceFeed.items.length > 0) {
        this.selectedItemIndex = Math.min(
          this.selectedItemIndex,
          this.workspaceFeed.items.length - 1
        );
      } else {
        this.selectedItemIndex = 0;
      }
    } finally {
      this.workspaceLoading = false;
      this.drawScreen();
    }
  }

  public refreshActiveGoogleApp(): void {
    if (this.mode === 'google-workspace') {
      void this.refreshWorkspaceApp();
    } else if (this.mode === 'google-suite-launch') {
      void this.refreshGoogleSuiteApp();
    }
  }

  public cycleGoogleItem(delta: number): void {
    const items = this.workspaceFeed?.items ?? [];
    if (items.length === 0) return;
    this.selectedItemIndex = (this.selectedItemIndex + delta + items.length) % items.length;
    this.sound.playHoverTick();
    this.drawScreen();
  }

  public getSelectedGoogleItem(): WorkspaceFeedItem | null {
    const items = this.workspaceFeed?.items ?? [];
    if (items.length === 0) return null;
    return items[Math.min(this.selectedItemIndex, items.length - 1)] ?? null;
  }

  public async triggerGooglePrimaryAction(): Promise<void> {
    const svc = this.activeApp?.googleService;
    const item = this.getSelectedGoogleItem();

    if (this.mode === 'google-workspace' && this.workspaceFeed?.requiresAuth) {
      this.sound.playClick();
      void signInWithGoogle().catch(() => {});
      return;
    }

    if ((svc === 'youtube' || svc === 'google-tv') && item?.videoId) {
      this.sound.playClick();
      openYouTubePlayerOverlay(item.videoId, item.title);
      return;
    }

    if (svc === 'photos') {
      this.sound.playClick();
      await pickRealDevicePhotos();
      await this.refreshGoogleSuiteApp();
      return;
    }

    if (svc === 'play-games' && item) {
      const match = (this.installedAppsProvider?.() ?? PLAY_STORE_CATALOG).find(
        (a) => a.title.toLowerCase() === item.title.toLowerCase()
      );
      if (match && this.appLauncher) {
        this.sound.playClick();
        this.appLauncher(match);
        return;
      }
    }

    const targetUrl =
      item?.linkUrl ||
      this.workspaceFeed?.selectedLinkUrl ||
      this.activeApp?.webUrl ||
      this.activeApp?.playStoreUrl;

    if (targetUrl) {
      this.sound.playClick();
      openExternalUrlSafely(targetUrl);
    } else {
      this.openActiveGoogleAppExternally();
    }
  }

  public promptLiveSearchForActiveApp(): void {
    const svc = this.activeApp?.googleService;
    if (svc === 'youtube' || svc === 'google-tv') {
      openLiveSearchPromptModal({
        title: svc === 'google-tv' ? 'Search Google TV' : 'Search YouTube in VR',
        placeholder: 'Search videos, channels, 360 VR...',
        initialValue: getYouTubeSearchQuery(),
        onSubmit: (q) => {
          setYouTubeSearchQuery(q);
          void this.refreshGoogleSuiteApp();
        },
      });
    } else {
      openLiveSearchPromptModal({
        title: 'Google Chrome VR — Search or Enter URL',
        placeholder: 'Search Google news or paste https://...',
        initialValue: getChromeInput(),
        onSubmit: (q) => {
          setChromeInput(q);
          const chromeApp =
            (this.installedAppsProvider?.() ?? PLAY_STORE_CATALOG).find(
              (a) => a.id === 'google-chrome'
            ) ?? PLAY_STORE_CATALOG.find((a) => a.id === 'google-chrome');
          if (this.activeApp?.googleService !== 'chrome' && chromeApp) {
            this.launchApp(chromeApp);
          } else {
            void this.refreshGoogleSuiteApp();
          }
        },
      });
    }
  }

  public screenPointToLogicalXY(worldPoint: THREE.Vector3): {px: number; py: number} | null {
    const mesh = this.env.screenMesh;
    if (!mesh) return null;
    mesh.updateMatrixWorld();
    mesh.worldToLocal(this._hitLocalScratch.copy(worldPoint));
    const x = this._hitLocalScratch.x;
    const y = this._hitLocalScratch.y;
    const z = this._hitLocalScratch.z;
    const u = THREE.MathUtils.clamp((Math.atan2(x, -z) + 0.46) / 0.92, 0, 1);
    const v = THREE.MathUtils.clamp(0.5 - y / 1.65, 0, 1);
    return {px: u * LOGICAL_W, py: v * LOGICAL_H};
  }

  public updateScreenHover(worldPoint: THREE.Vector3 | null): {id: string; label: string} | null {
    if (!worldPoint || this.screenHitboxes.length === 0) {
      if (this.hoveredScreenBoxId !== null) {
        this.hoveredScreenBoxId = null;
        this.drawScreen();
      }
      return null;
    }
    const coords = this.screenPointToLogicalXY(worldPoint);
    if (!coords) return null;

    let hitBox: (typeof this.screenHitboxes)[number] | null = null;
    for (let i = this.screenHitboxes.length - 1; i >= 0; i--) {
      const b = this.screenHitboxes[i];
      if (
        coords.px >= b.x &&
        coords.px <= b.x + b.w &&
        coords.py >= b.y &&
        coords.py <= b.y + b.h
      ) {
        hitBox = b;
        break;
      }
    }

    const nextId = hitBox?.id ?? null;
    if (nextId !== this.hoveredScreenBoxId) {
      this.hoveredScreenBoxId = nextId;
      this.drawScreen();
    }
    return hitBox ? {id: hitBox.id, label: hitBox.label} : null;
  }

  public handleScreenClickAt(worldPoint: THREE.Vector3): boolean {
    const coords = this.screenPointToLogicalXY(worldPoint);
    if (!coords) return false;
    for (let i = this.screenHitboxes.length - 1; i >= 0; i--) {
      const b = this.screenHitboxes[i];
      if (
        coords.px >= b.x &&
        coords.px <= b.x + b.w &&
        coords.py >= b.y &&
        coords.py <= b.y + b.h
      ) {
        this.sound.playClick();
        b.onClick();
        return true;
      }
    }
    return false;
  }

  openActiveGoogleAppExternally(): void {
    if (!this.activeApp) return;
    const isAndroid = /Android/i.test(navigator.userAgent);
    const url = isAndroid
      ? `intent://#Intent;package=${this.activeApp.packageId};end`
      : this.workspaceFeed?.selectedLinkUrl || this.activeApp.webUrl || this.activeApp.playStoreUrl;

    openExternalUrlSafely(url);
    this.sound.playClick();
  }

  exitToHub(): void {
    closeYouTubePlayerOverlay();
    this.stopCurrentGame();
    this.activeApp = null;
    this.workspaceFeed = null;
    this.workspaceLoading = false;
    this.selectedItemIndex = 0;
    this.hoveredScreenBoxId = null;
    this.mode = 'hub';
    this.env.setTheaterDim(0);
    this.env.setAccentColor('#38bdf8');
    this.sound.playClick();
    this.drawScreen();
    this.onSessionChange?.(null, 0);
  }

  toggleCinemaPlay(): void {
    this.cinemaPlaying = !this.cinemaPlaying;
    this.sound.playClick();
  }

  toggleCinemaDim(): void {
    this.cinemaDimmed = !this.cinemaDimmed;
    this.env.setTheaterDim(this.cinemaDimmed ? 0.9 : 0.2);
    this.sound.playClick();
  }

  getActiveApp(): PlayStoreAppItem | null {
    return this.activeApp;
  }

  getMode(): 'hub' | PlayableModeId {
    return this.mode;
  }

  updateLocomotionFrame(
    state: 'idle' | 'walk' | 'run' | 'jump' | 'crouch',
    moveDirection: 'forward' | 'backward',
    crouching: boolean,
    speedMps: number,
    jumpHeightM: number
  ): void {
    this.liveLocoState = state;
    this.liveMoveDirection = moveDirection;
    this.liveCrouching = crouching;
    this.liveSpeedMps = speedMps;
    this.liveJumpHeightM = jumpHeightM;
  }

  triggerRacerBoost(): void {
    if (this.mode !== 'neon-racer') return;
    this.racerSpeed = Math.min(1.85, this.racerSpeed + 0.25);
    this.score += 25;
    if (this.score > this.highScore) this.highScore = this.score;
    this.racerBannerText = 'NITRO BOOST +25';
    this.racerBannerTimer = 1.1;
    this.sound.playPickup();
    this.onSessionChange?.(this.activeApp, this.score);
  }

  triggerLocomotionStep(
    running: boolean,
    moveDirection: 'forward' | 'backward' = 'forward'
  ): void {
    if (this.mode === 'neon-racer') {
      if (moveDirection === 'backward') {
        this.racerSpeed = Math.max(0.45, this.racerSpeed - 0.14);
        this.racerBannerText = 'BACK-WALK BRAKE';
        this.racerBannerTimer = 0.8;
      } else if (running) {
        this.racerSpeed = Math.min(1.85, this.racerSpeed + 0.14);
        this.score += 15;
        if (this.score > this.highScore) this.highScore = this.score;
        this.racerBannerText = 'TURBO RUN +15';
        this.racerBannerTimer = 0.9;
        this.onSessionChange?.(this.activeApp, this.score);
      } else {
        this.racerSpeed = Math.min(1.5, Math.max(this.racerSpeed + 0.04, 0.95));
        this.score += 5;
        if (this.score > this.highScore) this.highScore = this.score;
        this.onSessionChange?.(this.activeApp, this.score);
      }
    } else if (this.mode === 'cosmic-blaster' && running) {
      this.blasterBannerText = 'RUN OVERDRIVE x2 LOCK';
      this.blasterBannerTimer = 1.0;
    }
  }

  triggerLocomotionJump(): void {
    if (this.mode === 'neon-racer') {
      if (!this.racerAirborne) {
        this.racerAirborne = true;
        this.racerJumpVelY = 4.25;
      }
      this.score += 60;
      this.racerSpeed = Math.min(1.85, this.racerSpeed + 0.22);
      if (this.score > this.highScore) this.highScore = this.score;
      this.racerBannerText = 'JUMP AIRBORNE! +60';
      this.racerBannerTimer = 1.2;
      this.sound.playPickup();
      this.onSessionChange?.(this.activeApp, this.score);
    } else if (this.mode === 'cosmic-blaster') {
      this.triggerBlasterJumpShockwave();
    }
  }

  private triggerBlasterJumpShockwave(): void {
    const cam = xb.core.camera;
    if (cam) {
      cam.getWorldPosition(this._camPosScratch);
    } else {
      this._camPosScratch.set(0, 1.5, 0);
    }
    this.shockwaveRing.position.set(this._camPosScratch.x, 0.35, this._camPosScratch.z);
    this.shockwaveRing.scale.setScalar(0.35);
    this.shockwaveRing.visible = true;
    this.shockwaveTimer = 0.65;

    let slammed = 0;
    for (let i = 0; i < this.targetPool.length && slammed < 2; i++) {
      const target = this.targetPool[i];
      if (!target.active) continue;
      if (target.lod.position.distanceTo(this._camPosScratch) <= 4.6) {
        target.active = false;
        target.lod.visible = false;
        this.activeTargetCount = Math.max(0, this.activeTargetCount - 1);
        this.score += 120;
        slammed += 1;
      }
    }
    if (slammed > 0) {
      if (this.score > this.highScore) this.highScore = this.score;
      this.sound.playExplosion();
      this.onSessionChange?.(this.activeApp, this.score);
      this.blasterBannerText = `JUMP SHOCKWAVE x${slammed}! +${slammed * 120}`;
    } else {
      this.score += 35;
      if (this.score > this.highScore) this.highScore = this.score;
      this.sound.playPickup();
      this.onSessionChange?.(this.activeApp, this.score);
      this.blasterBannerText = 'JUMP SHOCKWAVE! +35';
    }
    this.blasterBannerTimer = 1.4;
  }

  getScore(): number {
    return this.score;
  }

  private stopCurrentGame(): void {
    for (let i = 0; i < this.targetPool.length; i++) {
      this.targetPool[i].active = false;
      this.targetPool[i].lod.visible = false;
    }
    this.activeTargetCount = 0;

    for (let i = 0; i < this.boltPool.length; i++) {
      this.boltPool[i].active = false;
      this.boltPool[i].mesh.visible = false;
    }

    for (let i = 0; i < this.hazardPool.length; i++) {
      this.hazardPool[i].active = false;
      this.hazardPool[i].mesh.visible = false;
    }

    if (this.shockwaveRing) {
      this.shockwaveRing.visible = false;
    }
    this.shockwaveTimer = 0;

    for (let i = 0; i < this.racerObstaclePool.length; i++) {
      this.racerObstaclePool[i].active = false;
    }
  }

  private spawnWaveTargets(count: number): void {
    let spawned = 0;
    for (let i = 0; i < this.targetPool.length && spawned < count; i++) {
      const slot = this.targetPool[i];
      if (slot.active) continue;

      const angle = (Math.random() - 0.5) * Math.PI * 1.65;
      const elevation = 1.2 + Math.random() * 1.45;
      const distance = 2.6 + Math.random() * 2.2;

      slot.angle = angle;
      slot.elevation = elevation;
      slot.distance = distance;
      slot.speed = (0.28 + Math.random() * 0.35) * (Math.random() > 0.5 ? 1 : -1);
      slot.hp = 1;
      slot.active = true;
      slot.lod.position.set(
        Math.sin(angle) * distance,
        elevation,
        -Math.cos(angle) * distance
      );
      slot.lod.visible = true;
      spawned += 1;
      this.activeTargetCount += 1;
    }
  }

  onSelectStart(event: xb.SelectEvent): void {
    if (this.mode !== 'cosmic-blaster') return;
    const targetObj = event.target as THREE.Object3D & {isUI?: boolean};
    if (targetObj?.isUI) return;
    this.fireLaser(event);
  }

  public fireFromCamera(): void {
    if (this.mode !== 'cosmic-blaster') return;
    const cam = xb.core.camera;
    if (!cam) return;
    cam.getWorldPosition(this._rayOrigin);
    cam.getWorldDirection(this._rayDir);
    this.spawnBolt(this._rayOrigin, this._rayDir);
  }

  public fireAlongRay(origin: THREE.Vector3, direction: THREE.Vector3): void {
    if (this.mode !== 'cosmic-blaster') return;
    this._rayOrigin.copy(origin);
    this._rayDir.copy(direction).normalize();
    this.spawnBolt(this._rayOrigin, this._rayDir);
  }

  public checkAirTouchHit(worldPoint: THREE.Vector3, radius = 0.35): boolean {
    if (this.mode !== 'cosmic-blaster') return false;
    for (let j = 0; j < this.targetPool.length; j++) {
      const target = this.targetPool[j];
      if (!target.active) continue;
      if (worldPoint.distanceTo(target.lod.position) <= radius) {
        target.active = false;
        target.lod.visible = false;
        this.activeTargetCount = Math.max(0, this.activeTargetCount - 1);
        this.score += 120;
        if (this.score > this.highScore) this.highScore = this.score;
        this.sound.playExplosion();
        this.onSessionChange?.(this.activeApp, this.score);
        return true;
      }
    }
    return false;
  }

  private fireLaser(event: xb.SelectEvent): void {
    const controller = event.source?.controller;
    if (controller) {
      controller.getWorldPosition(this._rayOrigin);
      this._rayDir.set(0, 0, -1).applyQuaternion(controller.quaternion).normalize();
    } else if (xb.core.camera) {
      xb.core.camera.getWorldPosition(this._rayOrigin);
      xb.core.camera.getWorldDirection(this._rayDir);
    } else {
      return;
    }
    this.spawnBolt(this._rayOrigin, this._rayDir);
  }

  private spawnBolt(origin: THREE.Vector3, dir: THREE.Vector3): void {
    // Acquire pre-allocated bolt from fixed pool (zero runtime heap allocations)
    let bolt: LaserBolt | null = null;
    for (let i = 0; i < this.boltPool.length; i++) {
      if (!this.boltPool[i].active) {
        bolt = this.boltPool[i];
        break;
      }
    }
    if (!bolt) {
      // Recycle oldest slot
      bolt = this.boltPool[0];
    }

    bolt.active = true;
    bolt.life = 1.4;
    bolt.velocity.copy(dir).multiplyScalar(15);
    bolt.mesh.position.copy(origin).addScaledVector(dir, 0.25);
    this._quat.setFromUnitVectors(BOLT_Z_AXIS, dir);
    bolt.mesh.quaternion.copy(this._quat);
    bolt.mesh.visible = true;
    this.sound.playLaser();
  }

  update(): void {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.elapsed += dt;

    if (this.mode === 'cosmic-blaster') {
      this.updateCosmicBlaster(dt);
    } else if (this.mode === 'neon-racer') {
      this.updateNeonRacer(dt);
    }

    const mirrorLive = this.mode === 'hub' && deviceHomeService.isScreenMirrorActive();
    const maxGameInterval = 1 / this.screenRedrawHz;
    const redrawInterval = mirrorLive
      ? maxGameInterval
      : this.mode === 'google-workspace' ||
          this.mode === 'google-suite-launch' ||
          this.mode === 'control-scheme' ||
          this.mode === 'play-browser'
        ? Math.max(0.25, maxGameInterval)
        : this.mode === 'hub'
          ? Math.max(0.18, maxGameInterval)
          : maxGameInterval;
    this.drawTimer += dt;
    if (this.drawTimer >= redrawInterval) {
      this.drawTimer = 0;
      this.drawScreen();
    }
  }

  private updateCosmicBlaster(dt: number): void {
    const cam = xb.core.camera;
    if (cam) {
      cam.getWorldPosition(this._camPosScratch);
    } else {
      this._camPosScratch.set(0, 1.5, 0);
    }

    if (this.blasterBannerTimer > 0) {
      this.blasterBannerTimer = Math.max(0, this.blasterBannerTimer - dt);
    }

    if (this.shockwaveTimer > 0) {
      this.shockwaveTimer = Math.max(0, this.shockwaveTimer - dt);
      const frac = 1 - this.shockwaveTimer / 0.65;
      this.shockwaveRing.scale.setScalar(0.4 + frac * 7.5);
      this.shockwaveMat.opacity = Math.max(0, (1 - frac) * 0.85);
      if (this.shockwaveTimer <= 0) {
        this.shockwaveRing.visible = false;
      }
    }

    for (let i = 0; i < this.targetPool.length; i++) {
      const target = this.targetPool[i];
      if (!target.active) continue;
      target.angle += target.speed * dt;
      const bob = Math.sin(this.elapsed * 2.4 + target.angle) * 0.14;
      target.lod.position.set(
        Math.sin(target.angle) * target.distance,
        target.elevation + bob,
        -Math.cos(target.angle) * target.distance
      );
      target.lod.rotation.y += dt * 1.8;
      target.lod.rotation.x += dt * 0.9;
      if (cam) target.lod.update(cam);
    }

    // Periodically fire slow dodgeable drone plasma orbs toward the player
    this.hazardTimer -= dt;
    if (this.hazardTimer <= 0 && this.activeTargetCount > 0) {
      this.hazardTimer = Math.max(1.35, 2.8 - this.wave * 0.15);
      let shooter: SpaceTarget | null = null;
      for (let i = 0; i < this.targetPool.length; i++) {
        if (this.targetPool[i].active) {
          shooter = this.targetPool[i];
          if (Math.random() > 0.5) break;
        }
      }
      if (shooter) {
        for (let i = 0; i < this.hazardPool.length; i++) {
          const h = this.hazardPool[i];
          if (h.active) continue;
          h.active = true;
          h.life = 3.2;
          h.mesh.position.copy(shooter.lod.position);
          h.velocity
            .copy(this._camPosScratch)
            .sub(shooter.lod.position)
            .normalize()
            .multiplyScalar(2.4);
          h.mesh.visible = true;
          break;
        }
      }
    }

    for (let i = 0; i < this.hazardPool.length; i++) {
      const h = this.hazardPool[i];
      if (!h.active) continue;
      h.mesh.position.addScaledVector(h.velocity, dt);
      h.life -= dt;
      const distSq = h.mesh.position.distanceToSquared(this._camPosScratch);
      if (distSq < 0.22 * 0.22) {
        if (this.liveCrouching || this.liveJumpHeightM > 0.14) {
          this.score += 40;
          if (this.score > this.highScore) this.highScore = this.score;
          this.sound.playPickup();
          this.blasterBannerText = this.liveCrouching ? 'CROUCH SHIELD +40' : 'JUMP DODGE +40';
          this.blasterBannerTimer = 1.0;
        } else {
          this.score = Math.max(0, this.score - 35);
          this.sound.playHoverTick();
          this.blasterBannerText = 'MOVE / DUCK / JUMP TO DODGE!';
          this.blasterBannerTimer = 1.1;
        }
        this.onSessionChange?.(this.activeApp, this.score);
        h.active = false;
        h.mesh.visible = false;
      } else if (h.life <= 0) {
        if (this.liveLocoState === 'walk' || this.liveLocoState === 'run') {
          this.score += 20;
          if (this.score > this.highScore) this.highScore = this.score;
          this.onSessionChange?.(this.activeApp, this.score);
        }
        h.active = false;
        h.mesh.visible = false;
      }
    }

    for (let i = 0; i < this.boltPool.length; i++) {
      const bolt = this.boltPool[i];
      if (!bolt.active) continue;

      bolt.mesh.position.addScaledVector(bolt.velocity, dt);
      bolt.life -= dt;

      let hit = false;
      for (let j = 0; j < this.targetPool.length; j++) {
        const target = this.targetPool[j];
        if (!target.active) continue;
        if (bolt.mesh.position.distanceTo(target.lod.position) < 0.34) {
          target.active = false;
          target.lod.visible = false;
          this.activeTargetCount = Math.max(0, this.activeTargetCount - 1);
          this.score += 100;
          if (this.score > this.highScore) this.highScore = this.score;
          if (this.score > this.blasterHighScore) this.blasterHighScore = this.score;
          this.sound.playExplosion();
          this.onSessionChange?.(this.activeApp, this.score);
          hit = true;
          break;
        }
      }

      if (hit || bolt.life <= 0) {
        bolt.active = false;
        bolt.mesh.visible = false;
      }
    }

    if (this.activeTargetCount === 0) {
      this.spawnTimer += dt;
      if (this.spawnTimer > 0.8) {
        this.spawnTimer = 0;
        this.wave += 1;
        this.spawnWaveTargets(Math.min(5 + this.wave, this.maxBlasterTargets));
      }
    }
  }

  private updateNeonRacer(dt: number): void {
    const head = this.sensors.getHeadAngles();
    const locoXZ = this.sensors.getLocomotionOffsetXZ();
    const steerInput = THREE.MathUtils.clamp(
      -head.yaw * 1.4 - head.roll * 1.2 + THREE.MathUtils.clamp(-locoXZ.x * 0.25, -0.35, 0.35),
      -1,
      1
    );
    this.racerX = THREE.MathUtils.lerp(this.racerX, steerInput, Math.min(1, dt * 8));

    // Back-camera Walk / Run / Back-Walk throttle + idle floor
    const targetCruise =
      this.liveLocoState === 'run'
        ? 1.52
        : this.liveLocoState === 'walk'
          ? this.liveMoveDirection === 'backward'
            ? 0.52
            : 1.06
          : 0.72;
    this.racerSpeed = THREE.MathUtils.lerp(this.racerSpeed, targetCruise, Math.min(1, dt * 1.6));

    // Airborne jump physics inside Neon Racer
    if (this.racerAirborne) {
      this.racerJumpY += this.racerJumpVelY * dt;
      this.racerJumpVelY -= 11.4 * dt;
      if (this.racerJumpY <= 0) {
        this.racerJumpY = 0;
        this.racerJumpVelY = 0;
        this.racerAirborne = false;
      }
    }
    const effectiveJumpY = Math.max(this.racerJumpY, this.liveJumpHeightM);

    if (this.racerBannerTimer > 0) {
      this.racerBannerTimer = Math.max(0, this.racerBannerTimer - dt);
    }

    this.racerRoadScroll = (this.racerRoadScroll + dt * this.racerSpeed * 2.4) % 1;
    if (this.racerFlash > 0) this.racerFlash = Math.max(0, this.racerFlash - dt * 3);

    this.racerSpawnTimer += dt;
    if (this.racerSpawnTimer >= 0.72 / Math.max(0.45, this.racerSpeed)) {
      this.racerSpawnTimer = 0;
      for (let i = 0; i < this.racerObstaclePool.length; i++) {
        const slot = this.racerObstaclePool[i];
        if (!slot.active) {
          slot.lane = (Math.floor(Math.random() * 3) - 1) * 0.62;
          slot.z = 0.02;
          const r = Math.random();
          slot.isOrb = r > 0.48;
          slot.isHighGate = !slot.isOrb && r < 0.22;
          slot.active = true;
          break;
        }
      }
    }

    for (let i = 0; i < this.racerObstaclePool.length; i++) {
      const obs = this.racerObstaclePool[i];
      if (!obs.active) continue;
      obs.z += dt * this.racerSpeed;
      if (obs.z >= 0.88 && obs.z <= 0.98) {
        if (Math.abs(obs.lane - this.racerX) < 0.28) {
          if (obs.isOrb) {
            this.score += 50;
            this.sound.playPickup();
          } else if (obs.isHighGate && this.liveCrouching) {
            this.score += 70;
            this.racerBannerText = 'DUCK CLEAR! +70';
            this.racerBannerTimer = 1.1;
            this.sound.playPickup();
          } else if (!obs.isHighGate && effectiveJumpY > 0.18) {
            this.score += 80;
            this.racerBannerText = 'JUMP CLEAR! +80';
            this.racerBannerTimer = 1.1;
            this.sound.playPickup();
          } else {
            this.score = Math.max(0, this.score - 75);
            this.racerFlash = 1;
            this.racerBannerText = obs.isHighGate ? 'CROUCH OR STEER!' : 'JUMP OR STEER!';
            this.racerBannerTimer = 1.1;
            this.sound.playExplosion();
          }
          if (this.score > this.highScore) this.highScore = this.score;
          if (this.score > this.racerHighScore) this.racerHighScore = this.score;
          this.onSessionChange?.(this.activeApp, this.score);
          obs.active = false;
          continue;
        }
      }
      if (obs.z > 1.05) {
        this.score += 10;
        if (this.score > this.highScore) this.highScore = this.score;
        if (this.score > this.racerHighScore) this.racerHighScore = this.score;
        obs.active = false;
      }
    }
  }

  private getCachedGradient(
    ctx: CanvasRenderingContext2D,
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    stops: Array<[number, string]>
  ): CanvasGradient {
    const existing = this.gradientCache.get(key);
    if (existing) return existing;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (let i = 0; i < stops.length; i++) {
      g.addColorStop(stops[i][0], stops[i][1]);
    }
    this.gradientCache.set(key, g);
    return g;
  }

  private getCachedImage(url?: string): HTMLImageElement | null {
    if (!url) return null;
    const entry = this.imageCache.get(url);
    if (entry) {
      return entry.loaded && !entry.failed ? entry.img : null;
    }
    if (this.imageCache.size >= 24) {
      const oldestKey = this.imageCache.keys().next().value;
      if (oldestKey) this.imageCache.delete(oldestKey);
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const record = {img, loaded: false, failed: false};
    img.onload = () => {
      record.loaded = true;
      this.drawScreen();
    };
    img.onerror = () => {
      record.failed = true;
    };
    img.src = url;
    this.imageCache.set(url, record);
    return null;
  }

  private addScreenHitbox(
    id: string,
    label: string,
    x: number,
    y: number,
    w: number,
    h: number,
    onClick: () => void
  ): void {
    this.screenHitboxes.push({id, label, x, y, w, h, onClick});
  }

  private drawRoundedBox(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    fill: string,
    stroke?: string,
    lineWidth = 1.5
  ): void {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  private drawScreen(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.screenHitboxes.length = 0;

    // Draw using logical 1024x512 coordinates scaled cleanly to the active Eco/Balanced/High canvas
    ctx.setTransform(this.canvasScale, 0, 0, this.canvasScale, 0, 0);
    const W = LOGICAL_W;
    const H = LOGICAL_H;

    if (this.mode === 'hub') {
      this.drawHubScreen(ctx, W, H);
    } else if (this.mode === 'cosmic-blaster') {
      this.drawBlasterScreen(ctx, W, H);
    } else if (this.mode === 'neon-racer') {
      this.drawRacerScreen(ctx, W, H);
    } else if (this.mode === 'google-workspace' || this.mode === 'google-suite-launch') {
      this.drawLiveGoogleAppScreen(ctx, W, H);
    } else if (this.mode === 'control-scheme') {
      this.drawControlSchemeScreen(ctx, W, H);
    } else if (this.mode === 'play-browser') {
      this.drawPlayBrowserScreen(ctx, W, H);
    } else {
      this.drawCinemaDeckScreen(ctx, W, H);
    }

    this.screenTexture.needsUpdate = true;
  }

  private drawDeviceStatusBar(
    ctx: CanvasRenderingContext2D,
    W: number,
    dev: DeviceStatusSnapshot
  ): void {
    const auth = getGoogleAuthSnapshot();
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const dateStr = now.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'});

    ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
    ctx.fillRect(0, 0, W, 44);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.fillRect(0, 43, W, 1.5);

    // Left: Real device model + OS
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${dev.deviceModel} • ${dev.platformLabel} (${dev.resolutionLabel})`,
      22,
      27
    );

    // Center: Real system clock + date
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${timeStr}  •  ${dateStr}`, W / 2, 27);

    // Right: Network, Battery, Google Auth pill
    const batStr =
      dev.batteryPct !== null
        ? `${dev.batteryCharging ? '⚡' : ''}${dev.batteryPct}%`
        : `${dev.cpuCores}c`;
    const netStr = dev.online ? dev.networkLabel : 'OFFLINE';

    ctx.textAlign = 'right';
    ctx.fillStyle = dev.online ? '#34d399' : '#fb7185';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(`${netStr}  |  BAT ${batStr}`, W - 210, 27);

    const authId = 'home-auth';
    const hovered = this.hoveredScreenBoxId === authId;
    const authText = auth.signedIn ? auth.userEmail.split('@')[0] : 'Google Sign-In';
    this.drawRoundedBox(
      ctx,
      W - 196,
      7,
      178,
      30,
      15,
      auth.signedIn ? 'rgba(16, 185, 129, 0.22)' : 'rgba(56, 189, 248, 0.22)',
      hovered ? '#ffffff' : auth.signedIn ? '#34d399' : '#38bdf8',
      hovered ? 2 : 1.2
    );
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(authText.slice(0, 18), W - 107, 27);
    this.addScreenHitbox(
      authId,
      auth.signedIn ? 'Open Gmail Live' : 'Sign in with Google',
      W - 196,
      7,
      178,
      30,
      () => {
        if (auth.signedIn) {
          const gmail = (this.installedAppsProvider?.() ?? PLAY_STORE_CATALOG).find(
            (a) => a.id === 'google-gmail'
          );
          if (gmail && this.appLauncher) this.appLauncher(gmail);
        } else {
          void signInWithGoogle().catch(() => {});
        }
      }
    );
  }

  private drawHubScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const dev = deviceHomeService.getSnapshot();
    const tel = this.sensors.getTelemetry();
    const mirrorVideo = deviceHomeService.getMirrorVideo();
    const mirrorLive = Boolean(dev.screenMirrorActive && mirrorVideo && mirrorVideo.readyState >= 2);

    ctx.fillStyle = this.getCachedGradient(ctx, 'hub', 0, 0, W, H, [
      [0, '#04091a'],
      [0.5, '#0b1633'],
      [1, '#1b1444'],
    ]);
    ctx.fillRect(0, 0, W, H);

    // Subtle wallpaper grid
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
    ctx.lineWidth = 1;
    for (let y = 44; y < H; y += 36) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Full-screen Device Screen Mirroring view (when active and not in wallpaper mode)
    if (mirrorLive && mirrorVideo && !this.mirrorAsWallpaper) {
      this.drawDeviceStatusBar(ctx, W, dev);
      const vw = mirrorVideo.videoWidth || 16;
      const vh = mirrorVideo.videoHeight || 9;
      const areaX = 16;
      const areaY = 52;
      const areaW = W - 32;
      const areaH = H - 108;
      const scale = Math.min(areaW / vw, areaH / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = areaX + (areaW - dw) / 2;
      const dy = areaY + (areaH - dh) / 2;

      ctx.fillStyle = '#000000';
      ctx.fillRect(areaX, areaY, areaW, areaH);
      ctx.drawImage(mirrorVideo, dx, dy, dw, dh);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.strokeRect(dx, dy, dw, dh);

      // Mirror Controls Bar
      const toggleWallpaperId = 'mirror-wallpaper';
      this.drawRoundedBox(
        ctx,
        24,
        H - 46,
        260,
        36,
        10,
        'rgba(30, 41, 59, 0.92)',
        this.hoveredScreenBoxId === toggleWallpaperId ? '#ffffff' : '#38bdf8',
        1.8
      );
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Show Apps Over Mirror', 154, H - 23);
      this.addScreenHitbox(toggleWallpaperId, 'Overlay Home Apps', 24, H - 46, 260, 36, () => {
        this.mirrorAsWallpaper = true;
        this.drawScreen();
      });

      const stopMirrorId = 'mirror-stop';
      this.drawRoundedBox(
        ctx,
        W - 244,
        H - 46,
        220,
        36,
        10,
        'rgba(225, 29, 72, 0.35)',
        this.hoveredScreenBoxId === stopMirrorId ? '#ffffff' : '#fb7185',
        1.8
      );
      ctx.fillStyle = '#ffe4e6';
      ctx.fillText('Stop Device Mirror', W - 134, H - 23);
      this.addScreenHitbox(stopMirrorId, 'Stop Device Screen Mirror', W - 244, H - 46, 220, 36, () => {
        deviceHomeService.stopDeviceScreenMirror();
        this.mirrorAsWallpaper = false;
        this.drawScreen();
      });
      return;
    }

    // Mirror active as live translucent wallpaper behind Device Home Screen icons
    if (mirrorLive && mirrorVideo && this.mirrorAsWallpaper) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.drawImage(mirrorVideo, 0, 44, W, H - 44);
      ctx.restore();
    }

    this.drawDeviceStatusBar(ctx, W, dev);

    // Quick Action Row: Search Bar + Mirror Screen + Pagination
    const searchId = 'home-search';
    this.drawRoundedBox(
      ctx,
      24,
      56,
      368,
      44,
      22,
      'rgba(15, 23, 42, 0.9)',
      this.hoveredScreenBoxId === searchId ? '#ffffff' : 'rgba(56, 189, 248, 0.5)',
      2
    );
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 19px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('G', 44, 84);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '16px sans-serif';
    ctx.fillText('Search Google Web or Open Chrome...', 72, 83);
    this.addScreenHitbox(searchId, 'Search Google / Chrome', 24, 56, 368, 44, () => {
      this.promptLiveSearchForActiveApp();
    });

    const mirrorId = 'home-mirror';
    this.drawRoundedBox(
      ctx,
      406,
      56,
      250,
      44,
      14,
      mirrorLive ? 'rgba(16, 185, 129, 0.28)' : 'rgba(56, 189, 248, 0.2)',
      this.hoveredScreenBoxId === mirrorId ? '#ffffff' : mirrorLive ? '#34d399' : '#38bdf8',
      2
    );
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      mirrorLive ? '📺 Fullscreen Mirror' : '📺 Mirror Real Screen',
      531,
      83
    );
    this.addScreenHitbox(
      mirrorId,
      mirrorLive ? 'Fullscreen Mirrored Device Screen' : 'Mirror Your Device Screen into VR',
      406,
      56,
      250,
      44,
      () => {
        if (mirrorLive) {
          this.mirrorAsWallpaper = false;
          this.drawScreen();
        } else {
          void deviceHomeService.toggleDeviceScreenMirror().then(() => {
            this.mirrorAsWallpaper = false;
            this.drawScreen();
          });
        }
      }
    );

    const installedApps = this.installedAppsProvider?.() ?? PLAY_STORE_CATALOG;
    const pageSize = 8;
    const totalPages = Math.max(1, Math.ceil(installedApps.length / pageSize));
    if (this.homeAppPage >= totalPages) this.homeAppPage = 0;

    const prevId = 'home-prev';
    this.drawRoundedBox(
      ctx,
      670,
      56,
      96,
      44,
      12,
      'rgba(30, 41, 59, 0.9)',
      this.hoveredScreenBoxId === prevId ? '#ffffff' : '#64748b',
      1.6
    );
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('◀ Prev', 718, 83);
    this.addScreenHitbox(prevId, 'Previous App Page', 670, 56, 96, 44, () => {
      this.setHomeAppPage(this.homeAppPage - 1);
    });

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(`HOME ${this.homeAppPage + 1}/${totalPages}`, 832, 83);

    const nextId = 'home-next';
    this.drawRoundedBox(
      ctx,
      898,
      56,
      102,
      44,
      12,
      'rgba(30, 41, 59, 0.9)',
      this.hoveredScreenBoxId === nextId ? '#ffffff' : '#64748b',
      1.6
    );
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('Next ▶', 949, 83);
    this.addScreenHitbox(nextId, 'Next App Page', 898, 56, 102, 44, () => {
      this.setHomeAppPage(this.homeAppPage + 1);
    });

    // 4x2 Interactive Device Home App Grid
    const startIdx = this.homeAppPage * pageSize;
    const pageApps = installedApps.slice(startIdx, startIdx + pageSize);
    const cols = 4;
    const cardW = 228;
    const cardH = 152;
    const gapX = 16;
    const gapY = 16;
    const gridX = 24;
    const gridY = 114;

    for (let i = 0; i < pageApps.length; i++) {
      const app = pageApps[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridX + col * (cardW + gapX);
      const y = gridY + row * (cardH + gapY);
      const boxId = `home-app-${app.id}`;
      const isHovered = this.hoveredScreenBoxId === boxId;

      this.drawRoundedBox(
        ctx,
        x,
        y,
        cardW,
        cardH,
        16,
        isHovered ? 'rgba(30, 58, 138, 0.92)' : 'rgba(15, 23, 42, 0.88)',
        isHovered ? '#ffffff' : app.accentColor,
        isHovered ? 3 : 1.8
      );

      // Top accent strip
      ctx.fillStyle = app.accentColor;
      ctx.fillRect(x + 14, y + 12, 48, 6);

      // App initial glyph badge
      this.drawRoundedBox(ctx, x + 14, y + 26, 46, 46, 12, app.accentColor);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(app.title.slice(0, 2).toUpperCase(), x + 37, y + 57);

      // Badge pill
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(x + 70, y + 28, 142, 22);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(app.badge.slice(0, 18), x + 78, y + 43);

      // Developer
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.fillText(app.developer.slice(0, 22), x + 70, y + 66);

      // App Title
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 19px sans-serif';
      ctx.fillText(app.title.slice(0, 19), x + 14, y + 104);

      // Footer hint
      ctx.fillStyle = isHovered ? '#34d399' : '#38bdf8';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(
        isHovered ? '▶ GAZE / CLICK TO LAUNCH' : `★ ${app.rating}  •  INSTALLED`,
        x + 14,
        y + 134
      );

      this.addScreenHitbox(boxId, `Device App: ${app.title}`, x, y, cardW, cardH, () => {
        if (this.appLauncher) {
          this.appLauncher(app);
        } else {
          this.launchApp(app);
        }
      });
    }

    // Bottom Live Device OS & Sensor Strip
    this.drawRoundedBox(
      ctx,
      24,
      H - 52,
      W - 48,
      40,
      10,
      'rgba(15, 23, 42, 0.9)',
      'rgba(56, 189, 248, 0.4)',
      1.4
    );
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      `DEVICE HOME (${installedApps.length} APPS)  •  SENSORS: ${tel.statusLabel.toUpperCase()}  •  MOTION: ${tel.locomotion.state.toUpperCase()} (${tel.locomotion.stepCount} STEPS)`,
      42,
      H - 27
    );
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '14px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(
      `COMPASS ${tel.compassHeadingDeg}°  YAW ${tel.yawDeg}°  PITCH ${tel.pitchDeg}°`,
      W - 42,
      H - 27
    );
  }

  private drawPlayBrowserScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#06111f');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#34d399';
    ctx.fillRect(0, 0, W, 10);

    const b = this.browserState;
    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('VIRTUAL PLAY STORE BROWSER (IMAX MIRROR)', 48, 52);

    ctx.fillStyle = '#93c5fd';
    ctx.font = '18px monospace';
    ctx.fillText((b?.url ?? 'https://play.google.com/store').slice(0, 82), 48, 84);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText((b?.heading ?? 'Google Play Store').slice(0, 52), 48, 134);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '20px sans-serif';
    ctx.fillText((b?.summary ?? '').slice(0, 88), 48, 168);

    const items = b?.items.slice(0, 5) ?? [];
    let y = 198;
    for (const item of items) {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
      ctx.fillRect(48, y, W - 96, 52);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(48, y, 6, 52);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 21px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(item.title.slice(0, 46), 70, y + 33);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(item.meta.slice(0, 38), W - 66, y + 33);
      y += 58;
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '18px sans-serif';
    ctx.fillText(
      'USE FLOATING BROWSER PANEL TO SEARCH & INSTALL  •  SHAKE HEAD TO EXIT',
      W / 2,
      H - 18
    );
  }

  private wrapCanvasLines(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    maxLines: number
  ): string[] {
    const rawParas = text.split('\n');
    const out: string[] = [];
    for (const para of rawParas) {
      const words = para.trim().split(/\s+/);
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          out.push(line);
          line = word;
          if (out.length >= maxLines) return out;
        } else {
          line = candidate;
        }
      }
      if (line) {
        out.push(line);
        if (out.length >= maxLines) return out;
      }
    }
    return out;
  }

  private drawLiveGoogleAppScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const accent = this.activeApp?.accentColor || '#4285F4';
    const svc = this.activeApp?.googleService;
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#070c1b');
    grad.addColorStop(1, '#111827');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Top Google accent stripe
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 8);

    // Header Title + Live Subtitle
    ctx.fillStyle = accent;
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      `GOOGLE LIVE APP  •  ${this.activeApp?.packageId ?? ''}`,
      36,
      36
    );

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(this.activeApp?.title ?? 'Google App', 36, 74);

    // Interactive Top Action Buttons
    const actionBtns: Array<{
      id: string;
      label: string;
      fill: string;
      border: string;
      onClick: () => void;
    }> = [];

    const feed = this.workspaceFeed;
    const items = feed?.items ?? [];
    const selectedItem = items[Math.min(this.selectedItemIndex, Math.max(0, items.length - 1))];

    if (items.length > 1) {
      actionBtns.push({
        id: 'g-prev',
        label: '◀ Prev',
        fill: 'rgba(30, 41, 59, 0.92)',
        border: '#64748b',
        onClick: () => this.cycleGoogleItem(-1),
      });
      actionBtns.push({
        id: 'g-next',
        label: 'Next ▶',
        fill: 'rgba(30, 41, 59, 0.92)',
        border: '#64748b',
        onClick: () => this.cycleGoogleItem(1),
      });
    }

    if (svc === 'youtube' || svc === 'google-tv' || svc === 'chrome') {
      actionBtns.push({
        id: 'g-search',
        label: 'Search',
        fill: 'rgba(56, 189, 248, 0.22)',
        border: '#38bdf8',
        onClick: () => this.promptLiveSearchForActiveApp(),
      });
    }

    if (svc === 'photos') {
      actionBtns.push({
        id: 'g-pick-photos',
        label: 'Pick Photos',
        fill: 'rgba(251, 191, 36, 0.24)',
        border: '#fbbf24',
        onClick: () => {
          void pickRealDevicePhotos().then(() => this.refreshGoogleSuiteApp());
        },
      });
    } else if ((svc === 'youtube' || svc === 'google-tv') && selectedItem?.videoId) {
      actionBtns.push({
        id: 'g-watch',
        label: '▶ Watch Video',
        fill: 'rgba(239, 68, 68, 0.35)',
        border: '#f87171',
        onClick: () => void this.triggerGooglePrimaryAction(),
      });
    } else if (this.mode === 'google-workspace' && feed?.requiresAuth) {
      actionBtns.push({
        id: 'g-signin',
        label: 'Sign in Google',
        fill: 'rgba(52, 211, 153, 0.25)',
        border: '#34d399',
        onClick: () => {
          void signInWithGoogle().catch(() => {});
        },
      });
    } else {
      actionBtns.push({
        id: 'g-open',
        label: 'Open App',
        fill: 'rgba(52, 211, 153, 0.22)',
        border: '#34d399',
        onClick: () => void this.triggerGooglePrimaryAction(),
      });
    }

    actionBtns.push({
      id: 'g-sync',
      label: '↻ Sync',
      fill: 'rgba(30, 41, 59, 0.92)',
      border: '#38bdf8',
      onClick: () => this.refreshActiveGoogleApp(),
    });
    actionBtns.push({
      id: 'g-home',
      label: '⌂ Home',
      fill: 'rgba(225, 29, 72, 0.28)',
      border: '#fb7185',
      onClick: () => this.exitToHub(),
    });

    let bx = W - 28;
    for (let i = actionBtns.length - 1; i >= 0; i--) {
      const b = actionBtns[i];
      const bw = Math.max(84, b.label.length * 10 + 24);
      bx -= bw;
      const hovered = this.hoveredScreenBoxId === b.id;
      this.drawRoundedBox(
        ctx,
        bx,
        24,
        bw,
        36,
        10,
        b.fill,
        hovered ? '#ffffff' : b.border,
        hovered ? 2.4 : 1.5
      );
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, bx + bw / 2, 47);
      this.addScreenHitbox(b.id, b.label, bx, 24, bw, 36, b.onClick);
      bx -= 8;
    }

    if (this.workspaceLoading) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`Loading live ${this.activeApp?.title ?? 'Google'} data into VR Theater...`, 36, 175);
      return;
    }

    if (!feed || (this.mode === 'google-workspace' && feed.requiresAuth)) {
      this.drawRoundedBox(ctx, 36, 120, W - 72, 280, 16, 'rgba(30, 41, 59, 0.92)', '#fbbf24', 2);
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Sign in with Google to stream live personal data', 66, 178);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '20px sans-serif';
      ctx.fillText(
        `Gaze/click "Sign in Google" above or top-right to authorize ${this.activeApp?.title ?? 'Workspace'}.`,
        66,
        228
      );
      ctx.fillStyle = '#94a3b8';
      ctx.font = '18px sans-serif';
      ctx.fillText(
        'Streams live Gmail messages, Drive files, Calendar events, Docs, Sheets, Slides, Tasks & Contacts.',
        66,
        274
      );
      return;
    }

    if (feed.error) {
      ctx.fillStyle = '#fb7185';
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Live Service Notice:', 36, 130);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '19px sans-serif';
      ctx.fillText(feed.error.slice(0, 92), 36, 166);
      return;
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '17px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(feed.subtitle.slice(0, 96), 36, 102);

    // Split View: Left Interactive Item List (480px) + Right Rich Live Preview (460px)
    const listX = 36;
    const listW = 472;
    const previewX = 526;
    const previewY = 122;
    const previewW = W - previewX - 36;
    const previewH = H - previewY - 46;

    const visibleItems = items.slice(0, 5);
    if (visibleItems.length === 0) {
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '22px sans-serif';
      ctx.fillText(
        svc === 'photos'
          ? 'No photos selected yet. Click "Pick Photos" above to view your real gallery!'
          : 'No items returned right now. Click "Sync" or "Open App" above.',
        listX,
        180
      );
    } else {
      let y = 122;
      for (let i = 0; i < visibleItems.length; i++) {
        const item = visibleItems[i];
        const isSelected = i === this.selectedItemIndex;
        const rowId = `g-row-${i}`;
        const isHovered = this.hoveredScreenBoxId === rowId;
        this.drawRoundedBox(
          ctx,
          listX,
          y,
          listW,
          62,
          10,
          isSelected ? 'rgba(30, 58, 138, 0.88)' : 'rgba(30, 41, 59, 0.82)',
          isHovered ? '#ffffff' : isSelected ? accent : 'rgba(148, 163, 184, 0.22)',
          isSelected || isHovered ? 2.2 : 1
        );
        ctx.fillStyle = accent;
        ctx.fillRect(listX, y + 8, 5, 46);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 17px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(item.title.slice(0, 40), listX + 14, y + 25);

        ctx.fillStyle = '#cbd5e1';
        ctx.font = '14px sans-serif';
        ctx.fillText(item.detail.slice(0, 50), listX + 14, y + 48);

        if (item.meta) {
          ctx.fillStyle = '#38bdf8';
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'right';
          ctx.fillText(item.meta.slice(0, 14), listX + listW - 10, y + 23);
        }

        this.addScreenHitbox(rowId, `Select: ${item.title.slice(0, 26)}`, listX, y, listW, 62, () => {
          this.selectedItemIndex = i;
          this.drawScreen();
        });
        y += 69;
      }
    }

    // Right Rich Live Preview Card
    this.drawRoundedBox(
      ctx,
      previewX,
      previewY,
      previewW,
      previewH,
      14,
      'rgba(15, 23, 42, 0.92)',
      accent,
      1.8
    );

    if (svc === 'maps' || svc === 'earth') {
      this.drawMapsRadarPreview(ctx, previewX, previewY, previewW, previewH, accent, selectedItem);
    } else if (selectedItem?.tableRows && selectedItem.tableRows.length > 0) {
      this.drawSheetsTablePreview(ctx, previewX, previewY, previewW, previewH, selectedItem);
    } else if (selectedItem?.imageUrl) {
      this.drawMediaImagePreview(ctx, previewX, previewY, previewW, previewH, selectedItem);
    } else if (selectedItem) {
      ctx.fillStyle = accent;
      ctx.font = 'bold 19px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(selectedItem.title.slice(0, 36), previewX + 18, previewY + 34);

      const body = selectedItem.fullText || selectedItem.detail;
      const lines = this.wrapCanvasLines(ctx, body, previewW - 36, 12);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '15px sans-serif';
      let ly = previewY + 66;
      for (const line of lines) {
        ctx.fillText(line, previewX + 18, ly);
        ly += 22;
      }
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '15px sans-serif';
    ctx.fillText(
      'GAZE / CLICK ANY ITEM OR BUTTON ABOVE  •  SHAKE HEAD LEFT-RIGHT TO RETURN HOME',
      W / 2,
      H - 16
    );
  }

  private drawMediaImagePreview(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    item: WorkspaceFeedItem
  ): void {
    const img = this.getCachedImage(item.imageUrl);
    const imgAreaH = h - 94;
    if (img) {
      const scale = Math.min((w - 28) / img.width, imgAreaH / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = x + (w - dw) / 2;
      const dy = y + 14 + (imgAreaH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
      ctx.fillRect(x + 14, y + 14, w - 28, imgAreaH);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Loading live media preview...', x + w / 2, y + 14 + imgAreaH / 2);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText(item.title.slice(0, 38), x + 16, y + h - 54);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '14px sans-serif';
    ctx.fillText(item.detail.slice(0, 46), x + 16, y + h - 28);

    if (item.videoId) {
      const playId = 'g-preview-play';
      this.drawRoundedBox(
        ctx,
        x + w - 126,
        y + h - 46,
        110,
        32,
        8,
        'rgba(239, 68, 68, 0.85)',
        this.hoveredScreenBoxId === playId ? '#ffffff' : '#fca5a5',
        1.5
      );
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('▶ Play VR', x + w - 71, y + h - 25);
      this.addScreenHitbox(playId, `Play: ${item.title.slice(0, 24)}`, x + w - 126, y + h - 46, 110, 32, () => {
        if (item.videoId) openYouTubePlayerOverlay(item.videoId, item.title);
      });
    }
  }

  private drawSheetsTablePreview(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    _h: number,
    item: WorkspaceFeedItem
  ): void {
    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${item.title.slice(0, 32)} — Live Sheet`, x + 16, y + 30);

    const rows = (item.tableRows ?? []).slice(0, 7);
    const cols = 4;
    const cellW = (w - 32) / cols;
    const cellH = 38;
    let ry = y + 48;

    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = x + 16 + c * cellW;
        ctx.fillStyle = r === 0 ? 'rgba(15, 157, 88, 0.28)' : 'rgba(30, 41, 59, 0.72)';
        ctx.fillRect(cx, ry, cellW - 2, cellH - 2);
        ctx.fillStyle = r === 0 ? '#a7f3d0' : '#e2e8f0';
        ctx.font = r === 0 ? 'bold 13px sans-serif' : '13px monospace';
        ctx.textAlign = 'left';
        const val = rows[r]?.[c] ?? '';
        ctx.fillText(val.slice(0, 11), cx + 6, ry + 23);
      }
      ry += cellH;
    }
  }

  private drawMapsRadarPreview(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    accent: string,
    selectedItem?: WorkspaceFeedItem
  ): void {
    const tel = this.sensors.getTelemetry();
    const cx = x + w / 2;
    const cy = y + 128;
    const r = 88;

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.52, 0, Math.PI * 2);
    ctx.stroke();

    // Live rotating North / Compass heading beam
    const rad = THREE.MathUtils.degToRad(tel.compassHeadingDeg - 90);
    ctx.fillStyle = 'rgba(52, 211, 153, 0.25)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, rad - 0.35, rad + 0.35);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 15px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`HEADING ${tel.compassHeadingDeg}°`, cx, y + 28);

    if (selectedItem) {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(selectedItem.title.slice(0, 36), x + 16, y + h - 84);
      const lines = this.wrapCanvasLines(
        ctx,
        selectedItem.fullText || selectedItem.detail,
        w - 32,
        3
      );
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '14px sans-serif';
      let ly = y + h - 60;
      for (const l of lines) {
        ctx.fillText(l, x + 16, ly);
        ly += 20;
      }
    }
  }

  private drawControlSchemeScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#040a18');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('PHONE-SENSOR-ONLY VR CONTROL SCHEME (NO CONTROLLER NEEDED)', 48, 52);

    const rows = [
      {
        key: '1. LOOK & NAVIGATE',
        color: '#38bdf8',
        desc: 'Compass + Gyro + Accel steer 360° head-gaze cursor across all menus & apps.',
      },
      {
        key: '2. SELECT & LAUNCH',
        color: '#34d399',
        desc: 'Hold gaze 1.0s on any button/app, OR Nod Head forward, OR Tap Headset side.',
      },
      {
        key: '3. BROWSE APP LIST',
        color: '#a78bfa',
        desc: 'Gaze Play Store list & Tilt Head Left/Right (±16°) or look top/bottom to scroll.',
      },
      {
        key: '4. PLAY IN VR',
        color: '#f472b6',
        desc: 'Blaster: Gaze drone 0.4s / Nod to fire.  Racer: Tilt head left/right to steer.',
      },
      {
        key: '5. BACK & RECENTER',
        color: '#fbbf24',
        desc: 'Shake Head Left-Right = Exit App to Hub.  Look Straight Down 1.2s = Recenter.',
      },
    ];

    let y = 84;
    for (const r of rows) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(48, y, W - 96, 62);
      ctx.fillStyle = r.color;
      ctx.fillRect(48, y, 8, 62);

      ctx.fillStyle = r.color;
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(r.key, 70, y + 26);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '19px sans-serif';
      ctx.fillText(r.desc, 70, y + 51);
      y += 70;
    }

    const tel = this.sensors.getTelemetry();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '18px monospace';
    ctx.fillText(
      `LIVE: Compass ${tel.compassHeadingDeg}° | Yaw ${tel.yawDeg}° | Pitch ${tel.pitchDeg}° | Roll ${tel.rollDeg}° | ${tel.statusLabel}`,
      48,
      H - 22
    );
  }

  private drawBlasterScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2 + 25;
    const r = 155;

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();

    const head = this.sensors.getHeadAngles();
    const locoXZ = this.sensors.getLocomotionOffsetXZ();
    const px = cx + THREE.MathUtils.clamp((locoXZ.x / 6.5) * (r * 0.72), -r * 0.75, r * 0.75);
    const py = cy + THREE.MathUtils.clamp((locoXZ.z / 6.5) * (r * 0.72), -r * 0.75, r * 0.75);
    const lookAngle = -head.yaw;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, r * 0.75, lookAngle - Math.PI / 2 - 0.35, lookAngle - Math.PI / 2 + 0.35);
    ctx.closePath();
    ctx.fill();

    // Live player XZ arena marker
    ctx.fillStyle = this.liveCrouching ? '#a78bfa' : '#34d399';
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < this.targetPool.length; i++) {
      const target = this.targetPool[i];
      if (!target.active) continue;
      const normDist = Math.min(1, target.distance / 5);
      const bx = cx + Math.sin(target.angle) * r * normDist;
      const by = cy - Math.cos(target.angle) * r * normDist;
      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.arc(bx, by, 9, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < this.hazardPool.length; i++) {
      const h = this.hazardPool[i];
      if (!h.active) continue;
      const hx = cx + THREE.MathUtils.clamp((h.mesh.position.x / 5) * r, -r, r);
      const hy = cy + THREE.MathUtils.clamp((h.mesh.position.z / 5) * r, -r, r);
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(this.activeApp?.title.toUpperCase() ?? 'COSMIC BLASTER 360', 48, 60);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 42px monospace';
    ctx.fillText(`SCORE ${this.score}`, 48, 120);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '24px sans-serif';
    ctx.fillText(`WAVE ${this.wave}  •  DRONES LEFT: ${this.activeTargetCount}`, 48, 160);

    const locoLabel =
      this.liveLocoState === 'jump'
        ? 'JUMP SHOCKWAVE!'
        : this.liveLocoState === 'run'
          ? 'OVERDRIVE RUN x2'
          : this.liveCrouching
            ? 'CROUCH SHIELD ON'
            : this.liveLocoState === 'walk'
              ? this.liveMoveDirection === 'backward'
                ? 'WALKING BACK'
                : 'WALKING ARENA'
              : 'BACK-CAM READY';
    ctx.fillStyle = this.liveLocoState === 'idle' ? '#94a3b8' : '#34d399';
    ctx.font = 'bold 21px sans-serif';
    ctx.fillText(`MOTION: ${locoLabel}`, 48, 200);

    if (this.blasterBannerTimer > 0 && this.blasterBannerText) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText(this.blasterBannerText, cx, 78);
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(`HIGH ${this.highScore}`, W - 48, 60);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '20px sans-serif';
    ctx.fillText(
      'LOOK TO AUTO-FIRE  •  WALK/RUN/DODGE  •  JUMP = SHOCKWAVE  •  CROUCH = SHIELD',
      cx,
      H - 30
    );
  }

  private drawRacerScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.fillStyle = this.getCachedGradient(ctx, 'racer-sky', 0, 0, 0, H * 0.52, [
      [0, '#09051a'],
      [1, '#3b0764'],
    ]);
    ctx.fillRect(0, 0, W, H * 0.52);

    ctx.fillStyle = '#fb7185';
    ctx.beginPath();
    ctx.arc(W / 2, H * 0.45, 95, Math.PI, 0);
    ctx.fill();

    ctx.fillStyle = '#090d1f';
    ctx.fillRect(0, H * 0.5, W, H * 0.5);

    const horizonY = H * 0.5;
    const bottomW = 640;
    const topW = 70;
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.moveTo(W / 2 - topW / 2, horizonY);
    ctx.lineTo(W / 2 + topW / 2, horizonY);
    ctx.lineTo(W / 2 + bottomW / 2, H);
    ctx.lineTo(W / 2 - bottomW / 2, H);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#f472b6';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(W / 2 - topW / 2, horizonY);
    ctx.lineTo(W / 2 - bottomW / 2, H);
    ctx.moveTo(W / 2 + topW / 2, horizonY);
    ctx.lineTo(W / 2 + bottomW / 2, H);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 2;
    for (let s = 0; s < 8; s++) {
      const t = ((s / 8 + this.racerRoadScroll) % 1) ** 2;
      const y = horizonY + t * (H - horizonY);
      const halfW = THREE.MathUtils.lerp(topW / 2, bottomW / 2, t);
      ctx.beginPath();
      ctx.moveTo(W / 2 - halfW, y);
      ctx.lineTo(W / 2 + halfW, y);
      ctx.stroke();
    }

    for (let i = 0; i < this.racerObstaclePool.length; i++) {
      const obs = this.racerObstaclePool[i];
      if (!obs.active) continue;
      const p = obs.z ** 2;
      const y = horizonY + p * (H - horizonY);
      const roadHalf = THREE.MathUtils.lerp(topW / 2, bottomW / 2, p);
      const x = W / 2 + obs.lane * roadHalf;
      const size = 8 + p * 36;
      if (obs.isOrb) {
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(x, y - size * 0.4, size * 0.55, 0, Math.PI * 2);
        ctx.fill();
      } else if (obs.isHighGate) {
        // Overhead laser gate (duck/crouch under!)
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(x - size * 0.85, y - size * 1.45, size * 1.7, size * 0.45);
        ctx.fillStyle = 'rgba(251, 191, 36, 0.45)';
        ctx.fillRect(x - size * 0.85, y - size * 1.0, 5, size);
        ctx.fillRect(x + size * 0.85 - 5, y - size * 1.0, 5, size);
      } else {
        // Ground red barrier (jump over or steer!)
        ctx.fillStyle = '#f43f5e';
        ctx.fillRect(x - size * 0.7, y - size * 0.7, size * 1.4, size * 0.7);
      }
    }

    const px = W / 2 + this.racerX * (bottomW * 0.42);
    const groundY = H - 56;
    const jumpPx = Math.max(this.racerJumpY, this.liveJumpHeightM) * 95;
    const py = groundY - jumpPx + (this.liveCrouching ? 14 : 0);

    // Craft shadow when airborne
    if (jumpPx > 4) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.beginPath();
      ctx.ellipse(px, groundY + 14, 34, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Turbo flames when running
    if (this.liveLocoState === 'run') {
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(px - 18, py + 16);
      ctx.lineTo(px - 10, py + 38);
      ctx.lineTo(px - 2, py + 16);
      ctx.moveTo(px + 2, py + 16);
      ctx.lineTo(px + 10, py + 38);
      ctx.lineTo(px + 18, py + 16);
      ctx.fill();
    }

    const craftH = this.liveCrouching ? 18 : 34;
    ctx.fillStyle = this.liveCrouching ? '#a78bfa' : jumpPx > 10 ? '#34d399' : '#22d3ee';
    ctx.beginPath();
    ctx.moveTo(px, py - craftH);
    ctx.lineTo(px + 42, py + 16);
    ctx.lineTo(px - 42, py + 16);
    ctx.closePath();
    ctx.fill();

    if (this.racerFlash > 0) {
      ctx.fillStyle = `rgba(244, 63, 94, ${this.racerFlash * 0.45})`;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`SCORE ${this.score}`, 42, 56);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f472b6';
    ctx.fillText(`SPEED ${Math.round(this.racerSpeed * 220)} KM/H`, W - 42, 56);
    ctx.textAlign = 'center';
    ctx.fillStyle = this.racerBannerTimer > 0 ? '#fbbf24' : '#e2e8f0';
    ctx.font = this.racerBannerTimer > 0 ? 'bold 26px sans-serif' : '19px sans-serif';
    ctx.fillText(
      this.racerBannerTimer > 0
        ? this.racerBannerText
        : 'BACK-CAM: TURN=STEER • WALK/RUN=SPEED • JUMP OVER RED • CROUCH UNDER GOLD',
      W / 2,
      46
    );
  }

  private drawCinemaDeckScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0a0f1e');
    grad.addColorStop(1, '#1e1b4b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = this.activeApp?.accentColor ?? '#fbbf24';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      `ANDROID VR SESSION  •  ${this.activeApp?.packageId ?? 'com.pocketvr.app'}`,
      54,
      66
    );

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText(this.activeApp?.title ?? 'Pocket Cinema Theater', 54, 134);

    const barCount = 32;
    const barW = (W - 108) / barCount;
    for (let i = 0; i < barCount; i++) {
      const h = this.cinemaPlaying
        ? 30 + Math.abs(Math.sin(this.elapsed * 3.5 + i * 0.45)) * 150
        : 28;
      ctx.fillStyle = i % 2 === 0 ? (this.activeApp?.accentColor ?? '#fbbf24') : '#6366f1';
      ctx.fillRect(54 + i * barW + 4, 370 - h, barW - 8, h);
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '24px sans-serif';
    ctx.fillText(
      this.cinemaPlaying
        ? '▶ Playing in Curved VR Mode • Gaze Screen to Pause or Shake Head to Exit'
        : '❚❚ Paused • Gaze Screen to Resume or Shake Head to Exit',
      54,
      440
    );
  }

  dispose(): void {
    closeYouTubePlayerOverlay();
    if (this.unsubAuth) {
      this.unsubAuth();
      this.unsubAuth = null;
    }
    this.imageCache.clear();
    this.screenHitboxes.length = 0;
    this.stopCurrentGame();
    this.gradientCache.clear();
    this.screenTexture.dispose();
    this.targetGeo.dispose();
    this.targetRingGeo.dispose();
    this.boltGeo.dispose();
    this.boltMat.dispose();
    this.targetMat.dispose();
    this.targetLowMat.dispose();
    this.targetRingMat.dispose();
    this.hazardGeo.dispose();
    this.hazardMat.dispose();
    this.shockwaveGeo.dispose();
    this.shockwaveMat.dispose();
  }
}
