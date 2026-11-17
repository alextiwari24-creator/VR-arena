import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from './audio/SoundEngine.ts';
import {MobileVREngine} from './engine/MobileVREngine.ts';
import {AirTouchPlayground} from './environment/AirTouchPlayground.ts';
import {VRLoungeEnvironment} from './environment/VRLoungeEnvironment.ts';
import {VRGameTheater} from './games/VRGameTheater.ts';
import {HandGestureController, VRGestureAction} from './gestures/HandGestureController.ts';
import {HeadGazeController} from './sensors/HeadGazeController.ts';
import {SensorFusionTracker} from './sensors/SensorFusionTracker.ts';
import {
  disposeCatalogTextures,
  PLAY_STORE_CATALOG,
  setCatalogTextureResolution,
} from './store/catalog.ts';
import {VirtualPlayStore} from './store/VirtualPlayStore.ts';
import {PlayStoreAppItem} from './types.ts';
import {mountGoogleSignInOverlay} from './ui/googleSignInOverlay.ts';
import {SensorCalibrationCard} from './ui/SensorCalibrationCard.ts';
import {VirtualPlayBrowserCard} from './ui/VirtualPlayBrowserCard.ts';
import {VRLauncherCard} from './ui/VRLauncherCard.ts';

export class VRStoreHubApp extends xb.Script {
  private sound = new SoundEngine();
  private vrEngine = new MobileVREngine();
  private sensors = new SensorFusionTracker();
  private env = new VRLoungeEnvironment();
  private playground!: AirTouchPlayground;
  private theater!: VRGameTheater;
  private gestures!: HandGestureController;
  private headGaze!: HeadGazeController;
  private sensorCard!: SensorCalibrationCard;
  private storeCard!: VirtualPlayStore;
  private launcherCard!: VRLauncherCard;
  private browserCard!: VirtualPlayBrowserCard;
  private unsubscribeQuality: (() => void) | null = null;

  private hudOverlay!: xb.UIOverlay;
  private hudTitleText!: xb.UIText;
  private hudGestureText!: xb.UIText;
  private launcherHudBtn!: xb.UIButton;
  private browserHudBtn!: xb.UIButton;
  private camHandsHudBtn!: xb.UIButton;
  private arViewHudBtn!: xb.UIButton;
  private stereoHudBtn!: xb.UIButton;
  private gazeHudBtn!: xb.UIButton;
  private controlsGuideBtn!: xb.UIButton;
  private exitGameBtn!: xb.UIButton;
  private cinemaPlayBtn!: xb.UIButton;
  private cinemaDimBtn!: xb.UIButton;
  private togglePanelsBtn!: xb.UIButton;
  private muteBtn!: xb.UIButton;
  private panelsVisible = true;
  private launcherVisible = true;
  private browserVisible = true;
  private screenScale = 1.0;
  private userPrefersAR = false;
  private unmountGoogleOverlay: (() => void) | null = null;

  private readonly _screenRayDir = new THREE.Vector3();
  private readonly _screenRayOrigin = new THREE.Vector3();

  private unsubscribeTrim: (() => void) | null = null;

  init(): void {
    xb.ui.theme = 'grayGlass';

    this.add(this.vrEngine);
    this.add(this.sensors);
    this.add(this.env);

    this.playground = new AirTouchPlayground(this.sound);
    this.add(this.playground);

    this.theater = new VRGameTheater(
      this.env,
      this.sensors,
      this.sound,
      (app, score) => this.handleSessionChange(app, score)
    );
    this.add(this.theater);

    this.unsubscribeQuality = this.vrEngine.onQualityChange((tier, profile) => {
      setCatalogTextureResolution(tier === 'high' ? 256 : 128);
      this.env.setQualityProfile(profile, tier);
      this.playground.setLodBias(profile.lodBias);
      this.theater.setQualityProfile(
        profile.screenRedrawHz,
        profile.maxBlasterTargets,
        profile.screenResolutionScale
      );
    });
    this.unsubscribeTrim = this.vrEngine.registerMemoryTrimmer(() => {
      this.env.releaseDormantResources();
      return 0;
    });

    this.gestures = new HandGestureController(
      this.sensors,
      {
        getGameMode: () => this.theater.getMode(),
        onAction: (action, sourceLabel) => this.handleGestureAction(action, sourceLabel),
        onFireRay: (origin, dir) => this.theater.fireAlongRay(origin, dir),
        onCheckAirHit: (pt) => this.theater.checkAirTouchHit(pt),
        onScreenTouch: (hitPoint) => this.handleTheaterScreenTouch(hitPoint),
        onBackCamStateChange: (active, video) => this.handleBackCamStateChange(active, video),
      },
      this.sound
    );
    this.add(this.gestures);

    this.headGaze = new HeadGazeController(this.sensors, this.sound, {
      getGameMode: () => this.theater.getMode(),
      onScreenAction: (hitPoint) => this.handleTheaterScreenTouch(hitPoint),
      onFireFromGaze: (origin, dir) => this.theater.fireAlongRay(origin, dir),
      onBoost: () => this.theater.triggerRacerBoost(),
      onExitToHub: () => this.theater.exitToHub(),
      onJump: () => this.theater.triggerLocomotionJump(),
      onStep: (running) => this.theater.triggerLocomotionStep(running),
      onStatusUpdate: (label) => {
        if (this.hudGestureText) this.hudGestureText.text = label;
      },
    });
    this.add(this.headGaze);

    // Left Card: All-Hardware 9-DoF Head Tracking + Walk/Run/Jump + VR Engine Telemetry
    this.sensorCard = new SensorCalibrationCard(
      this.sensors,
      this.sound,
      this.gestures,
      this.headGaze,
      this.vrEngine
    );
    this.sensorCard.position.set(-0.98, 1.34, -0.96);
    this.sensorCard.rotation.y = 0.56;
    this.add(this.sensorCard);

    // Right Card: Dynamic Google Play VR Storefront (Live Search, Categories, Download, Install)
    this.storeCard = new VirtualPlayStore(
      this.theater,
      this.sound,
      (app) => this.launchAppDirectlyIntoVR(app)
    );
    this.storeCard.position.set(0.98, 1.34, -0.96);
    this.storeCard.rotation.y = -0.56;
    this.add(this.storeCard);

    // Center Card: VR App Launcher (Installed VR Icons, Direct VR Launch & Uninstall Manager)
    this.launcherCard = new VRLauncherCard(
      this.storeCard,
      this.sound,
      (app) => this.launchAppDirectlyIntoVR(app)
    );
    this.launcherCard.position.set(0, 1.3, -1.2);
    this.launcherCard.rotation.x = -0.04;
    this.add(this.launcherCard);

    // Right Wing Card: Live Google Play Store Web Browser inside VR
    this.browserCard = new VirtualPlayBrowserCard(this.storeCard, this.theater, this.sound);
    this.browserCard.position.set(1.58, 1.3, -0.16);
    this.browserCard.rotation.y = -1.28;
    this.add(this.browserCard);

    // Bottom View-Space Session HUD Overlay
    this.hudOverlay = this.createHudOverlay();
    this.add(this.hudOverlay);

    // Register UI cards, Launcher, Storefront, Browser, HUD, Theater Screen, and 3D toys
    const roots = [
      this.launcherCard,
      this.sensorCard,
      this.storeCard,
      this.browserCard,
      this.hudOverlay,
    ];
    this.gestures.registerInteractiveRoots(roots);
    this.gestures.registerPlayground(this.playground);
    this.headGaze.registerInteractiveRoots(roots);
    this.headGaze.registerPlayground(this.playground);
    this.headGaze.registerDroneContainer(this.theater.getGameGroup());
    if (this.env.screenMesh) {
      this.gestures.registerTheaterScreen(this.env.screenMesh);
      this.headGaze.registerTheaterScreen(this.env.screenMesh);
    }

    this.unmountGoogleOverlay = mountGoogleSignInOverlay();
  }

  /**
   * Ensures VR stereoscopic presentation is active before launching any app into VR Mode.
   */
  private launchAppDirectlyIntoVR(app: PlayStoreAppItem): void {
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    const isXrPresenting = Boolean(renderer?.xr?.isPresenting);
    if (!isXrPresenting && !this.vrEngine.isStereoEnabled()) {
      this.vrEngine.setStereoEnabled(true);
      this.sensors.setCardboardStereo(true);
      this.stereoHudBtn.label = 'VR SBS: ON';
    }
    this.theater.launchApp(app);
  }

  private handleBackCamStateChange(active: boolean, video: HTMLVideoElement | null): void {
    if (active && video && this.userPrefersAR) {
      this.env.setARPassthrough(true, video);
      this.arViewHudBtn.label = 'AR Cam: ON';
    } else {
      this.env.setARPassthrough(false, null);
      this.arViewHudBtn.label = 'VR World';
    }
  }

  private handleTheaterScreenTouch(hitPoint: THREE.Vector3): void {
    const mode = this.theater.getMode();
    if (mode === 'hub' || mode === 'control-scheme') {
      this.sound.playClick();
      const firstGame =
        PLAY_STORE_CATALOG.find((a) => a.id === 'cosmic-blaster') ?? PLAY_STORE_CATALOG[0];
      this.theater.launchApp(firstGame);
    } else if (mode === 'google-workspace') {
      this.sound.playClick();
      void this.theater.refreshWorkspaceApp();
    } else if (mode === 'google-suite-launch') {
      this.theater.openActiveGoogleAppExternally();
    } else if (mode === 'play-browser') {
      this.sound.playClick();
      this.browserVisible = true;
      this.browserCard.visible = true;
      this.browserHudBtn.label = 'Browser: ON';
    } else if (mode === 'cinema-deck') {
      this.theater.toggleCinemaPlay();
    } else if (mode === 'neon-racer') {
      this.theater.triggerRacerBoost();
    } else if (mode === 'cosmic-blaster' && xb.core.camera) {
      xb.core.camera.getWorldPosition(this._screenRayOrigin);
      this._screenRayDir.copy(hitPoint).sub(this._screenRayOrigin).normalize();
      this.theater.fireAlongRay(this._screenRayOrigin, this._screenRayDir);
    }
  }

  private handleGestureAction(action: VRGestureAction, sourceLabel: string): void {
    this.hudGestureText.text = sourceLabel;
    switch (action) {
      case 'fire':
        if (!this.gestures.isCameraHandGesturesEnabled()) {
          this.theater.fireFromCamera();
        }
        break;
      case 'recenter':
        this.sound.playClick();
        this.sensors.recenter();
        break;
      case 'boost':
        this.theater.triggerRacerBoost();
        break;
      case 'play-pause':
        this.theater.toggleCinemaPlay();
        break;
      case 'dim-room':
        this.theater.toggleCinemaDim();
        break;
      case 'quick-launch': {
        const firstGame =
          PLAY_STORE_CATALOG.find((a) => a.id === 'cosmic-blaster') ?? PLAY_STORE_CATALOG[0];
        this.theater.launchApp(firstGame);
        break;
      }
      case 'exit-game':
        this.theater.exitToHub();
        break;
    }
  }

  private createHudOverlay(): xb.UIOverlay {
    this.hudTitleText = new xb.UIText({
      text: 'VR Hub • 16 Google Apps Ready • Gaze 1s / Nod = Click',
      style: {fontSize: 13.5, fontWeight: 'bold', flexGrow: 1},
    });
    this.hudGestureText = new xb.UIText({
      text: 'Sensor Gaze: ON',
      style: {fontSize: 12, color: '#a78bfa', textAlign: 'right'},
    });

    this.gazeHudBtn = new xb.UIButton({
      label: 'Gaze: ON',
      icon: 'gps_fixed',
      onClick: () => {
        this.sound.playClick();
        const next = !this.headGaze.isEnabled();
        this.headGaze.setEnabled(next);
        this.gazeHudBtn.label = next ? 'Gaze: ON' : 'Gaze: OFF';
      },
    });

    this.launcherHudBtn = new xb.UIButton({
      label: 'Launcher: ON',
      icon: 'apps',
      onClick: () => {
        this.sound.playClick();
        this.launcherVisible = !this.launcherVisible;
        this.launcherCard.visible = this.launcherVisible && this.panelsVisible;
        if (this.launcherVisible && !this.panelsVisible) {
          this.setPanelsVisible(true);
        }
        this.launcherHudBtn.label = this.launcherVisible ? 'Launcher: ON' : 'Launcher: OFF';
      },
    });

    this.browserHudBtn = new xb.UIButton({
      label: 'Browser: ON',
      icon: 'public',
      onClick: () => {
        this.sound.playClick();
        this.browserVisible = !this.browserVisible;
        this.browserCard.visible = this.browserVisible && this.panelsVisible;
        if (this.browserVisible && !this.panelsVisible) {
          this.setPanelsVisible(true);
        }
        this.browserHudBtn.label = this.browserVisible ? 'Browser: ON' : 'Browser: OFF';
      },
    });

    this.controlsGuideBtn = new xb.UIButton({
      label: 'Controls',
      icon: 'help_outline',
      onClick: () => {
        if (this.theater.getMode() === 'control-scheme') {
          this.theater.exitToHub();
        } else {
          this.theater.showControlSchemeGuide();
        }
      },
    });

    this.camHandsHudBtn = new xb.UIButton({
      label: 'Back-Cam Hands',
      icon: 'back_hand',
      onClick: () => {
        this.sound.playClick();
        this.camHandsHudBtn.disabled = true;
        this.camHandsHudBtn.label = 'Loading Hands...';
        void this.gestures.toggleCameraHandGestures().then((active) => {
          this.camHandsHudBtn.disabled = false;
          this.camHandsHudBtn.label = active ? 'Back-Cam: ON' : 'Back-Cam: OFF';
        });
      },
    });

    this.arViewHudBtn = new xb.UIButton({
      label: 'VR World',
      icon: 'public',
      onClick: () => {
        this.sound.playClick();
        const nextAR = !this.env.isARPassthrough();
        this.userPrefersAR = nextAR;
        if (nextAR) {
          const video = this.sensors.getCameraVideo();
          if (video) {
            this.env.setARPassthrough(true, video);
            this.arViewHudBtn.label = 'AR Cam: ON';
          } else {
            void this.gestures.startCameraHandGestures();
          }
        } else {
          this.env.setARPassthrough(false, null);
          this.arViewHudBtn.label = 'VR World';
        }
      },
    });

    this.stereoHudBtn = new xb.UIButton({
      label: 'VR SBS: OFF',
      icon: 'vrpano',
      onClick: () => {
        this.sound.playClick();
        const next = !this.vrEngine.isStereoEnabled();
        this.vrEngine.setStereoEnabled(next);
        this.sensors.setCardboardStereo(next);
        this.stereoHudBtn.label = next ? 'VR SBS: ON' : 'VR SBS: OFF';
      },
    });

    this.exitGameBtn = new xb.UIButton({
      label: 'Exit App',
      icon: 'stop_circle',
      visible: false,
      onClick: () => {
        this.theater.exitToHub();
      },
    });

    this.cinemaPlayBtn = new xb.UIButton({
      label: 'Play/Pause',
      icon: 'play_pause',
      visible: false,
      onClick: () => {
        this.theater.toggleCinemaPlay();
      },
    });

    this.cinemaDimBtn = new xb.UIButton({
      label: 'Dim Room',
      icon: 'brightness_4',
      visible: false,
      onClick: () => {
        this.theater.toggleCinemaDim();
      },
    });

    this.togglePanelsBtn = new xb.UIButton({
      label: 'Hide Panels',
      icon: 'visibility_off',
      onClick: () => {
        this.sound.playClick();
        this.setPanelsVisible(!this.panelsVisible);
      },
    });

    const scaleBtn = new xb.UIButton({
      label: 'Screen 1.0x',
      icon: 'aspect_ratio',
      onClick: () => {
        this.sound.playClick();
        const scales = [0.85, 1.0, 1.2, 1.35];
        const idx = scales.indexOf(this.screenScale);
        this.screenScale = scales[(idx + 1) % scales.length];
        this.env.setTheaterScale(this.screenScale);
        scaleBtn.label = `Screen ${this.screenScale.toFixed(2)}x`;
      },
    });

    const recenterBtn = new xb.UIButton({
      label: 'Recenter',
      icon: 'explore',
      onClick: () => {
        this.sound.playClick();
        this.sensors.recenter();
      },
    });

    this.muteBtn = new xb.UIButton({
      label: 'Audio',
      icon: 'volume_up',
      onClick: () => {
        const nextMuted = !this.sound.isMuted();
        this.sound.setMuted(nextMuted);
        this.muteBtn.icon = nextMuted ? 'volume_off' : 'volume_up';
        if (!nextMuted) this.sound.playClick();
      },
    });

    const overlay = new xb.UIOverlay({
      style: {
        width: 920,
        position: 'absolute',
        left: '50%',
        bottom: 18,
        transform: {translateX: '-50%'},
        flexDirection: 'column',
        gap: 8,
        padding: 12,
      },
      children: [
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          },
          children: [new xb.UIExitButton(), this.hudTitleText, this.hudGestureText],
        }),
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
          },
          children: [
            this.launcherHudBtn,
            this.browserHudBtn,
            this.gazeHudBtn,
            this.controlsGuideBtn,
            this.camHandsHudBtn,
            this.arViewHudBtn,
            this.stereoHudBtn,
            this.cinemaPlayBtn,
            this.cinemaDimBtn,
            this.exitGameBtn,
            recenterBtn,
            scaleBtn,
            this.togglePanelsBtn,
            this.muteBtn,
          ],
        }),
      ],
    });
    overlay.name = 'PocketVR Hub HUD';
    return overlay;
  }

  private setPanelsVisible(visible: boolean): void {
    this.panelsVisible = visible;
    this.launcherCard.visible = visible && this.launcherVisible;
    this.sensorCard.visible = visible;
    this.storeCard.visible = visible;
    this.browserCard.visible = visible && this.browserVisible;
    this.togglePanelsBtn.label = visible ? 'Hide Panels' : 'Show Panels';
    this.togglePanelsBtn.icon = visible ? 'visibility_off' : 'visibility';
  }

  private handleSessionChange(app: PlayStoreAppItem | null, score: number): void {
    if (!app) {
      this.hudTitleText.text = 'VR Hub • 16 Google Apps Ready • Gaze 1s / Nod = Click';
      this.exitGameBtn.visible = false;
      this.cinemaPlayBtn.visible = false;
      this.cinemaDimBtn.visible = false;
      this.setPanelsVisible(true);
      return;
    }

    this.exitGameBtn.visible = true;
    const isCinema = app.playableMode === 'cinema-deck';
    this.cinemaPlayBtn.visible = isCinema;
    this.cinemaDimBtn.visible = isCinema;

    if (app.playableMode === 'cosmic-blaster') {
      this.hudTitleText.text = `${app.title} • Score: ${score}`;
      this.setPanelsVisible(false);
    } else if (app.playableMode === 'neon-racer') {
      this.hudTitleText.text = `${app.title} • Score: ${score}`;
    } else {
      this.hudTitleText.text = `Active in VR: ${app.title}`;
    }
  }

  update(): void {
    const tel = this.sensors.getTelemetry();
    this.env.setCompassRingRotation(tel.compassHeadingDeg);

    const gTel = this.gestures.getTelemetry();
    if (!gTel.cameraHandsLoading) {
      const targetHudLabel = gTel.cameraHandsActive ? 'Back-Cam: ON' : 'Back-Cam: OFF';
      if (this.camHandsHudBtn.label !== targetHudLabel) {
        this.camHandsHudBtn.label = targetHudLabel;
      }
    }
    const targetArLabel = this.env.isARPassthrough() ? 'AR Cam: ON' : 'VR World';
    if (this.arViewHudBtn.label !== targetArLabel) {
      this.arViewHudBtn.label = targetArLabel;
    }
    const targetStereoLabel = this.vrEngine.isStereoEnabled() ? 'VR SBS: ON' : 'VR SBS: OFF';
    if (this.stereoHudBtn.label !== targetStereoLabel) {
      this.stereoHudBtn.label = targetStereoLabel;
    }

    const gazeTel = this.headGaze.getTelemetry();
    const targetGazeLabel = gazeTel.enabled ? 'Gaze: ON' : 'Gaze: OFF';
    if (this.gazeHudBtn.label !== targetGazeLabel) {
      this.gazeHudBtn.label = targetGazeLabel;
    }

    if (gazeTel.enabled && gazeTel.hoveredLabel) {
      const pct = Math.round(gazeTel.dwellProgress * 100);
      this.hudGestureText.text =
        pct > 5 ? `Gaze ${pct}%: ${gazeTel.hoveredLabel}` : `Gazing: ${gazeTel.hoveredLabel}`;
    } else if (gTel.activeGesture !== 'none' || gTel.cameraHandsActive) {
      this.hudGestureText.text = gTel.lastActionLabel;
    } else if (gazeTel.enabled) {
      this.hudGestureText.text = gazeTel.sensorActionLabel;
    }
  }

  dispose(): void {
    if (this.unsubscribeQuality) {
      this.unsubscribeQuality();
      this.unsubscribeQuality = null;
    }
    if (this.unsubscribeTrim) {
      this.unsubscribeTrim();
      this.unsubscribeTrim = null;
    }
    if (this.unmountGoogleOverlay) {
      this.unmountGoogleOverlay();
      this.unmountGoogleOverlay = null;
    }
    disposeCatalogTextures();
    this.sound.dispose();
  }
}
