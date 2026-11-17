import * as THREE from 'three';
import {VREffectiveTier} from '../types.ts';

export interface GpuTextureCapabilities {
  rendererName: string;
  isLowEndGpu: boolean;
  isSoftwareGl: boolean;
  hasAstc: boolean;
  hasEtc2: boolean;
  hasEtc1: boolean;
  hasS3tc: boolean;
  hasBptc: boolean;
  maxTextureSize: number;
  maxAnisotropy: number;
  summaryLabel: string;
}

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

const cachedByteEstimates = new WeakMap<THREE.Texture, number>();

/**
 * Probes WebGL / WebGL2 GPU renderer info & hardware compressed texture formats
 * (ASTC / ETC2 / ETC1 / S3TC / BPTC) to adapt texture formats and budgets for Android phones.
 */
export function probeGpuTextureCapabilities(
  renderer?: THREE.WebGLRenderer
): GpuTextureCapabilities {
  const fallback: GpuTextureCapabilities = {
    rendererName: 'Unknown GPU',
    isLowEndGpu: false,
    isSoftwareGl: false,
    hasAstc: false,
    hasEtc2: false,
    hasEtc1: false,
    hasS3tc: false,
    hasBptc: false,
    maxTextureSize: 2048,
    maxAnisotropy: 1,
    summaryLabel: '16-Bit Packed',
  };

  if (!renderer || typeof renderer.getContext !== 'function') {
    return fallback;
  }

  let gl: WebGLRenderingContext | WebGL2RenderingContext;
  try {
    gl = renderer.getContext();
  } catch {
    return fallback;
  }

  const extAny = renderer.extensions as unknown as {
    has?: (name: string) => boolean;
  };
  const hasExt = (name: string): boolean => {
    try {
      if (extAny?.has?.(name)) return true;
      return Boolean(gl.getExtension(name));
    } catch {
      return false;
    }
  };

  let rendererName = 'Mobile WebGL';
  try {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const raw = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      if (typeof raw === 'string' && raw.length > 0) {
        rendererName = raw;
      }
    }
  } catch {
    // Ignore restricted debug renderer info
  }

  const isSoftwareGl = /SwiftShader|llvmpipe|softpipe|ANGLE.*Google.*SwiftShader/i.test(
    rendererName
  );
  // Entry-level Android SoCs (Adreno 3xx/4xx/50x, Mali-4xx/T7xx/T8xx/G31/G52, PowerVR GE8xxx)
  const isLowEndGpu =
    isSoftwareGl ||
    /Mali-4|Mali-T[678]|Mali-G3|Mali-G51|Mali-G52|Adreno \(TM\) [34]|Adreno \(TM\) 50|PowerVR GE8|PowerVR Rogue/i.test(
      rendererName
    );

  const hasAstc = hasExt('WEBGL_compressed_texture_astc');
  const hasEtc2 = hasExt('WEBGL_compressed_texture_etc');
  const hasEtc1 = hasExt('WEBGL_compressed_texture_etc1');
  const hasS3tc = hasExt('WEBGL_compressed_texture_s3tc');
  const hasBptc = hasExt('EXT_texture_compression_bptc');

  const caps = renderer.capabilities as {maxTextureSize?: number; getMaxAnisotropy?: () => number};
  const maxTextureSize = caps?.maxTextureSize ?? 2048;
  const maxAnisotropy = caps?.getMaxAnisotropy ? caps.getMaxAnisotropy() : 1;

  const formats: string[] = [];
  if (hasAstc) formats.push('ASTC');
  if (hasEtc2) formats.push('ETC2');
  else if (hasEtc1) formats.push('ETC1');
  if (hasS3tc) formats.push('S3TC');
  if (hasBptc && formats.length === 0) formats.push('BPTC');
  const summaryLabel =
    formats.length > 0 ? `${formats.slice(0, 2).join('+')}/16b` : '16-Bit 5551/4444';

  return {
    rendererName,
    isLowEndGpu,
    isSoftwareGl,
    hasAstc,
    hasEtc2,
    hasEtc1,
    hasS3tc,
    hasBptc,
    maxTextureSize,
    maxAnisotropy,
    summaryLabel,
  };
}

/**
 * Compresses an offscreen HTMLCanvasElement into a memory-efficient 16-bit GPU texture
 * (`RGB565` when opaque, `RGBA4444` when transparent) with 4x4 ordered Bayer dithering
 * on Eco/Balanced tiers, cutting GPU VRAM usage by 50% compared to RGBA8888 and skipping
 * costly mipmap allocation for fixed-plane VR textures.
 */
export function buildOptimizedSurfaceTexture(
  canvas: HTMLCanvasElement,
  tier: VREffectiveTier,
  options: {alpha?: boolean; anisotropy?: number; allowMipmaps?: boolean} = {}
): THREE.Texture {
  const alpha = Boolean(options.alpha);
  const use16BitCompression = tier !== 'high';

  if (use16BitCompression) {
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (ctx) {
      const w = canvas.width;
      const h = canvas.height;
      const imgData = ctx.getImageData(0, 0, w, h).data;
      const packed = new Uint16Array(w * h);

      if (alpha) {
        // RGBA4444: 4 bits per channel (2 bytes/px vs 4 bytes/px RGBA8888 = 50% VRAM saved)
        for (let y = 0; y < h; y++) {
          const rowBase = y * w;
          const by = (y & 3) * 4;
          for (let x = 0; x < w; x++) {
            const idx = rowBase + x;
            const p = idx * 4;
            const dither = (BAYER_4X4[by + (x & 3)] - 7.5) * 0.9;
            const r4 = Math.max(0, Math.min(15, ((imgData[p] + dither) * 15) / 255 + 0.5)) | 0;
            const g4 =
              Math.max(0, Math.min(15, ((imgData[p + 1] + dither) * 15) / 255 + 0.5)) | 0;
            const b4 =
              Math.max(0, Math.min(15, ((imgData[p + 2] + dither) * 15) / 255 + 0.5)) | 0;
            const a4 = Math.max(0, Math.min(15, (imgData[p + 3] * 15) / 255 + 0.5)) | 0;
            packed[idx] = (r4 << 12) | (g4 << 8) | (b4 << 4) | a4;
          }
        }
        const tex = new THREE.DataTexture(
          packed,
          w,
          h,
          THREE.RGBAFormat,
          THREE.UnsignedShort4444Type
        );
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        tex.anisotropy = 1;
        tex.needsUpdate = true;
        cachedByteEstimates.set(tex, w * h * 2);
        return tex;
      } else {
        // RGBA5551 packed into UnsignedShort5551Type (2 bytes/px, full WebGL2 core, 50% VRAM saved)
        for (let y = 0; y < h; y++) {
          const rowBase = y * w;
          const by = (y & 3) * 4;
          for (let x = 0; x < w; x++) {
            const idx = rowBase + x;
            const p = idx * 4;
            const dither = (BAYER_4X4[by + (x & 3)] - 7.5) * 0.45;
            const r5 = Math.max(0, Math.min(31, ((imgData[p] + dither) * 31) / 255 + 0.5)) | 0;
            const g5 =
              Math.max(0, Math.min(31, ((imgData[p + 1] + dither) * 31) / 255 + 0.5)) | 0;
            const b5 =
              Math.max(0, Math.min(31, ((imgData[p + 2] + dither) * 31) / 255 + 0.5)) | 0;
            packed[idx] = (r5 << 11) | (g5 << 6) | (b5 << 1) | 1;
          }
        }
        const tex = new THREE.DataTexture(
          packed,
          w,
          h,
          THREE.RGBAFormat,
          THREE.UnsignedShort5551Type
        );
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        tex.anisotropy = 1;
        tex.needsUpdate = true;
        cachedByteEstimates.set(tex, w * h * 2);
        return tex;
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = Boolean(options.allowMipmaps);
  tex.minFilter = options.allowMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = options.anisotropy ?? 1;
  tex.needsUpdate = true;
  const mipFactor = options.allowMipmaps ? 1.33 : 1.0;
  cachedByteEstimates.set(tex, Math.round(canvas.width * canvas.height * 4 * mipFactor));
  return tex;
}

/**
 * Estimates total GPU VRAM occupied by all textures currently attached inside a scene graph.
 */
export function estimateSceneTextureVramBytes(root: THREE.Object3D): number {
  const seen = new Set<THREE.Texture>();
  let totalBytes = 0;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      const mRecord = m as unknown as Record<string, unknown>;
      for (const key of ['map', 'emissiveMap', 'alphaMap', 'roughnessMap', 'envMap']) {
        const tex = mRecord[key] as THREE.Texture | undefined;
        if (!tex || seen.has(tex)) continue;
        seen.add(tex);
        totalBytes += estimateSingleTextureBytes(tex);
      }
    }
  });

  return totalBytes;
}

export function estimateSingleTextureBytes(tex: THREE.Texture): number {
  const cached = cachedByteEstimates.get(tex);
  if (cached !== undefined) return cached;

  const img = tex.image as
    | {width?: number; height?: number; videoWidth?: number; videoHeight?: number}
    | undefined;
  const w = img?.width ?? img?.videoWidth ?? 128;
  const h = img?.height ?? img?.videoHeight ?? 128;
  const bpp =
    tex.type === THREE.UnsignedShort4444Type || tex.type === THREE.UnsignedShort5551Type ? 2 : 4;
  const mipFactor = tex.generateMipmaps ? 1.33 : 1.0;
  return Math.round(w * h * bpp * mipFactor);
}
