import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {VRLoungeEnvironment} from '../environment/VRLoungeEnvironment.ts';
import {SensorFusionTracker} from '../sensors/SensorFusionTracker.ts';
import {
  fetchGoogleWorkspaceFeed,
  getGoogleAuthSnapshot,
  subscribeGoogleAuth,
  WorkspaceFeedResult,
} from '../services/googleWorkspaceService.ts';
import {PlayableModeId, PlayStoreAppItem} from '../types.ts';

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
  active: boolean;
}

const LOGICAL_W = 1024;
const LOGICAL_H = 512;
const TARGET_POOL_SIZE = 14;
const BOLT_POOL_SIZE = 24;
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
  private wave = 1;
  private cinemaPlaying = true;
  private cinemaDimmed = false;

  // Google Workspace live API state
  private workspaceFeed: WorkspaceFeedResult | null = null;
  private workspaceLoading = false;
  private unsubAuth: (() => void) | null = null;

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
  private racerSpeed = 0.65;
  private racerRoadScroll = 0;
  private racerObstaclePool: RacerObstacle[] = [];
  private racerSpawnTimer = 0;
  private racerFlash = 0;

  // Reusable scratch vectors (zero GC in loop)
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();
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

    for (let i = 0; i < OBSTACLE_POOL_SIZE; i++) {
      this.racerObstaclePool.push({
        lane: 0,
        z: 0,
        isOrb: false,
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
      if (snap.signedIn && this.mode === 'google-workspace' && this.activeApp?.googleService) {
        void this.refreshWorkspaceApp();
      }
    });

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
    this.workspaceFeed = null;
    this.env.setAccentColor(app.accentColor);

    if (this.mode === 'cosmic-blaster') {
      this.env.setTheaterDim(0.7);
      this.spawnWaveTargets(5);
    } else if (this.mode === 'neon-racer') {
      this.env.setTheaterDim(0.55);
      this.racerX = 0;
      this.racerSpeed = 0.65;
      for (let i = 0; i < this.racerObstaclePool.length; i++) {
        this.racerObstaclePool[i].active = false;
      }
    } else if (this.mode === 'google-workspace') {
      this.env.setTheaterDim(0.6);
      void this.refreshWorkspaceApp();
    } else if (this.mode === 'google-suite-launch') {
      this.cinemaPlaying = true;
      this.env.setTheaterDim(0.65);
    } else if (this.mode === 'control-scheme') {
      this.env.setTheaterDim(0.35);
    } else {
      this.cinemaPlaying = true;
      this.cinemaDimmed = true;
      this.env.setTheaterDim(0.85);
    }

    this.sound.playInstallComplete();
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
    } finally {
      this.workspaceLoading = false;
      this.drawScreen();
    }
  }

  openActiveGoogleAppExternally(): void {
    if (!this.activeApp) return;
    const isAndroid = /Android/i.test(navigator.userAgent);
    const url = isAndroid
      ? `intent://#Intent;package=${this.activeApp.packageId};end`
      : this.activeApp.webUrl || this.activeApp.playStoreUrl;

    const a = document.createElement('a');
    a.href = url;
    if (!url.startsWith('intent://')) {
      a.target = '_blank';
    }
    a.rel = 'noopener noreferrer';
    a.click();
    this.sound.playClick();
  }

  exitToHub(): void {
    this.stopCurrentGame();
    this.activeApp = null;
    this.workspaceFeed = null;
    this.workspaceLoading = false;
    this.mode = 'hub';
    this.env.setTheaterDim(0);
    this.env.setAccentColor('#38bdf8');
    this.sound.playClick();
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

  triggerRacerBoost(): void {
    if (this.mode !== 'neon-racer') return;
    this.racerSpeed = Math.min(1.85, this.racerSpeed + 0.25);
    this.score += 25;
    if (this.score > this.highScore) this.highScore = this.score;
    this.sound.playPickup();
    this.onSessionChange?.(this.activeApp, this.score);
  }

  triggerLocomotionStep(running: boolean): void {
    if (this.mode === 'neon-racer' && running) {
      this.racerSpeed = Math.min(1.85, this.racerSpeed + 0.1);
      this.score += 10;
      if (this.score > this.highScore) this.highScore = this.score;
      this.onSessionChange?.(this.activeApp, this.score);
    }
  }

  triggerLocomotionJump(): void {
    if (this.mode === 'neon-racer') {
      this.score += 60;
      this.racerSpeed = Math.min(1.85, this.racerSpeed + 0.22);
      if (this.score > this.highScore) this.highScore = this.score;
      this.sound.playPickup();
      this.onSessionChange?.(this.activeApp, this.score);
    }
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

    const maxGameInterval = 1 / this.screenRedrawHz;
    const redrawInterval =
      this.mode === 'google-workspace' ||
      this.mode === 'control-scheme' ||
      this.mode === 'play-browser'
        ? Math.max(0.2, maxGameInterval)
        : maxGameInterval;
    this.drawTimer += dt;
    if (this.drawTimer >= redrawInterval) {
      this.drawTimer = 0;
      this.drawScreen();
    }
  }

  private updateCosmicBlaster(dt: number): void {
    const cam = xb.core.camera;

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
    const steerInput = THREE.MathUtils.clamp(-head.yaw * 1.4 - head.roll * 1.2, -1, 1);
    this.racerX = THREE.MathUtils.lerp(this.racerX, steerInput, Math.min(1, dt * 8));

    this.racerSpeed = Math.min(1.5, this.racerSpeed + dt * 0.015);
    this.racerRoadScroll = (this.racerRoadScroll + dt * this.racerSpeed * 2.4) % 1;
    if (this.racerFlash > 0) this.racerFlash = Math.max(0, this.racerFlash - dt * 3);

    this.racerSpawnTimer += dt;
    if (this.racerSpawnTimer >= 0.65 / this.racerSpeed) {
      this.racerSpawnTimer = 0;
      for (let i = 0; i < this.racerObstaclePool.length; i++) {
        const slot = this.racerObstaclePool[i];
        if (!slot.active) {
          slot.lane = (Math.floor(Math.random() * 3) - 1) * 0.62;
          slot.z = 0.02;
          slot.isOrb = Math.random() > 0.42;
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
          } else {
            this.score = Math.max(0, this.score - 75);
            this.racerFlash = 1;
            this.sound.playExplosion();
          }
          if (this.score > this.highScore) this.highScore = this.score;
          this.onSessionChange?.(this.activeApp, this.score);
          obs.active = false;
          continue;
        }
      }
      if (obs.z > 1.05) {
        this.score += 10;
        if (this.score > this.highScore) this.highScore = this.score;
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

  private drawScreen(): void {
    const ctx = this.ctx;
    if (!ctx) return;

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
    } else if (this.mode === 'google-workspace') {
      this.drawGoogleWorkspaceScreen(ctx, W, H);
    } else if (this.mode === 'google-suite-launch') {
      this.drawGoogleSuiteLaunchScreen(ctx, W, H);
    } else if (this.mode === 'control-scheme') {
      this.drawControlSchemeScreen(ctx, W, H);
    } else if (this.mode === 'play-browser') {
      this.drawPlayBrowserScreen(ctx, W, H);
    } else {
      this.drawCinemaDeckScreen(ctx, W, H);
    }

    this.screenTexture.needsUpdate = true;
  }

  private drawHubScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.fillStyle = this.getCachedGradient(ctx, 'hub', 0, 0, W, H, [
      [0, '#070d1f'],
      [0.5, '#0f172a'],
      [1, '#1e1b4b'],
    ]);
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.1)';
    ctx.lineWidth = 1;
    for (let y = 0; y < H; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    const tel = this.sensors.getTelemetry();
    const auth = getGoogleAuthSnapshot();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('POCKETVR PLAY HUB  //  ALL GOOGLE APPS PRE-INSTALLED', 54, 58);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText('Sensor-Controlled Android VR', 54, 128);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '23px sans-serif';
    ctx.fillText('• LOOK AT ANY BUTTON (1.0s Dwell), HEAD NOD, or TAP HEADSET to Click', 54, 188);
    ctx.fillText('• TILT HEAD LEFT/RIGHT while gazing list to Scroll 16+ Google & VR Apps', 54, 226);
    ctx.fillText('• SHAKE HEAD LEFT-RIGHT to Exit back to Hub  •  LOOK DOWN 1.2s to Recenter', 54, 264);

    ctx.fillStyle = auth.signedIn ? '#34d399' : '#fbbf24';
    ctx.font = 'bold 21px sans-serif';
    ctx.fillText(
      auth.signedIn
        ? `✓ Google Connected (${auth.userEmail}) — Launch Gmail, Drive, Calendar & Docs!`
        : '★ Sign in with Google (top-right or Play Store panel) for live Gmail, Drive & Calendar',
      54,
      325
    );

    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(54, 380, W - 108, 86);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 2;
    ctx.strokeRect(54, 380, W - 108, 86);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(
      `SENSORS: ${tel.statusLabel.toUpperCase()}  •  MOTION: ${tel.locomotion.state.toUpperCase()} (${tel.locomotion.stepCount} STEPS)`,
      78,
      415
    );
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '20px monospace';
    ctx.fillText(
      `COMPASS: ${tel.compassHeadingDeg}°   YAW: ${tel.yawDeg}°   PITCH: ${tel.pitchDeg}°   CADENCE: ${tel.locomotion.cadenceSpm} SPM`,
      78,
      448
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

  private drawGoogleWorkspaceScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const accent = this.activeApp?.accentColor || '#4285F4';
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#090f21');
    grad.addColorStop(1, '#111827');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Top Google accent stripe
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 10);

    ctx.fillStyle = accent;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      `GOOGLE APP (PRE-INSTALLED)  •  ${this.activeApp?.packageId ?? ''}`,
      48,
      54
    );

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText(this.activeApp?.title ?? 'Google Workspace', 48, 106);

    if (this.workspaceLoading) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('Syncing live Google data into VR Theater...', 48, 220);
      return;
    }

    const feed = this.workspaceFeed;
    if (!feed || feed.requiresAuth) {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
      ctx.fillRect(48, 148, W - 96, 250);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.strokeRect(48, 148, W - 96, 250);

      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText('Sign in with Google to view live content', 78, 208);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '22px sans-serif';
      ctx.fillText(
        `Use the "Sign in with Google" button (top-right or Play Store card) to`,
        78,
        262
      );
      ctx.fillText(
        `authorize read access for ${this.activeApp?.title ?? 'Google Apps'}.`,
        78,
        296
      );
      ctx.fillStyle = '#94a3b8';
      ctx.font = '20px sans-serif';
      ctx.fillText(
        'Once signed in, your real inbox, files, events, or tasks will stream here.',
        78,
        352
      );
    } else if (feed.error) {
      ctx.fillStyle = '#fb7185';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText('Workspace Notice:', 48, 175);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '21px sans-serif';
      ctx.fillText(feed.error.slice(0, 88), 48, 215);
    } else {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '20px sans-serif';
      ctx.fillText(feed.subtitle, 48, 142);

      const items = feed.items.slice(0, 5);
      if (items.length === 0) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '26px sans-serif';
        ctx.fillText('No recent items found in this Google account.', 48, 230);
      } else {
        let y = 172;
        for (const item of items) {
          ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
          ctx.fillRect(48, y, W - 96, 56);
          ctx.fillStyle = accent;
          ctx.fillRect(48, y, 6, 56);

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 20px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(item.title.slice(0, 58), 68, y + 24);

          ctx.fillStyle = '#cbd5e1';
          ctx.font = '16px sans-serif';
          ctx.fillText(item.detail.slice(0, 74), 68, y + 46);

          if (item.meta) {
            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 15px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(item.meta.slice(0, 24), W - 64, y + 26);
          }
          y += 62;
        }
      }
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '19px sans-serif';
    ctx.fillText(
      'GAZE SCREEN 1.2s TO REFRESH  •  SHAKE HEAD LEFT-RIGHT TO RETURN TO HUB',
      W / 2,
      H - 22
    );
  }

  private drawGoogleSuiteLaunchScreen(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const accent = this.activeApp?.accentColor || '#4285F4';
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#070b19');
    grad.addColorStop(1, '#172554');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 10);

    ctx.fillStyle = accent;
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`INSTALLED GOOGLE ANDROID APP  •  ${this.activeApp?.packageId ?? ''}`, 54, 62);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 52px sans-serif';
    ctx.fillText(this.activeApp?.title ?? 'Google App', 54, 132);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '24px sans-serif';
    ctx.fillText(this.activeApp?.description.slice(0, 74) ?? '', 54, 184);

    // Status Card inside Curved VR Screen
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fillRect(54, 224, W - 108, 178);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(54, 224, W - 108, 178);

    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('✓ INSTALLED ON DEVICE & READY IN VR', 84, 278);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '22px sans-serif';
    ctx.fillText(`Package: ${this.activeApp?.packageId ?? ''}`, 84, 324);
    ctx.fillText(
      `Destination: ${this.activeApp?.webUrl ?? this.activeApp?.playStoreUrl ?? ''}`,
      84,
      362
    );

    ctx.textAlign = 'center';
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(
      'GAZE SCREEN OR NOD TO OPEN REAL APP  •  SHAKE HEAD LEFT-RIGHT TO EXIT',
      W / 2,
      H - 36
    );
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
    const lookAngle = -head.yaw;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, lookAngle - Math.PI / 2 - 0.35, lookAngle - Math.PI / 2 + 0.35);
    ctx.closePath();
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

    ctx.textAlign = 'right';
    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(`HIGH ${this.highScore}`, W - 48, 60);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '21px sans-serif';
    ctx.fillText(
      'LOOK 360° TO LOCK-ON  •  NOD / TAP HEADSET TO FIRE  •  SHAKE HEAD TO EXIT',
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
      } else {
        ctx.fillStyle = '#f43f5e';
        ctx.fillRect(x - size * 0.7, y - size * 0.7, size * 1.4, size * 0.7);
      }
    }

    const px = W / 2 + this.racerX * (bottomW * 0.42);
    const py = H - 56;
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.moveTo(px, py - 34);
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
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '19px sans-serif';
    ctx.fillText(
      'TILT/TURN HEAD TO STEER  •  NOD = NITRO BOOST  •  SHAKE HEAD = EXIT',
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
    if (this.unsubAuth) {
      this.unsubAuth();
      this.unsubAuth = null;
    }
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
  }
}
