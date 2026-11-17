import * as THREE from 'three';
import * as xb from 'xrblocks';
import {trimCatalogTextureCache} from '../store/catalog.ts';
import {VREffectiveTier, VREngineTelemetry, VRQualityPreset} from '../types.ts';
import {
  estimateSceneTextureVramBytes,
  GpuTextureCapabilities,
  probeGpuTextureCapabilities,
} from './TextureOptimizer.ts';

export interface QualityProfileConfig {
  maxPixelRatio: number;
  screenRedrawHz: number;
  screenResolutionScale: number;
  starRatio: number;
  showSecondaryProps: boolean;
  enableFog: boolean;
  maxBlasterTargets: number;
  lodBias: number;
}

export const QUALITY_PROFILES: Record<VREffectiveTier, QualityProfileConfig> = {
  eco: {
    maxPixelRatio: 0.9,
    screenRedrawHz: 12,
    screenResolutionScale: 0.5, // 512x256 -> 75% less pixel upload bandwidth
    starRatio: 0.35,
    showSecondaryProps: false,
    enableFog: false,
    maxBlasterTargets: 6,
    lodBias: 0.55, // Aggressively switch meshes to mid/low/culled LODs on entry-level GPUs
  },
  balanced: {
    maxPixelRatio: 1.35,
    screenRedrawHz: 20,
    screenResolutionScale: 0.75,
    starRatio: 0.65,
    showSecondaryProps: true,
    enableFog: true,
    maxBlasterTargets: 9,
    lodBias: 0.88,
  },
  high: {
    maxPixelRatio: 2.0,
    screenRedrawHz: 30,
    screenResolutionScale: 1.0,
    starRatio: 1.0,
    showSecondaryProps: true,
    enableFog: true,
    maxBlasterTargets: 12,
    lodBias: 1.25,
  },
};

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

/**
 * Lightweight Mobile VR Rendering Engine for Android headsets.
 *
 * Implements 4-pillar optimization for entry-level Android smartphones:
 * 1. Level-of-Detail (LOD): Tier-adaptive `lodBias` coordinator across arena pylons,
 *    speaker towers, HoloToys, and Cosmic Blaster drones.
 * 2. Texture Compression & VRAM Budget: WebGL compressed format probing (ASTC/ETC2/S3TC/16-bit),
 *    mip-free fixed textures, and automatic/manual LRU cache pruning.
 * 3. Efficient Rendering Passes: Single-clear scissor stereo SBS pass, shader pre-warming,
 *    low-end Mali/Adreno/SwiftShader GPU detection, and dynamic DPR scaling.
 * 4. Aggressive GC & Memory Management: Render-list cleanup, periodic memory pressure trimming,
 *    and an in-engine Low-End Stress Benchmark collecting p95 frame time & draw-call metrics.
 */
export class MobileVREngine extends xb.Script {
  private stereoEnabled = false;
  private ipdMm = 64;
  private preset: VRQualityPreset = 'auto';
  private effectiveTier: VREffectiveTier = 'balanced';

  private gpuCaps: GpuTextureCapabilities = probeGpuTextureCapabilities(undefined);
  private shadersPrewarmed = false;

  private readonly stereoCamera = new THREE.StereoCamera();
  private readonly _sizeVec = new THREE.Vector2();
  private readonly _clearColor = new THREE.Color(0x060914);
  private readonly _dividerColor = new THREE.Color(0x020617);

  // Rolling performance governor & p95 tracker (fixed circular ring buffer -> zero GC)
  private frameCounter = 0;
  private frameAccumSec = 0;
  private currentFps = 60;
  private currentFrameMs = 16.7;
  private p95FrameMs = 18.0;
  private readonly frameSamplesMs = new Float32Array(60);
  private readonly sortedScratchMs = new Float32Array(60);
  private sampleWriteIdx = 0;
  private sampleFillCount = 0;

  private lastTierSwitchAt = 0;
  private lastMemoryAuditAt = 0;
  private lowFpsStreak = 0;
  private highFpsStreak = 0;
  private appliedPixelRatio = 1.0;

  // Cached GPU memory & LOD telemetry updated every ~1s
  private estimatedVramMb = 0;
  private jsHeapMb: number | null = null;
  private readonly lodCounts = {high: 0, mid: 0, low: 0};

  private benchmarkRunning = false;
  private benchmarkSummary = 'Bench: Ready';

  private readonly trimCallbacks = new Set<(aggressive: boolean) => number>();
  private readonly qualityListeners = new Set<
    (tier: VREffectiveTier, profile: QualityProfileConfig) => void
  >();

  constructor() {
    super();
    this.stereoCamera.eyeSep = this.ipdMm / 1000;
    this.effectiveTier = this.detectInitialHardwareTier();
  }

  init(): void {
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    this.gpuCaps = probeGpuTextureCapabilities(renderer);
    if (this.preset === 'auto' && this.gpuCaps.isLowEndGpu) {
      this.effectiveTier = 'eco';
    }
    this.applyRendererTuning();
    this.syncStereoOverride();
    this.prewarmShaders();
    this.refreshResourceAudit();
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

  public prewarmShaders(): void {
    if (this.shadersPrewarmed) return;
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    const scene = xb.core.scene;
    const camera = xb.core.camera;
    if (!renderer || !scene || !camera) return;
    try {
      renderer.compile(scene, camera);
      this.shadersPrewarmed = true;
    } catch {
      // Ignore environments without active GL context
    }
  }

  public registerMemoryTrimmer(fn: (aggressive: boolean) => number): () => void {
    this.trimCallbacks.add(fn);
    return () => this.trimCallbacks.delete(fn);
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

  public getGpuCapabilities(): GpuTextureCapabilities {
    return this.gpuCaps;
  }

  public setPreset(preset: VRQualityPreset): void {
    this.preset = preset;
    if (preset !== 'auto') {
      this.setEffectiveTier(preset);
    } else {
      const baseTier = this.detectInitialHardwareTier();
      this.setEffectiveTier(this.gpuCaps.isLowEndGpu ? 'eco' : baseTier);
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

  /**
   * Aggressive GC & GPU Resource Reclamation:
   * - Evicts LRU textures from Play Store & procedural icon caches
   * - Disposes dormant AR video / cached buffers
   * - Flushes Three.js internal WebGLRenderLists caches so dereferenced draw items GC cleanly
   */
  public trimMemory(aggressive = true): {texturesFreed: number; vramAfterMb: number} {
    let freed = trimCatalogTextureCache(aggressive);
    for (const cb of this.trimCallbacks) {
      freed += cb(aggressive);
    }

    const renderer = xb.core.renderer as
      | (THREE.WebGLRenderer & {renderLists?: {dispose?: () => void}})
      | undefined;
    try {
      renderer?.renderLists?.dispose?.();
    } catch {
      // Safe fallback
    }

    this.refreshResourceAudit();
    return {
      texturesFreed: freed,
      vramAfterMb: this.estimatedVramMb,
    };
  }

  /**
   * Runs a non-blocking 1.8s low-end Android stress profile (temporarily switches to Eco + SBS
   * sweep if needed, measures live avg FPS, p95 frame ms, draw calls, triangles, and trims GC),
   * then restores previous preset/stereo state.
   */
  public async runLowEndStressBenchmark(): Promise<string> {
    if (this.benchmarkRunning) return this.benchmarkSummary;
    this.benchmarkRunning = true;
    const prevPreset = this.preset;
    const prevStereo = this.stereoEnabled;

    try {
      this.benchmarkSummary = 'Bench: Testing Eco+SBS...';
      this.setPreset('eco');
      this.setStereoEnabled(true);

      // Reset rolling sample window so we measure pure Eco+SBS performance
      this.sampleFillCount = 0;
      this.sampleWriteIdx = 0;

      await new Promise<void>((resolve) => {
        if (typeof window !== 'undefined') {
          window.setTimeout(resolve, 1600);
        } else {
          resolve();
        }
      });

      this.recomputeP95();
      this.refreshResourceAudit();
      const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
      const calls = renderer?.info?.render?.calls ?? 0;
      const tris = renderer?.info?.render?.triangles ?? 0;
      const trimRes = this.trimMemory(true);

      this.benchmarkSummary =
        `Eco+SBS: ${this.currentFps}fps p95=${this.p95FrameMs}ms | ` +
        `${calls} draws ${(tris / 1000).toFixed(1)}k tris | Freed ${trimRes.texturesFreed} tex`;
      return this.benchmarkSummary;
    } finally {
      this.setStereoEnabled(prevStereo);
      this.setPreset(prevPreset);
      this.benchmarkRunning = false;
    }
  }

  private setEffectiveTier(tier: VREffectiveTier): void {
    this.effectiveTier = tier;
    this.lastTierSwitchAt = performance.now();
    this.applyRendererTuning();
    if (tier === 'eco') {
      this.trimMemory(false);
    }
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
    // Lower stereo pixel-ratio ceiling on Eco / Low-End GPUs for 2x fill-rate headroom
    const stereoCap = this.stereoEnabled && this.effectiveTier === 'eco' ? 0.72 : profile.maxPixelRatio;
    const targetDpr = Math.min(nativeDpr, stereoCap);

    if (Math.abs(targetDpr - this.appliedPixelRatio) > 0.04) {
      this.appliedPixelRatio = targetDpr;
      renderer.setPixelRatio(targetDpr);
    }

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
        this.stereoCamera.aspect = 0.5;
        this.stereoCamera.eyeSep = this.ipdMm / 1000;
        this.stereoCamera.update(persp);

        const prevAutoClear = webgl.autoClear;
        const prevScissor = webgl.getScissorTest();
        const halfW = Math.floor(w / 2);

        // Single clear pass for both eyes eliminates redundant mobile tile resolve
        webgl.setScissorTest(false);
        webgl.setViewport(0, 0, w, h);
        webgl.autoClear = false;
        webgl.setClearColor(this._clearColor, 1);
        webgl.clear(true, true, false);

        webgl.setScissorTest(true);

        // Left Eye pass
        webgl.setScissor(0, 0, halfW, h);
        webgl.setViewport(0, 0, halfW, h);
        webgl.render(scene, this.stereoCamera.cameraL);

        // Right Eye pass
        webgl.setScissor(halfW, 0, w - halfW, h);
        webgl.setViewport(halfW, 0, w - halfW, h);
        webgl.render(scene, this.stereoCamera.cameraR);

        // Fast 2px binocular divider via scissor clear
        webgl.setScissor(Math.max(0, halfW - 1), 0, 2, h);
        webgl.setClearColor(this._dividerColor, 1);
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

  private recomputeP95(): void {
    const n = this.sampleFillCount;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      this.sortedScratchMs[i] = this.frameSamplesMs[i];
    }
    this.sortedScratchMs.subarray(0, n).sort();
    const idx = Math.min(n - 1, Math.floor(n * 0.95));
    this.p95FrameMs = Number(this.sortedScratchMs[idx].toFixed(1));
  }

  private refreshResourceAudit(): void {
    const scene = xb.core.scene;
    if (scene) {
      const vramBytes = estimateSceneTextureVramBytes(scene);
      this.estimatedVramMb = Number((vramBytes / (1024 * 1024)).toFixed(2));

      this.lodCounts.high = 0;
      this.lodCounts.mid = 0;
      this.lodCounts.low = 0;
      scene.traverse((obj) => {
        if (obj instanceof THREE.LOD && obj.visible) {
          const lvl = obj.getCurrentLevel();
          if (lvl === 0) this.lodCounts.high += 1;
          else if (lvl === 1) this.lodCounts.mid += 1;
          else this.lodCounts.low += 1;
        }
      });
    }

    const perfMem =
      typeof performance !== 'undefined'
        ? (performance as PerformanceWithMemory).memory
        : undefined;
    if (perfMem && perfMem.usedJSHeapSize > 0) {
      this.jsHeapMb = Math.round(perfMem.usedJSHeapSize / (1024 * 1024));
    }
  }

  update(): void {
    const dt = Math.min(xb.getDeltaTime(), 0.25);
    if (dt <= 0) return;

    this.frameCounter += 1;
    this.frameAccumSec += dt;

    this.frameSamplesMs[this.sampleWriteIdx] = dt * 1000;
    this.sampleWriteIdx = (this.sampleWriteIdx + 1) % this.frameSamplesMs.length;
    if (this.sampleFillCount < this.frameSamplesMs.length) {
      this.sampleFillCount += 1;
    }

    if (this.frameAccumSec >= 1.0) {
      const avgDt = this.frameAccumSec / this.frameCounter;
      this.currentFps = Math.min(120, Math.round(this.frameCounter / this.frameAccumSec));
      this.currentFrameMs = Number((avgDt * 1000).toFixed(1));
      this.frameCounter = 0;
      this.frameAccumSec = 0;

      this.recomputeP95();
      this.refreshResourceAudit();

      const now = performance.now();

      // Automatic background GC pressure relief every 12s on Eco tier or high texture count
      const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
      const texCount = renderer?.info?.memory?.textures ?? 0;
      if (
        now - this.lastMemoryAuditAt > 12000 &&
        (this.effectiveTier === 'eco' || texCount > 45 || (this.jsHeapMb !== null && this.jsHeapMb > 220))
      ) {
        this.lastMemoryAuditAt = now;
        this.trimMemory(this.effectiveTier === 'eco' && texCount > 36);
      }

      // Adaptive performance governor in 'auto' preset
      if (this.preset === 'auto' && !this.benchmarkRunning && now - this.lastTierSwitchAt > 3500) {
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
    const renderInfo = renderer?.info?.render;
    const memInfo = renderer?.info?.memory;

    return {
      stereoEnabled: this.stereoEnabled,
      xrPresenting: isXrPresenting,
      preset: this.preset,
      effectiveTier: this.effectiveTier,
      fps: this.currentFps,
      frameTimeMs: this.currentFrameMs,
      p95FrameMs: this.p95FrameMs,
      pixelRatio: Number(this.appliedPixelRatio.toFixed(2)),
      drawCalls: renderInfo?.calls ?? 0,
      triangles: renderInfo?.triangles ?? 0,
      ipdMm: this.ipdMm,
      gpuCompression: this.gpuCaps.summaryLabel,
      texturesCount: memInfo?.textures ?? 0,
      geometriesCount: memInfo?.geometries ?? 0,
      estimatedVramMb: this.estimatedVramMb,
      jsHeapMb: this.jsHeapMb,
      lodCounts: {
        high: this.lodCounts.high,
        mid: this.lodCounts.mid,
        low: this.lodCounts.low,
      },
      isLowEndHardware: this.gpuCaps.isLowEndGpu || this.detectInitialHardwareTier() === 'eco',
      benchmarkSummary: this.benchmarkSummary,
    };
  }

  dispose(): void {
    this.qualityListeners.clear();
    this.trimCallbacks.clear();
    xb.core.renderSceneOverride = undefined;
  }
}
