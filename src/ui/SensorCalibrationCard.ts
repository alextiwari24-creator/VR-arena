import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';
import {MobileVREngine} from '../engine/MobileVREngine.ts';
import {HandGestureController} from '../gestures/HandGestureController.ts';
import {HeadGazeController} from '../sensors/HeadGazeController.ts';
import {SensorFusionTracker} from '../sensors/SensorFusionTracker.ts';
import {SensorTrackingMode} from '../types.ts';

export class SensorCalibrationCard extends xb.UICard {
  private readonly sensors: SensorFusionTracker;
  private readonly gestures?: HandGestureController;
  private readonly headGaze?: HeadGazeController;
  private readonly vrEngine?: MobileVREngine;
  private readonly sound: SoundEngine;

  private statusText: xb.UIText;
  private headingText: xb.UIText;
  private anglesText: xb.UIText;
  private chipsText: xb.UIText;
  private locoText: xb.UIText;
  private enginePerfText: xb.UIText;
  private gestureText: xb.UIText;
  private fallbackHintText: xb.UIText;

  private enableSensorsBtn: xb.UIButton;
  private camFlowBtn: xb.UIButton;
  private camGesturesBtn: xb.UIButton;
  private stereoBtn: xb.UIButton;
  private sweepBtn: xb.UIButton;
  private overlayBtn: xb.UIButton;
  private modeBtn: xb.UIButton;
  private recenterBtn: xb.UIButton;
  private gazeBtn: xb.UIButton;
  private tapClickBtn: xb.UIButton;
  private locoToggleBtn: xb.UIButton;
  private testJumpBtn: xb.UIButton;
  private qualityBtn: xb.UIButton;
  private ipdBtn: xb.UIButton;

  private updateTimer = 0;

  constructor(
    sensors: SensorFusionTracker,
    sound: SoundEngine,
    gestures?: HandGestureController,
    headGaze?: HeadGazeController,
    vrEngine?: MobileVREngine
  ) {
    const statusText = new xb.UIText({
      text: 'Auto-Detecting Device Hardware...',
      style: {fontSize: 15, fontWeight: 'bold', color: '#38bdf8'},
    });
    const headingText = new xb.UIText({
      text: 'Compass: 0° N  •  0 Hz',
      style: {fontSize: 18, fontWeight: 'bold'},
    });
    const anglesText = new xb.UIText({
      text: 'Yaw: 0°   Pitch: 0°   Roll: 0°',
      style: {fontSize: 14, opacity: 0.85},
    });
    const chipsText = new xb.UIText({
      text: 'Orient: -- | Gyro: -- | Acc: -- | LinAcc: -- | Mag: -- | Cam: --',
      style: {fontSize: 11.5, opacity: 0.8},
    });
    const locoText = new xb.UIText({
      text: 'Motion: IDLE • 0 steps • 0 SPM • Vert: 0.0 m/s²',
      style: {fontSize: 12.5, fontWeight: 'bold', color: '#34d399'},
    });
    const enginePerfText = new xb.UIText({
      text: 'VR Engine: 60 FPS • Balanced • DPR 1.0 • Mono',
      style: {fontSize: 11.5, fontWeight: 'bold', color: '#7dd3fc'},
    });
    const gestureText = new xb.UIText({
      text: 'Hands: Ready • Gesture: NONE • Head: --',
      style: {fontSize: 12.5, fontWeight: 'bold', color: '#a78bfa'},
    });
    const fallbackHintText = new xb.UIText({
      text: 'All-hardware fusion + Walk/Run/Jump + Hand Gestures.',
      style: {fontSize: 11.5, opacity: 0.68, lineHeight: 1.25},
    });

    const enableSensorsBtn = new xb.UIButton({
      label: 'Enable Sensors',
      icon: 'sensors',
      style: {flexGrow: 1},
    });
    const camFlowBtn = new xb.UIButton({
      label: 'Cam Flow: OFF',
      icon: 'videocam',
      style: {flexGrow: 1},
    });
    const camGesturesBtn = new xb.UIButton({
      label: 'Back-Cam Hands',
      icon: 'back_hand',
      style: {flexGrow: 1},
    });
    const recenterBtn = new xb.UIButton({
      label: 'Recenter',
      icon: 'center_focus_strong',
      style: {flexGrow: 1},
    });
    const stereoBtn = new xb.UIButton({
      label: 'SBS: OFF',
      icon: 'vrpano',
      style: {flexGrow: 1},
    });
    const sweepBtn = new xb.UIButton({
      label: 'Sweep: OFF',
      icon: '360',
      style: {flexGrow: 1},
    });
    const overlayBtn = new xb.UIButton({
      label: 'Skeleton: ON',
      icon: 'accessibility_new',
      style: {flexGrow: 1},
    });
    const modeBtn = new xb.UIButton({
      label: 'Mode: Auto All-HW',
      icon: 'tune',
      style: {flexGrow: 1},
    });
    const gazeBtn = new xb.UIButton({
      label: 'Gaze: ON',
      icon: 'gps_fixed',
      style: {flexGrow: 1},
    });
    const tapClickBtn = new xb.UIButton({
      label: 'Tap Click: ON',
      icon: 'touch_app',
      style: {flexGrow: 1},
    });
    const locoToggleBtn = new xb.UIButton({
      label: 'WalkMove: ON',
      icon: 'directions_run',
      style: {flexGrow: 1},
    });
    const testJumpBtn = new xb.UIButton({
      label: 'Test Jump',
      icon: 'arrow_upward',
      style: {flexGrow: 1},
    });
    const qualityBtn = new xb.UIButton({
      label: 'GPU: Auto',
      icon: 'speed',
      style: {flexGrow: 1},
    });
    const ipdBtn = new xb.UIButton({
      label: 'IPD: 64mm',
      icon: 'visibility',
      style: {flexGrow: 1},
    });

    const smoothLabel = new xb.UIText({
      text: '34%',
      style: {fontSize: 14, fontWeight: 'bold'},
    });
    const smoothSlider = new xb.UISlider({
      ariaLabel: 'Sensor responsiveness',
      min: 5,
      max: 95,
      step: 5,
      value: 34,
      style: {width: '100%', height: 30},
      onInput: (val) => {
        smoothLabel.text = `${val}%`;
        sensors.setSmoothing(val / 100);
      },
    });

    const sensLabel = new xb.UIText({
      text: '1.0x',
      style: {fontSize: 14, fontWeight: 'bold'},
    });
    const sensSlider = new xb.UISlider({
      ariaLabel: 'Head tracking sensitivity',
      min: 50,
      max: 200,
      step: 10,
      value: 100,
      style: {width: '100%', height: 30},
      onInput: (val) => {
        const mult = val / 100;
        sensLabel.text = `${mult.toFixed(1)}x`;
        sensors.setSensitivity(mult);
      },
    });

    const monitorChildren: xb.UIElement[] = [
      statusText,
      headingText,
      anglesText,
      chipsText,
      enginePerfText,
      locoText,
      gestureText,
      fallbackHintText,
    ];
    if (gestures) {
      monitorChildren.push(
        new xb.UIImage({
          src: gestures.getHandMonitorTexture(),
          ariaLabel: 'Live back camera hand tracking feed',
          pointerEvents: 'none',
          style: {
            width: '100%',
            height: 82,
            objectFit: 'cover',
            borderRadius: 10,
            marginTop: 4,
          },
        })
      );
    }

    super({
      size: {width: 0.66, height: 'auto'},
      manipulation: true,
      edge: true,
      style: {flexDirection: 'column', gap: 9, padding: 18},
      children: [
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', alignItems: 'center', gap: 10},
          children: [
            new xb.UIIcon({
              icon: 'sensors',
              style: {width: 28, height: 28, color: '#38bdf8'},
            }),
            new xb.UIText({
              text: 'All-Hardware Head & AR Hand AI',
              style: {fontSize: 20, fontWeight: 'bold'},
            }),
          ],
        }),
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'column',
            gap: 5,
            padding: 11,
            backgroundColor: 'rgba(15, 23, 42, 0.72)',
            borderRadius: 14,
          },
          children: monitorChildren,
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [enableSensorsBtn, camFlowBtn, camGesturesBtn],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [stereoBtn, sweepBtn, overlayBtn],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [modeBtn, recenterBtn],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [gazeBtn, tapClickBtn],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [locoToggleBtn, testJumpBtn],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [qualityBtn, ipdBtn],
        }),
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          },
          children: [
            new xb.UIText({text: 'Fusion Responsiveness', style: {fontSize: 13.5}}),
            smoothLabel,
          ],
        }),
        smoothSlider,
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          },
          children: [
            new xb.UIText({text: 'Head Look Sensitivity', style: {fontSize: 13.5}}),
            sensLabel,
          ],
        }),
        sensSlider,
      ],
    });

    this.name = 'Sensor calibration card';
    this.sensors = sensors;
    this.gestures = gestures;
    this.headGaze = headGaze;
    this.vrEngine = vrEngine;
    this.sound = sound;
    this.statusText = statusText;
    this.headingText = headingText;
    this.anglesText = anglesText;
    this.chipsText = chipsText;
    this.enginePerfText = enginePerfText;
    this.locoText = locoText;
    this.gestureText = gestureText;
    this.fallbackHintText = fallbackHintText;
    this.enableSensorsBtn = enableSensorsBtn;
    this.camFlowBtn = camFlowBtn;
    this.camGesturesBtn = camGesturesBtn;
    this.stereoBtn = stereoBtn;
    this.sweepBtn = sweepBtn;
    this.overlayBtn = overlayBtn;
    this.modeBtn = modeBtn;
    this.recenterBtn = recenterBtn;
    this.gazeBtn = gazeBtn;
    this.tapClickBtn = tapClickBtn;
    this.locoToggleBtn = locoToggleBtn;
    this.testJumpBtn = testJumpBtn;
    this.qualityBtn = qualityBtn;
    this.ipdBtn = ipdBtn;

    this.wireActions();
  }

  private wireActions(): void {
    this.enableSensorsBtn.onClick = () => {
      this.sound.playClick();
      void this.sensors.requestSensorAccess().then((granted) => {
        this.enableSensorsBtn.label = granted ? 'Sensors Active' : 'Retry Sensors';
        this.refreshTelemetry();
      });
    };

    this.camFlowBtn.onClick = () => {
      this.sound.playClick();
      this.camFlowBtn.disabled = true;
      void this.sensors.toggleCameraOpticalFlow().then((active) => {
        this.camFlowBtn.disabled = false;
        this.camFlowBtn.label = active ? 'Cam Flow: ON' : 'Cam Flow: OFF';
        this.refreshTelemetry();
      });
    };

    this.camGesturesBtn.onClick = () => {
      if (!this.gestures) return;
      this.sound.playClick();
      this.camGesturesBtn.disabled = true;
      this.camGesturesBtn.label = 'Loading AI...';
      void this.gestures.toggleCameraHandGestures().then((active) => {
        this.camGesturesBtn.disabled = false;
        this.camGesturesBtn.label = active ? 'Cam Hands: ON' : 'Cam Hands: OFF';
        this.refreshTelemetry();
      });
    };

    this.recenterBtn.onClick = () => {
      this.sound.playClick();
      this.sensors.recenter();
      this.refreshTelemetry();
    };

    this.stereoBtn.onClick = () => {
      this.sound.playClick();
      const current = this.vrEngine
        ? this.vrEngine.isStereoEnabled()
        : this.sensors.isCardboardStereo();
      const next = !current;
      this.vrEngine?.setStereoEnabled(next);
      this.sensors.setCardboardStereo(next);
      this.stereoBtn.label = next ? 'SBS: ON' : 'SBS: OFF';
      this.refreshTelemetry();
    };

    this.sweepBtn.onClick = () => {
      this.sound.playClick();
      const next = !this.sensors.isDemoSweepActive();
      this.sensors.setDemoSweep(next);
      this.sweepBtn.label = next ? 'Sweep: ON' : 'Sweep: OFF';
      this.refreshTelemetry();
    };

    this.overlayBtn.onClick = () => {
      if (!this.gestures) return;
      this.sound.playClick();
      const next = !this.gestures.isSkeletalOverlayVisible();
      this.gestures.setSkeletalOverlayVisible(next);
      this.overlayBtn.label = next ? 'Skeleton: ON' : 'Skeleton: OFF';
      this.overlayBtn.icon = next ? 'accessibility_new' : 'visibility_off';
      this.refreshTelemetry();
    };

    const modes: Array<{id: SensorTrackingMode; label: string}> = [
      {id: 'auto', label: 'Mode: Auto All-HW'},
      {id: 'fusion', label: 'Mode: Compass + Accel'},
      {id: 'compass-only', label: 'Mode: Compass Only'},
      {id: 'camera-flow', label: 'Mode: Camera Flow'},
      {id: 'off', label: 'Mode: Tracking Off'},
    ];
    this.modeBtn.onClick = () => {
      this.sound.playClick();
      const current = this.sensors.getMode();
      const idx = modes.findIndex((m) => m.id === current);
      const next = modes[(idx + 1) % modes.length];
      this.sensors.setMode(next.id);
      this.modeBtn.label = next.label;
      this.refreshTelemetry();
    };

    this.gazeBtn.onClick = () => {
      if (!this.headGaze) return;
      this.sound.playClick();
      const next = !this.headGaze.isEnabled();
      this.headGaze.setEnabled(next);
      this.gazeBtn.label = next ? 'Gaze: ON' : 'Gaze: OFF';
      this.refreshTelemetry();
    };

    this.tapClickBtn.onClick = () => {
      if (!this.headGaze) return;
      this.sound.playClick();
      const next = !this.headGaze.isTapClickEnabled();
      this.headGaze.setTapClickEnabled(next);
      this.tapClickBtn.label = next ? 'Tap Click: ON' : 'Tap Click: OFF';
      this.refreshTelemetry();
    };

    this.locoToggleBtn.onClick = () => {
      this.sound.playClick();
      const next = !this.sensors.isLocomotionEnabled();
      this.sensors.setLocomotionEnabled(next);
      this.locoToggleBtn.label = next ? 'WalkMove: ON' : 'WalkMove: OFF';
      this.refreshTelemetry();
    };

    this.testJumpBtn.onClick = () => {
      this.sensors.triggerJump();
      this.sound.playJump();
      this.refreshTelemetry();
    };

    this.qualityBtn.onClick = () => {
      if (!this.vrEngine) return;
      this.sound.playClick();
      const preset = this.vrEngine.cyclePreset();
      this.qualityBtn.label =
        preset === 'auto'
          ? 'GPU: Auto'
          : preset === 'eco'
            ? 'GPU: Eco Low-End'
            : preset === 'balanced'
              ? 'GPU: Balanced'
              : 'GPU: High';
      this.refreshTelemetry();
    };

    this.ipdBtn.onClick = () => {
      if (!this.vrEngine) return;
      this.sound.playClick();
      const ipd = this.vrEngine.cycleIPD();
      this.ipdBtn.label = `IPD: ${ipd}mm`;
      this.refreshTelemetry();
    };
  }

  private getCardinal(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round((deg % 360) / 45) % 8];
  }

  private refreshTelemetry(): void {
    const tel = this.sensors.getTelemetry();
    const hw = tel.hardware;
    this.statusText.text = `${tel.statusLabel} (${tel.fusionAlgorithm})`;
    this.headingText.text = `Compass: ${tel.compassHeadingDeg}° ${this.getCardinal(
      tel.compassHeadingDeg
    )}  •  ${tel.sampleHz} Hz • β=${tel.fusionBeta.toFixed(2)}`;
    this.anglesText.text = `Yaw: ${tel.yawDeg}°   Pitch: ${tel.pitchDeg}°   Roll: ${tel.rollDeg}°`;

    const gyroBadge = hw.gyro ? (tel.gyroCalibrated ? 'CAL' : 'ON') : '--';
    this.chipsText.text =
      `Orient: ${hw.orientationSensor ? 'ON' : '--'} | ` +
      `Gyro: ${gyroBadge} | ` +
      `Acc: ${hw.accel ? 'ON' : '--'} | ` +
      `LinAcc: ${hw.linearAccel ? 'ON' : '--'} | ` +
      `Mag: ${hw.compass ? 'ON' : '--'} | ` +
      `Cam: ${hw.cameraFlow ? 'ON' : '--'}`;

    if (this.vrEngine) {
      const vt = this.vrEngine.getTelemetry();
      const eyeMode = vt.xrPresenting ? 'WebXR' : vt.stereoEnabled ? `SBS ${vt.ipdMm}mm` : 'Mono';
      this.enginePerfText.text =
        `VR Engine: ${vt.fps} FPS (${vt.frameTimeMs}ms) • ${vt.effectiveTier.toUpperCase()} • DPR ${vt.pixelRatio} • ${vt.drawCalls} draws • ${eyeMode}`;
      const expectedStereo = vt.stereoEnabled ? 'SBS: ON' : 'SBS: OFF';
      if (this.stereoBtn.label !== expectedStereo) {
        this.stereoBtn.label = expectedStereo;
      }
    }

    const loco = tel.locomotion;
    const locoBadge =
      loco.state === 'jump'
        ? `JUMP (${loco.jumpHeightM.toFixed(2)}m)`
        : loco.state === 'run'
          ? `RUN (${loco.cadenceSpm} SPM)`
          : loco.state === 'walk'
            ? `WALK (${loco.cadenceSpm} SPM)`
            : 'IDLE';
    this.locoText.text = `Motion: ${locoBadge} • ${loco.stepCount} steps • ${loco.speedMps} m/s`;
    this.locoText.style.color =
      loco.state === 'jump'
        ? '#fbbf24'
        : loco.state === 'run'
          ? '#f472b6'
          : loco.state === 'walk'
            ? '#34d399'
            : '#94a3b8';

    if (this.gestures) {
      const g = this.gestures.getTelemetry();
      if (!g.cameraHandsLoading) {
        const expected = g.cameraHandsActive ? 'Back-Cam: ON' : 'Back-Cam Hands';
        if (this.camGesturesBtn.label !== expected) {
          this.camGesturesBtn.label = expected;
        }
      }
      const expectedOverlay = g.skeletalOverlayVisible ? 'Skeleton: ON' : 'Skeleton: OFF';
      if (this.overlayBtn.label !== expectedOverlay) {
        this.overlayBtn.label = expectedOverlay;
      }
      const depthSuffix =
        g.detectedDepthMeters !== null ? ` (${g.detectedDepthMeters.toFixed(2)}m)` : '';
      const handSrc = g.xrHandsActive
        ? 'XR Hands'
        : g.cameraHandsActive
          ? `Back-Cam 3D${depthSuffix}`
          : 'Standby';
      const gestLabel =
        g.activeGesture === 'none'
          ? 'NONE'
          : `${g.activeGesture.toUpperCase()} (${g.activeHand})`;
      const headLabel = g.headGesture === 'none' ? '--' : g.headGesture.toUpperCase();
      this.gestureText.text = `Hands: ${handSrc} • Gesture: ${gestLabel} • Head: ${headLabel}`;
      this.fallbackHintText.text = g.lastActionLabel;
    } else if (hw.gyro && hw.compass && hw.accel) {
      this.fallbackHintText.text = tel.gyroCalibrated
        ? 'Full 9-axis hardware fusion + drift bias calibration active.'
        : 'Full 9-axis hardware fusion active.';
    } else if (hw.accel && !hw.compass && !hw.gyro && !hw.cameraFlow) {
      this.fallbackHintText.text =
        'No Gyro/Compass detected: Accel tracks tilt; tap Cam Flow: ON for 360° yaw!';
    } else if (hw.cameraFlow) {
      this.fallbackHintText.text =
        '3x3 subpixel Camera Optical Flow tracking pan/tilt with available sensors.';
    } else {
      this.fallbackHintText.text = `Active fallback pipeline: ${tel.activeSourcesLabel}`;
    }
  }

  update(): void {
    const dt = xb.getDeltaTime();
    this.updateTimer += dt;
    if (this.updateTimer >= 0.12) {
      this.updateTimer = 0;
      this.refreshTelemetry();
    }
  }
}
