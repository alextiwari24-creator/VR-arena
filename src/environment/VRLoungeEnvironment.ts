import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import {QualityProfileConfig} from '../engine/MobileVREngine.ts';
import {buildOptimizedSurfaceTexture} from '../engine/TextureOptimizer.ts';
import {VREffectiveTier} from '../types.ts';

const STAR_COUNT = 320;

export class VRLoungeEnvironment extends xb.Script {
  private hemiLight!: THREE.HemisphereLight;
  private keyLight!: THREE.DirectionalLight;
  private rimLight!: THREE.PointLight;
  private envTexture: THREE.Texture | null = null;

  private floorGroup = new THREE.Group();
  private floorMesh!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private compassRingGroup = new THREE.Group();
  private theaterGroup = new THREE.Group();
  private vrDomeGroup = new THREE.Group();
  private skyMesh!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private vrArenaGroup = new THREE.Group();
  private haloRingA!: THREE.Mesh;
  private haloRingB!: THREE.Mesh;
  private starMesh!: THREE.InstancedMesh;

  private readonly lodNodes: THREE.LOD[] = [];
  private readonly lodBaseDistances: Array<{d1: number; d2: number}> = [];
  private lodBias = 1.0;

  public screenMesh!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private screenGlowBarTop!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private screenGlowBarBottom!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

  private readonly disposables: Array<{dispose: () => void}> = [];
  private skyTexture: THREE.Texture | null = null;
  private deckTexture: THREE.Texture | null = null;
  private activeTextureTier: VREffectiveTier = 'balanced';

  private dimLevel = 0; // 0 = bright lounge, 1 = cinema dark
  private targetDimLevel = 0;
  private elapsed = 0;
  private arPassthrough = false;
  private arVideoTexture: THREE.VideoTexture | null = null;
  private currentProfile: QualityProfileConfig | null = null;

  init(): void {
    this.setupLightingAndEnvironment();
    this.buildVRSkyDome();
    this.buildRadialDeck();
    this.buildCompassRing();
    this.buildVRArenaPillars();
    this.buildCurvedTheaterAssembly();
    this.buildStarfieldDome();
  }

  private setupLightingAndEnvironment(): void {
    const scene = xb.core.scene;
    scene.background = new THREE.Color(0x060914);
    scene.fog = new THREE.FogExp2(0x060914, 0.032);

    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    if (renderer) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const roomEnv = new RoomEnvironment();
      this.envTexture = pmrem.fromScene(roomEnv, 0.04).texture;
      scene.environment = this.envTexture;
      roomEnv.dispose();
      pmrem.dispose();
    }

    this.hemiLight = new THREE.HemisphereLight(0x8bb8ff, 0x181028, 2.2);
    this.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xfff1dc, 2.4);
    this.keyLight.position.set(3.5, 6.5, 4.0);
    this.add(this.keyLight);

    this.rimLight = new THREE.PointLight(0x6366f1, 4.5, 16);
    this.rimLight.position.set(0, 3.2, -3.5);
    this.add(this.rimLight);
  }

  private createSkyTexture(tier: VREffectiveTier): THREE.Texture {
    const size = tier === 'high' ? 512 : 256;
    const s = size / 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.scale(s, s);
      const grad = ctx.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0.0, '#040615');
      grad.addColorStop(0.32, '#0a1230');
      grad.addColorStop(0.5, '#121d46');
      grad.addColorStop(0.62, '#080e22');
      grad.addColorStop(1.0, '#03050c');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 512, 512);

      const aurora = ctx.createLinearGradient(0, 220, 0, 290);
      aurora.addColorStop(0, 'rgba(56, 189, 248, 0)');
      aurora.addColorStop(0.5, 'rgba(56, 189, 248, 0.22)');
      aurora.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = aurora;
      ctx.fillRect(0, 220, 512, 70);
      ctx.restore();
    }
    return buildOptimizedSurfaceTexture(canvas, tier, {alpha: false});
  }

  private buildVRSkyDome(): void {
    this.vrDomeGroup.name = 'VR 360 Sky Dome';
    this.vrDomeGroup.xb = {pointerEvents: 'none'};

    this.skyTexture = this.createSkyTexture(this.activeTextureTier);

    const skyGeo = new THREE.SphereGeometry(28, 24, 14);
    const skyMat = new THREE.MeshBasicMaterial({
      map: this.skyTexture,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.xb = {pointerEvents: 'none'};
    this.skyMesh.matrixAutoUpdate = false;
    this.skyMesh.updateMatrix();

    // Geodesic VR holodeck wireframe dome
    const gridGeo = new THREE.SphereGeometry(21, 20, 12);
    const gridMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.085,
      depthWrite: false,
    });
    const gridMesh = new THREE.Mesh(gridGeo, gridMat);
    gridMesh.xb = {pointerEvents: 'none'};
    gridMesh.matrixAutoUpdate = false;
    gridMesh.updateMatrix();

    this.vrDomeGroup.add(this.skyMesh, gridMesh);
    this.disposables.push(skyGeo, skyMat, gridGeo, gridMat);
    this.add(this.vrDomeGroup);
  }

  private buildVRArenaPillars(): void {
    this.vrArenaGroup.name = 'VR 360 Arena Architecture';
    this.vrArenaGroup.xb = {pointerEvents: 'none'};

    const pillarBaseGeo = new THREE.BoxGeometry(0.18, 2.8, 0.18);
    const pillarBaseMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.35,
      metalness: 0.85,
    });
    const neonStripGeo = new THREE.BoxGeometry(0.035, 2.4, 0.2);
    const neonStripMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.72,
    });
    const beaconGeo = new THREE.OctahedronGeometry(0.09, 0);
    const beaconMat = new THREE.MeshBasicMaterial({
      color: 0xa855f7,
      transparent: true,
      opacity: 0.8,
    });
    const midPylonMat = new THREE.MeshBasicMaterial({
      color: 0x172554,
    });

    // 8 surrounding VR arena pylons wrapped in 3-tier THREE.LOD
    // (0..5.2m: 3-part PBR+neon+beacon; 5.2..11m: 1-draw basic box; >11m: culled)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const r = 4.55;

      const lod = new THREE.LOD();
      lod.position.set(Math.sin(angle) * r, 1.4, -Math.cos(angle) * r);
      lod.lookAt(0, 1.4, 0);
      lod.xb = {pointerEvents: 'none'};
      lod.matrixAutoUpdate = false;
      lod.updateMatrix();

      const highGroup = new THREE.Group();
      const body = new THREE.Mesh(pillarBaseGeo, pillarBaseMat);
      const strip = new THREE.Mesh(neonStripGeo, neonStripMat);
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.y = 1.65;
      highGroup.add(body, strip, beacon);

      const midMesh = new THREE.Mesh(pillarBaseGeo, midPylonMat);
      const emptyFar = new THREE.Object3D();

      lod.addLevel(highGroup, 0);
      lod.addLevel(midMesh, 5.2);
      lod.addLevel(emptyFar, 11.0);
      this.registerLod(lod, 5.2, 11.0);

      this.vrArenaGroup.add(lod);
    }

    // 12 distant 360-degree VR horizon monoliths batched into ONE InstancedMesh (-11 draw calls)
    const monoGeo = new THREE.BoxGeometry(0.75, 7.5, 0.75);
    const monoMat = new THREE.MeshLambertMaterial({
      color: 0x0b1530,
      emissive: 0x1e3a8a,
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0.82,
    });
    const monoInstanced = new THREE.InstancedMesh(monoGeo, monoMat, 12);
    monoInstanced.xb = {pointerEvents: 'none'};
    monoInstanced.matrixAutoUpdate = false;
    monoInstanced.updateMatrix();
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const dist = 12.2 + (i % 3) * 1.8;
      const hScale = 0.7 + (i % 4) * 0.35;
      dummy.position.set(Math.sin(angle) * dist, (7.5 * hScale) / 2 - 0.5, -Math.cos(angle) * dist);
      dummy.scale.set(1, hScale, 1);
      dummy.lookAt(0, dummy.position.y, 0);
      dummy.updateMatrix();
      monoInstanced.setMatrixAt(i, dummy.matrix);
    }
    monoInstanced.instanceMatrix.needsUpdate = true;
    monoInstanced.computeBoundingSphere();
    this.vrArenaGroup.add(monoInstanced);

    // Dual counter-rotating overhead VR orbital halo rings
    const haloGeoA = new THREE.TorusGeometry(5.6, 0.025, 8, 56);
    const haloMatA = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.38,
    });
    this.haloRingA = new THREE.Mesh(haloGeoA, haloMatA);
    this.haloRingA.position.y = 4.2;
    this.haloRingA.rotation.x = Math.PI / 2 + 0.18;
    this.haloRingA.xb = {pointerEvents: 'none'};

    const haloGeoB = new THREE.TorusGeometry(7.2, 0.022, 8, 64);
    const haloMatB = new THREE.MeshBasicMaterial({
      color: 0x818cf8,
      transparent: true,
      opacity: 0.32,
    });
    this.haloRingB = new THREE.Mesh(haloGeoB, haloMatB);
    this.haloRingB.position.y = 4.8;
    this.haloRingB.rotation.x = Math.PI / 2 - 0.22;
    this.haloRingB.xb = {pointerEvents: 'none'};

    this.vrArenaGroup.add(this.haloRingA, this.haloRingB);
    this.disposables.push(
      pillarBaseGeo,
      pillarBaseMat,
      neonStripGeo,
      neonStripMat,
      beaconGeo,
      beaconMat,
      midPylonMat,
      monoGeo,
      monoMat,
      haloGeoA,
      haloMatA,
      haloGeoB,
      haloMatB
    );
    this.add(this.vrArenaGroup);
  }

  private createDeckFloorTexture(tier: VREffectiveTier): THREE.Texture {
    const size = tier === 'high' ? 512 : 256;
    const s = size / 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.scale(s, s);
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(0, 0, 512, 512);

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.lineWidth = 2;
      for (let r = 48; r <= 240; r += 48) {
        ctx.beginPath();
        ctx.arc(256, 256, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (let a = 0; a < 12; a++) {
        const rad = (a / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(256 + Math.cos(rad) * 32, 256 + Math.sin(rad) * 32);
        ctx.lineTo(256 + Math.cos(rad) * 246, 256 + Math.sin(rad) * 246);
        ctx.stroke();
      }

      const grad = ctx.createRadialGradient(256, 256, 180, 256, 256, 256);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0)');
      grad.addColorStop(0.85, 'rgba(56, 189, 248, 0.12)');
      grad.addColorStop(1, 'rgba(99, 102, 241, 0.4)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(256, 256, 256, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    const maxAniso = renderer?.capabilities?.getMaxAnisotropy
      ? renderer.capabilities.getMaxAnisotropy()
      : 1;
    const anisotropy = tier === 'high' ? Math.min(4, maxAniso) : 1;

    return buildOptimizedSurfaceTexture(canvas, tier, {
      alpha: false,
      anisotropy,
      allowMipmaps: tier === 'high',
    });
  }

  private buildRadialDeck(): void {
    this.floorGroup.name = 'VR Lounge Deck';
    this.floorGroup.xb = {pointerEvents: 'none'};

    this.deckTexture = this.createDeckFloorTexture(this.activeTextureTier);

    // 1. Main circular floor plate (static matrix frozen)
    const floorGeo = new THREE.CylinderGeometry(4.4, 4.6, 0.08, 48);
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.deckTexture,
      roughness: 0.42,
      metalness: 0.55,
    });
    this.floorMesh = new THREE.Mesh(floorGeo, floorMat);
    this.floorMesh.position.y = -0.04;
    this.floorMesh.matrixAutoUpdate = false;
    this.floorMesh.updateMatrix();
    this.floorGroup.add(this.floorMesh);

    // 2. Outer metallic bezel ring
    const outerRingGeo = new THREE.TorusGeometry(4.45, 0.06, 12, 56);
    const outerRingMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.2,
      metalness: 0.9,
    });
    const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRing.rotation.x = Math.PI / 2;
    outerRing.position.y = 0.01;
    outerRing.matrixAutoUpdate = false;
    outerRing.updateMatrix();
    this.floorGroup.add(outerRing);

    // 3. Inner neon accent ring
    const neonRingGeo = new THREE.TorusGeometry(2.3, 0.018, 10, 48);
    const neonRingMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x38bdf8,
      emissiveIntensity: 1.6,
      roughness: 0.25,
      metalness: 0.1,
    });
    const neonRing = new THREE.Mesh(neonRingGeo, neonRingMat);
    neonRing.rotation.x = Math.PI / 2;
    neonRing.position.y = 0.02;
    neonRing.matrixAutoUpdate = false;
    neonRing.updateMatrix();
    this.floorGroup.add(neonRing);

    // 4. Outer ambient ground plane (unlit Basic saves full PBR fragment cost on 38m horizon)
    const horizonGeo = new THREE.CircleGeometry(38, 32);
    const horizonMat = new THREE.MeshBasicMaterial({
      color: 0x050811,
    });
    const horizonFloor = new THREE.Mesh(horizonGeo, horizonMat);
    horizonFloor.rotation.x = -Math.PI / 2;
    horizonFloor.position.y = -0.085;
    horizonFloor.matrixAutoUpdate = false;
    horizonFloor.updateMatrix();
    this.floorGroup.add(horizonFloor);

    this.disposables.push(
      floorGeo,
      floorMat,
      outerRingGeo,
      outerRingMat,
      neonRingGeo,
      neonRingMat,
      horizonGeo,
      horizonMat
    );
    this.add(this.floorGroup);
  }

  private buildCompassRing(): void {
    this.compassRingGroup.name = 'Compass Floor Ring';
    this.compassRingGroup.position.y = 0.025;
    this.compassRingGroup.xb = {pointerEvents: 'none'};

    const radius = 1.9;
    const cardinals = [
      {label: 'N', angle: 0, color: '#f43f5e'},
      {label: 'E', angle: Math.PI / 2, color: '#38bdf8'},
      {label: 'S', angle: Math.PI, color: '#94a3b8'},
      {label: 'W', angle: (Math.PI * 3) / 2, color: '#38bdf8'},
    ];

    // All 32 non-cardinal ticks batched into ONE InstancedMesh (-31 draw calls)
    const tickGeo = new THREE.BoxGeometry(0.015, 0.008, 0.08);
    const tickMat = new THREE.MeshBasicMaterial({
      color: 0x475569,
    });
    const tickInstanced = new THREE.InstancedMesh(tickGeo, tickMat, 32);
    tickInstanced.matrixAutoUpdate = false;
    tickInstanced.updateMatrix();

    const dummy = new THREE.Object3D();
    let idx = 0;
    for (let i = 0; i < 36; i++) {
      if (i % 9 === 0) continue;
      const angle = (i / 36) * Math.PI * 2;
      dummy.position.set(Math.sin(angle) * radius, 0, -Math.cos(angle) * radius);
      dummy.rotation.set(0, -angle, 0);
      dummy.updateMatrix();
      tickInstanced.setMatrixAt(idx++, dummy.matrix);
    }
    tickInstanced.instanceMatrix.needsUpdate = true;
    tickInstanced.computeBoundingSphere();
    this.compassRingGroup.add(tickInstanced);
    this.disposables.push(tickGeo, tickMat);

    const badgeGeo = new THREE.PlaneGeometry(0.22, 0.22);
    this.disposables.push(badgeGeo);

    for (const c of cardinals) {
      const badgeCanvas = document.createElement('canvas');
      badgeCanvas.width = 64;
      badgeCanvas.height = 64;
      const ctx = badgeCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.beginPath();
        ctx.arc(32, 32, 27, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 31px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.label, 32, 33);
      }
      const tex = buildOptimizedSurfaceTexture(badgeCanvas, 'eco', {alpha: true});
      const mat = new THREE.MeshBasicMaterial({map: tex, transparent: true});
      const badge = new THREE.Mesh(badgeGeo, mat);
      badge.position.set(Math.sin(c.angle) * radius, 0.01, -Math.cos(c.angle) * radius);
      badge.rotation.x = -Math.PI / 2;
      badge.matrixAutoUpdate = false;
      badge.updateMatrix();
      this.compassRingGroup.add(badge);
      this.disposables.push(tex, mat);
    }

    this.add(this.compassRingGroup);
  }

  private buildCurvedTheaterAssembly(): void {
    this.theaterGroup.name = 'Curved VR Theater';
    this.theaterGroup.position.set(0, 1.95, -0.4);

    // 1. Curved screen surface (arc facing user at origin)
    const screenRadius = 3.2;
    const arcAngle = 0.92;
    const screenHeight = 1.65;

    const screenGeo = new THREE.CylinderGeometry(
      screenRadius,
      screenRadius,
      screenHeight,
      36,
      1,
      true,
      Math.PI - arcAngle / 2,
      arcAngle
    );
    const uvAttr = screenGeo.attributes.uv;
    for (let i = 0; i < uvAttr.count; i++) {
      uvAttr.setX(i, 1 - uvAttr.getX(i));
    }
    uvAttr.needsUpdate = true;

    const initialTex = this.createPlaceholderScreenTexture();
    const screenMat = new THREE.MeshBasicMaterial({
      map: initialTex,
      side: THREE.BackSide,
    });
    this.screenMesh = new THREE.Mesh(screenGeo, screenMat);
    this.screenMesh.name = 'VR Theater Screen';
    this.screenMesh.matrixAutoUpdate = false;
    this.screenMesh.updateMatrix();
    this.theaterGroup.add(this.screenMesh);

    // 2. Curved metallic outer frame shell behind screen
    const frameGeo = new THREE.CylinderGeometry(
      screenRadius + 0.05,
      screenRadius + 0.05,
      screenHeight + 0.14,
      36,
      1,
      true,
      Math.PI - (arcAngle + 0.05) / 2,
      arcAngle + 0.05
    );
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.3,
      metalness: 0.85,
      side: THREE.DoubleSide,
    });
    const frameMesh = new THREE.Mesh(frameGeo, frameMat);
    frameMesh.xb = {pointerEvents: 'none'};
    frameMesh.matrixAutoUpdate = false;
    frameMesh.updateMatrix();
    this.theaterGroup.add(frameMesh);

    // 3. Top and bottom glowing neon trim arcs
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x38bdf8,
      emissiveIntensity: 1.5,
      roughness: 0.2,
      metalness: 0.2,
    });
    const barGeo = new THREE.CylinderGeometry(
      screenRadius - 0.01,
      screenRadius - 0.01,
      0.032,
      36,
      1,
      true,
      Math.PI - arcAngle / 2,
      arcAngle
    );
    this.screenGlowBarTop = new THREE.Mesh(barGeo, barMat);
    this.screenGlowBarTop.position.y = screenHeight / 2 + 0.035;
    this.screenGlowBarTop.xb = {pointerEvents: 'none'};
    this.screenGlowBarTop.matrixAutoUpdate = false;
    this.screenGlowBarTop.updateMatrix();

    this.screenGlowBarBottom = new THREE.Mesh(barGeo, barMat);
    this.screenGlowBarBottom.position.y = -screenHeight / 2 - 0.035;
    this.screenGlowBarBottom.xb = {pointerEvents: 'none'};
    this.screenGlowBarBottom.matrixAutoUpdate = false;
    this.screenGlowBarBottom.updateMatrix();

    this.theaterGroup.add(this.screenGlowBarTop, this.screenGlowBarBottom);

    // 4. Left & right spatial speaker towers with 2-level THREE.LOD (Detailed 7-mesh close -> 1-mesh box mid/far)
    const speakerMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.45,
      metalness: 0.75,
    });
    const lowSpeakerMat = new THREE.MeshBasicMaterial({
      color: 0x1e293b,
    });
    const coneMat = new THREE.MeshLambertMaterial({
      color: 0x0f172a,
    });
    const towerGeo = new THREE.BoxGeometry(0.24, 1.45, 0.22);
    const coneGeo = new THREE.CylinderGeometry(0.075, 0.055, 0.04, 16);
    const ringTrimGeo = new THREE.TorusGeometry(0.078, 0.008, 8, 20);

    for (const side of [-1, 1]) {
      const towerLod = new THREE.LOD();
      const angle = Math.PI + side * (arcAngle / 2 + 0.09);
      towerLod.position.set(
        Math.sin(angle) * screenRadius,
        -0.05,
        Math.cos(angle) * screenRadius
      );
      towerLod.lookAt(0, -0.05, 0);
      towerLod.xb = {pointerEvents: 'none'};
      towerLod.matrixAutoUpdate = false;
      towerLod.updateMatrix();

      const highTower = new THREE.Group();
      const body = new THREE.Mesh(towerGeo, speakerMat);
      highTower.add(body);
      for (const yOff of [-0.36, 0.04, 0.42]) {
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.rotation.x = Math.PI / 2;
        cone.position.set(0, yOff, 0.11);
        const trim = new THREE.Mesh(ringTrimGeo, barMat);
        trim.position.set(0, yOff, 0.125);
        highTower.add(cone, trim);
      }

      const lowTower = new THREE.Mesh(towerGeo, lowSpeakerMat);

      towerLod.addLevel(highTower, 0);
      towerLod.addLevel(lowTower, 3.8);
      this.registerLod(towerLod, 3.8, 999);
      this.theaterGroup.add(towerLod);
    }

    this.disposables.push(
      initialTex,
      screenGeo,
      screenMat,
      frameGeo,
      frameMat,
      barGeo,
      barMat,
      speakerMat,
      lowSpeakerMat,
      coneMat,
      towerGeo,
      coneGeo,
      ringTrimGeo
    );
    this.add(this.theaterGroup);
  }

  private createPlaceholderScreenTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#090d1a';
      ctx.fillRect(0, 0, 512, 256);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('POCKETVR PLAY THEATER', 256, 120);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px sans-serif';
      ctx.fillText('Install an app from the Play Store or launch a game', 256, 150);
    }
    return buildOptimizedSurfaceTexture(canvas, 'eco', {alpha: false});
  }

  private buildStarfieldDome(): void {
    const starGeo = new THREE.OctahedronGeometry(0.05, 0);
    const starMat = new THREE.MeshBasicMaterial({color: 0xffffff});
    this.starMesh = new THREE.InstancedMesh(starGeo, starMat, STAR_COUNT);
    this.starMesh.xb = {pointerEvents: 'none'};

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const palette = [0x93c5fd, 0xc4b5fd, 0xf9a8d4, 0x67e8f9, 0xffffff];

    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.85 + 0.08);
      const radius = 14 + Math.random() * 14;
      dummy.position.set(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi) + 0.5,
        radius * Math.sin(phi) * Math.sin(theta)
      );
      const scale = 0.55 + Math.random() * 1.35;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      this.starMesh.setMatrixAt(i, dummy.matrix);

      color.setHex(palette[i % palette.length]);
      this.starMesh.setColorAt(i, color);
    }
    this.starMesh.instanceMatrix.needsUpdate = true;
    if (this.starMesh.instanceColor) this.starMesh.instanceColor.needsUpdate = true;
    this.starMesh.computeBoundingSphere();

    this.disposables.push(starGeo, starMat);
    this.add(this.starMesh);
  }

  private registerLod(lod: THREE.LOD, d1: number, d2: number): void {
    this.lodNodes.push(lod);
    this.lodBaseDistances.push({d1, d2});
  }

  public setLodBias(bias: number): void {
    const b = Math.max(0.35, bias);
    if (Math.abs(b - this.lodBias) < 0.02) return;
    this.lodBias = b;
    for (let i = 0; i < this.lodNodes.length; i++) {
      const lod = this.lodNodes[i];
      const base = this.lodBaseDistances[i];
      if (lod.levels.length > 1) lod.levels[1].distance = base.d1 * b;
      if (lod.levels.length > 2) lod.levels[2].distance = base.d2 * b;
    }
  }

  public updateLODs(camera: THREE.Camera, outCounts?: {high: number; mid: number; low: number}): void {
    for (let i = 0; i < this.lodNodes.length; i++) {
      const lod = this.lodNodes[i];
      lod.update(camera);
      if (outCounts) {
        const level = lod.getCurrentLevel();
        if (level === 0) outCounts.high += 1;
        else if (level === 1) outCounts.mid += 1;
        else outCounts.low += 1;
      }
    }
  }

  setTheaterDim(dim: number): void {
    this.targetDimLevel = THREE.MathUtils.clamp(dim, 0, 1);
  }

  setAccentColor(hex: string): void {
    const mat = this.screenGlowBarTop.material;
    mat.color.set(hex);
    mat.emissive.set(hex);
    this.rimLight.color.set(hex);
  }

  setCompassRingRotation(headingDeg: number): void {
    this.compassRingGroup.rotation.y = THREE.MathUtils.degToRad(headingDeg);
  }

  setTheaterScale(scale: number): void {
    const s = THREE.MathUtils.clamp(scale, 0.75, 1.35);
    this.theaterGroup.scale.setScalar(s);
  }

  setARPassthrough(enabled: boolean, video: HTMLVideoElement | null): boolean {
    const scene = xb.core.scene;
    if (enabled && video) {
      if (this.arVideoTexture) {
        this.arVideoTexture.dispose();
      }
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      this.arVideoTexture = tex;
      scene.background = tex;
      scene.fog = null;
      this.floorGroup.visible = false;
      this.starMesh.visible = false;
      this.vrDomeGroup.visible = false;
      this.vrArenaGroup.visible = false;
      this.arPassthrough = true;
      return true;
    }

    this.arPassthrough = false;
    scene.background = new THREE.Color(0x060914);
    scene.fog =
      this.currentProfile && !this.currentProfile.enableFog
        ? null
        : new THREE.FogExp2(0x060914, 0.026);
    this.floorGroup.visible = true;
    this.starMesh.visible = true;
    this.vrDomeGroup.visible = true;
    this.vrArenaGroup.visible = this.currentProfile ? this.currentProfile.showSecondaryProps : true;
    if (this.arVideoTexture) {
      this.arVideoTexture.dispose();
      this.arVideoTexture = null;
    }
    return false;
  }

  public setQualityProfile(profile: QualityProfileConfig, tier: VREffectiveTier = 'balanced'): void {
    this.currentProfile = profile;
    this.setLodBias(profile.lodBias);

    if (this.starMesh) {
      this.starMesh.count = Math.max(48, Math.round(STAR_COUNT * profile.starRatio));
    }

    if (tier !== this.activeTextureTier) {
      this.activeTextureTier = tier;
      if (this.skyMesh) {
        const nextSky = this.createSkyTexture(tier);
        const prevSky = this.skyTexture;
        this.skyMesh.material.map = nextSky;
        this.skyMesh.material.needsUpdate = true;
        this.skyTexture = nextSky;
        prevSky?.dispose();
      }
      if (this.floorMesh) {
        const nextDeck = this.createDeckFloorTexture(tier);
        const prevDeck = this.deckTexture;
        this.floorMesh.material.map = nextDeck;
        this.floorMesh.material.needsUpdate = true;
        this.deckTexture = nextDeck;
        prevDeck?.dispose();
      }
    }

    const scene = xb.core.scene;
    if (scene) {
      // Skip PMREM environment map lookup on Eco for lower fragment shader cost
      scene.environment = tier === 'eco' ? null : this.envTexture;
      if (!this.arPassthrough) {
        scene.fog = profile.enableFog ? new THREE.FogExp2(0x060914, 0.026) : null;
      }
    }
    if (!this.arPassthrough && this.vrArenaGroup) {
      this.vrArenaGroup.visible = profile.showSecondaryProps;
    }
  }

  public releaseDormantResources(): void {
    if (!this.arPassthrough && this.arVideoTexture) {
      this.arVideoTexture.dispose();
      this.arVideoTexture = null;
    }
  }

  isARPassthrough(): boolean {
    return this.arPassthrough;
  }

  update(): void {
    const dt = xb.getDeltaTime();
    this.elapsed += dt;

    if (xb.core.camera) {
      this.updateLODs(xb.core.camera);
    }

    this.dimLevel = THREE.MathUtils.damp(this.dimLevel, this.targetDimLevel, 4.0, dt);
    this.hemiLight.intensity = THREE.MathUtils.lerp(2.2, 0.45, this.dimLevel);
    this.keyLight.intensity = THREE.MathUtils.lerp(2.4, 0.35, this.dimLevel);
    this.rimLight.intensity = THREE.MathUtils.lerp(4.5, 2.0, this.dimLevel);

    if (this.starMesh.visible) {
      this.starMesh.rotation.y = this.elapsed * 0.008;
    }
    if (this.vrArenaGroup.visible) {
      this.haloRingA.rotation.z = this.elapsed * 0.09;
      this.haloRingB.rotation.z = -this.elapsed * 0.065;
    }
  }

  dispose(): void {
    if (this.arVideoTexture) {
      this.arVideoTexture.dispose();
      this.arVideoTexture = null;
    }
    if (this.skyTexture) {
      this.skyTexture.dispose();
      this.skyTexture = null;
    }
    if (this.deckTexture) {
      this.deckTexture.dispose();
      this.deckTexture = null;
    }
    if (this.envTexture) {
      this.envTexture.dispose();
      this.envTexture = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
