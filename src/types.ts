export type StoreCategory = 'all' | 'google' | 'vr-games' | 'arcade' | 'apps' | 'installed';

export type PlayableModeId =
  | 'cosmic-blaster'
  | 'neon-racer'
  | 'cinema-deck'
  | 'google-workspace'
  | 'google-suite-launch'
  | 'control-scheme'
  | 'play-browser';

export interface PlayBrowserItem {
  packageId: string;
  title: string;
  developer: string;
  rating: string;
  iconUrl: string;
  summary: string;
  price: string;
  playStoreUrl: string;
}

export interface PlayBrowserDetail extends PlayBrowserItem {
  downloads: string;
  description: string;
}

export type GoogleAppKind =
  | 'gmail'
  | 'drive'
  | 'calendar'
  | 'docs'
  | 'sheets'
  | 'slides'
  | 'tasks'
  | 'contacts'
  | 'youtube'
  | 'maps'
  | 'chrome'
  | 'photos'
  | 'meet'
  | 'earth'
  | 'play-games'
  | 'google-tv';

export interface PlayStoreAppItem {
  id: string;
  packageId: string;
  title: string;
  developer: string;
  category: Exclude<StoreCategory, 'all' | 'installed'>;
  rating: string;
  sizeMb: number;
  accentColor: string;
  secondaryColor: string;
  badge: string;
  description: string;
  playStoreUrl: string;
  playableMode: PlayableModeId;
  vrCompatible?: boolean;
  iconUrl?: string;
  requiresCompass?: boolean;
  googleService?: GoogleAppKind;
  webUrl?: string;
}

export type InstallStage = 'idle' | 'downloading' | 'verifying' | 'optimizing' | 'installed';

export interface AppInstallState {
  stage: InstallStage;
  progress: number; // 0..100
  installedAt?: number;
}

export type SensorTrackingMode = 'auto' | 'fusion' | 'compass-only' | 'camera-flow' | 'off';

export interface HardwareAvailability {
  webxr: boolean;
  orientationSensor: boolean; // Generic Sensor API Absolute/RelativeOrientationSensor
  compass: boolean; // Magnetometer or deviceorientation alpha/webkitCompassHeading
  gyro: boolean; // Gyroscope or DeviceMotion rotationRate
  accel: boolean; // Accelerometer / GravitySensor / accelerationIncludingGravity
  linearAccel: boolean; // LinearAccelerationSensor / devicemotion.acceleration (neck parallax)
  cameraFlow: boolean; // Optical flow from device camera
  touchDrag: boolean; // Keyboard / Touch fallback
}

export type LocomotionState = 'idle' | 'walk' | 'run' | 'jump';

export interface LocomotionTelemetry {
  enabled: boolean;
  state: LocomotionState;
  stepCount: number;
  cadenceSpm: number;
  speedMps: number;
  jumpHeightM: number;
  verticalAccelMs2: number;
}

export interface SensorTelemetry {
  active: boolean;
  permissionState: 'prompt' | 'granted' | 'denied' | 'unsupported';
  hardware: HardwareAvailability;
  activeSourcesLabel: string;
  hasCompass: boolean;
  hasGyro: boolean;
  hasAccel: boolean;
  gyroCalibrated: boolean;
  fusionAlgorithm: string;
  fusionBeta: number;
  compassHeadingDeg: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  sampleHz: number;
  cardboardStereo: boolean;
  mode: SensorTrackingMode;
  statusLabel: string;
  locomotion: LocomotionTelemetry;
}

export type HandGestureName =
  | 'none'
  | 'pinch'
  | 'point'
  | 'open-palm'
  | 'fist'
  | 'thumbs-up'
  | 'thumbs-down'
  | 'victory'
  | 'spread';

export interface GestureTelemetry {
  xrHandsActive: boolean;
  cameraHandsActive: boolean;
  cameraHandsLoading: boolean;
  skeletalOverlayVisible: boolean;
  detectedDepthMeters: number | null;
  activeGesture: HandGestureName;
  activeHand: 'left' | 'right' | 'camera' | 'none';
  confidence: number;
  headGesture: 'none' | 'nod' | 'shake';
  lastActionLabel: string;
}

export interface HeadGazeTelemetry {
  enabled: boolean;
  tapClickEnabled: boolean;
  hoveredLabel: string;
  dwellProgress: number; // 0..1
  sensorActionLabel: string;
}

export type VRQualityPreset = 'auto' | 'eco' | 'balanced' | 'high';
export type VREffectiveTier = 'eco' | 'balanced' | 'high';

export interface VREngineTelemetry {
  stereoEnabled: boolean;
  xrPresenting: boolean;
  preset: VRQualityPreset;
  effectiveTier: VREffectiveTier;
  fps: number;
  frameTimeMs: number;
  p95FrameMs: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  ipdMm: number;
  gpuCompression: string;
  texturesCount: number;
  geometriesCount: number;
  estimatedVramMb: number;
  jsHeapMb: number | null;
  lodCounts: {high: number; mid: number; low: number};
  isLowEndHardware: boolean;
  benchmarkSummary: string;
}
