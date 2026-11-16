import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {AirTouchPlayground} from '../environment/AirTouchPlayground.ts';
import {HeadGazeTelemetry, PlayableModeId} from '../types.ts';
import {computeSafeUIWorldBounds} from '../ui/uiBounds.ts';
import {SensorFusionTracker} from './SensorFusionTracker.ts';

export interface HeadGazeCallbacks {
  getGameMode: () => 'hub' | PlayableModeId;
  onScreenAction: (hitPoint: THREE.Vector3) => void;
  onFireFromGaze: (origin: THREE.Vector3, dir: THREE.Vector3) => void;
  onBoost: () => void;
  onExitToHub: () => void;
  onJump?: () => void;
  onStep?: (running: boolean) => void;
  onStatusUpdate?: (label: string) => void;
}

const DWELL_UI_SEC = 1.05;
const DWELL_SLIDER_SEC = 0.55;
const DWELL_SCREEN_SEC = 1.25;
const DWELL_DRONE_SEC = 0.42;
const LOOK_DOWN_RECENTER_SEC = 1.15;

export class HeadGazeController extends xb.Script {
  private readonly sensors: SensorFusionTracker;
  private readonly sound: SoundEngine;
  private readonly callbacks: HeadGazeCallbacks;

  private interactiveRoots: THREE.Object3D[] = [];
  private playground: AirTouchPlayground | null = null;
  private theaterScreen: THREE.Object3D | null = null;
  private droneRoots: THREE.Object3D[] = [];

  private enabled = true;
  private tapClickEnabled = true;

  // 3D Gaze Reticle visuals
  private reticleGroup = new THREE.Group();
  private centerDotMat: THREE.MeshBasicMaterial;
  private outerRingMat: THREE.MeshBasicMaterial;
  private progressRingMesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private progressRingGeo: THREE.RingGeometry;
  private progressSteps: THREE.RingGeometry[] = [];
  private readonly disposables: Array<{dispose: () => void}> = [];

  // Dwell & gesture state
  private currentTarget: object | null = null;
  private currentTargetKind: 'button' | 'slider' | 'input' | 'scroll' | 'screen' | 'toy' | 'none' =
    'none';
  private currentTargetLabel = '';
  private dwellElapsed = 0;
  private dwellTriggered = false;
  private lookDownElapsed = 0;
  private lookDownTriggered = false;
  private lastActionLabel = 'Gaze 1.0s • Nod/Tap = Click • Shake = Back • Tilt = Scroll';
  private lastActionExpiresAt = 0;
  private lastTriggerAt = 0;

  // Zero-GC scratch objects
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camDir = new THREE.Vector3();
  private readonly _hitPoint = new THREE.Vector3();
  private readonly _box = new THREE.Box3();
  private readonly _rayHit = new THREE.Vector3();
  private readonly _hitBox = new THREE.Box3();

  constructor(
    sensors: SensorFusionTracker,
    sound: SoundEngine,
    callbacks: HeadGazeCallbacks
  ) {
    super();
    this.sensors = sensors;
    this.sound = sound;
    this.callbacks = callbacks;

    this.reticleGroup.name = 'Head Gaze Reticle';
    this.reticleGroup.xb = {pointerEvents: 'none'};

    const dotGeo = new THREE.CircleGeometry(0.0045, 16);
    this.centerDotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.88,
      depthTest: false,
      depthWrite: false,
    });
    const dotMesh = new THREE.Mesh(dotGeo, this.centerDotMat);
    dotMesh.renderOrder = 1202;
    dotMesh.xb = {pointerEvents: 'none'};

    const outerGeo = new THREE.RingGeometry(0.011, 0.0145, 28);
    this.outerRingMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const outerMesh = new THREE.Mesh(outerGeo, this.outerRingMat);
    outerMesh.renderOrder = 1201;
    outerMesh.xb = {pointerEvents: 'none'};

    // Prebuild 24 radial progress arc geometries (zero GC during runtime!)
    const ringCount = 24;
    for (let i = 0; i <= ringCount; i++) {
      const frac = i / ringCount;
      const g = new THREE.RingGeometry(
        0.0155,
        0.0225,
        28,
        1,
        Math.PI / 2,
        Math.max(0.001, frac * Math.PI * 2)
      );
      this.progressSteps.push(g);
      this.disposables.push(g);
    }

    this.progressRingGeo = this.progressSteps[0];
    const progressMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.progressRingMesh = new THREE.Mesh(this.progressRingGeo, progressMat);
    this.progressRingMesh.renderOrder = 1203;
    this.progressRingMesh.visible = false;
    this.progressRingMesh.xb = {pointerEvents: 'none'};

    this.reticleGroup.add(outerMesh, dotMesh, this.progressRingMesh);
    this.disposables.push(
      dotGeo,
      this.centerDotMat,
      outerGeo,
      this.outerRingMat,
      progressMat
    );
  }

  init(): void {
    this.add(this.reticleGroup);
  }

  registerInteractiveRoots(roots: THREE.Object3D[]): void {
    this.interactiveRoots = roots;
  }

  registerPlayground(playground: AirTouchPlayground): void {
    this.playground = playground;
  }

  registerTheaterScreen(screenMesh: THREE.Object3D): void {
    this.theaterScreen = screenMesh;
  }

  registerDroneContainer(container: THREE.Object3D): void {
    this.droneRoots = [container];
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.reticleGroup.visible = enabled;
    if (!enabled) {
      this.resetDwell();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setTapClickEnabled(enabled: boolean): void {
    this.tapClickEnabled = enabled;
  }

  isTapClickEnabled(): boolean {
    return this.tapClickEnabled;
  }

  private resetDwell(): void {
    this.currentTarget = null;
    this.currentTargetKind = 'none';
    this.currentTargetLabel = '';
    this.dwellElapsed = 0;
    this.dwellTriggered = false;
    this.progressRingMesh.visible = false;
  }

  private setProgressArc(progress: number, colorHex: number): void {
    const p = THREE.MathUtils.clamp(progress, 0, 1);
    if (p <= 0.03) {
      this.progressRingMesh.visible = false;
      return;
    }
    const idx = Math.min(
      this.progressSteps.length - 1,
      Math.max(1, Math.round(p * (this.progressSteps.length - 1)))
    );
    this.progressRingMesh.geometry = this.progressSteps[idx];
    this.progressRingMesh.material.color.setHex(colorHex);
    this.progressRingMesh.visible = true;
  }

  private setStatusBanner(label: string): void {
    this.lastActionLabel = label;
    this.lastActionExpiresAt = performance.now() + 2400;
    this.callbacks.onStatusUpdate?.(label);
  }

  update(): void {
    const cam = xb.core.camera as THREE.PerspectiveCamera | undefined;
    if (!cam) return;

    this.reticleGroup.visible = this.enabled;
    if (!this.enabled) return;

    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const now = performance.now();
    const motion = this.sensors.consumeHeadMotionSignals();
    const mode = this.callbacks.getGameMode();

    // Handle Walk / Run / Jump physical sensor events even if reticle doesn't hit UI
    if (motion.jumped) {
      this.sound.playJump();
      this.callbacks.onJump?.();
      this.setStatusBanner('Sensed: JUMP!');
    } else if (motion.landed) {
      this.sound.playLanding();
    } else if (motion.stepEvent !== 'none') {
      const running = motion.stepEvent === 'run';
      this.sound.playFootstep(running);
      this.callbacks.onStep?.(running);
      this.setStatusBanner(running ? 'Sensed: RUNNING!' : 'Sensed: WALKING');
    }

    cam.updateMatrixWorld();
    cam.getWorldPosition(this._camPos);
    cam.getWorldDirection(this._camDir);
    this._raycaster.set(this._camPos, this._camDir);

    // 1. Back / Exit gesture: Head shake exits any launched app or game back to VR Hub
    if (motion.shake) {
      if (mode !== 'hub') {
        this.sound.playClick();
        this.callbacks.onExitToHub();
        this.setStatusBanner('Head Shake -> Exited to VR Play Hub');
      } else {
        this.sensors.recenter();
        this.sound.playClick();
        this.setStatusBanner('Head Shake -> Recentered Horizon');
      }
      this.resetDwell();
    }

    // 2. Look-Down Recenter (looking below -45 deg for 1.15s centers forward view hands-free)
    if (motion.pitch < -0.78) {
      this.lookDownElapsed += dt;
      if (this.lookDownElapsed >= LOOK_DOWN_RECENTER_SEC && !this.lookDownTriggered) {
        this.lookDownTriggered = true;
        this.sensors.recenter();
        this.sound.playInstallComplete();
        this.setStatusBanner('Look-Down Recenter Complete');
      }
    } else {
      this.lookDownElapsed = 0;
      this.lookDownTriggered = false;
    }

    // 3. Find closest interactive target along head center gaze ray
    let bestDist = 8.0;
    let hitTarget: object | null = null;
    let hitKind: 'button' | 'slider' | 'input' | 'scroll' | 'screen' | 'toy' | 'none' = 'none';
    let hitLabel = '';
    this._hitPoint.copy(this._camPos).addScaledVector(this._camDir, 1.8);

    // 3a. Interactive UI elements (buttons, sliders, text inputs, scroll views)
    const uiHit = this.findBestGazedUI();
    if (uiHit && uiHit.distance < bestDist) {
      bestDist = uiHit.distance;
      hitTarget = uiHit.element;
      hitKind = uiHit.kind;
      this._hitPoint.copy(uiHit.point);
      this._hitBox.copy(uiHit.box);

      if (uiHit.kind === 'button') {
        const btn = uiHit.element as xb.UIButton;
        hitLabel = btn.label || btn.ariaLabel || 'Menu Button';
      } else if (uiHit.kind === 'slider') {
        hitLabel = (uiHit.element as xb.UISlider).ariaLabel || 'Slider';
      } else if (uiHit.kind === 'input') {
        hitLabel = 'Search / Package Input';
      } else {
        hitLabel = 'App List (Tilt Left/Right to Scroll)';
      }
    }

    // 3b. Floating 3D Playground toys & Cosmic Blaster drones
    if (!hitTarget && this.playground) {
      const toyHits = this._raycaster.intersectObjects(this.playground.getTouchableMeshes(), false);
      if (toyHits.length > 0 && toyHits[0].distance < bestDist) {
        bestDist = toyHits[0].distance;
        hitTarget = toyHits[0].object;
        hitKind = 'toy';
        hitLabel = toyHits[0].object.name || '3D Object';
        this._hitPoint.copy(toyHits[0].point);
      }
    }

    // 3c. Cosmic Blaster 3D drones around 360° sphere
    if (!hitTarget && mode === 'cosmic-blaster' && this.droneRoots.length > 0) {
      for (const root of this.droneRoots) {
        const hits = this._raycaster.intersectObjects(root.children, true);
        if (hits.length > 0 && hits[0].distance < bestDist) {
          bestDist = hits[0].distance;
          hitTarget = hits[0].object;
          hitKind = 'toy';
          hitLabel = 'Target Drone (Lock-On)';
          this._hitPoint.copy(hits[0].point);
        }
      }
    }

    // 3d. Curved Theater Screen
    if (!hitTarget && this.theaterScreen) {
      const screenHits = this._raycaster.intersectObject(this.theaterScreen, false);
      if (screenHits.length > 0 && screenHits[0].distance < bestDist) {
        bestDist = screenHits[0].distance;
        hitTarget = this.theaterScreen;
        hitKind = 'screen';
        hitLabel =
          mode === 'hub'
            ? 'Curved Screen (Nod/Dwell to Launch)'
            : mode === 'google-workspace'
              ? 'Live Google Screen (Dwell to Refresh)'
              : 'VR Theater Screen';
        this._hitPoint.copy(screenHits[0].point);
      }
    }

    // Position the 3D gaze reticle just slightly toward the camera from the hit point
    const reticleDist = Math.max(0.45, bestDist - 0.02);
    this.reticleGroup.position.copy(this._camPos).addScaledVector(this._camDir, reticleDist);
    this.reticleGroup.lookAt(this._camPos);
    // Keep apparent reticle angular size consistent across distances
    const angularScale = THREE.MathUtils.clamp(reticleDist / 1.35, 0.55, 2.2);
    this.reticleGroup.scale.setScalar(angularScale);

    const instantTrigger =
      motion.nod || (this.tapClickEnabled && motion.headsetTap);

    // 4. Continuous Roll-Tilt / Top-Bottom Edge Gaze Scrolling when looking at Play Store catalog
    if (hitKind === 'scroll' && hitTarget instanceof xb.UIScrollView) {
      let scrollDelta = 0;
      if (Math.abs(motion.roll) > 0.28) {
        // Tilt head left/right (>16 deg) to scroll smoothly
        scrollDelta = -Math.sign(motion.roll) * (Math.abs(motion.roll) - 0.28) * 620 * dt;
      } else if (!this._hitBox.isEmpty()) {
        // Or look near top/bottom 22% of catalog list to auto-scroll gently
        const ySpan = Math.max(0.05, this._hitBox.max.y - this._hitBox.min.y);
        const relY = (this._hitPoint.y - this._hitBox.min.y) / ySpan;
        if (relY > 0.78) {
          scrollDelta = -220 * dt;
        } else if (relY < 0.22) {
          scrollDelta = 220 * dt;
        }
      }
      if (Math.abs(scrollDelta) > 0.1) {
        hitTarget.scrollTop = Math.max(0, hitTarget.scrollTop + scrollDelta);
      }
    }

    // 5. Dwell state machine + Instant Nod / Headset Tap trigger
    const targetChanged = hitTarget !== this.currentTarget;
    if (targetChanged) {
      this.currentTarget = hitTarget;
      this.currentTargetKind = hitKind;
      this.currentTargetLabel = hitLabel;
      this.dwellElapsed = 0;
      this.dwellTriggered = false;
      if (hitTarget && hitKind !== 'scroll') {
        this.sound.playHoverTick();
      }
    }

    if (this.lookDownElapsed > 0.2) {
      const p = this.lookDownElapsed / LOOK_DOWN_RECENTER_SEC;
      this.setProgressArc(p, 0xfbbf24);
      this.outerRingMat.color.setHex(0xfbbf24);
    } else if (hitTarget && hitKind !== 'scroll') {
      const isDisabledBtn =
        hitKind === 'button' && Boolean((hitTarget as xb.UIButton).disabled);

      if (!isDisabledBtn) {
        this.dwellElapsed += dt;
        const requiredSec =
          hitKind === 'slider'
            ? DWELL_SLIDER_SEC
            : hitKind === 'toy' && mode === 'cosmic-blaster'
              ? DWELL_DRONE_SEC
              : hitKind === 'screen'
                ? DWELL_SCREEN_SEC
                : DWELL_UI_SEC;

        const progress = Math.min(1, this.dwellElapsed / requiredSec);
        this.outerRingMat.color.setHex(hitKind === 'toy' ? 0xf43f5e : 0x34d399);
        this.setProgressArc(progress, hitKind === 'toy' ? 0xf43f5e : 0x34d399);

        const canFireCooldown = now - this.lastTriggerAt > 420;
        if (
          canFireCooldown &&
          ((!this.dwellTriggered && this.dwellElapsed >= requiredSec) || instantTrigger)
        ) {
          this.dwellTriggered = true;
          this.lastTriggerAt = now;
          this.executeGazeTrigger(hitTarget, hitKind, mode);
          if (hitKind === 'slider' || (hitKind === 'toy' && mode === 'cosmic-blaster')) {
            // Allow repeating nudges on sliders or rapid lock-on firing
            this.dwellElapsed = 0;
            this.dwellTriggered = false;
          }
        }
      } else {
        this.outerRingMat.color.setHex(0x64748b);
        this.setProgressArc(0, 0x64748b);
      }
    } else {
      this.outerRingMat.color.setHex(0x38bdf8);
      this.setProgressArc(0, 0x38bdf8);

      // Even if gazing at empty space, Head Nod fires in Cosmic Blaster or boosts in Neon Racer
      if (instantTrigger && now - this.lastTriggerAt > 360) {
        this.lastTriggerAt = now;
        if (mode === 'cosmic-blaster') {
          this.callbacks.onFireFromGaze(this._camPos, this._camDir);
          this.setStatusBanner(motion.nod ? 'Head Nod -> Fired Plasma!' : 'Headset Tap -> Fired!');
        } else if (mode === 'neon-racer') {
          this.callbacks.onBoost();
          this.setStatusBanner('Head Nod -> Nitro Boost!');
        }
      }
    }

    if (now > this.lastActionExpiresAt) {
      this.lastActionLabel =
        hitTarget && hitLabel
          ? `Gazing: ${hitLabel}`
          : 'Gaze 1.0s • Nod/Tap = Click • Shake = Back • Tilt = Scroll';
    }
  }

  private executeGazeTrigger(
    target: object,
    kind: 'button' | 'slider' | 'input' | 'scroll' | 'screen' | 'toy' | 'none',
    mode: 'hub' | PlayableModeId
  ): void {
    if (kind === 'button') {
      const btn = target as xb.UIButton;
      if (!btn.disabled) {
        this.sound.playClick();
        btn.onClick?.();
        const label = btn.label || btn.ariaLabel || 'Button';
        this.setStatusBanner(`Sensor Click: ${label}`);
      }
    } else if (kind === 'slider') {
      const slider = target as xb.UISlider;
      const t = THREE.MathUtils.clamp(
        (this._hitPoint.x - this._hitBox.min.x) /
          Math.max(0.02, this._hitBox.max.x - this._hitBox.min.x),
        0,
        1
      );
      const raw = slider.min + t * (slider.max - slider.min);
      const stepped = slider.step > 0 ? Math.round(raw / slider.step) * slider.step : raw;
      const val = THREE.MathUtils.clamp(stepped, slider.min, slider.max);
      slider.value = val;
      slider.onInput?.(val);
      this.sound.playClick();
      this.setStatusBanner(`Adjusted Slider -> ${Math.round(val)}`);
    } else if (kind === 'input') {
      const input = target as xb.UITextInput;
      try {
        input.focus();
      } catch {}
      this.sound.playClick();
      this.setStatusBanner('Focused Search / Package Input');
    } else if (kind === 'toy') {
      if (mode === 'cosmic-blaster') {
        this.callbacks.onFireFromGaze(this._camPos, this._camDir);
        this.setStatusBanner('Head-Aim Lock -> Fired!');
      } else if (this.playground) {
        const hitName = this.playground.touchObject(
          target as THREE.Object3D,
          this._hitPoint,
          this._camDir
        );
        if (hitName) {
          this.setStatusBanner(`Gaze-Touched ${hitName}`);
        }
      }
    } else if (kind === 'screen') {
      this.callbacks.onScreenAction(this._hitPoint);
      this.setStatusBanner('Gaze Triggered VR Theater Screen');
    }
  }

  private findBestGazedUI(): {
    kind: 'button' | 'slider' | 'input' | 'scroll';
    element: xb.UIButton | xb.UISlider | xb.UITextInput | xb.UIScrollView;
    point: THREE.Vector3;
    distance: number;
    box: THREE.Box3;
  } | null {
    let best: {
      kind: 'button' | 'slider' | 'input' | 'scroll';
      element: xb.UIButton | xb.UISlider | xb.UITextInput | xb.UIScrollView;
      point: THREE.Vector3;
      distance: number;
      box: THREE.Box3;
    } | null = null;
    let bestScoreDist = 6.5;

    for (const root of this.interactiveRoots) {
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
                  : null;
        if (!kind) return;

        const pres = xb.getUIPresentationObject(obj);
        if (!computeSafeUIWorldBounds(pres, this._box)) return;

        this._box.expandByScalar(0.008);
        const hit = this._raycaster.ray.intersectBox(this._box, this._rayHit);
        if (hit) {
          const dist = this._camPos.distanceTo(hit);
          // Always prioritize actionable buttons/sliders/inputs over their parent ScrollView
          const priorityBias = kind === 'scroll' ? 0.14 : 0;
          if (dist + priorityBias < bestScoreDist) {
            bestScoreDist = dist + priorityBias;
            best = {
              kind,
              element: obj as xb.UIButton | xb.UISlider | xb.UITextInput | xb.UIScrollView,
              point: hit.clone(),
              distance: dist,
              box: this._box.clone(),
            };
          }
        }
      });
    }

    return best;
  }

  getTelemetry(): HeadGazeTelemetry {
    const requiredSec =
      this.currentTargetKind === 'slider'
        ? DWELL_SLIDER_SEC
        : this.currentTargetKind === 'screen'
          ? DWELL_SCREEN_SEC
          : DWELL_UI_SEC;
    return {
      enabled: this.enabled,
      tapClickEnabled: this.tapClickEnabled,
      hoveredLabel: this.currentTargetLabel,
      dwellProgress:
        this.currentTarget && this.currentTargetKind !== 'scroll'
          ? Math.min(1, this.dwellElapsed / requiredSec)
          : 0,
      sensorActionLabel: this.lastActionLabel,
    };
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
