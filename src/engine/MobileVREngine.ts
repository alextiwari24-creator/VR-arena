import * as THREE from 'three';
import * as xb from 'xrblocks';
import {VREffectiveTier, VREngineTelemetry, VRQualityPreset} from '../types.ts';

export interface QualityProfileConfig {
  maxPixelRatio: number;
  screenRedrawHz: number;
  starRatio: number;
  showSecondaryProps: boolean;
  enableFog: boolean;
  maxBlasterTargets: number;
}

const QUALITY_PROFILES: Record<VREffectiveTier, QualityProfileConfig> = {
  eco: {
    maxPixelRatio: 1.0,
    screenRedrawHz: 12,
    starRatio: 0.35,
    showSecondaryProps: false,
    enableFog: false,
    maxBlasterTargets: 6,
  },
  balanced: {
    maxPixelRatio: 1.35,
    screenRedrawHz: 20,
    starRatio: 0.65,
    showSecondaryProps: true,
    enableFog: true,
    maxBlasterTargets: 9,
  },
  high: {
    maxPixelRatio: 2.0,
    screenRedrawHz: 30,
    starRatio: 1.0,
    showSecondaryProps: true,
    enableFog: true,
    maxBlasterTargets: 12,
  },
};

/**
 * Lightweight Mobile VR Rendering Engine for Android headsets.
 *
 * Responsibilities:
 * - Stereoscopic Side-by-Side (Cardboard SBS) rendering with zero-allocation per-eye frustums
 *   & configurable IPD, seamlessly deferring to native WebXR stereo when presenting.
 * - Low-end hardware detection + dynamic thermal/FPS adaptive quality governor
 *   (automatically scales pixelRatio, draw calls, fog, star count, and canvas upload Hz).
 * - Exposes live GPU/frame telemetry (FPS, frame time, draw calls, triangles, DPR, IPD).
 */
export class MobileVREngine extends xb.Script {
  private stereoEnabled = false;
  private ipdMm = 64;
  private preset: VRQualityPreset = 'auto';
  private effectiveTier: VREffectiveTier = 'balanced';

  private readonly stereoCamera = new THREE.StereoCamera();
  private readonly _sizeVec = new THREE.Vector2();
  private readonly _clearColor = new THREE.Color(0x060914);

  // Rolling performance governor (zero allocations in update loop)
  private frameCounter = 0;
  private frameAccumSec = 0;
  private currentFps = 60;
  private currentFrameMs = 16.7;
  private lastTierSwitchAt = 0;
  private lowFpsStreak = 0;
  private highFpsStreak = 0;
  private appliedPixelRatio = 1.0;

  private qualityListeners = new Set<
    (tier: VREffectiveTier, profile: QualityProfileConfig) => void
  >();

  constructor() {
    super();
    this.stereoCamera.eyeSep = this.ipdMm / 1000;
    this.effectiveTier = this.detectInitialHardwareTier();
  }

  init(): void {
    this.applyRendererTuning();
    this.syncStereoOverride();
  }

  private detectInitialHardwareTier(): VREffectiveTier {
    if (typeof navigator === 'undefined') return 'balanced';
    const nav = navigator as Navigator & {deviceMemory?: number};
    const cores = nav.hardwareConcurrency ?? 4;
    const memGb = nav.deviceMemory ?? 4;
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (memGb <= 3 || cores <= 4 || (isAndroid && memGb <= 4)) {
      return 'eco';
    }
    if (isAndroid || cores <= 6) {
      return 'balanced';
    }
    return 'high';
  }

  public onQualityChange(
    listener: (tier: VREffectiveTier, profile: QualityProfileConfig) => void
  ): () => void {
    this.qualityListeners.add(listener);
    listener(this.effectiveTier, QUALITY_PROFILES[this.effectiveTier]);
    return () => this.qualityListeners.delete(listener);
  }

  public getQualityProfile(): QualityProfileConfig {
    return QUALITY_PROFILES[this.effectiveTier];
  }

  public getEffectiveTier(): VREffectiveTier {
    return this.effectiveTier;
  }

  public setPreset(preset: VRQualityPreset): void {
    this.preset = preset;
    if (preset !== 'auto') {
      this.setEffectiveTier(preset);
    } else {
      this.setEffectiveTier(this.detectInitialHardwareTier());
    }
  }

  public cyclePreset(): VRQualityPreset {
    const order: VRQualityPreset[] = ['auto', 'eco', 'balanced', 'high'];
    const next = order[(order.indexOf(this.preset) + 1) % order.length];
    this.setPreset(next);
    return next;
  }

  public getPreset(): VRQualityPreset {
    return this.preset;
  }

  public setStereoEnabled(enabled: boolean): void {
    this.stereoEnabled = enabled;
    this.syncStereoOverride();
  }

  public isStereoEnabled(): boolean {
    return this.stereoEnabled;
  }

  public cycleIPD(): number {
    const steps = [64, 68, 70, 58, 60];
    const idx = steps.indexOf(this.ipdMm);
    this.ipdMm = steps[(idx + 1) % steps.length];
    this.stereoCamera.eyeSep = this.ipdMm / 1000;
    return this.ipdMm;
  }

  public getIPDMm(): number {
    return this.ipdMm;
  }

  private setEffectiveTier(tier: VREffectiveTier): void {
    this.effectiveTier = tier;
    this.lastTierSwitchAt = performance.now();
    this.applyRendererTuning();
    const profile = QUALITY_PROFILES[tier];
    for (const listener of this.qualityListeners) {
      listener(tier, profile);
    }
  }

  private applyRendererTuning(): void {
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    if (!renderer) return;

    const profile = QUALITY_PROFILES[this.effectiveTier];
    const nativeDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    // Slight stereo supersampling guard on Eco so dual-eye passes stay 60fps
    const stereoCap =
      this.stereoEnabled && this.effectiveTier === 'eco' ? 0.85 : profile.maxPixelRatio;
    const targetDpr = Math.min(nativeDpr, stereoCap);

    if (Math.abs(targetDpr - this.appliedPixelRatio) > 0.04) {
      this.appliedPixelRatio = targetDpr;
      renderer.setPixelRatio(targetDpr);
    }

    // Keep shadow map disabled on lower-end Android devices for max fill rate
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = this.effectiveTier === 'high';
    }
  }

  private syncStereoOverride(): void {
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    if (!renderer) return;

    this.applyRendererTuning();

    const isXrPresenting = Boolean(renderer.xr?.isPresenting);
    if (this.stereoEnabled && !isXrPresenting) {
      xb.core.renderSceneOverride = (r, scene, camera) => {
        const webgl = r as THREE.WebGLRenderer;
        const persp = camera as THREE.PerspectiveCamera;
        webgl.getSize(this._sizeVec);
        const w = this._sizeVec.x;
        const h = this._sizeVec.y;
        if (w <= 0 || h <= 0) return;

        persp.updateMatrixWorld();
        // Split-screen per-eye aspect (width / 2) / height
        this.stereoCamera.aspect = 0.5;
        this.stereoCamera.eyeSep = this.ipdMm / 1000;
        this.stereoCamera.update(persp);

        const prevAutoClear = webgl.autoClear;
        const prevScissor = webgl.getScissorTest();
        const halfW = Math.floor(w / 2);

        // Single clear pass for both eyes cuts mobile GPU tile bandwidth
        webgl.setScissorTest(false);
        webgl.setViewport(0, 0, w, h);
        webgl.autoClear = false;
        webgl.clear(true, true, true);

        webgl.setScissorTest(true);

        // Left Eye
        webgl.setScissor(0, 0, halfW, h);
        webgl.setViewport(0, 0, halfW, h);
        webgl.render(scene, this.stereoCamera.cameraL);

        // Right Eye
        webgl.setScissor(halfW, 0, w - halfW, h);
        webgl.setViewport(halfW, 0, w - halfW, h);
        webgl.render(scene, this.stereoCamera.cameraR);

        // Clean center binocular divider line (2px) using fast scissor clear
        webgl.setScissor(Math.max(0, halfW - 1), 0, 2, h);
        webgl.setClearColor(0x020617, 1);
        webgl.clearColor();

        webgl.setClearColor(this._clearColor, 1);
        webgl.setScissorTest(prevScissor);
        webgl.setViewport(0, 0, w, h);
        webgl.autoClear = prevAutoClear;
      };
    } else {
      xb.core.renderSceneOverride = undefined;
      if (renderer.setViewport) {
        renderer.getSize(this._sizeVec);
        if (this._sizeVec.x > 0 && this._sizeVec.y > 0) {
          renderer.setScissorTest(false);
          renderer.setViewport(0, 0, this._sizeVec.x, this._sizeVec.y);
        }
      }
    }
  }

  update(): void {
    const dt = Math.min(xb.getDeltaTime(), 0.25);
    if (dt <= 0) return;

    this.frameCounter += 1;
    this.frameAccumSec += dt;

    if (this.frameAccumSec >= 1.0) {
      const avgDt = this.frameAccumSec / this.frameCounter;
      this.currentFps = Math.min(120, Math.round(this.frameCounter / this.frameAccumSec));
      this.currentFrameMs = Number((avgDt * 1000).toFixed(1));
      this.frameCounter = 0;
      this.frameAccumSec = 0;

      // Adaptive performance governor in 'auto' preset
      if (this.preset === 'auto' && performance.now() - this.lastTierSwitchAt > 3500) {
        if (this.currentFps < 40) {
          this.lowFpsStreak += 1;
          this.highFpsStreak = 0;
          if (this.lowFpsStreak >= 2) {
            this.lowFpsStreak = 0;
            if (this.effectiveTier === 'high') this.setEffectiveTier('balanced');
            else if (this.effectiveTier === 'balanced') this.setEffectiveTier('eco');
          }
        } else if (this.currentFps >= 57) {
          this.highFpsStreak += 1;
          this.lowFpsStreak = 0;
          if (this.highFpsStreak >= 4) {
            this.highFpsStreak = 0;
            if (this.effectiveTier === 'eco') this.setEffectiveTier('balanced');
            else if (this.effectiveTier === 'balanced') this.setEffectiveTier('high');
          }
        } else {
          this.lowFpsStreak = 0;
          this.highFpsStreak = 0;
        }
      }
    }
  }

  getTelemetry(): VREngineTelemetry {
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    const isXrPresenting = Boolean(renderer?.xr?.isPresenting);
    const info = renderer?.info?.render;

    return {
      stereoEnabled: this.stereoEnabled,
      xrPresenting: isXrPresenting,
      preset: this.preset,
      effectiveTier: this.effectiveTier,
      fps: this.currentFps,
      frameTimeMs: this.currentFrameMs,
      pixelRatio: Number(this.appliedPixelRatio.toFixed(2)),
      drawCalls: info?.calls ?? 0,
      triangles: info?.triangles ?? 0,
      ipdMm: this.ipdMm,
    };
  }

  dispose(): void {
    this.qualityListeners.clear();
    xb.core.renderSceneOverride = undefined;
  }
}
