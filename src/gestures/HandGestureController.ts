import {FilesetResolver, GestureRecognizer, NormalizedLandmark} from '@mediapipe/tasks-vision';
import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {AirTouchPlayground} from '../environment/AirTouchPlayground.ts';
import {SensorFusionTracker} from '../sensors/SensorFusionTracker.ts';
import {GestureTelemetry, HandGestureName, PlayableModeId} from '../types.ts';
import {computeSafeUIWorldBounds} from '../ui/uiBounds.ts';

export type VRGestureAction =
  | 'fire'
  | 'recenter'
  | 'boost'
  | 'play-pause'
  | 'dim-room'
  | 'quick-launch'
  | 'exit-game';

export interface GestureActionCallbacks {
  getGameMode: () => 'hub' | PlayableModeId;
  onAction: (action: VRGestureAction, sourceLabel: string) => void;
  onFireRay?: (origin: THREE.Vector3, direction: THREE.Vector3) => void;
  onCheckAirHit?: (worldPoint: THREE.Vector3) => boolean;
  onScreenTouch?: (hitPoint: THREE.Vector3) => void;
  onBackCamStateChange?: (active: boolean, video: HTMLVideoElement | null) => void;
}

const MEDIAPIPE_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';
const GESTURE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

const MEDIAPIPE_TO_GESTURE: Record<string, HandGestureName> = {
  Pointing_Up: 'point',
  Open_Palm: 'open-palm',
  Closed_Fist: 'fist',
  Thumb_Up: 'thumbs-up',
  Thumb_Down: 'thumbs-down',
  Victory: 'victory',
  ILoveYou: 'spread',
};

const VALID_XR_GESTURES = new Set<string>([
  'pinch',
  'point',
  'open-palm',
  'fist',
  'thumbs-up',
  'thumbs-down',
  'victory',
  'spread',
]);

// Standard 21-landmark hand bone topology
const HAND_BONE_PAIRS: ReadonlyArray<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

interface VirtualHandRig {
  group: THREE.Group;
  joints: THREE.Mesh[];
  bones: THREE.Mesh[];
  jointMat: THREE.MeshBasicMaterial;
  boneMat: THREE.MeshBasicMaterial;
  palmRing: THREE.Mesh;
  palmRingMat: THREE.MeshBasicMaterial;
  tipOrb: THREE.Mesh;
  tipOrbMat: THREE.MeshBasicMaterial;
  pinchRing: THREE.Mesh;
  pinchRingMat: THREE.MeshBasicMaterial;
  rayLine: THREE.Line;
  rayPositions: Float32Array;
  rayMat: THREE.LineBasicMaterial;
  reticle: THREE.Mesh;
  reticleMat: THREE.MeshBasicMaterial;
  visible: boolean;
  wasVisible: boolean;
  smoothedDepth: number;
  isPinching: boolean;
  prevTipZ: number;
  prevTipWorld: THREE.Vector3;
  activeScrollView: xb.UIScrollView | null;
  lastScrollY: number;
  activeSlider: xb.UISlider | null;
  grabbedCard: xb.UICard | null;
  grabOffset: THREE.Vector3;
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);

export class HandGestureController extends xb.Script {
  private readonly sensors: SensorFusionTracker;
  private readonly callbacks: GestureActionCallbacks;
  private sound: SoundEngine | null = null;
  private interactiveRoots: THREE.Object3D[] = [];
  private playground: AirTouchPlayground | null = null;
  private theaterScreen: THREE.Object3D | null = null;

  // WebXR / Simulator hand & head gesture listeners
  private xrActiveHands: Record<'left' | 'right', Map<HandGestureName, number>> = {
    left: new Map(),
    right: new Map(),
  };
  private xrHandsSeenAt = 0;

  // Back-Camera MediaPipe hand tracking + 3D virtual hands
  private cameraHandsEnabled = false;
  private cameraHandsLoading = false;
  private skeletalOverlayVisible = true;
  private userDisabledCameraHands = false;
  private autoStartGestureBound = false;
  private cameraRecognizer: GestureRecognizer | null = null;
  private cameraVideo: HTMLVideoElement | null = null;
  private cameraSampleAccum = 0;
  private lastVideoTimestampMs = 0;
  private lastCameraGesture: HandGestureName = 'none';
  private lastCameraConfidence = 0;
  private cameraFailMessage = '';
  private handsSeenAt = 0;

  // Live 2D Back-Cam Hand Monitor Texture (for on-screen visual confirmation)
  private monitorCanvas: HTMLCanvasElement;
  private monitorCtx: CanvasRenderingContext2D | null;
  private monitorTexture: THREE.CanvasTexture;

  private handRigs: VirtualHandRig[] = [];
  private readonly disposables: Array<{dispose: () => void}> = [];

  // Head gesture tracking
  private activeHeadGesture: 'none' | 'nod' | 'shake' = 'none';
  private headGestureExpiresAt = 0;

  // Action & Air-Touch cooldowns
  private lastTriggeredActionAt = new Map<string, number>();
  private lastButtonClickAt = new WeakMap<object, number>();
  private lastScreenTouchAt = 0;
  private lastHoveredUi: object | null = null;
  private lastActionLabel = 'Show hand to back camera to touch anything in AR';
  private lastActionExpiresAt = 0;

  // Zero-GC scratch math
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _camPos = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();
  private readonly _localPt = new THREE.Vector3();
  private readonly _worldPt = new THREE.Vector3();
  private readonly _midPt = new THREE.Vector3();
  private readonly _boneDir = new THREE.Vector3();
  private readonly _hitPoint = new THREE.Vector3();
  private readonly _localHit = new THREE.Vector3();
  private readonly _box = new THREE.Box3();
  private readonly _rayHitVec = new THREE.Vector3();
  private readonly _bestUiPoint = new THREE.Vector3();
  private readonly _bestUiBox = new THREE.Box3();
  private readonly _bestUiHit: {
    kind: 'button' | 'slider' | 'input' | 'scroll' | 'card';
    element: xb.UIButton | xb.UISlider | xb.UITextInput | xb.UIScrollView | xb.UICard;
    point: THREE.Vector3;
    distance: number;
    box: THREE.Box3;
    directTouch: boolean;
  } = {
    kind: 'button',
    element: null as unknown as xb.UIButton,
    point: this._bestUiPoint,
    distance: 0,
    box: this._bestUiBox,
    directTouch: false,
  };

  private readonly handleXRGestureStart = (event: {
    detail: {hand: 'left' | 'right'; name: string; confidence?: number};
  }) => {
    this.onXRGestureEvent(event.detail, true);
  };

  private readonly handleXRGestureUpdate = (event: {
    detail: {hand: 'left' | 'right'; name: string; confidence?: number};
  }) => {
    this.onXRGestureEvent(event.detail, false);
  };

  private readonly handleXRGestureEnd = (event: {
    detail: {hand: 'left' | 'right'; name: string};
  }) => {
    const hand = event.detail.hand;
    const normalized = this.normalizeGestureName(event.detail.name);
    if (normalized !== 'none') {
      this.xrActiveHands[hand]?.delete(normalized);
    }
  };

  private readonly handleHeadGesture = (event: {
    detail: {name: string; confidence: number};
  }) => {
    const {name, confidence} = event.detail;
    if (confidence < 0.45) return;
    if (name === 'nod') {
      this.activeHeadGesture = 'nod';
      this.headGestureExpiresAt = performance.now() + 1400;
      this.triggerAction('recenter', 'Head Nod -> Recenter', 900);
    } else if (name === 'shake') {
      this.activeHeadGesture = 'shake';
      this.headGestureExpiresAt = performance.now() + 1400;
      if (this.callbacks.getGameMode() !== 'hub') {
        this.triggerAction('exit-game', 'Head Shake -> Exit Game', 1200);
      }
    }
  };

  private readonly handleFirstInteractionAutoStart = () => {
    this.unbindFirstInteractionAutoStart();
    if (!this.cameraHandsEnabled && !this.cameraHandsLoading && !this.userDisabledCameraHands) {
      void this.startCameraHandGestures();
    }
  };

  constructor(
    sensors: SensorFusionTracker,
    callbacks: GestureActionCallbacks,
    sound?: SoundEngine
  ) {
    super();
    this.sensors = sensors;
    this.callbacks = callbacks;
    this.sound = sound ?? null;

    this.monitorCanvas = document.createElement('canvas');
    this.monitorCanvas.width = 256;
    this.monitorCanvas.height = 144;
    this.monitorCtx = this.monitorCanvas.getContext('2d', {alpha: false});
    this.monitorTexture = new THREE.CanvasTexture(this.monitorCanvas);
    this.monitorTexture.colorSpace = THREE.SRGBColorSpace;
    this.monitorTexture.generateMipmaps = false;
    this.monitorTexture.minFilter = THREE.LinearFilter;
    this.monitorTexture.magFilter = THREE.LinearFilter;
    this.disposables.push(this.monitorTexture);
    this.drawMonitorIdle('Starting Back Camera Hand AI...');
  }

  public getHandMonitorTexture(): THREE.CanvasTexture {
    return this.monitorTexture;
  }

  public registerInteractiveRoots(roots: THREE.Object3D[]): void {
    this.interactiveRoots = roots;
  }

  public registerPlayground(playground: AirTouchPlayground): void {
    this.playground = playground;
  }

  public registerTheaterScreen(screen: THREE.Object3D): void {
    this.theaterScreen = screen;
  }

  init(): void {
    this.buildVirtualHandRigs();

    const gestures = xb.core.gestureRecognition as unknown as
      | {
          addEventListener: (type: string, fn: (e: never) => void) => void;
          removeEventListener: (type: string, fn: (e: never) => void) => void;
        }
      | undefined;

    if (gestures) {
      gestures.addEventListener('gesturestart', this.handleXRGestureStart as (e: never) => void);
      gestures.addEventListener('gestureupdate', this.handleXRGestureUpdate as (e: never) => void);
      gestures.addEventListener('gestureend', this.handleXRGestureEnd as (e: never) => void);
    }

    const headGestures = xb.core.input?.headGestures as unknown as
      | {
          addEventListener: (type: string, fn: (e: never) => void) => void;
          removeEventListener: (type: string, fn: (e: never) => void) => void;
        }
      | undefined;

    if (headGestures) {
      headGestures.addEventListener('gesture', this.handleHeadGesture as (e: never) => void);
    }

    // Automatically start back-camera hand sensing immediately, and bind first-tap retry
    void this.startCameraHandGestures().then((started) => {
      if (!started && !this.userDisabledCameraHands) {
        this.bindFirstInteractionAutoStart();
      }
    });
  }

  onXRSessionStarted(): void {
    if (!this.cameraHandsEnabled && !this.cameraHandsLoading && !this.userDisabledCameraHands) {
      void this.startCameraHandGestures();
    }
  }

  onSimulatorStarted(): void {
    if (!this.cameraHandsEnabled && !this.cameraHandsLoading && !this.userDisabledCameraHands) {
      void this.startCameraHandGestures();
    }
  }

  private bindFirstInteractionAutoStart(): void {
    if (this.autoStartGestureBound || typeof window === 'undefined') return;
    this.autoStartGestureBound = true;
    window.addEventListener('pointerdown', this.handleFirstInteractionAutoStart, {once: true});
    window.addEventListener('touchstart', this.handleFirstInteractionAutoStart, {once: true});
  }

  private unbindFirstInteractionAutoStart(): void {
    if (!this.autoStartGestureBound || typeof window === 'undefined') return;
    this.autoStartGestureBound = false;
    window.removeEventListener('pointerdown', this.handleFirstInteractionAutoStart);
    window.removeEventListener('touchstart', this.handleFirstInteractionAutoStart);
  }

  private buildVirtualHandRigs(): void {
    const jointGeo = new THREE.SphereGeometry(0.0072, 10, 10);
    const tipGeo = new THREE.SphereGeometry(0.0125, 12, 12);
    const boneGeo = new THREE.CylinderGeometry(0.0032, 0.0032, 1.0, 8);
    const ringGeo = new THREE.TorusGeometry(0.024, 0.0022, 8, 24);
    const palmRingGeo = new THREE.TorusGeometry(0.036, 0.002, 8, 28);
    const reticleGeo = new THREE.RingGeometry(0.012, 0.021, 24);

    this.disposables.push(jointGeo, tipGeo, boneGeo, ringGeo, palmRingGeo, reticleGeo);

    for (let h = 0; h < 2; h++) {
      const group = new THREE.Group();
      group.name = `BackCam Translucent Hand Overlay ${h}`;
      group.visible = false;
      group.xb = {pointerEvents: 'none'};

      const jointMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        depthTest: false,
      });
      const boneMat = new THREE.MeshBasicMaterial({
        color: 0xbae6fd,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        depthTest: false,
      });

      const joints: THREE.Mesh[] = [];
      for (let i = 0; i < 21; i++) {
        const m = new THREE.Mesh(jointGeo, jointMat);
        m.renderOrder = 951;
        m.xb = {pointerEvents: 'none'};
        group.add(m);
        joints.push(m);
      }

      const bones: THREE.Mesh[] = [];
      for (let b = 0; b < HAND_BONE_PAIRS.length; b++) {
        const bone = new THREE.Mesh(boneGeo, boneMat);
        bone.renderOrder = 950;
        bone.xb = {pointerEvents: 'none'};
        group.add(bone);
        bones.push(bone);
      }

      const palmRingMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        depthTest: false,
      });
      const palmRing = new THREE.Mesh(palmRingGeo, palmRingMat);
      palmRing.renderOrder = 950;
      palmRing.xb = {pointerEvents: 'none'};
      group.add(palmRing);

      const tipOrbMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.56,
        depthWrite: false,
        depthTest: false,
      });
      const tipOrb = new THREE.Mesh(tipGeo, tipOrbMat);
      tipOrb.renderOrder = 952;
      tipOrb.xb = {pointerEvents: 'none'};
      group.add(tipOrb);

      const pinchRingMat = new THREE.MeshBasicMaterial({
        color: 0x6ee7b7,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        depthTest: false,
      });
      const pinchRing = new THREE.Mesh(ringGeo, pinchRingMat);
      pinchRing.renderOrder = 952;
      pinchRing.xb = {pointerEvents: 'none'};
      group.add(pinchRing);

      const rayPositions = new Float32Array(6);
      const rayGeo = new THREE.BufferGeometry();
      rayGeo.setAttribute('position', new THREE.BufferAttribute(rayPositions, 3));
      const rayMat = new THREE.LineBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
      });
      const rayLine = new THREE.Line(rayGeo, rayMat);
      rayLine.frustumCulled = false;
      rayLine.renderOrder = 949;
      rayLine.xb = {pointerEvents: 'none'};
      group.add(rayLine);

      const reticleMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const reticle = new THREE.Mesh(reticleGeo, reticleMat);
      reticle.renderOrder = 999;
      reticle.visible = false;
      reticle.xb = {pointerEvents: 'none'};
      group.add(reticle);

      this.disposables.push(
        jointMat,
        boneMat,
        palmRingMat,
        tipOrbMat,
        pinchRingMat,
        rayGeo,
        rayMat,
        reticleMat
      );
      this.add(group);

      this.handRigs.push({
        group,
        joints,
        bones,
        jointMat,
        boneMat,
        palmRing,
        palmRingMat,
        tipOrb,
        tipOrbMat,
        pinchRing,
        pinchRingMat,
        rayLine,
        rayPositions,
        rayMat,
        reticle,
        reticleMat,
        visible: false,
        wasVisible: false,
        smoothedDepth: 0.52,
        isPinching: false,
        prevTipZ: 0.52,
        prevTipWorld: new THREE.Vector3(),
        activeScrollView: null,
        lastScrollY: 0,
        activeSlider: null,
        grabbedCard: null,
        grabOffset: new THREE.Vector3(),
      });
    }
  }

  private normalizeGestureName(raw: string): HandGestureName {
    if (VALID_XR_GESTURES.has(raw)) {
      return raw as HandGestureName;
    }
    return MEDIAPIPE_TO_GESTURE[raw] ?? 'none';
  }

  private onXRGestureEvent(
    detail: {hand: 'left' | 'right'; name: string; confidence?: number},
    isStart: boolean
  ): void {
    const gesture = this.normalizeGestureName(detail.name);
    if (gesture === 'none') return;
    const confidence = detail.confidence ?? 0.85;
    this.xrHandsSeenAt = performance.now();
    this.xrActiveHands[detail.hand].set(gesture, confidence);

    if (isStart || gesture === 'point' || gesture === 'pinch') {
      this.dispatchGestureAction(gesture, `${detail.hand.toUpperCase()} XR`, isStart);
    }
  }

  async toggleCameraHandGestures(): Promise<boolean> {
    if (this.cameraHandsLoading) return this.cameraHandsEnabled;

    if (this.cameraHandsEnabled) {
      this.userDisabledCameraHands = true;
      this.stopCameraHandGestures();
      return false;
    }

    this.userDisabledCameraHands = false;
    return this.startCameraHandGestures();
  }

  async startCameraHandGestures(): Promise<boolean> {
    if (this.cameraHandsEnabled) return true;
    if (this.cameraHandsLoading) return false;

    this.cameraHandsLoading = true;
    this.cameraFailMessage = '';
    this.lastActionLabel = 'Starting Back-Cam Hand Sensing...';
    this.lastActionExpiresAt = performance.now() + 4500;
    this.drawMonitorIdle('Activating Back Camera...');

    try {
      const video = await this.sensors.acquireSharedCamera('hand-gestures');
      if (!video) {
        this.cameraFailMessage = 'Tap Back-Cam Hands to allow camera';
        this.lastActionLabel = 'Allow camera to enable Back-Cam AR Hand Touch';
        this.lastActionExpiresAt = performance.now() + 3000;
        this.drawMonitorIdle('Tap Back-Cam Hands to allow camera');
        return false;
      }

      if (!this.cameraRecognizer) {
        this.drawMonitorIdle('Loading Hand AI Model...');
        this.installMediaPipeLogFilter();
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
        const preferredDelegate: 'GPU' | 'CPU' = this.canUseWebGL2() ? 'GPU' : 'CPU';
        try {
          this.cameraRecognizer = await GestureRecognizer.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: GESTURE_MODEL_URL,
              delegate: preferredDelegate,
            },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.42,
            minHandPresenceConfidence: 0.42,
            minTrackingConfidence: 0.42,
          });
        } catch {
          if (preferredDelegate === 'CPU') {
            throw new Error('Failed to initialize Hand GestureRecognizer');
          }
          this.cameraRecognizer = await GestureRecognizer.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: GESTURE_MODEL_URL,
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.42,
            minHandPresenceConfidence: 0.42,
            minTrackingConfidence: 0.42,
          });
        }
      }

      this.cameraVideo = video;
      this.cameraHandsEnabled = true;
      this.unbindFirstInteractionAutoStart();
      this.lastActionLabel = 'VR Hand Tracking Active! Show hand to touch anything in VR';
      this.lastActionExpiresAt = performance.now() + 3500;
      this.callbacks.onBackCamStateChange?.(true, video);
      return true;
    } catch {
      this.sensors.releaseSharedCamera('hand-gestures');
      this.cameraVideo = null;
      this.cameraHandsEnabled = false;
      this.cameraFailMessage = 'Hand AI offline / camera blocked';
      this.lastActionLabel = 'Back-Cam unavailable (XR Hands & touch still active)';
      this.lastActionExpiresAt = performance.now() + 3500;
      this.drawMonitorIdle('Camera unavailable');
      this.callbacks.onBackCamStateChange?.(false, null);
      return false;
    } finally {
      this.cameraHandsLoading = false;
    }
  }

  private canUseWebGL2(): boolean {
    if (typeof document === 'undefined') return false;
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2'));
    } catch {
      return false;
    }
  }

  private installMediaPipeLogFilter(): void {
    const g = globalThis as typeof globalThis & {__pocketVrMpLogFiltered?: boolean};
    if (g.__pocketVrMpLogFiltered) return;
    g.__pocketVrMpLogFiltered = true;

    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (
        first.startsWith('INFO: Created TensorFlow Lite XNNPACK delegate for CPU') ||
        first.startsWith('INFO: ') ||
        /^I\d{4}\s/.test(first) ||
        first.includes('GL version:')
      ) {
        console.info(...args);
        return;
      }
      origError(...args);
    };
  }

  stopCameraHandGestures(): void {
    this.cameraHandsEnabled = false;
    this.lastCameraGesture = 'none';
    this.lastCameraConfidence = 0;
    this.cameraVideo = null;
    for (const rig of this.handRigs) {
      rig.visible = false;
      rig.wasVisible = false;
      rig.group.visible = false;
      rig.activeSlider = null;
      rig.activeScrollView = null;
      rig.grabbedCard = null;
    }
    this.playground?.setHoveredObject(null);
    this.sensors.releaseSharedCamera('hand-gestures');
    this.drawMonitorIdle('Back-Cam Hand Sensing Paused');
    this.callbacks.onBackCamStateChange?.(false, null);
  }

  isCameraHandGesturesEnabled(): boolean {
    return this.cameraHandsEnabled;
  }

  isCameraHandGesturesLoading(): boolean {
    return this.cameraHandsLoading;
  }

  setSkeletalOverlayVisible(visible: boolean): void {
    this.skeletalOverlayVisible = visible;
    for (const rig of this.handRigs) {
      rig.group.visible = rig.visible && visible;
    }
    this.lastActionLabel = visible
      ? 'Translucent 3D Skeletal Overlay: ON'
      : 'Translucent 3D Skeletal Overlay: OFF (Air-Touch still active)';
    this.lastActionExpiresAt = performance.now() + 2000;
  }

  isSkeletalOverlayVisible(): boolean {
    return this.skeletalOverlayVisible;
  }

  private drawMonitorIdle(message: string): void {
    const ctx = this.monitorCtx;
    if (!ctx) return;
    const W = this.monitorCanvas.width;
    const H = this.monitorCanvas.height;
    ctx.fillStyle = '#090f1e';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message, W / 2, H / 2 + 4);
    this.monitorTexture.needsUpdate = true;
  }

  private drawMonitorFrame(
    allLandmarks: NormalizedLandmark[][],
    detectedGesture: HandGestureName
  ): void {
    const ctx = this.monitorCtx;
    if (!ctx || !this.cameraVideo || this.cameraVideo.readyState < 2) return;
    const W = this.monitorCanvas.width;
    const H = this.monitorCanvas.height;

    ctx.drawImage(this.cameraVideo, 0, 0, W, H);

    // Subtle translucent skeletal overlay showing real-time 3D gesture localization
    if (this.skeletalOverlayVisible && allLandmarks && allLandmarks.length > 0) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let h = 0; h < allLandmarks.length; h++) {
        const lms = allLandmarks[h];
        const rig = this.handRigs[h];
        const pinching = rig?.isPinching ?? false;

        // Soft translucent outer glow so the real hand shows cleanly underneath
        ctx.strokeStyle = pinching
          ? 'rgba(52, 211, 153, 0.22)'
          : 'rgba(56, 189, 248, 0.16)';
        ctx.lineWidth = 4.6;
        for (const [a, b] of HAND_BONE_PAIRS) {
          const pa = lms[a];
          const pb = lms[b];
          if (!pa || !pb) continue;
          ctx.beginPath();
          ctx.moveTo(pa.x * W, pa.y * H);
          ctx.lineTo(pb.x * W, pb.y * H);
          ctx.stroke();
        }

        // Crisp slim translucent bone filaments
        ctx.strokeStyle = pinching
          ? 'rgba(110, 231, 183, 0.72)'
          : 'rgba(125, 211, 252, 0.58)';
        ctx.lineWidth = 1.6;
        for (const [a, b] of HAND_BONE_PAIRS) {
          const pa = lms[a];
          const pb = lms[b];
          if (!pa || !pb) continue;
          ctx.beginPath();
          ctx.moveTo(pa.x * W, pa.y * H);
          ctx.lineTo(pb.x * W, pb.y * H);
          ctx.stroke();
        }

        // Subtle palm depth anchor halo (centroid of 0, 5, 9, 17)
        const p0 = lms[0];
        const p5 = lms[5];
        const p9 = lms[9];
        const p17 = lms[17];
        if (p0 && p5 && p9 && p17) {
          const cx = ((p0.x + p5.x + p9.x + p17.x) * 0.25) * W;
          const cy = ((p0.y + p5.y + p9.y + p17.y) * 0.25) * H;
          ctx.strokeStyle = pinching
            ? 'rgba(110, 231, 183, 0.42)'
            : 'rgba(125, 211, 252, 0.34)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(cx, cy, 11, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Translucent landmark nodes & highlighted index fingertip cursor
        for (let i = 0; i < lms.length; i++) {
          const p = lms[i];
          const isIndexTip = i === 8;
          ctx.fillStyle = isIndexTip
            ? pinching
              ? 'rgba(110, 231, 183, 0.85)'
              : 'rgba(252, 211, 77, 0.78)'
            : 'rgba(224, 242, 254, 0.62)';
          ctx.beginPath();
          ctx.arc(p.x * W, p.y * H, isIndexTip ? 3.8 : 2.0, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();

      const depthMeters = this.handRigs.find((r) => r.visible)?.smoothedDepth;
      const depthLabel = depthMeters ? ` • Z ${depthMeters.toFixed(2)}m` : '';
      ctx.fillStyle = 'rgba(6, 12, 24, 0.52)';
      ctx.fillRect(0, H - 22, W, 22);
      ctx.fillStyle = '#6ee7b7';
      ctx.font = 'bold 11.5px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(
        `3D HAND (${allLandmarks.length})${depthLabel} • ${
          detectedGesture === 'none' ? 'TRACKING' : detectedGesture.toUpperCase()
        }`,
        8,
        H - 7
      );
    } else if (allLandmarks && allLandmarks.length > 0) {
      ctx.fillStyle = 'rgba(6, 12, 24, 0.5)';
      ctx.fillRect(0, H - 22, W, 22);
      ctx.fillStyle = '#7dd3fc';
      ctx.font = 'bold 11.5px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('HAND SENSED (SKELETON OVERLAY HIDDEN)', 8, H - 7);
    } else {
      ctx.fillStyle = 'rgba(6, 12, 24, 0.48)';
      ctx.fillRect(0, H - 22, W, 22);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11.5px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('BACK-CAM READY • SHOW HAND FOR 3D SKELETON', 8, H - 7);
    }

    this.monitorTexture.needsUpdate = true;
  }

  private sampleCameraHandGestures(dt: number): void {
    if (
      !this.cameraHandsEnabled ||
      !this.cameraRecognizer ||
      !this.cameraVideo ||
      this.cameraVideo.readyState < 2 ||
      this.cameraVideo.videoWidth === 0
    ) {
      return;
    }

    // Run ~18-20 Hz for responsive 3D hand + fingertip air-touch tracking
    this.cameraSampleAccum += dt;
    if (this.cameraSampleAccum < 0.052) return;
    this.cameraSampleAccum = 0;

    const nowMs = Math.max(this.lastVideoTimestampMs + 1, Math.round(performance.now()));
    this.lastVideoTimestampMs = nowMs;

    try {
      const result = this.cameraRecognizer.recognizeForVideo(this.cameraVideo, nowMs);
      let detectedGesture: HandGestureName = 'none';
      let bestScore = 0;

      const landmarksList = result.landmarks ?? [];
      const numHands = landmarksList.length;
      if (numHands > 0) {
        this.handsSeenAt = performance.now();
      }

      // Project each detected back-camera hand into 3D VR/AR world space and run Air-Touch
      for (let h = 0; h < this.handRigs.length; h++) {
        const rig = this.handRigs[h];
        const landmarks = landmarksList[h];
        if (!landmarks || landmarks.length < 21) {
          rig.visible = false;
          rig.wasVisible = false;
          rig.group.visible = false;
          rig.activeSlider = null;
          rig.activeScrollView = null;
          rig.grabbedCard = null;
          continue;
        }

        rig.visible = true;
        rig.group.visible = this.skeletalOverlayVisible;
        this.updateHandRigFromBackCam(rig, landmarks);
        this.processAirTouchForRig(rig, landmarks);
      }

      if (numHands === 0) {
        this.playground?.setHoveredObject(null);
      }

      if (result.gestures && result.gestures.length > 0) {
        for (let i = 0; i < result.gestures.length; i++) {
          const top = result.gestures[i]?.[0];
          if (top && top.score >= 0.55) {
            const mapped = this.normalizeGestureName(top.categoryName);
            if (mapped !== 'none' && top.score > bestScore) {
              detectedGesture = mapped;
              bestScore = top.score;
            }
          }
        }
      }

      if (this.handRigs.some((r) => r.visible && r.isPinching)) {
        detectedGesture = 'pinch';
        bestScore = Math.max(bestScore, 0.92);
      }

      this.drawMonitorFrame(landmarksList, detectedGesture);

      const isNewGesture = detectedGesture !== this.lastCameraGesture;
      this.lastCameraGesture = detectedGesture;
      this.lastCameraConfidence = bestScore;

      if (detectedGesture !== 'none') {
        this.dispatchGestureAction(detectedGesture, 'Back-Cam', isNewGesture);
      }
    } catch {
      // Ignore transient frame inference errors
    }
  }

  /**
   * Projects 21 normalized back-camera landmarks directly into the viewer's 3D AR/VR space.
   */
  private updateHandRigFromBackCam(
    rig: VirtualHandRig,
    landmarks: NormalizedLandmark[]
  ): void {
    const cam = xb.core.camera as THREE.PerspectiveCamera | undefined;
    if (!cam) return;

    cam.updateMatrixWorld();
    const fovRad = THREE.MathUtils.degToRad(cam.fov || 60);
    const halfH = Math.tan(fovRad * 0.5);
    const halfW = halfH * (cam.aspect || 1.33);

    const wrist = landmarks[0];
    const midMcp = landmarks[9];
    const palmNorm = Math.hypot(midMcp.x - wrist.x, midMcp.y - wrist.y);
    const targetDepth = THREE.MathUtils.clamp(0.095 / Math.max(palmNorm, 0.045), 0.28, 0.92);
    rig.smoothedDepth = rig.wasVisible
      ? THREE.MathUtils.lerp(rig.smoothedDepth, targetDepth, 0.35)
      : targetDepth;

    const lerpAlpha = rig.wasVisible ? 0.55 : 1.0;

    for (let i = 0; i < 21; i++) {
      const lm = landmarks[i];
      // Back camera faces outward in the exact view direction: no X mirroring
      const ndcX = lm.x * 2 - 1;
      const ndcY = 1 - lm.y * 2;
      const zDist = Math.max(0.22, rig.smoothedDepth + lm.z * 0.42);

      this._localPt.set(
        ndcX * zDist * halfW * 1.15,
        ndcY * zDist * halfH * 1.15,
        -zDist
      );
      this._worldPt.copy(this._localPt).applyMatrix4(cam.matrixWorld);

      if (lerpAlpha >= 1.0) {
        rig.joints[i].position.copy(this._worldPt);
      } else {
        rig.joints[i].position.lerp(this._worldPt, lerpAlpha);
      }
    }

    for (let b = 0; b < HAND_BONE_PAIRS.length; b++) {
      const [aIdx, bIdx] = HAND_BONE_PAIRS[b];
      const pA = rig.joints[aIdx].position;
      const pB = rig.joints[bIdx].position;
      const bone = rig.bones[b];

      this._midPt.copy(pA).add(pB).multiplyScalar(0.5);
      this._boneDir.copy(pB).sub(pA);
      const len = this._boneDir.length();
      if (len > 0.002) {
        this._boneDir.divideScalar(len);
        bone.position.copy(this._midPt);
        bone.scale.set(1, len, 1);
        bone.quaternion.setFromUnitVectors(UP_AXIS, this._boneDir);
        bone.visible = true;
      } else {
        bone.visible = false;
      }
    }

    // Place translucent palm depth halo at centroid of wrist + index/middle/pinky MCPs
    rig.palmRing.position
      .copy(rig.joints[0].position)
      .add(rig.joints[5].position)
      .add(rig.joints[9].position)
      .add(rig.joints[17].position)
      .multiplyScalar(0.25);
    rig.palmRing.lookAt(cam.position);

    const indexTip = rig.joints[8].position;
    rig.tipOrb.position.copy(indexTip);
    rig.pinchRing.position.copy(indexTip);
    rig.pinchRing.lookAt(cam.position);
    rig.wasVisible = true;
  }

  /**
   * Lets the back-camera hand touch, pinch, drag, focus, scroll, and interact with
   * ANYTHING in the app: UIButtons, UISliders, UIScrollViews, UITextInputs, UICard panels,
   * the Curved Theater Screen, AirTouchPlayground 3D objects, and Cosmic Blaster drones.
   */
  private processAirTouchForRig(
    rig: VirtualHandRig,
    landmarks: NormalizedLandmark[]
  ): void {
    const cam = xb.core.camera;
    if (!cam) return;

    const indexTipWorld = rig.joints[8].position;
    const thumbTip = landmarks[4];
    const indexTipLm = landmarks[8];
    const wrist = landmarks[0];
    const midMcp = landmarks[9];

    const palmScale = Math.max(0.05, Math.hypot(midMcp.x - wrist.x, midMcp.y - wrist.y));
    const pinchRatio =
      Math.hypot(thumbTip.x - indexTipLm.x, thumbTip.y - indexTipLm.y) / palmScale;

    const wasPinching = rig.isPinching;
    rig.isPinching = wasPinching ? pinchRatio < 0.48 : pinchRatio < 0.36;
    const pinchStarted = !wasPinching && rig.isPinching;

    if (!rig.isPinching) {
      rig.grabbedCard = null;
      rig.activeScrollView = null;
      rig.activeSlider = null;
    }

    const depthJump = rig.prevTipZ - rig.smoothedDepth;
    rig.prevTipZ = rig.smoothedDepth;
    const isPokeImpulse = depthJump > 0.045;

    // If user is currently pinching & dragging a UICard in mid-air, move it smoothly
    if (rig.grabbedCard && rig.isPinching) {
      rig.grabbedCard.position.copy(indexTipWorld).add(rig.grabOffset);
      rig.grabbedCard.lookAt(cam.position.x, rig.grabbedCard.position.y, cam.position.z);
    }

    cam.getWorldPosition(this._camPos);
    this._rayDir.copy(indexTipWorld).sub(this._camPos).normalize();
    this._raycaster.set(this._camPos, this._rayDir);

    // 1. Direct 3D fingertip touch on AirTouchPlayground floating 3D objects & Space Drones
    let touchedSomething = false;
    if (this.playground) {
      const directToy = this.playground.checkDirectFingertipTouch(indexTipWorld, 0.115);
      if (directToy) {
        touchedSomething = true;
        this.setStatusOnly(`Air-Touched ${directToy}!`);
      }
    }
    if (this.callbacks.onCheckAirHit?.(indexTipWorld)) {
      touchedSomething = true;
      this.setStatusOnly('Air-Hit Drone! +120');
    }

    // 2. Raycast against AirTouchPlayground 3D meshes
    let bestHitDist = 3.8;
    let hoveredToyMesh: THREE.Object3D | null = null;
    if (this.playground) {
      const toyHits = this._raycaster.intersectObjects(this.playground.getTouchableMeshes(), true);
      if (toyHits.length > 0 && toyHits[0].distance < bestHitDist) {
        bestHitDist = toyHits[0].distance;
        hoveredToyMesh = toyHits[0].object;
        this._hitPoint.copy(toyHits[0].point);
        if (pinchStarted || isPokeImpulse) {
          const hitName = this.playground.touchObject(
            hoveredToyMesh,
            this._hitPoint,
            this._rayDir
          );
          if (hitName) {
            touchedSomething = true;
            this.setStatusOnly(`Air-Pinched ${hitName}!`);
          }
        }
      }
      this.playground.setHoveredObject(hoveredToyMesh);
    }

    // 3. Raycast / Direct-Touch against UI controls (Button, Slider, Input, ScrollView, Card)
    const uiHit = this.findBestUIHit(indexTipWorld, bestHitDist);
    if (uiHit) {
      bestHitDist = uiHit.distance;
      this._hitPoint.copy(uiHit.point);
    }

    // 4. Raycast / Direct-Touch against Curved Theater Screen if nothing closer hit
    let screenHit: THREE.Intersection | null = null;
    if (!hoveredToyMesh && !uiHit && this.theaterScreen) {
      const hits = this._raycaster.intersectObject(this.theaterScreen, false);
      if (hits.length > 0 && hits[0].distance < bestHitDist) {
        screenHit = hits[0];
        bestHitDist = hits[0].distance;
        this._hitPoint.copy(hits[0].point);
      }
    }

    const hasHit = Boolean(hoveredToyMesh || uiHit || screenHit);
    const beamEndDist = hasHit ? bestHitDist : 1.45;
    if (!hasHit) {
      this._hitPoint.copy(this._camPos).addScaledVector(this._rayDir, beamEndDist);
    }

    rig.rayPositions[0] = indexTipWorld.x;
    rig.rayPositions[1] = indexTipWorld.y;
    rig.rayPositions[2] = indexTipWorld.z;
    rig.rayPositions[3] = this._hitPoint.x;
    rig.rayPositions[4] = this._hitPoint.y;
    rig.rayPositions[5] = this._hitPoint.z;
    rig.rayLine.geometry.attributes.position.needsUpdate = true;

    rig.reticle.visible = hasHit;
    if (hasHit) {
      rig.reticle.position.copy(this._hitPoint);
      rig.reticle.lookAt(this._camPos);
    }

    // 5. Execute touch/pinch on hit UI element or Curved Theater Screen
    if (uiHit) {
      if (this.lastHoveredUi !== uiHit.element) {
        this.lastHoveredUi = uiHit.element;
        this.sound?.playHoverTick();
      }

      if (uiHit.kind === 'button') {
        const btn = uiHit.element as xb.UIButton;
        if (!btn.disabled && (pinchStarted || uiHit.directTouch || isPokeImpulse)) {
          const lastClick = this.lastButtonClickAt.get(btn) ?? 0;
          if (performance.now() - lastClick > 450) {
            this.lastButtonClickAt.set(btn, performance.now());
            touchedSomething = true;
            btn.onClick?.();
            const label = btn.label || btn.ariaLabel || 'Button';
            this.setStatusOnly(`Air-Touched: ${label}`);
          }
        }
      } else if (uiHit.kind === 'input') {
        const input = uiHit.element as xb.UITextInput;
        if (pinchStarted || uiHit.directTouch || isPokeImpulse) {
          const lastClick = this.lastButtonClickAt.get(input) ?? 0;
          if (performance.now() - lastClick > 550) {
            this.lastButtonClickAt.set(input, performance.now());
            touchedSomething = true;
            try {
              input.focus();
            } catch {}
            this.sound?.playClick();
            this.setStatusOnly('Focused Search / Package Input');
          }
        }
      } else if (uiHit.kind === 'slider' && (rig.isPinching || uiHit.directTouch)) {
        const slider = uiHit.element as xb.UISlider;
        rig.activeSlider = slider;
        const t = THREE.MathUtils.clamp(
          (uiHit.point.x - uiHit.box.min.x) / Math.max(0.02, uiHit.box.max.x - uiHit.box.min.x),
          0,
          1
        );
        const rawVal = slider.min + t * (slider.max - slider.min);
        const stepped =
          slider.step > 0 ? Math.round(rawVal / slider.step) * slider.step : rawVal;
        const clamped = THREE.MathUtils.clamp(stepped, slider.min, slider.max);
        if (Math.abs(clamped - slider.value) >= (slider.step || 0.01)) {
          slider.value = clamped;
          slider.onInput?.(clamped);
          touchedSomething = true;
          this.setStatusOnly(`Slider: ${Math.round(clamped)}`);
        }
      } else if (uiHit.kind === 'scroll' && rig.isPinching) {
        const scrollView = uiHit.element as xb.UIScrollView;
        if (rig.activeScrollView !== scrollView) {
          rig.activeScrollView = scrollView;
          rig.lastScrollY = indexTipWorld.y;
        } else {
          const dy = indexTipWorld.y - rig.lastScrollY;
          rig.lastScrollY = indexTipWorld.y;
          scrollView.scrollTop = Math.max(0, scrollView.scrollTop + dy * 950);
          touchedSomething = true;
        }
      } else if (uiHit.kind === 'card' && pinchStarted) {
        const card = uiHit.element as xb.UICard;
        rig.grabbedCard = card;
        rig.grabOffset.copy(card.position).sub(indexTipWorld);
        touchedSomething = true;
        this.sound?.playClick();
        this.setStatusOnly(`Moving ${card.name || 'VR Panel'}`);
      }
    } else if (screenHit && (pinchStarted || isPokeImpulse)) {
      const now = performance.now();
      if (now - this.lastScreenTouchAt > 420) {
        this.lastScreenTouchAt = now;
        touchedSomething = true;
        this.callbacks.onScreenTouch?.(screenHit.point);
        this.setStatusOnly('Air-Touched Theater Screen');
      }
    } else {
      this.lastHoveredUi = null;
    }

    // 6. In Cosmic Blaster 360 VR, pinching/poking anywhere in air fires along your 3D hand ray!
    if (
      !uiHit &&
      this.callbacks.getGameMode() === 'cosmic-blaster' &&
      (pinchStarted || (this.lastCameraGesture === 'point' && isPokeImpulse))
    ) {
      this.callbacks.onFireRay?.(indexTipWorld, this._rayDir);
      touchedSomething = true;
    }

    const colorHex = touchedSomething || rig.isPinching
      ? 0x6ee7b7 // Soft translucent emerald on active pinch/touch
      : hasHit
        ? 0xfcd34d // Soft translucent amber on hover
        : 0x7dd3fc; // Subtle ice-cyan free tracking

    rig.jointMat.color.setHex(colorHex);
    rig.boneMat.color.setHex(colorHex);
    rig.palmRingMat.color.setHex(colorHex);
    rig.tipOrbMat.color.setHex(colorHex);
    rig.pinchRingMat.color.setHex(colorHex);
    rig.rayMat.color.setHex(colorHex);
    rig.reticleMat.color.setHex(colorHex);

    const activeState = rig.isPinching || touchedSomething;
    rig.jointMat.opacity = activeState ? 0.54 : hasHit ? 0.46 : 0.36;
    rig.boneMat.opacity = activeState ? 0.36 : hasHit ? 0.3 : 0.22;
    rig.palmRingMat.opacity = activeState ? 0.32 : hasHit ? 0.26 : 0.18;
    rig.tipOrbMat.opacity = activeState ? 0.68 : hasHit ? 0.58 : 0.46;
    rig.pinchRingMat.opacity = activeState ? 0.62 : 0.36;
    rig.rayMat.opacity = activeState ? 0.52 : hasHit ? 0.42 : 0.22;

    const orbScale = activeState ? 1.38 : hasHit ? 1.18 : 1.0;
    rig.tipOrb.scale.setScalar(orbScale);
    rig.pinchRing.scale.setScalar(THREE.MathUtils.clamp(pinchRatio * 1.4, 0.45, 1.5));
    rig.prevTipWorld.copy(indexTipWorld);
  }

  private findBestUIHit(
    indexTipWorld: THREE.Vector3,
    maxDist: number
  ): typeof this._bestUiHit | null {
    let found = false;
    let bestScoreDist = maxDist;

    for (let r = 0; r < this.interactiveRoots.length; r++) {
      const root = this.interactiveRoots[r];
      if (!root.visible) continue;
      root.traverse((obj) => {
        if (!obj.visible) return;
        const kind =
          obj instanceof xb.UIButton
            ? 'button'
            : obj instanceof xb.UISlider
              ? 'slider'
              : obj instanceof xb.UITextInput
                ? 'input'
                : obj instanceof xb.UIScrollView
                  ? 'scroll'
                  : obj instanceof xb.UICard
                    ? 'card'
                    : null;
        if (!kind) return;

        const pres = xb.getUIPresentationObject(obj);
        if (!computeSafeUIWorldBounds(pres, this._box)) return;

        this._box.expandByScalar(0.012);

        const tipDist = this._box.distanceToPoint(indexTipWorld);
        const directTouch = tipDist <= 0.068;

        const rayHit = this._raycaster.ray.intersectBox(this._box, this._rayHitVec);
        if (rayHit || directTouch) {
          const hitPt = rayHit
            ? this._rayHitVec
            : this._box.clampPoint(indexTipWorld, this._localHit);
          const camDist = this._camPos.distanceTo(hitPt);
          // Prefer specific controls over containing ScrollView or UICard
          const priorityBias = kind === 'card' ? 0.16 : kind === 'scroll' ? 0.08 : 0;
          if (camDist + priorityBias < bestScoreDist) {
            bestScoreDist = camDist + priorityBias;
            found = true;
            this._bestUiHit.kind = kind;
            this._bestUiHit.element = obj as
              | xb.UIButton
              | xb.UISlider
              | xb.UITextInput
              | xb.UIScrollView
              | xb.UICard;
            this._bestUiPoint.copy(hitPt);
            this._bestUiHit.distance = camDist;
            this._bestUiBox.copy(this._box);
            this._bestUiHit.directTouch = directTouch;
          }
        }
      });
    }

    return found ? this._bestUiHit : null;
  }

  private dispatchGestureAction(
    gesture: HandGestureName,
    sourceTag: string,
    isEdgeStart: boolean
  ): void {
    const mode = this.callbacks.getGameMode();

    switch (gesture) {
      case 'point':
      case 'pinch': {
        if (mode === 'cosmic-blaster') {
          const activeRig = this.handRigs.find((r) => r.visible);
          if (activeRig && this.callbacks.onFireRay) {
            this._camPos.copy(xb.core.camera.position);
            this._rayDir.copy(activeRig.joints[8].position).sub(this._camPos).normalize();
            this.triggerAction('fire', `${sourceTag} Aim Fire!`, 260);
            this.callbacks.onFireRay(activeRig.joints[8].position, this._rayDir);
          } else {
            this.triggerAction('fire', `${sourceTag} ${gesture} -> Fire`, 260);
          }
        } else if (isEdgeStart) {
          this.setStatusOnly(`${sourceTag}: ${gesture.toUpperCase()}`);
        }
        break;
      }
      case 'open-palm':
      case 'spread': {
        if (mode === 'cinema-deck') {
          this.triggerAction('play-pause', `${sourceTag} Palm -> Play/Pause`, 1100);
        } else {
          this.triggerAction('recenter', `${sourceTag} Palm -> Recenter`, 1400);
        }
        break;
      }
      case 'fist': {
        if (mode === 'neon-racer') {
          this.triggerAction('boost', `${sourceTag} Fist -> Turbo Boost`, 650);
        } else if (mode === 'cinema-deck') {
          this.triggerAction('dim-room', `${sourceTag} Fist -> Dim Room`, 1100);
        } else if (mode === 'cosmic-blaster') {
          this.triggerAction('fire', `${sourceTag} Fist -> Rapid Fire`, 240);
        } else if (isEdgeStart) {
          this.setStatusOnly(`${sourceTag}: FIST`);
        }
        break;
      }
      case 'thumbs-up': {
        if (mode === 'hub') {
          this.triggerAction('quick-launch', `${sourceTag} 👍 -> Quick Launch VR`, 1800);
        } else if (mode === 'neon-racer') {
          this.triggerAction('boost', `${sourceTag} 👍 -> Nitro Boost`, 750);
        }
        break;
      }
      case 'thumbs-down':
      case 'victory': {
        if (mode !== 'hub') {
          this.triggerAction('exit-game', `${sourceTag} -> Exit to Hub`, 1500);
        } else if (gesture === 'victory' && isEdgeStart) {
          this.triggerAction('recenter', `${sourceTag} ✌ -> Recenter`, 1200);
        }
        break;
      }
      default:
        break;
    }
  }

  private setStatusOnly(label: string): void {
    this.lastActionLabel = label;
    this.lastActionExpiresAt = performance.now() + 1800;
  }

  private triggerAction(action: VRGestureAction, label: string, cooldownMs: number): void {
    const now = performance.now();
    const last = this.lastTriggeredActionAt.get(action) ?? 0;
    if (now - last < cooldownMs) return;
    this.lastTriggeredActionAt.set(action, now);
    this.lastActionLabel = label;
    this.lastActionExpiresAt = now + 2200;
    this.callbacks.onAction(action, label);
  }

  update(): void {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.sampleCameraHandGestures(dt);

    const now = performance.now();
    if (this.activeHeadGesture !== 'none' && now > this.headGestureExpiresAt) {
      this.activeHeadGesture = 'none';
    }
    if (now > this.lastActionExpiresAt && this.cameraFailMessage === '') {
      this.lastActionLabel = this.cameraHandsEnabled
        ? 'Back-Cam AR Hands: Show hand to touch UI, Screen & 3D Orbs!'
        : 'Tap anywhere or Back-Cam Hands to sense hands & touch in AR';
    }
  }

  getTelemetry(): GestureTelemetry {
    const now = performance.now();
    const xrHandsActive = now - this.xrHandsSeenAt < 3000;
    const camHandVisible = this.cameraHandsEnabled && now - this.handsSeenAt < 1200;

    let activeGesture: HandGestureName = 'none';
    let activeHand: GestureTelemetry['activeHand'] = 'none';
    let confidence = 0;

    for (const hand of ['right', 'left'] as const) {
      for (const [name, score] of this.xrActiveHands[hand].entries()) {
        if (score >= confidence) {
          activeGesture = name;
          activeHand = hand;
          confidence = score;
        }
      }
    }

    if (activeGesture === 'none' && camHandVisible && this.lastCameraGesture !== 'none') {
      activeGesture = this.lastCameraGesture;
      activeHand = 'camera';
      confidence = this.lastCameraConfidence;
    }

    const firstVisibleRig = this.handRigs.find((r) => r.visible);
    const detectedDepthMeters = firstVisibleRig
      ? Number(firstVisibleRig.smoothedDepth.toFixed(2))
      : null;

    return {
      xrHandsActive,
      cameraHandsActive: this.cameraHandsEnabled,
      cameraHandsLoading: this.cameraHandsLoading,
      skeletalOverlayVisible: this.skeletalOverlayVisible,
      detectedDepthMeters,
      activeGesture,
      activeHand,
      confidence,
      headGesture: this.activeHeadGesture,
      lastActionLabel: this.lastActionLabel,
    };
  }

  dispose(): void {
    this.unbindFirstInteractionAutoStart();

    const gestures = xb.core.gestureRecognition as unknown as
      | {removeEventListener: (type: string, fn: (e: never) => void) => void}
      | undefined;
    if (gestures) {
      gestures.removeEventListener('gesturestart', this.handleXRGestureStart as (e: never) => void);
      gestures.removeEventListener('gestureupdate', this.handleXRGestureUpdate as (e: never) => void);
      gestures.removeEventListener('gestureend', this.handleXRGestureEnd as (e: never) => void);
    }

    const headGestures = xb.core.input?.headGestures as unknown as
      | {removeEventListener: (type: string, fn: (e: never) => void) => void}
      | undefined;
    if (headGestures) {
      headGestures.removeEventListener('gesture', this.handleHeadGesture as (e: never) => void);
    }

    this.stopCameraHandGestures();
    if (this.cameraRecognizer) {
      try {
        this.cameraRecognizer.close();
      } catch {}
      this.cameraRecognizer = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
