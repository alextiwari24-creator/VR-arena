import * as THREE from 'three';
import * as xb from 'xrblocks';
import {HardwareAvailability, SensorTelemetry, SensorTrackingMode} from '../types.ts';
import {MadgwickAHRS} from './MadgwickFilter.ts';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const SENSOR_STALE_MS = 1500;

interface GenericSensorLike extends EventTarget {
  start(): void;
  stop(): void;
  activated?: boolean;
}

interface OrientationSensorLike extends GenericSensorLike {
  quaternion?: [number, number, number, number];
}

interface VectorSensorLike extends GenericSensorLike {
  x?: number;
  y?: number;
  z?: number;
}

type SensorCtor<T extends GenericSensorLike> = new (options?: {
  frequency?: number;
  referenceFrame?: 'device' | 'screen';
}) => T;

/**
 * Pro-Grade Adaptive All-Hardware Head Tracker.
 *
 * Uses every orientation, inertial, magnetic, linear-acceleration, optical, and XR source
 * available on the device, falling back seamlessly per-axis when any hardware chip is missing:
 * - WebXR native 6DoF pose (when presenting)
 * - W3C Generic Sensor API (`AbsoluteOrientationSensor`, `RelativeOrientationSensor`,
 *   `GravitySensor`, `LinearAccelerationSensor`, `Gyroscope`, `Accelerometer`, `Magnetometer`)
 * - Legacy `deviceorientationabsolute`, `deviceorientation`, `devicemotion`
 * - Quaternion complementary fusion with auto stationary gyro-bias calibration & magnetic spike rejection
 * - Subtle neck-model micro-parallax from LinearAcceleration
 * - Multi-patch subpixel Camera Optical-Flow visual tracking (shared video stream)
 * - Arrow-key + Cardboard Side-by-Side (SBS) stereo split rendering
 */
export class SensorFusionTracker extends xb.Script {
  private mode: SensorTrackingMode = 'auto';
  private permissionState: SensorTelemetry['permissionState'] = 'prompt';

  // Quaternion & Euler fused state (gimbal-lock free)
  private readonly _headQuat = new THREE.Quaternion();
  private yawRad = 0;
  private pitchRad = 0;
  private rollRad = 0;
  private yawZeroOffsetRad = 0;
  private rawCompassDeg = 0;
  private lastAcceptedCompassRad = 0;
  private hasCompassSeed = false;

  // Advanced 9-DoF Madgwick quaternion fusion + One-Euro adaptive smoother
  private readonly madgwick = new MadgwickAHRS();
  private readonly _rawAccelVec = new THREE.Vector3(0, 9.81, 0);
  private readonly _rawMagVec = new THREE.Vector3();
  private lastAccelMag = 9.81;
  private hasRawAccel = false;
  private hasRawMag = false;
  private fusionAlgorithmLabel = 'Madgwick 9-DoF + 1€';

  // Automatic gyro bias estimator (kills drift on cheap MEMS sensors)
  private gyroBiasX = 0;
  private gyroBiasY = 0;
  private gyroBiasZ = 0;
  private stationaryAccumSec = 0;
  private gyroCalibrated = false;

  // Neck-model micro-parallax + anatomical cervical neck-pivot translation
  private readonly _neckOffset = new THREE.Vector3();
  private readonly _neckVel = new THREE.Vector3();
  private readonly _neckPivotVec = new THREE.Vector3(0, 0.11, -0.075);
  private readonly _neckPivotRest = new THREE.Vector3(0, 0.11, -0.075);
  private readonly _baseCamPos = new THREE.Vector3();
  private hasBaseCamPos = false;

  // Walk / Run / Jump / Crouch real-time IMU + Optical-Flow locomotion engine
  private locomotionEnabled = true;
  private locomotionState: 'idle' | 'walk' | 'run' | 'jump' | 'crouch' = 'idle';
  private readonly _gravLp = new THREE.Vector3(0, 9.81, 0);
  private hasGravLp = false;
  private readonly _locoOffsetXZ = new THREE.Vector3();
  private readonly _camFwdXZ = new THREE.Vector3();
  private jumpHeightY = 0;
  private jumpVelY = 0;
  private isAirborne = false;
  private freeFallMs = 0;
  private pushOffPrimedUntil = 0;
  private jumpCooldownUntil = 0;
  private smoothedVertAcc = 0;
  private latestVertAcc = 0;
  private stepPeakArmed = false;
  private stepPeakMax = 0;
  private lastStepAt = 0;
  private lastImuStepAt = 0;
  private stepCount = 0;
  private stepTimestamps: number[] = [];
  private cadenceSpm = 0;
  private locoSpeed = 0;
  private locoHoldUntil = 0;
  private walkBobPhase = 0;
  private pendingStepKind: 'none' | 'walk' | 'run' = 'none';
  private pendingJumpEvent = false;
  private pendingLandEvent = false;
  private lastMotionStepSampleAt = 0;

  // Sensor tuning
  private smoothing = 0.34;
  private sensitivity = 1.0;

  // Sample rate estimation
  private sampleCount = 0;
  private sampleTimer = 0;
  private sampleHz = 0;

  // Per-hardware freshness timestamps
  private lastSeen = {
    absQuat: 0,
    relQuat: 0,
    compass: 0,
    gyro: 0,
    accel: 0,
    gravity: 0,
    linearAccel: 0,
    orientEuler: 0,
    cameraFlow: 0,
    keyboard: 0,
  };

  // Latest readings & 3D gravity/magnetic vectors for tilt-compensated heading
  private readonly _hwQuat = new THREE.Quaternion();
  private readonly _hwEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _screenQuat = new THREE.Quaternion();
  private readonly _worldTransformQuat = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  private readonly _q0 = new THREE.Quaternion();
  private readonly _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  private readonly _devOrientEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _devOrientQuat = new THREE.Quaternion();
  private readonly _upVec = new THREE.Vector3(0, 1, 0);
  private readonly _magVec = new THREE.Vector3();
  private readonly _eastVec = new THREE.Vector3();
  private readonly _northVec = new THREE.Vector3();
  private readonly _camFwdVec = new THREE.Vector3(0, 0, -1);

  private latestCompassYawRad = 0;
  private latestGravityPitch = 0;
  private latestGravityRoll = 0;
  private latestOrientPitch = 0;
  private latestOrientRoll = 0;
  private hasGravityVec = false;
  private firstSeenAlpha: number | null = null;
  private alphaHasVaried = false;
  private firstSeenRelYaw: number | null = null;
  private relYawHasVaried = false;
  private autoFlowEnabled = false;

  private lastGyroTime = 0;
  private lastMotionTime = 0;
  private genericSensors: GenericSensorLike[] = [];
  private genericSensorsStarted = false;

  // Shared device camera stream (used by Optical Flow and/or Camera Hand Gestures)
  private cameraStream: MediaStream | null = null;
  private cameraVideo: HTMLVideoElement | null = null;
  private cameraConsumers = new Set<string>();
  private cameraFlowEnabled = false;
  private cameraAutoStartPromise: Promise<boolean> | null = null;
  private userDisabledCameraFlow = false;
  private switchedToCameraFlowByToggle = false;
  private modeBeforeCameraFlow: SensorTrackingMode = 'auto';
  private flowCanvas: HTMLCanvasElement | null = null;
  private flowCtx: CanvasRenderingContext2D | null = null;
  private readonly flowW = 96;
  private readonly flowH = 72;
  private readonly coarseW = 48;
  private readonly coarseH = 36;
  private readonly currLuma = new Uint8Array(96 * 72);
  private readonly prevLuma = new Uint8Array(96 * 72);
  private readonly coarseCurr = new Uint8Array(48 * 36);
  private readonly coarsePrev = new Uint8Array(48 * 36);
  private readonly patchDx = new Float32Array(9);
  private readonly patchDy = new Float32Array(9);
  private readonly patchContrast = new Float32Array(9);
  private readonly sortScratch = new Float32Array(9);
  private hasPrevLuma = false;
  private flowSampleAccum = 0;
  private visVertLp = 0;
  private visVySmooth = 0;
  private visRawVy1 = 0;
  private visRawVy2 = 0;
  private visPeakPos = 0;
  private visPeakNeg = 0;
  private visJumpPrimeFrames = 0;
  private visJumpPrimedUntil = 0;
  private visDivergenceLp = 0;
  private visForwardHoldFrames = 0;
  private visBackwardHoldFrames = 0;
  private visCoherentForward = false;
  private visCoherentBackward = false;
  private visMoveSign: 1 | -1 = 1;
  private crouchOffsetY = 0;
  private crouchTargetY = 0;
  private crouchUntil = 0;

  // Screen wake lock
  private wakeLockSentinel: {release: () => Promise<void>} | null = null;

  // Keyboard & pointer-drag fallback
  private pressedKeys = new Set<string>();
  private isDraggingLook = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private dragPitchBias = 0;

  // Stereoscopic state mirror (rendered by MobileVREngine)
  private cardboardStereo = false;

  // Desktop preview head-sweep test mode
  private demoSweepActive = false;
  private demoSweepPhase = 0;

  // Sensor-only VR control gestures (nod, shake, headset side-tap)
  private prevCamYaw = 0;
  private prevCamPitch = 0;
  private hasPrevCamAngles = false;
  private nodDownAt = 0;
  private shakeSwingSign = 0;
  private shakeSwingAt = 0;
  private pendingNod = false;
  private pendingShake = false;
  private pendingTap = false;
  private lastNodTriggeredAt = 0;
  private lastShakeTriggeredAt = 0;
  private lastTapTriggeredAt = 0;
  private latestLinearAccelMag = 0;

  // Reusable scratch objects (zero GC in update loop)
  private readonly _targetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _targetQuat = new THREE.Quaternion();
  private readonly _smoothedTargetQuat = new THREE.Quaternion();
  private readonly _zAxis = new THREE.Vector3(0, 0, 1);

  private readonly onDeviceOrientation = (e: DeviceOrientationEvent) => {
    this.handleOrientation(e);
  };

  private readonly onDeviceMotion = (e: DeviceMotionEvent) => {
    this.handleMotion(e);
  };

  private readonly handleWindowKeyDown = (e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      k === 'a' ||
      k === 'd' ||
      k === 'w' ||
      k === 's'
    ) {
      this.pressedKeys.add(e.key);
    } else if (e.code === 'Space') {
      this.triggerJump();
    } else if (k === 'r') {
      this.triggerManualStep(e.shiftKey);
    }
  };

  private readonly handleWindowKeyUp = (e: KeyboardEvent) => {
    this.pressedKeys.delete(e.key);
  };

  private readonly handleCanvasPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const target = e.target as HTMLElement | null;
    if (target && target.tagName !== 'CANVAS') return;
    this.isDraggingLook = true;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
  };

  private readonly handleCanvasPointerMove = (e: PointerEvent) => {
    if (!this.isDraggingLook) return;
    const dx = e.clientX - this.lastPointerX;
    const dy = e.clientY - this.lastPointerY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    if (Math.hypot(dx, dy) < 0.5) return;
    // Offset yawZeroOffsetRad so drag look works cleanly alongside live sensors
    this.yawZeroOffsetRad -= dx * 0.0042;
    this.dragPitchBias = THREE.MathUtils.clamp(this.dragPitchBias + dy * 0.0036, -1.25, 1.25);
    this.lastSeen.keyboard = performance.now();
  };

  private readonly handleCanvasPointerUp = () => {
    this.isDraggingLook = false;
  };

  private readonly handleFirstInteractionCam = () => {
    void this.ensureCameraFlowStarted();
  };

  init(): void {
    this.attachPassiveListeners();
    this.tryStartGenericSensors();
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.handleFirstInteractionCam, {passive: true});
      window.addEventListener('touchstart', this.handleFirstInteractionCam, {passive: true});
    }
    void this.ensureCameraFlowStarted();
  }

  private removeFirstInteractionCamListeners(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', this.handleFirstInteractionCam);
    window.removeEventListener('touchstart', this.handleFirstInteractionCam);
  }

  async ensureCameraFlowStarted(force = false): Promise<boolean> {
    if (!force && this.userDisabledCameraFlow) return false;
    if (this.cameraFlowEnabled && this.cameraVideo) {
      this.removeFirstInteractionCamListeners();
      return true;
    }
    if (this.cameraAutoStartPromise) {
      return this.cameraAutoStartPromise;
    }
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return false;
    }

    this.cameraAutoStartPromise = (async () => {
      try {
        if (!force && typeof navigator.permissions?.query === 'function') {
          try {
            const status = await navigator.permissions.query({name: 'camera' as PermissionName});
            if (status.state === 'denied') {
              return false;
            }
          } catch {
            // Permissions API may not support 'camera' on some WebViews; proceed directly
          }
        }
        const video = await this.acquireSharedCamera('optical-flow');
        if (!video) return false;
        this.cameraFlowEnabled = true;
        this.autoFlowEnabled = true;
        this.removeFirstInteractionCamListeners();
        return true;
      } finally {
        this.cameraAutoStartPromise = null;
      }
    })();

    return this.cameraAutoStartPromise;
  }

  private attachPassiveListeners(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener(
      'deviceorientationabsolute',
      this.onDeviceOrientation as EventListener,
      true
    );
    window.addEventListener('deviceorientation', this.onDeviceOrientation, true);
    window.addEventListener('devicemotion', this.onDeviceMotion, true);
    window.addEventListener('keydown', this.handleWindowKeyDown);
    window.addEventListener('keyup', this.handleWindowKeyUp);
    window.addEventListener('pointerdown', this.handleCanvasPointerDown, {passive: true});
    window.addEventListener('pointermove', this.handleCanvasPointerMove, {passive: true});
    window.addEventListener('pointerup', this.handleCanvasPointerUp, {passive: true});
    window.addEventListener('pointercancel', this.handleCanvasPointerUp, {passive: true});
  }

  async requestSensorAccess(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    const devOrient = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    const devMotion = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    try {
      if (typeof devOrient?.requestPermission === 'function') {
        const res = await devOrient.requestPermission();
        this.permissionState = res === 'granted' ? 'granted' : 'denied';
      } else {
        this.permissionState = 'granted';
      }

      if (typeof devMotion?.requestPermission === 'function') {
        await devMotion.requestPermission();
      }
    } catch {
      this.permissionState = 'denied';
      return false;
    }

    this.attachPassiveListeners();
    this.tryStartGenericSensors(true);
    this.requestWakeLock();
    this.recenter();
    return this.permissionState === 'granted';
  }

  private requestWakeLock(): void {
    const nav = navigator as Navigator & {
      wakeLock?: {request: (type: 'screen') => Promise<{release: () => Promise<void>}>};
    };
    if (!nav.wakeLock || this.wakeLockSentinel) return;
    void nav.wakeLock
      .request('screen')
      .then((sentinel) => {
        this.wakeLockSentinel = sentinel;
      })
      .catch(() => {});
  }

  private tryStartGenericSensors(forceRestart = false): void {
    if (typeof window === 'undefined') return;
    if (this.genericSensorsStarted && !forceRestart) return;
    this.stopGenericSensors();
    this.genericSensorsStarted = true;

    const win = window as unknown as Record<string, SensorCtor<GenericSensorLike> | undefined>;

    const tryCreate = <T extends GenericSensorLike>(
      name: string,
      opts: {frequency?: number; referenceFrame?: 'device' | 'screen'}
    ): T | null => {
      const Ctor = win[name] as SensorCtor<T> | undefined;
      if (typeof Ctor !== 'function') return null;
      try {
        return new Ctor(opts);
      } catch {
        try {
          return new Ctor({frequency: opts.frequency ?? 60});
        } catch {
          return null;
        }
      }
    };

    // 1. AbsoluteOrientationSensor (9-axis hardware fusion)
    const absOrient = tryCreate<OrientationSensorLike>('AbsoluteOrientationSensor', {
      frequency: 60,
      referenceFrame: 'device',
    });
    if (absOrient) {
      absOrient.addEventListener('reading', () => {
        if (!absOrient.quaternion) return;
        this.applyOrientationSensorQuaternion(absOrient.quaternion, true);
      });
      absOrient.addEventListener('error', () => {});
      try {
        absOrient.start();
        this.genericSensors.push(absOrient);
      } catch {}
    }

    // 2. RelativeOrientationSensor (6-axis accel+gyro)
    const relOrient = tryCreate<OrientationSensorLike>('RelativeOrientationSensor', {
      frequency: 60,
      referenceFrame: 'device',
    });
    if (relOrient) {
      relOrient.addEventListener('reading', () => {
        if (!relOrient.quaternion) return;
        this.applyOrientationSensorQuaternion(relOrient.quaternion, false);
      });
      relOrient.addEventListener('error', () => {});
      try {
        relOrient.start();
        this.genericSensors.push(relOrient);
      } catch {}
    }

    // 3. GravitySensor
    const gravity = tryCreate<VectorSensorLike>('GravitySensor', {frequency: 60});
    if (gravity) {
      gravity.addEventListener('reading', () => {
        if (
          typeof gravity.x === 'number' &&
          typeof gravity.y === 'number' &&
          typeof gravity.z === 'number'
        ) {
          this.updateGravityTilt(gravity.x, gravity.y, gravity.z, true);
        }
      });
      gravity.addEventListener('error', () => {});
      try {
        gravity.start();
        this.genericSensors.push(gravity);
      } catch {}
    }

    // 4. LinearAccelerationSensor (micro-parallax neck-model head movement)
    const linAcc = tryCreate<VectorSensorLike>('LinearAccelerationSensor', {frequency: 60});
    if (linAcc) {
      linAcc.addEventListener('reading', () => {
        if (
          typeof linAcc.x === 'number' &&
          typeof linAcc.y === 'number' &&
          typeof linAcc.z === 'number'
        ) {
          this.applyLinearAcceleration(linAcc.x, linAcc.y, linAcc.z);
        }
      });
      linAcc.addEventListener('error', () => {});
      try {
        linAcc.start();
        this.genericSensors.push(linAcc);
      } catch {}
    }

    // 5. Gyroscope
    const gyro = tryCreate<VectorSensorLike>('Gyroscope', {frequency: 60});
    if (gyro) {
      gyro.addEventListener('reading', () => {
        if (
          typeof gyro.x === 'number' &&
          typeof gyro.y === 'number' &&
          typeof gyro.z === 'number'
        ) {
          const now = performance.now();
          const dt = this.lastGyroTime > 0 ? Math.min((now - this.lastGyroTime) / 1000, 0.1) : 0.016;
          this.lastGyroTime = now;
          this.integrateGyro(gyro.x, gyro.y, gyro.z, dt);
        }
      });
      gyro.addEventListener('error', () => {});
      try {
        gyro.start();
        this.genericSensors.push(gyro);
      } catch {}
    }

    // 6. Accelerometer
    const accel = tryCreate<VectorSensorLike>('Accelerometer', {frequency: 60});
    if (accel) {
      accel.addEventListener('reading', () => {
        if (
          typeof accel.x === 'number' &&
          typeof accel.y === 'number' &&
          typeof accel.z === 'number'
        ) {
          this.updateGravityTilt(accel.x, accel.y, accel.z, false);
        }
      });
      accel.addEventListener('error', () => {});
      try {
        accel.start();
        this.genericSensors.push(accel);
      } catch {}
    }

    // 7. Magnetometer (3D tilt-compensated compass with magnetic spike filter)
    const mag = tryCreate<VectorSensorLike>('Magnetometer', {frequency: 30});
    if (mag) {
      mag.addEventListener('reading', () => {
        if (typeof mag.x === 'number' && typeof mag.y === 'number' && typeof mag.z === 'number') {
          // Reject severe magnetic interference (normal Earth field is ~25-65 uT)
          const fieldMag = Math.hypot(mag.x, mag.y, mag.z);
          if (fieldMag > 15 && fieldMag < 120) {
            this._magVec.set(mag.x, mag.y, mag.z);
            this._rawMagVec.set(mag.x, mag.y, mag.z);
            this.hasRawMag = true;
            let headingRad: number;
            if (this.hasGravityVec) {
              // Full 3D tilt-compensated azimuth works upright in VR, landscape, & tilted up/down
              this._eastVec.crossVectors(this._magVec, this._upVec);
              if (this._eastVec.lengthSq() > 1e-4) {
                this._eastVec.normalize();
                this._northVec.crossVectors(this._upVec, this._eastVec).normalize();
                const eastComp = this._camFwdVec.dot(this._eastVec);
                const northComp = this._camFwdVec.dot(this._northVec);
                headingRad = Math.atan2(eastComp, northComp);
                this.acceptCompassSample(-headingRad, (((headingRad * RAD_TO_DEG) % 360) + 360) % 360);
              }
            } else {
              headingRad = Math.atan2(mag.y, mag.x);
              this.acceptCompassSample(headingRad, (((-headingRad * RAD_TO_DEG) % 360) + 360) % 360);
            }
          }
        }
      });
      mag.addEventListener('error', () => {});
      try {
        mag.start();
        this.genericSensors.push(mag);
      } catch {}
    }
  }

  private stopGenericSensors(): void {
    for (const s of this.genericSensors) {
      try {
        s.stop();
      } catch {}
    }
    this.genericSensors.length = 0;
  }

  private acceptCompassSample(yawRad: number, compassDeg: number): void {
    const now = performance.now();
    if (!this.hasCompassSeed) {
      this.lastAcceptedCompassRad = yawRad;
      this.hasCompassSeed = true;
    } else {
      const jump = Math.abs(this.shortestAngleDiff(this.lastAcceptedCompassRad, yawRad));
      const gyroFresh = now - this.lastSeen.gyro < 400;
      // If gyro is active and reports stillness, reject sudden >35° magnetic interference spikes
      if (gyroFresh && jump > 35 * DEG_TO_RAD) {
        return;
      }
      this.lastAcceptedCompassRad +=
        this.shortestAngleDiff(this.lastAcceptedCompassRad, yawRad) * 0.45;
    }
    this.latestCompassYawRad = this.lastAcceptedCompassRad;
    this.rawCompassDeg = compassDeg;
    this.lastSeen.compass = now;
    this.sampleCount += 1;
  }

  private applyOrientationSensorQuaternion(q: [number, number, number, number], isAbsolute: boolean): void {
    const now = performance.now();
    this.sampleCount += 1;
    this.permissionState = 'granted';

    this._hwQuat.set(q[0], q[1], q[2], q[3]);
    this._hwQuat.premultiply(this._worldTransformQuat);
    const screenAngle = ((window.screen?.orientation?.angle ?? 0) as number) * DEG_TO_RAD;
    this._screenQuat.setFromAxisAngle(this._zAxis, -screenAngle);
    this._hwQuat.multiply(this._screenQuat);

    this._hwEuler.setFromQuaternion(this._hwQuat, 'YXZ');

    if (isAbsolute) {
      this.lastSeen.absQuat = now;
      this.rawCompassDeg = (((-this._hwEuler.y * RAD_TO_DEG) % 360) + 360) % 360;
    } else {
      if (this.firstSeenRelYaw === null) {
        this.firstSeenRelYaw = this._hwEuler.y;
      } else if (Math.abs(this.shortestAngleDiff(this.firstSeenRelYaw, this._hwEuler.y)) > 0.004) {
        this.relYawHasVaried = true;
      }
      // Only mark relative orientation sensor healthy for yaw if it actually provides yaw variation
      if (this.relYawHasVaried) {
        this.lastSeen.relQuat = now;
      }
    }

    if (this.mode === 'auto' || this.mode === 'fusion') {
      if (isAbsolute || this.relYawHasVaried) {
        const deltaYaw = this.shortestAngleDiff(this.yawRad, this._hwEuler.y);
        this.yawRad += deltaYaw * Math.min(1, this.smoothing * 1.45);
      }
      this.pitchRad = THREE.MathUtils.lerp(
        this.pitchRad,
        THREE.MathUtils.clamp(this._hwEuler.x, -1.42, 1.42),
        Math.min(1, this.smoothing * 1.45)
      );
      this.rollRad = THREE.MathUtils.lerp(
        this.rollRad,
        THREE.MathUtils.clamp(this._hwEuler.z, -1.15, 1.15),
        Math.min(1, this.smoothing * 1.45)
      );
      this._headQuat.copy(this._hwQuat);
      this.madgwick.setFromQuaternion(this._hwQuat);
      this.fusionAlgorithmLabel = isAbsolute ? '9-DoF HW + 1€ Neck' : '6-DoF HW + 1€ Neck';
    }
  }

  private handleOrientation(event: DeviceOrientationEvent): void {
    if (event.alpha === null && event.beta === null && event.gamma === null) {
      return;
    }

    const now = performance.now();
    this.sampleCount += 1;
    this.permissionState = 'granted';

    const webkitHeading = (event as DeviceOrientationEvent & {webkitCompassHeading?: number})
      .webkitCompassHeading;
    const rawAlpha = event.alpha;
    if (typeof rawAlpha === 'number' && !Number.isNaN(rawAlpha)) {
      if (this.firstSeenAlpha === null) {
        this.firstSeenAlpha = rawAlpha;
      } else if (Math.abs(rawAlpha - this.firstSeenAlpha) > 0.08) {
        this.alphaHasVaried = true;
      }
    }

    const screenAngleDeg = (window.screen?.orientation?.angle ?? 0) as number;
    const screenOrientRad = screenAngleDeg * DEG_TO_RAD;
    const alphaRad = (rawAlpha ?? 0) * DEG_TO_RAD;
    const betaRad = (event.beta ?? 90) * DEG_TO_RAD;
    const gammaRad = (event.gamma ?? 0) * DEG_TO_RAD;

    // Canonical gimbal-lock-free Three.js DeviceOrientation quaternion transform
    // Works upright in portrait, landscape-left, landscape-right, and full 360° up/down/left/right
    this._devOrientEuler.set(betaRad, alphaRad, -gammaRad, 'YXZ');
    this._devOrientQuat.setFromEuler(this._devOrientEuler);
    this._devOrientQuat.multiply(this._q1);
    this._devOrientQuat.multiply(this._q0.setFromAxisAngle(this._zAxis, -screenOrientRad));
    this._hwEuler.setFromQuaternion(this._devOrientQuat, 'YXZ');

    if (typeof webkitHeading === 'number' && !Number.isNaN(webkitHeading)) {
      this.alphaHasVaried = true;
      this.acceptCompassSample(-webkitHeading * DEG_TO_RAD, webkitHeading);
    } else if (
      typeof rawAlpha === 'number' &&
      !Number.isNaN(rawAlpha) &&
      (event.absolute === true || this.alphaHasVaried)
    ) {
      const compassYaw = this._hwEuler.y;
      const compassDeg = (((-compassYaw * RAD_TO_DEG) % 360) + 360) % 360;
      this.acceptCompassSample(compassYaw, compassDeg);
    }

    this.latestOrientPitch = THREE.MathUtils.clamp(this._hwEuler.x, -1.38, 1.38);
    this.latestOrientRoll = THREE.MathUtils.clamp(this._hwEuler.z, -1.12, 1.12);
    this.lastSeen.orientEuler = now;
  }

  private handleMotion(event: DeviceMotionEvent): void {
    const now = performance.now();
    const dt = this.lastMotionTime > 0 ? Math.min((now - this.lastMotionTime) / 1000, 0.1) : 0.016;
    this.lastMotionTime = now;

    if (this.mode === 'compass-only' || this.mode === 'off') return;

    const acc = event.accelerationIncludingGravity;
    if (acc && acc.x !== null && acc.y !== null && acc.z !== null) {
      this.updateGravityTilt(acc.x, acc.y, acc.z, false);
    }

    const lin = event.acceleration;
    if (lin && lin.x !== null && lin.y !== null && lin.z !== null) {
      this.applyLinearAcceleration(lin.x, lin.y, lin.z);
    }

    const gyro = event.rotationRate;
    if (gyro && gyro.alpha !== null && gyro.beta !== null && gyro.gamma !== null) {
      // W3C DeviceMotionEvent.rotationRate: beta=X (pitch), gamma=Y (yaw), alpha=Z (roll)
      this.integrateGyro(
        gyro.beta * DEG_TO_RAD,
        gyro.gamma * DEG_TO_RAD,
        gyro.alpha * DEG_TO_RAD,
        dt
      );
    }
  }

  private applyLinearAcceleration(lx: number, ly: number, lz: number): void {
    const mag = Math.hypot(lx, ly, lz);
    this.latestLinearAccelMag = mag;
    const now = performance.now();

    // Always feed Walk / Run / Jump biomechanical detector (including gentle low-G motion)
    this.processLocomotionSample(lx, ly, lz, now);

    if (mag < 0.05 || mag > 28) return;
    this.lastSeen.linearAccel = now;

    // Detect crisp headset side-tap impulse (only when not mid-stride/jumping)
    if (
      mag > 4.6 &&
      mag < 16 &&
      !this.isAirborne &&
      this.locomotionState === 'idle' &&
      !this.isDraggingLook &&
      now - this.lastTapTriggeredAt > 650
    ) {
      this.pendingTap = true;
      this.lastTapTriggeredAt = now;
    }

    // Subtle neck-model micro-parallax velocity kick (damped back to zero in update)
    this._neckVel.x = THREE.MathUtils.clamp(this._neckVel.x + lx * 0.0018, -0.18, 0.18);
    this._neckVel.y = THREE.MathUtils.clamp(this._neckVel.y + ly * 0.0018, -0.18, 0.18);
    this._neckVel.z = THREE.MathUtils.clamp(this._neckVel.z + lz * 0.0018, -0.18, 0.18);
  }

  private processLocomotionSample(lx: number, ly: number, lz: number, now: number): void {
    // In dedicated camera-flow mode, Walk/Run/Jump is sensed purely by the back camera
    if (this.mode === 'camera-flow' || this.mode === 'off') return;
    const dtMs =
      this.lastMotionStepSampleAt > 0
        ? Math.min(80, Math.max(4, now - this.lastMotionStepSampleAt))
        : 16;
    this.lastMotionStepSampleAt = now;

    // Project onto Earth-vertical Up axis when gravity vector is known, otherwise Y axis
    const rawVert = this.hasGravityVec
      ? lx * this._upVec.x + ly * this._upVec.y + lz * this._upVec.z
      : ly;
    this.latestVertAcc = rawVert;
    this.smoothedVertAcc = THREE.MathUtils.lerp(this.smoothedVertAcc, rawVert, 0.35);

    // 1. Biomechanical Jump Detection (Push-off upward spike + Free-fall weightlessness)
    if (rawVert > 6.8) {
      this.pushOffPrimedUntil = now + 220;
    }
    if (rawVert < -3.4) {
      this.freeFallMs += dtMs;
    } else {
      this.freeFallMs = Math.max(0, this.freeFallMs - dtMs * 1.5);
    }

    if (
      !this.isAirborne &&
      now > this.jumpCooldownUntil &&
      ((this.freeFallMs >= 65 && now - this.lastStepAt > 120) ||
        (now <= this.pushOffPrimedUntil && rawVert < -2.1))
    ) {
      this.lastImuStepAt = now;
      this.triggerJump();
      this.freeFallMs = 0;
      this.pushOffPrimedUntil = 0;
      return;
    }

    // 2. Walk vs Run Pedometer Peak Detector
    if (this.isAirborne || now < this.jumpCooldownUntil - 150) {
      this.stepPeakArmed = false;
      this.stepPeakMax = 0;
      return;
    }

    const absVert = Math.max(this.smoothedVertAcc, Math.hypot(lx, ly, lz) * 0.72);
    if (!this.stepPeakArmed) {
      if (absVert > 1.45 && now - this.lastStepAt >= 205) {
        this.stepPeakArmed = true;
        this.stepPeakMax = absVert;
      }
    } else {
      if (absVert > this.stepPeakMax) {
        this.stepPeakMax = absVert;
      }
      if (absVert < 0.85) {
        this.lastImuStepAt = now;
        this.visMoveSign = 1;
        this.registerStep(now, this.stepPeakMax);
        this.stepPeakArmed = false;
        this.stepPeakMax = 0;
      }
    }
  }

  private registerStep(now: number, peakAccel: number): void {
    this.lastStepAt = now;
    this.stepCount += 1;
    this.stepTimestamps.push(now);
    const cutoff = now - 2400;
    while (this.stepTimestamps.length > 0 && this.stepTimestamps[0] < cutoff) {
      this.stepTimestamps.shift();
    }

    if (this.stepTimestamps.length >= 2) {
      const spanSec =
        (this.stepTimestamps[this.stepTimestamps.length - 1] - this.stepTimestamps[0]) / 1000;
      this.cadenceSpm =
        spanSec > 0.15
          ? Math.round(((this.stepTimestamps.length - 1) / spanSec) * 60)
          : 110;
    } else {
      this.cadenceSpm = peakAccel >= 4.4 ? 156 : 108;
    }

    const isRunning = this.cadenceSpm >= 136 || peakAccel >= 4.6;
    this.locomotionState = isRunning ? 'run' : 'walk';
    this.locoSpeed = isRunning ? 3.5 : 1.55;
    this.locoHoldUntil = now + 720;
    this.pendingStepKind = isRunning ? 'run' : 'walk';
  }

  public triggerJump(): void {
    const now = performance.now();
    if (this.isAirborne && this.jumpHeightY > 0.08) return;
    this.isAirborne = true;
    this.jumpVelY = 3.45;
    this.locomotionState = 'jump';
    this.jumpCooldownUntil = now + 520;
    this.pendingJumpEvent = true;
  }

  public triggerManualStep(running = false): void {
    const now = performance.now();
    this.registerStep(now, running ? 5.8 : 2.6);
  }

  public setLocomotionEnabled(enabled: boolean): void {
    this.locomotionEnabled = enabled;
    if (!enabled) {
      this.locoSpeed = 0;
      this.locomotionState = 'idle';
    }
  }

  public isLocomotionEnabled(): boolean {
    return this.locomotionEnabled;
  }

  private updateGravityTilt(ax: number, ay: number, az: number, isGravitySensor: boolean): void {
    const norm = Math.hypot(ax, ay, az);
    if (norm < 0.5) return;

    // Store normalized device gravity Up vector for 3D tilt-compensated compass & Madgwick fusion
    this._upVec.set(ax / norm, ay / norm, az / norm);
    this._rawAccelVec.set(ax, ay, az);
    this.lastAccelMag = norm;
    this.hasRawAccel = true;
    this.hasGravityVec = true;

    const now = performance.now();
    this.sampleCount += 1;
    if (isGravitySensor) {
      this.lastSeen.gravity = now;
    } else {
      this.lastSeen.accel = now;
      // Fallback high-pass linear accel extraction for phones without LinearAccelerationSensor
      if (!this.hasGravLp) {
        this._gravLp.set(ax, ay, az);
        this.hasGravLp = true;
      } else {
        this._gravLp.lerp(this._rawAccelVec, 0.08);
        if (now - this.lastSeen.linearAccel > 120) {
          this.processLocomotionSample(
            ax - this._gravLp.x,
            ay - this._gravLp.y,
            az - this._gravLp.z,
            now
          );
        }
      }
    }

    const angle = (window.screen?.orientation?.angle ?? 0) as number;
    let gx = ax;
    let gy = ay;
    const gz = az;
    if (angle === 90) {
      gx = -ay;
      gy = ax;
    } else if (angle === -90 || angle === 270) {
      gx = ay;
      gy = -ax;
    }

    this.latestGravityPitch = THREE.MathUtils.clamp(Math.atan2(-gz, Math.hypot(gx, gy)), -1.38, 1.38);
    this.latestGravityRoll = THREE.MathUtils.clamp(Math.atan2(gx, Math.hypot(gy, gz)) * 0.65, -1.12, 1.12);
  }

  private integrateGyro(rxRadSec: number, ryRadSec: number, rzRadSec: number, dt: number): void {
    if (this.mode === 'compass-only' || this.mode === 'off' || this.mode === 'camera-flow') return;
    const now = performance.now();
    this.lastSeen.gyro = now;
    this.sampleCount += 1;

    // Stationary ZUPT gyro-bias estimator (eliminates thermal & MEMS drift when still)
    const speed = Math.hypot(rxRadSec, ryRadSec, rzRadSec);
    if (speed < 0.048) {
      this.stationaryAccumSec += dt;
      if (this.stationaryAccumSec > 0.32) {
        this.gyroBiasX = THREE.MathUtils.lerp(this.gyroBiasX, rxRadSec, 0.09);
        this.gyroBiasY = THREE.MathUtils.lerp(this.gyroBiasY, ryRadSec, 0.09);
        this.gyroBiasZ = THREE.MathUtils.lerp(this.gyroBiasZ, rzRadSec, 0.09);
        this.gyroCalibrated = true;
      }
    } else {
      this.stationaryAccumSec = 0;
    }

    if (now - this.lastSeen.absQuat < 250 || now - this.lastSeen.relQuat < 250) return;

    const cx = rxRadSec - this.gyroBiasX;
    const cy = ryRadSec - this.gyroBiasY;
    const cz = rzRadSec - this.gyroBiasZ;

    const angle = (window.screen?.orientation?.angle ?? 0) as number;
    let wx = cx;
    let wy = cy;
    const wz = cz * 0.72;

    if (angle === 90) {
      wx = -cy;
      wy = cx;
    } else if (angle === -90 || angle === 270) {
      wx = cy;
      wy = -cx;
    } else if (angle === 180) {
      wx = -cx;
      wy = -cy;
    }

    // Acceleration-magnitude gate: down-weight gravity pull during walk/run/jump impulses
    const accelDeviation = Math.abs(this.lastAccelMag - 9.81);
    const motionTrust = THREE.MathUtils.clamp(1 / (1 + accelDeviation * 0.48), 0.12, 1.0);
    const magFresh = this.hasRawMag && now - this.lastSeen.compass < SENSOR_STALE_MS;

    this.madgwick.setBaseBeta(0.03 + this.smoothing * 0.09);
    this.madgwick.step(
      wx,
      wy,
      wz,
      this._rawAccelVec.x,
      this._rawAccelVec.y,
      this._rawAccelVec.z,
      this.hasRawAccel && now - Math.max(this.lastSeen.accel, this.lastSeen.gravity) < SENSOR_STALE_MS,
      this._rawMagVec.x,
      this._rawMagVec.y,
      this._rawMagVec.z,
      magFresh,
      dt,
      motionTrust
    );
    this.madgwick.toQuaternion(this._headQuat);
    this._hwEuler.setFromQuaternion(this._headQuat, 'YXZ');
    this.yawRad = this._hwEuler.y;
    this.pitchRad = THREE.MathUtils.clamp(this._hwEuler.x, -1.42, 1.42);
    this.rollRad = THREE.MathUtils.clamp(this._hwEuler.z, -1.15, 1.15);
    this.fusionAlgorithmLabel = magFresh ? 'Madgwick 9-DoF + 1€' : 'Madgwick 6-DoF + 1€';
  }

  /**
   * Acquires a shared camera `<video>` feed for Optical Flow and/or Hand Gesture recognition.
   */
  async acquireSharedCamera(consumerId: string): Promise<HTMLVideoElement | null> {
    this.cameraConsumers.add(consumerId);
    if (this.cameraVideo && this.cameraStream) {
      this.ensureAutoOpticalFlow();
      return this.cameraVideo;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.cameraConsumers.delete(consumerId);
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: {ideal: 'environment'},
          width: {ideal: 640},
          height: {ideal: 480},
        },
        audio: false,
      });

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      this.cameraStream = stream;
      this.cameraVideo = video;
      this.ensureAutoOpticalFlow();
      return video;
    } catch {
      this.cameraConsumers.delete(consumerId);
      return null;
    }
  }

  private ensureAutoOpticalFlow(): void {
    if (!this.flowCanvas && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = this.flowW;
      canvas.height = this.flowH;
      this.flowCanvas = canvas;
      this.flowCtx = canvas.getContext('2d', {willReadFrequently: true});
      this.hasPrevLuma = false;
    }
    this.autoFlowEnabled = true;
  }

  getCameraVideo(): HTMLVideoElement | null {
    return this.cameraVideo;
  }

  releaseSharedCamera(consumerId: string): void {
    this.cameraConsumers.delete(consumerId);
    if (this.cameraConsumers.size === 0) {
      this.autoFlowEnabled = false;
      if (this.cameraStream) {
        for (const track of this.cameraStream.getTracks()) {
          track.stop();
        }
        this.cameraStream = null;
      }
      if (this.cameraVideo) {
        this.cameraVideo.srcObject = null;
        this.cameraVideo = null;
      }
    }
  }

  async toggleCameraOpticalFlow(): Promise<boolean> {
    if (this.cameraFlowEnabled) {
      this.userDisabledCameraFlow = true;
      this.stopCameraOpticalFlow();
      return false;
    }

    this.userDisabledCameraFlow = false;
    const video = await this.acquireSharedCamera('optical-flow');
    if (!video) return false;

    this.ensureAutoOpticalFlow();
    this.cameraFlowEnabled = true;
    this.removeFirstInteractionCamListeners();
    this.hasPrevLuma = false;
    this.visVertLp = 0;
    this.visVySmooth = 0;
    this.visRawVy1 = 0;
    this.visRawVy2 = 0;
    this.visPeakPos = 0;
    this.visPeakNeg = 0;
    this.visDivergenceLp = 0;
    this.visForwardHoldFrames = 0;
    this.visBackwardHoldFrames = 0;
    this.visCoherentForward = false;
    this.visCoherentBackward = false;
    this.visMoveSign = 1;
    this.crouchOffsetY = 0;
    this.crouchTargetY = 0;
    this.crouchUntil = 0;
    this.patchContrast.fill(0);
    this.visJumpPrimeFrames = 0;
    this.visJumpPrimedUntil = 0;
    if (this.mode !== 'camera-flow') {
      this.modeBeforeCameraFlow = this.mode;
      this.mode = 'camera-flow';
      this.switchedToCameraFlowByToggle = true;
    }
    this.fusionAlgorithmLabel = 'Back-Cam Optical 6DoF';
    return true;
  }

  stopCameraOpticalFlow(): void {
    this.cameraFlowEnabled = false;
    if (this.switchedToCameraFlowByToggle && this.mode === 'camera-flow') {
      this.mode = this.modeBeforeCameraFlow;
    }
    this.switchedToCameraFlowByToggle = false;
    this.releaseSharedCamera('optical-flow');
    if (this.cameraConsumers.size === 0) {
      this.flowCanvas = null;
      this.flowCtx = null;
      this.hasPrevLuma = false;
    }
  }

  isCameraFlowEnabled(): boolean {
    return this.cameraFlowEnabled;
  }

  getLocomotionOffsetXZ(): THREE.Vector3 {
    return this._locoOffsetXZ;
  }

  private medianTextured(values: Float32Array, contrast: Float32Array, minContrast = 4): number {
    let count = 0;
    for (let i = 0; i < 9; i++) {
      if (contrast[i] > minContrast) {
        this.sortScratch[count] = values[i];
        count += 1;
      }
    }
    if (count === 0) {
      for (let i = 0; i < 9; i++) {
        this.sortScratch[i] = values[i];
      }
      count = 9;
    }
    for (let i = 1; i < count; i++) {
      const key = this.sortScratch[i];
      let j = i - 1;
      while (j >= 0 && this.sortScratch[j] > key) {
        this.sortScratch[j + 1] = this.sortScratch[j];
        j -= 1;
      }
      this.sortScratch[j + 1] = key;
    }
    return this.sortScratch[count >> 1];
  }

  private computeSadBlock(
    prev: Uint8Array,
    curr: Uint8Array,
    stride: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    dx: number,
    dy: number,
    step: number
  ): number {
    let sad = 0;
    for (let y = y0; y < y1; y += step) {
      const rowA = y * stride;
      const rowB = (y + dy) * stride;
      for (let x = x0; x < x1; x += step) {
        const diff = prev[rowA + x] - curr[rowB + x + dx];
        sad += diff < 0 ? -diff : diff;
      }
    }
    return sad;
  }

  /**
   * 2-Level Coarse-to-Fine 3x3 Multi-Patch Optical Flow (Zero-GC).
   * Senses Head Yaw (Turn Left/Right), Pitch (Look Up/Down), Roll (Tilt),
   * and Body Locomotion (Walk, Run, Jump) directly from the back camera.
   */
  public processCameraLumaFrame(
    curr: Uint8Array,
    dtSec: number,
    now = performance.now(),
    orientationAngleDeg?: number
  ): void {
    const w = this.flowW;
    const h = this.flowH;
    const cw = this.coarseW;
    const len = w * h;

    let lumaSum = 0;
    let lumaSqSum = 0;
    for (let i = 0; i < len; i++) {
      const y = curr[i];
      lumaSum += y;
      lumaSqSum += y * y;
    }

    // 2x2 average downsample to 48x36 coarse pyramid level
    for (let cy = 0; cy < this.coarseH; cy++) {
      const sy = cy * 2 * w;
      const cRow = cy * cw;
      for (let cx = 0; cx < cw; cx++) {
        const sx = sy + cx * 2;
        this.coarseCurr[cRow + cx] =
          (curr[sx] + curr[sx + 1] + curr[sx + w] + curr[sx + w + 1]) >> 2;
      }
    }

    // Texture variance gate: skip featureless dark/saturated frames
    const mean = lumaSum / len;
    const variance = lumaSqSum / len - mean * mean;

    if (this.hasPrevLuma && variance > 55) {
      const coarseR = 5;
      const fineR = 2;
      const maxFineDx = 14;
      const maxFineDy = 13;

      let patchIdx = 0;
      for (let py = 0; py < 3; py++) {
        // Coarse bounds in 48x36: y in [6..14], [14..22], [22..30] (+/-5 stays in 1..35)
        const cy0 = 6 + py * 8;
        const cy1 = cy0 + 8;
        // Fine bounds in 96x72: y in [14..28], [28..42], [42..56] (+/-13 stays in 1..69)
        const fy0 = 14 + py * 14;
        const fy1 = fy0 + 14;

        for (let px = 0; px < 3; px++) {
          // Coarse bounds in 48x36: x in [6..16], [18..28], [30..40] (+/-5 stays in 1..45)
          const cx0 = 6 + px * 12;
          const cx1 = cx0 + 10;
          // Fine bounds in 96x72: x in [16..34], [38..56], [60..78] (+/-14 stays in 2..92)
          const fx0 = 16 + px * 22;
          const fx1 = fx0 + 18;

          // Level 1: Coarse search (±5px @ 48x36 = ±10px full-res) with tiny shift regularization
          // to prevent blank-patch saturation or repetitive tile/blind aliasing.
          let bestCDx = 0;
          let bestCDy = 0;
          let bestCSad = Number.POSITIVE_INFINITY;
          for (let cdy = -coarseR; cdy <= coarseR; cdy++) {
            for (let cdx = -coarseR; cdx <= coarseR; cdx++) {
              const rawSad = this.computeSadBlock(
                this.coarsePrev,
                this.coarseCurr,
                cw,
                cx0,
                cx1,
                cy0,
                cy1,
                cdx,
                cdy,
                1
              );
              const cost = rawSad + ((cdx < 0 ? -cdx : cdx) + (cdy < 0 ? -cdy : cdy)) * 18;
              if (cost < bestCSad) {
                bestCSad = cost;
                bestCDx = cdx;
                bestCDy = cdy;
              }
            }
          }

          // Level 2: Fine search (±2px around coarse seed)
          const seedDx = THREE.MathUtils.clamp(bestCDx * 2, -12, 12);
          const seedDy = THREE.MathUtils.clamp(bestCDy * 2, -11, 11);
          const minDx = Math.max(-maxFineDx, seedDx - fineR);
          const maxDx = Math.min(maxFineDx, seedDx + fineR);
          const minDy = Math.max(-maxFineDy, seedDy - fineR);
          const maxDy = Math.min(maxFineDy, seedDy + fineR);

          let bestDx = seedDx;
          let bestDy = seedDy;
          let bestCost = Number.POSITIVE_INFINITY;
          let bestSad = Number.POSITIVE_INFINITY;
          for (let dy = minDy; dy <= maxDy; dy++) {
            for (let dx = minDx; dx <= maxDx; dx++) {
              const sad = this.computeSadBlock(
                this.prevLuma,
                curr,
                w,
                fx0,
                fx1,
                fy0,
                fy1,
                dx,
                dy,
                2
              );
              const cost = sad + ((dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)) * 2;
              if (cost < bestCost) {
                bestCost = cost;
                bestSad = sad;
                bestDx = dx;
                bestDy = dy;
              }
            }
          }

          // Parabolic subpixel refinement along X and Y
          let subDx = bestDx;
          let subDy = bestDy;
          if (bestDx > -maxFineDx && bestDx < maxFineDx) {
            const leftSad = this.computeSadBlock(
              this.prevLuma,
              curr,
              w,
              fx0,
              fx1,
              fy0,
              fy1,
              bestDx - 1,
              bestDy,
              2
            );
            const rightSad = this.computeSadBlock(
              this.prevLuma,
              curr,
              w,
              fx0,
              fx1,
              fy0,
              fy1,
              bestDx + 1,
              bestDy,
              2
            );
            const denomX = 2 * (leftSad - 2 * bestSad + rightSad);
            if (Math.abs(denomX) > 1e-3) {
              subDx += THREE.MathUtils.clamp((leftSad - rightSad) / denomX, -0.5, 0.5);
            }
          }
          if (bestDy > -maxFineDy && bestDy < maxFineDy) {
            const upSad = this.computeSadBlock(
              this.prevLuma,
              curr,
              w,
              fx0,
              fx1,
              fy0,
              fy1,
              bestDx,
              bestDy - 1,
              2
            );
            const downSad = this.computeSadBlock(
              this.prevLuma,
              curr,
              w,
              fx0,
              fx1,
              fy0,
              fy1,
              bestDx,
              bestDy + 1,
              2
            );
            const denomY = 2 * (upSad - 2 * bestSad + downSad);
            if (Math.abs(denomY) > 1e-3) {
              subDy += THREE.MathUtils.clamp((upSad - downSad) / denomY, -0.5, 0.5);
            }
          }

          this.patchDx[patchIdx] = subDx;
          this.patchDy[patchIdx] = subDy;

          // Measure local texture gradient strength (zero-GC) to ignore featureless ceiling/floor
          let contrastSum = 0;
          let contrastSamples = 0;
          for (let y = fy0; y < fy1 - 2; y += 2) {
            const row = y * w;
            const nextRow = (y + 2) * w;
            for (let x = fx0; x < fx1 - 2; x += 2) {
              const c = curr[row + x];
              const gx = c - curr[row + x + 2];
              const gy = c - curr[nextRow + x];
              contrastSum += (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
              contrastSamples += 1;
            }
          }
          this.patchContrast[patchIdx] =
            contrastSamples > 0 ? contrastSum / contrastSamples : 0;

          patchIdx += 1;
        }
      }

      const medianDx = this.medianTextured(this.patchDx, this.patchContrast);
      const medianDy = this.medianTextured(this.patchDy, this.patchContrast);

      this.lastSeen.cameraFlow = now;
      this.sampleCount += 1;

      const hasAbsQuat = now - this.lastSeen.absQuat < SENSOR_STALE_MS;
      const hasGyro = now - this.lastSeen.gyro < SENSOR_STALE_MS;
      const hasCompass = now - this.lastSeen.compass < SENSOR_STALE_MS;
      const hasGravity =
        now - this.lastSeen.gravity < SENSOR_STALE_MS ||
        now - this.lastSeen.accel < SENSOR_STALE_MS;

      // Rotate optical-flow displacement into viewer frame for portrait/landscape headsets
      const angle =
        orientationAngleDeg ??
        ((typeof window !== 'undefined' ? window.screen?.orientation?.angle : 0) || 0);
      let rotDx = medianDx;
      let rotDy = medianDy;
      if (angle === 90) {
        rotDx = medianDy;
        rotDy = -medianDx;
      } else if (angle === -90 || angle === 270) {
        rotDx = -medianDy;
        rotDy = medianDx;
      } else if (angle === 180) {
        rotDx = -medianDx;
        rotDy = -medianDy;
      }

      // Camera FOV ~62 deg across 96px -> radPerPx:
      // Turning head LEFT shifts world RIGHT (+rotDx) -> +dYaw (Three.js +Y rotates left)
      // Looking UP shifts world DOWN (+rotDy) -> +dPitch (Three.js +X pitches up)
      const radPerPx = (62 * DEG_TO_RAD) / w;
      const dYaw = Math.abs(rotDx) > 0.06 ? rotDx * radPerPx : 0;
      const dPitch = Math.abs(rotDy) > 0.06 ? rotDy * radPerPx : 0;

      // Rotationally invariant 2D Curl for visual head Roll (tilt left/right)
      const topRowDx = (this.patchDx[0] + this.patchDx[1] + this.patchDx[2]) / 3;
      const botRowDx = (this.patchDx[6] + this.patchDx[7] + this.patchDx[8]) / 3;
      const leftColDy = (this.patchDy[0] + this.patchDy[3] + this.patchDy[6]) / 3;
      const rightColDy = (this.patchDy[2] + this.patchDy[5] + this.patchDy[8]) / 3;
      const rollCurl = ((topRowDx - botRowDx) / 28 + (rightColDy - leftColDy) / 44) * 0.5;
      const dRoll = Math.abs(rollCurl) > 0.004 ? THREE.MathUtils.clamp(rollCurl * 0.72, -0.14, 0.14) : 0;

      // Texture-weighted 2D Radial Divergence (strictly ignores blank ceilings/floors & edge outliers)
      let leftDxSum = 0;
      let leftW = 0;
      let rightDxSum = 0;
      let rightW = 0;
      let topDySum = 0;
      let topW = 0;
      let botDySum = 0;
      let botW = 0;
      for (let r = 0; r < 3; r++) {
        const li = r * 3;
        const ri = r * 3 + 2;
        if (this.patchContrast[li] > 6 && Math.abs(this.patchDx[li] - medianDx) < 3.8) {
          leftDxSum += this.patchDx[li];
          leftW += 1;
        }
        if (this.patchContrast[ri] > 6 && Math.abs(this.patchDx[ri] - medianDx) < 3.8) {
          rightDxSum += this.patchDx[ri];
          rightW += 1;
        }

        const ti = r;
        const bi = 6 + r;
        if (this.patchContrast[ti] > 6 && Math.abs(this.patchDy[ti] - medianDy) < 3.8) {
          topDySum += this.patchDy[ti];
          topW += 1;
        }
        if (this.patchContrast[bi] > 6 && Math.abs(this.patchDy[bi] - medianDy) < 3.8) {
          botDySum += this.patchDy[bi];
          botW += 1;
        }
      }
      const hasHorizDiv = leftW > 0 && rightW > 0;
      const hasVertDiv = topW > 0 && botW > 0;
      const horizExp = hasHorizDiv ? rightDxSum / rightW - leftDxSum / leftW : 0;
      const vertExp = hasVertDiv ? botDySum / botW - topDySum / topW : 0;
      const divAxes = (hasHorizDiv ? 1 : 0) + (hasVertDiv ? 1 : 0);
      const radialExp =
        divAxes > 0
          ? ((hasHorizDiv ? horizExp / 44 : 0) + (hasVertDiv ? vertExp / 28 : 0)) / divAxes
          : 0;
      const divRate = radialExp / Math.max(dtSec, 0.016);
      this.visDivergenceLp = THREE.MathUtils.lerp(this.visDivergenceLp, divRate, 0.28);

      const stableRotForDiv =
        Math.abs(rotDx) < 1.8 && Math.abs(rotDy) < 1.8 && Math.abs(this.visVySmooth) < 40;
      const isExpandingFwd =
        divAxes > 0 &&
        (!hasHorizDiv || horizExp > 0.14) &&
        (!hasVertDiv || vertExp > 0.09);
      const isContractingBack =
        divAxes > 0 &&
        (!hasHorizDiv || horizExp < -0.14) &&
        (!hasVertDiv || vertExp < -0.09);
      // Forward radial expansion vs Backward radial contraction
      if (isExpandingFwd && stableRotForDiv) {
        this.visForwardHoldFrames = Math.min(20, this.visForwardHoldFrames + 1);
        this.visBackwardHoldFrames = Math.max(0, this.visBackwardHoldFrames - 2);
      } else if (isContractingBack && stableRotForDiv) {
        this.visBackwardHoldFrames = Math.min(20, this.visBackwardHoldFrames + 1);
        this.visForwardHoldFrames = Math.max(0, this.visForwardHoldFrames - 2);
      } else {
        this.visForwardHoldFrames = Math.max(0, this.visForwardHoldFrames - 2);
        this.visBackwardHoldFrames = Math.max(0, this.visBackwardHoldFrames - 2);
      }
      this.visCoherentForward = this.visForwardHoldFrames >= 3;
      this.visCoherentBackward = this.visBackwardHoldFrames >= 3;

      if (this.mode === 'camera-flow') {
        this.yawRad += dYaw * 1.18;
        this.pitchRad = THREE.MathUtils.clamp(this.pitchRad + dPitch * 1.12, -1.38, 1.38);
        this.rollRad = THREE.MathUtils.clamp(this.rollRad * 0.94 + dRoll, -0.78, 0.78);
        this.rawCompassDeg = (((-this.yawRad * RAD_TO_DEG) % 360) + 360) % 360;
        this.fusionAlgorithmLabel = 'Back-Cam Optical 6DoF';
      } else {
        if (!hasGyro && !hasCompass && !hasAbsQuat) {
          this.yawRad += dYaw * 1.22;
        } else if (!hasGyro && !hasAbsQuat && hasCompass) {
          this.yawRad += dYaw * 0.72;
        }
        if (!hasGyro && !hasGravity && !hasAbsQuat) {
          this.pitchRad = THREE.MathUtils.clamp(this.pitchRad + dPitch * 1.12, -1.38, 1.38);
        }
      }

      // Visual Walk / Run / Jump / Crouch detection whenever back camera is active
      // (Active in camera-flow OR in auto mode whenever IMU hasn't fired an actual step recently)
      if (
        this.locomotionEnabled &&
        (this.mode === 'camera-flow' || now - this.lastImuStepAt > 350)
      ) {
        this.processVisualCameraLocomotion(rotDx, rotDy, dtSec, now);
      }
    } else if (this.cameraFlowEnabled) {
      this.lastSeen.cameraFlow = now;
    }

    this.prevLuma.set(curr);
    this.coarsePrev.set(this.coarseCurr);
    this.hasPrevLuma = true;
  }

  private processVisualCameraLocomotion(
    rotDx: number,
    rotDy: number,
    dtSec: number,
    now: number
  ): void {
    const safeDt = Math.max(dtSec, 0.016);
    // +vy: camera moving UP -> world moves DOWN (+rotDy)
    const instantVy = rotDy / safeDt;
    // 3-sample temporal median removes isolated 1-frame optical-flow texture glitches
    const a = this.visRawVy2;
    const b = this.visRawVy1;
    const c = instantVy;
    this.visRawVy2 = b;
    this.visRawVy1 = c;
    const rawVy =
      a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b;
    this.visVySmooth = THREE.MathUtils.lerp(this.visVySmooth, rawVy, 0.58);
    const vy = this.visVySmooth;
    const vxAbs = Math.abs(rotDx / safeDt);

    // High-pass filter isolates rhythmic step bobs & jump impulses from slow head pitch
    this.visVertLp = THREE.MathUtils.lerp(this.visVertLp, vy, Math.min(1, safeDt * 2.8));
    const vertHp = vy - this.visVertLp;
    this.latestVertAcc = Number((vertHp * 0.18).toFixed(1));

    // 1. Visual Jump Detector: Leg push-off surge (+vy upward) followed by apex fall (-vy downward)
    // Requires 2+ consecutive push-off frames so 1-frame glitches never false-trigger jump,
    // while standstill/walking jumps indoors (3-5m room) trigger crisply.
    const alreadyFastBounce = this.locomotionState === 'run' || this.visPeakNeg > 26;
    const jumpLaunchVyMin = alreadyFastBounce ? 64 : 44;
    const jumpLaunchHpMin = alreadyFastBounce ? 48 : 32;
    if (
      rawVy > jumpLaunchVyMin * 0.65 &&
      vy > jumpLaunchVyMin &&
      vertHp > jumpLaunchHpMin &&
      vxAbs < Math.abs(vy) * 1.15
    ) {
      this.visJumpPrimeFrames += 1;
      if (this.visJumpPrimeFrames >= 2) {
        this.visJumpPrimedUntil = now + 540;
      }
    } else {
      this.visJumpPrimeFrames = 0;
    }
    if (
      !this.isAirborne &&
      now > this.jumpCooldownUntil &&
      now <= this.visJumpPrimedUntil &&
      (vy < -17 || vertHp < -15)
    ) {
      this.visJumpPrimeFrames = 0;
      this.visJumpPrimedUntil = 0;
      this.visPeakPos = 0;
      this.visPeakNeg = 0;
      this.crouchTargetY = 0;
      this.triggerJump();
      return;
    }

    if (this.isAirborne || now < this.jumpCooldownUntil - 100) {
      this.visPeakPos = 0;
      this.visPeakNeg = 0;
      return;
    }

    // 2. Visual Crouch / Squat Detector: sudden downward drop without preceding jump launch or stride peak
    if (
      now > this.visJumpPrimedUntil &&
      (this.locomotionState === 'idle' ||
        (this.locomotionState === 'walk' && this.locoSpeed < 0.9)) &&
      this.visPeakPos < 14 &&
      vy < -24 &&
      vertHp < -19 &&
      vxAbs < Math.abs(vy) * 1.25
    ) {
      this.crouchTargetY = -0.34;
      this.crouchUntil = now + 1500;
      this.locoSpeed = 0;
      this.locoHoldUntil = 0;
      this.visPeakPos = 0;
      this.visPeakNeg = 0;
      this.locomotionState = 'crouch';
      return;
    } else if (this.crouchTargetY < -0.05 && vy > 18 && vertHp > 16) {
      this.crouchTargetY = 0;
      this.crouchUntil = 0;
      this.visPeakPos = 0;
      this.visPeakNeg = 0;
    }
    if (this.crouchTargetY < -0.05) {
      this.visPeakPos = 0;
      this.visPeakNeg = 0;
      return;
    }

    // 3. Visual Walk / Run / Backward-Walk Stride & Radial Expansion Detector
    // Use ~600ms envelope memory so first half-stride peak persists until opposite footstrike
    const envDecay = Math.exp(-safeDt * 1.15);
    this.visPeakPos = Math.max(this.visPeakPos * envDecay, vertHp > 0 ? vertHp : 0);
    this.visPeakNeg = Math.max(this.visPeakNeg * envDecay, vertHp < 0 ? -vertHp : 0);
    const bounceAmp = this.visPeakPos + this.visPeakNeg;

    const isFastVisualMotion =
      bounceAmp > 44 || (this.visCoherentForward && this.visDivergenceLp > 0.62);
    const hasStepOscillation =
      this.visPeakPos > 6.5 &&
      this.visPeakNeg > 6.5 &&
      bounceAmp > 14 &&
      vertHp < -4.5 &&
      vy < -3.2;
    const spanSinceLast = this.lastStepAt > 0 ? now - this.lastStepAt : 560;
    const isRapidStride =
      hasStepOscillation &&
      this.visPeakPos > 13 &&
      this.visPeakNeg > 13 &&
      spanSinceLast > 180 &&
      spanSinceLast < 400;
    const isRunningVisual = isFastVisualMotion || isRapidStride;
    const minStrideIntervalMs = isRunningVisual ? 260 : 480;
    if (now - this.lastStepAt < minStrideIntervalMs) return;

    const hasForwardCruise = this.visCoherentForward && this.visDivergenceLp > 0.11;
    const hasBackwardCruise = this.visCoherentBackward && this.visDivergenceLp < -0.11;

    if (hasStepOscillation || hasForwardCruise || hasBackwardCruise) {
      if (hasBackwardCruise || (!hasForwardCruise && this.visDivergenceLp < -0.11)) {
        this.visMoveSign = -1;
      } else {
        this.visMoveSign = 1;
      }
      const equivAccel = isRunningVisual
        ? Math.max(4.9, THREE.MathUtils.clamp(bounceAmp * 0.11, 4.9, 6.2))
        : THREE.MathUtils.clamp(Math.max(2.3, bounceAmp * 0.085), 2.3, 3.6);
      this.registerStep(now, equivAccel);
      this.visPeakPos *= 0.2;
      this.visPeakNeg *= 0.2;
    }
  }

  /**
   * 3x3 Multi-Patch Median-Consensus Optical Flow with 2-level coarse-to-fine pyramid.
   */
  private sampleCameraOpticalFlow(dt: number): void {
    if (
      (!this.cameraFlowEnabled && !this.autoFlowEnabled) ||
      !this.cameraVideo ||
      !this.flowCtx ||
      this.cameraVideo.readyState < 2
    ) {
      return;
    }

    this.flowSampleAccum += dt;
    if (this.flowSampleAccum < 1 / 30) return;
    const sampleDt = this.flowSampleAccum;
    this.flowSampleAccum = 0;

    const w = this.flowW;
    const h = this.flowH;
    this.flowCtx.drawImage(this.cameraVideo, 0, 0, w, h);
    const frame = this.flowCtx.getImageData(0, 0, w, h).data;
    for (let i = 0, p = 0; i < this.currLuma.length; i++, p += 4) {
      this.currLuma[i] = (frame[p] * 77 + frame[p + 1] * 150 + frame[p + 2] * 29) >> 8;
    }

    this.processCameraLumaFrame(this.currLuma, sampleDt, performance.now());
  }

  private shortestAngleDiff(from: number, to: number): number {
    let diff = (to - from + Math.PI) % (Math.PI * 2);
    if (diff < 0) diff += Math.PI * 2;
    return diff - Math.PI;
  }

  recenter(): void {
    this.yawZeroOffsetRad = this.yawRad;
    this.dragPitchBias = 0;
    this._neckOffset.set(0, 0, 0);
    this._neckVel.set(0, 0, 0);
    this._locoOffsetXZ.set(0, 0, 0);
    this.locoSpeed = 0;
    this.jumpHeightY = 0;
    this.jumpVelY = 0;
    this.isAirborne = false;
    this.hasPrevLuma = false;
    this.visVertLp = 0;
    this.visVySmooth = 0;
    this.visRawVy1 = 0;
    this.visRawVy2 = 0;
    this.visPeakPos = 0;
    this.visPeakNeg = 0;
    this.visForwardHoldFrames = 0;
    this.visBackwardHoldFrames = 0;
    this.visCoherentForward = false;
    this.visCoherentBackward = false;
    this.visMoveSign = 1;
    this.crouchOffsetY = 0;
    this.crouchTargetY = 0;
    this.crouchUntil = 0;
    this.patchContrast.fill(0);
    this.visDivergenceLp = 0;
    this.visJumpPrimeFrames = 0;
    this.visJumpPrimedUntil = 0;
  }

  setMode(mode: SensorTrackingMode): void {
    this.mode = mode;
    this.switchedToCameraFlowByToggle = false;
    if (mode === 'camera-flow' && !this.cameraFlowEnabled) {
      void this.toggleCameraOpticalFlow();
    }
  }

  getMode(): SensorTrackingMode {
    return this.mode;
  }

  setSmoothing(value: number): void {
    this.smoothing = THREE.MathUtils.clamp(value, 0.05, 0.95);
  }

  getSmoothing(): number {
    return this.smoothing;
  }

  setSensitivity(value: number): void {
    this.sensitivity = THREE.MathUtils.clamp(value, 0.5, 2.0);
  }

  getSensitivity(): number {
    return this.sensitivity;
  }

  setDemoSweep(enabled: boolean): void {
    this.demoSweepActive = enabled;
    if (!enabled) {
      this.pitchRad = 0;
      this.rollRad = 0;
    }
  }

  isDemoSweepActive(): boolean {
    return this.demoSweepActive;
  }

  setCardboardStereo(enabled: boolean): void {
    this.cardboardStereo = enabled;
  }

  isCardboardStereo(): boolean {
    return this.cardboardStereo;
  }

  update(): void {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const now = performance.now();

    this.sampleTimer += dt;
    if (this.sampleTimer >= 1.0) {
      this.sampleHz = Math.round(this.sampleCount / this.sampleTimer);
      this.sampleCount = 0;
      this.sampleTimer = 0;
    }

    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    const isXrPresenting = Boolean(renderer?.xr?.isPresenting);

    if (!isXrPresenting && this.mode !== 'off') {
      this.sampleCameraOpticalFlow(dt);

      if (this.pressedKeys.size > 0) {
        const keySpeed = 1.45 * dt;
        const left = this.pressedKeys.has('ArrowLeft') || this.pressedKeys.has('a') || this.pressedKeys.has('A');
        const right = this.pressedKeys.has('ArrowRight') || this.pressedKeys.has('d') || this.pressedKeys.has('D');
        const up = this.pressedKeys.has('ArrowUp') || this.pressedKeys.has('w') || this.pressedKeys.has('W');
        const down = this.pressedKeys.has('ArrowDown') || this.pressedKeys.has('s') || this.pressedKeys.has('S');
        if (left) this.yawRad += keySpeed;
        if (right) this.yawRad -= keySpeed;
        if (up) {
          this.pitchRad = THREE.MathUtils.clamp(this.pitchRad + keySpeed, -1.38, 1.38);
        }
        if (down) {
          this.pitchRad = THREE.MathUtils.clamp(this.pitchRad - keySpeed, -1.38, 1.38);
        }
        this.lastSeen.keyboard = now;
      }

      const hwQuatFresh =
        now - this.lastSeen.absQuat < 250 ||
        (this.relYawHasVaried && now - this.lastSeen.relQuat < 250);

      if (!hwQuatFresh && this.mode !== 'camera-flow') {
        const compassFresh = now - this.lastSeen.compass < SENSOR_STALE_MS;
        const gyroFresh = now - this.lastSeen.gyro < SENSOR_STALE_MS;
        const gravityFresh = now - this.lastSeen.gravity < SENSOR_STALE_MS;
        const accelFresh = now - this.lastSeen.accel < SENSOR_STALE_MS;
        const orientEulerFresh = now - this.lastSeen.orientEuler < SENSOR_STALE_MS;
        const camFlowFresh = now - this.lastSeen.cameraFlow < SENSOR_STALE_MS;

        if (compassFresh) {
          const deltaYaw = this.shortestAngleDiff(this.yawRad, this.latestCompassYawRad);
          const yawAlpha = this.mode === 'compass-only' || !gyroFresh ? this.smoothing : 0.04;
          this.yawRad += deltaYaw * yawAlpha;
        }

        if (this.mode !== 'compass-only' && (gravityFresh || accelFresh)) {
          const tiltAlpha = gyroFresh ? 0.045 : this.smoothing * 0.65;
          this.pitchRad = THREE.MathUtils.lerp(this.pitchRad, this.latestGravityPitch, tiltAlpha);
          this.rollRad = THREE.MathUtils.lerp(this.rollRad, this.latestGravityRoll, tiltAlpha);
        } else if (orientEulerFresh) {
          this.pitchRad = THREE.MathUtils.lerp(this.pitchRad, this.latestOrientPitch, this.smoothing);
          this.rollRad = THREE.MathUtils.lerp(this.rollRad, this.latestOrientRoll, this.smoothing);
        }

        // Fallback for accelerometer-only phones with no gyro/compass/camera-flow:
        // gentle head tilt left/right beyond 8 deg pans smoothly across all 360° sides
        if (
          this.mode === 'auto' &&
          !compassFresh &&
          !gyroFresh &&
          !camFlowFresh &&
          (gravityFresh || accelFresh || orientEulerFresh) &&
          Math.abs(this.rollRad) > 0.14
        ) {
          const excess = this.rollRad - Math.sign(this.rollRad) * 0.14;
          this.yawRad += excess * 1.45 * dt;
        }

        // Keep quaternion synced with fused Euler angles
        this._hwEuler.set(this.pitchRad, this.yawRad, this.rollRad, 'YXZ');
        this._headQuat.setFromEuler(this._hwEuler);
      }

      // Spring-damped neck-model micro-parallax from LinearAcceleration
      if (now - this.lastSeen.linearAccel < SENSOR_STALE_MS) {
        this._neckOffset.addScaledVector(this._neckVel, dt);
        this._neckOffset.clampLength(0, 0.055);
      }
      this._neckVel.multiplyScalar(Math.exp(-8 * dt));
      this._neckOffset.multiplyScalar(Math.exp(-5 * dt));

      if (this.demoSweepActive) {
        this.demoSweepPhase += dt * 1.15;
        this.yawRad = this.yawZeroOffsetRad + Math.sin(this.demoSweepPhase) * 0.45;
        this.pitchRad = Math.sin(this.demoSweepPhase * 1.7) * 0.14;
        this.rollRad = Math.cos(this.demoSweepPhase * 0.9) * 0.08;
        this.rawCompassDeg = (((this.yawRad * RAD_TO_DEG) % 360) + 360) % 360;
      }
    }

    const hw = this.getHardwareAvailability(now, isXrPresenting);
    const hasActiveHardwareDriver =
      hw.orientationSensor ||
      hw.compass ||
      hw.gyro ||
      hw.accel ||
      hw.cameraFlow ||
      this.mode === 'camera-flow' ||
      now - this.lastSeen.keyboard < 5000 ||
      this.demoSweepActive;

    // Update Jump, Crouch & Walk/Run 3D locomotion physics
    if (now > this.crouchUntil) {
      this.crouchTargetY = 0;
    }
    this.crouchOffsetY = THREE.MathUtils.lerp(
      this.crouchOffsetY,
      this.crouchTargetY,
      Math.min(1, dt * 8.5)
    );

    if (this.isAirborne) {
      this.jumpHeightY += this.jumpVelY * dt;
      this.jumpVelY -= 11.8 * dt;
      if (this.jumpHeightY <= 0) {
        this.jumpHeightY = 0;
        this.jumpVelY = 0;
        this.isAirborne = false;
        this.pendingLandEvent = true;
        this.locomotionState = now <= this.locoHoldUntil ? 'walk' : 'idle';
      } else {
        this.locomotionState = 'jump';
      }
    } else if (now > this.locoHoldUntil) {
      this.locoSpeed = THREE.MathUtils.lerp(this.locoSpeed, 0, Math.min(1, dt * 7.5));
      if (this.locoSpeed < 0.15) {
        this.locoSpeed = 0;
        this.locomotionState =
          Math.abs(this.crouchOffsetY) > 0.08 || this.crouchTargetY < -0.05
            ? 'crouch'
            : 'idle';
      }
    }

    let bobOffsetY = 0;
    if (this.locomotionEnabled && xb.core.camera && !isXrPresenting) {
      if (this.locoSpeed > 0.15) {
        xb.core.camera.getWorldDirection(this._camFwdXZ);
        this._camFwdXZ.y = 0;
        if (this._camFwdXZ.lengthSq() > 1e-4) {
          this._camFwdXZ.normalize();
          this._locoOffsetXZ.addScaledVector(
            this._camFwdXZ,
            this.visMoveSign * this.locoSpeed * 0.48 * dt
          );
          if (this._locoOffsetXZ.length() > 6.5) {
            this._locoOffsetXZ.setLength(6.5);
          }
        }
        const isRun = this.locomotionState === 'run';
        this.walkBobPhase += dt * (isRun ? 13 : 8.5);
        bobOffsetY = Math.abs(Math.sin(this.walkBobPhase)) * (isRun ? 0.048 : 0.025);
      }
    }

    if (!isXrPresenting && this.mode !== 'off' && hasActiveHardwareDriver && xb.core.camera) {
      if (!this.hasBaseCamPos) {
        this._baseCamPos.copy(xb.core.camera.position);
        this.hasBaseCamPos = true;
      }

      const relativeYaw = (this.yawRad - this.yawZeroOffsetRad) * this.sensitivity;
      const clampedPitch = THREE.MathUtils.clamp(
        (this.pitchRad + this.dragPitchBias) * this.sensitivity,
        -1.4,
        1.4
      );
      const clampedRoll = THREE.MathUtils.clamp(this.rollRad * 0.72, -0.78, 0.78);

      this._targetEuler.set(clampedPitch, relativeYaw, clampedRoll, 'YXZ');
      this._targetQuat.setFromEuler(this._targetEuler);

      // Velocity-adaptive One-Euro Quaternion Smoother + bounded predictive look-ahead
      this.madgwick.filterOutput(
        this._targetQuat,
        Math.max(dt, 0.004),
        this.smoothing,
        this._smoothedTargetQuat
      );
      xb.core.camera.quaternion.copy(this._smoothedTargetQuat);

      // Anatomical cervical neck-pivot translation offset (reduces rotational sickness)
      this._neckPivotVec.copy(this._neckPivotRest).applyQuaternion(this._smoothedTargetQuat);
      this._neckPivotVec.sub(this._neckPivotRest);

      xb.core.camera.position
        .copy(this._baseCamPos)
        .add(this._locoOffsetXZ)
        .add(this._neckOffset)
        .add(this._neckPivotVec);
      xb.core.camera.position.y += this.jumpHeightY + bobOffsetY + this.crouchOffsetY;
    } else if (
      !isXrPresenting &&
      xb.core.camera &&
      (this.isAirborne || this.locoSpeed > 0.1 || Math.abs(this.crouchOffsetY) > 0.01)
    ) {
      if (!this.hasBaseCamPos) {
        this._baseCamPos.copy(xb.core.camera.position);
        this.hasBaseCamPos = true;
      }
      xb.core.camera.position.copy(this._baseCamPos).add(this._locoOffsetXZ);
      xb.core.camera.position.y += this.jumpHeightY + bobOffsetY + this.crouchOffsetY;
    }

    // Track head angular velocity on camera/head pose for Nod & Shake gestures
    if (xb.core.camera && dt > 0.001) {
      const angles = this.getHeadAngles();
      if (!this.hasPrevCamAngles) {
        this.prevCamYaw = angles.yaw;
        this.prevCamPitch = angles.pitch;
        this.hasPrevCamAngles = true;
      } else {
        const dyaw = this.shortestAngleDiff(this.prevCamYaw, angles.yaw);
        const dpitch = angles.pitch - this.prevCamPitch;
        this.prevCamYaw = angles.yaw;
        this.prevCamPitch = angles.pitch;

        const yawRate = dyaw / dt;
        const pitchRate = dpitch / dt;

        // Sharp downward nod followed by upward return within 420ms
        if (pitchRate < -1.45 && Math.abs(yawRate) < 1.2) {
          this.nodDownAt = now;
        } else if (
          pitchRate > 1.35 &&
          now - this.nodDownAt < 420 &&
          now - this.lastNodTriggeredAt > 800
        ) {
          this.pendingNod = true;
          this.lastNodTriggeredAt = now;
          this.nodDownAt = 0;
        }

        // Crisp left-right head shake reversal within 460ms
        if (Math.abs(yawRate) > 2.0 && Math.abs(pitchRate) < 1.2) {
          const sign = Math.sign(yawRate);
          if (this.shakeSwingSign !== 0 && sign !== this.shakeSwingSign && now - this.shakeSwingAt < 460) {
            if (now - this.lastShakeTriggeredAt > 1100) {
              this.pendingShake = true;
              this.lastShakeTriggeredAt = now;
              this.shakeSwingSign = 0;
            }
          } else {
            this.shakeSwingSign = sign;
            this.shakeSwingAt = now;
          }
        }
      }
    }
  }

  private getHardwareAvailability(now: number, isXrPresenting: boolean): HardwareAvailability {
    return {
      webxr: isXrPresenting,
      orientationSensor:
        now - this.lastSeen.absQuat < SENSOR_STALE_MS ||
        now - this.lastSeen.relQuat < SENSOR_STALE_MS,
      compass: now - this.lastSeen.compass < SENSOR_STALE_MS,
      gyro: now - this.lastSeen.gyro < SENSOR_STALE_MS,
      accel:
        now - this.lastSeen.gravity < SENSOR_STALE_MS ||
        now - this.lastSeen.accel < SENSOR_STALE_MS ||
        now - this.lastSeen.orientEuler < SENSOR_STALE_MS,
      linearAccel: now - this.lastSeen.linearAccel < SENSOR_STALE_MS,
      cameraFlow:
        (this.cameraFlowEnabled || this.autoFlowEnabled) &&
        now - this.lastSeen.cameraFlow < SENSOR_STALE_MS,
      touchDrag: true,
    };
  }

  getTelemetry(): SensorTelemetry {
    const now = performance.now();
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    const isXrPresenting = Boolean(renderer?.xr?.isPresenting);
    const hw = this.getHardwareAvailability(now, isXrPresenting);
    const relativeYawDeg = ((this.yawRad - this.yawZeroOffsetRad) * RAD_TO_DEG) % 360;

    const activeSources: string[] = [];
    if (hw.webxr) activeSources.push('WebXR');
    if (hw.orientationSensor) activeSources.push('OrientSensor');
    if (hw.gyro) activeSources.push('Gyro');
    if (hw.accel) activeSources.push('Accel/Gravity');
    if (hw.linearAccel) activeSources.push('LinAccel');
    if (hw.compass) activeSources.push('Compass');
    if (hw.cameraFlow) activeSources.push('CamFlow');

    let statusLabel = 'Fallback: Mouse / Arrow Keys';
    if (isXrPresenting) {
      statusLabel = 'WebXR Native 6DoF Active';
    } else if (this.demoSweepActive) {
      statusLabel = 'Simulated Head Sweep';
    } else if (this.mode === 'off') {
      statusLabel = 'Sensor Tracking Paused';
    } else if (this.mode === 'camera-flow') {
      statusLabel = hw.cameraFlow
        ? 'Back-Cam Head & Walk/Run/Jump Active'
        : 'Starting Back-Camera Tracking...';
    } else if (activeSources.length > 0) {
      statusLabel = `Fusing: ${activeSources.join(' + ')}`;
    } else if (this.permissionState === 'denied') {
      statusLabel = 'Sensor Denied (CamFlow/Keys Fallback)';
    }

    return {
      active: activeSources.length > 0 || this.demoSweepActive || isXrPresenting,
      permissionState: this.permissionState,
      hardware: hw,
      activeSourcesLabel: activeSources.length > 0 ? activeSources.join(' • ') : 'Simulator / Arrows',
      hasCompass: hw.compass,
      hasGyro: hw.gyro,
      hasAccel: hw.accel,
      gyroCalibrated: this.gyroCalibrated,
      fusionAlgorithm: isXrPresenting
        ? 'WebXR 6DoF Native'
        : this.fusionAlgorithmLabel,
      fusionBeta: Number(this.madgwick.getActiveBeta().toFixed(3)),
      compassHeadingDeg: Math.round(((this.rawCompassDeg % 360) + 360) % 360),
      yawDeg: Math.round(relativeYawDeg),
      pitchDeg: Math.round(this.pitchRad * RAD_TO_DEG),
      rollDeg: Math.round(this.rollRad * RAD_TO_DEG),
      sampleHz: this.demoSweepActive ? 60 : this.sampleHz,
      cardboardStereo: this.cardboardStereo,
      mode: this.mode,
      statusLabel,
      locomotion: {
        enabled: this.locomotionEnabled,
        state: this.locomotionState,
        moveDirection:
          this.locoSpeed > 0.15
            ? this.visMoveSign < 0
              ? 'backward'
              : 'forward'
            : 'none',
        crouching: Math.abs(this.crouchOffsetY) > 0.08 || this.crouchTargetY < -0.05,
        stepCount: this.stepCount,
        cadenceSpm:
          this.locomotionState === 'idle' || this.locomotionState === 'crouch'
            ? 0
            : this.cadenceSpm,
        speedMps: Number(this.locoSpeed.toFixed(1)),
        jumpHeightM: Number(this.jumpHeightY.toFixed(2)),
        verticalAccelMs2: Number(this.latestVertAcc.toFixed(1)),
      },
    };
  }

  getHeadAngles(): {yaw: number; pitch: number; roll: number} {
    if (xb.core.camera) {
      this._targetEuler.setFromQuaternion(xb.core.camera.quaternion, 'YXZ');
      return {
        yaw: this._targetEuler.y,
        pitch: this._targetEuler.x,
        roll: this._targetEuler.z,
      };
    }
    return {
      yaw: this.yawRad - this.yawZeroOffsetRad,
      pitch: this.pitchRad,
      roll: this.rollRad,
    };
  }

  consumeHeadMotionSignals(): {
    yaw: number;
    pitch: number;
    roll: number;
    nod: boolean;
    shake: boolean;
    headsetTap: boolean;
    accelMag: number;
    stepEvent: 'none' | 'walk' | 'run';
    locoState: 'idle' | 'walk' | 'run' | 'jump' | 'crouch';
    moveDirection: 'forward' | 'backward';
    crouching: boolean;
    speedMps: number;
    jumpHeightM: number;
    jumped: boolean;
    landed: boolean;
  } {
    const angles = this.getHeadAngles();
    const nod = this.pendingNod;
    const shake = this.pendingShake;
    const headsetTap = this.pendingTap;
    const stepEvent = this.pendingStepKind;
    const jumped = this.pendingJumpEvent;
    const landed = this.pendingLandEvent;
    this.pendingNod = false;
    this.pendingShake = false;
    this.pendingTap = false;
    this.pendingStepKind = 'none';
    this.pendingJumpEvent = false;
    this.pendingLandEvent = false;
    return {
      ...angles,
      nod,
      shake,
      headsetTap,
      accelMag: this.latestLinearAccelMag,
      stepEvent,
      locoState: this.locomotionState,
      moveDirection: this.visMoveSign < 0 ? 'backward' : 'forward',
      crouching: Math.abs(this.crouchOffsetY) > 0.08 || this.crouchTargetY < -0.05,
      speedMps: this.locoSpeed,
      jumpHeightM: this.jumpHeightY,
      jumped,
      landed,
    };
  }

  dispose(): void {
    this.removeFirstInteractionCamListeners();
    this.stopGenericSensors();
    this.stopCameraOpticalFlow();
    if (this.wakeLockSentinel) {
      void this.wakeLockSentinel.release().catch(() => {});
      this.wakeLockSentinel = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener(
        'deviceorientationabsolute',
        this.onDeviceOrientation as EventListener,
        true
      );
      window.removeEventListener('deviceorientation', this.onDeviceOrientation, true);
      window.removeEventListener('devicemotion', this.onDeviceMotion, true);
      window.removeEventListener('keydown', this.handleWindowKeyDown);
      window.removeEventListener('keyup', this.handleWindowKeyUp);
      window.removeEventListener('pointerdown', this.handleCanvasPointerDown);
      window.removeEventListener('pointermove', this.handleCanvasPointerMove);
      window.removeEventListener('pointerup', this.handleCanvasPointerUp);
      window.removeEventListener('pointercancel', this.handleCanvasPointerUp);
    }
    xb.core.renderSceneOverride = undefined;
  }
}
