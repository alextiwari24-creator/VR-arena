import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import {QualityProfileConfig} from '../engine/MobileVREngine.ts';

const STAR_COUNT = 320;

export class VRLoungeEnvironment extends xb.Script {
  private hemiLight!: THREE.HemisphereLight;
  private keyLight!: THREE.DirectionalLight;
  private rimLight!: THREE.PointLight;
  private envTexture: THREE.Texture | null = null;

  private floorGroup = new THREE.Group();
  private compassRingGroup = new THREE.Group();
  private theaterGroup = new THREE.Group();
  private vrDomeGroup = new THREE.Group();
  private vrArenaGroup = new THREE.Group();
  private haloRingA!: THREE.Mesh;
  private haloRingB!: THREE.Mesh;
  private starMesh!: THREE.InstancedMesh;

  public screenMesh!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private screenGlowBarTop!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private screenGlowBarBottom!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

  private readonly disposables: Array<{dispose: () => void}> = [];
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

  private buildVRSkyDome(): void {
    this.vrDomeGroup.name = 'VR 360 Sky Dome';
    this.vrDomeGroup.xb = {pointerEvents: 'none'};

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0.0, '#040615');
      grad.addColorStop(0.32, '#0a1230');
      grad.addColorStop(0.5, '#121d46');
      grad.addColorStop(0.62, '#080e22');
      grad.addColorStop(1.0, '#03050c');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 512, 512);

      // Subtle horizon aurora band
      const aurora = ctx.createLinearGradient(0, 220, 0, 290);
      aurora.addColorStop(0, 'rgba(56, 189, 248, 0)');
      aurora.addColorStop(0.5, 'rgba(56, 189, 248, 0.22)');
      aurora.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = aurora;
      ctx.fillRect(0, 220, 512, 70);
    }
    const skyTex = new THREE.CanvasTexture(canvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;

    const skyGeo = new THREE.SphereGeometry(28, 32, 20);
    const skyMat = new THREE.MeshBasicMaterial({
      map: skyTex,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.xb = {pointerEvents: 'none'};

    // Geodesic VR holodeck wireframe dome for unmistakable 360-degree VR spatial orientation
    const gridGeo = new THREE.SphereGeometry(21, 28, 16);
    const gridMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.085,
      depthWrite: false,
    });
    const gridMesh = new THREE.Mesh(gridGeo, gridMat);
    gridMesh.xb = {pointerEvents: 'none'};

    this.vrDomeGroup.add(skyMesh, gridMesh);
    this.disposables.push(skyTex, skyGeo, skyMat, gridGeo, gridMat);
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

    // 8 surrounding VR arena pylons around the 4.6m perimeter deck
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const r = 4.55;
      const pylon = new THREE.Group();
      pylon.position.set(Math.sin(angle) * r, 1.4, -Math.cos(angle) * r);
      pylon.lookAt(0, 1.4, 0);
      pylon.xb = {pointerEvents: 'none'};

      const body = new THREE.Mesh(pillarBaseGeo, pillarBaseMat);
      const strip = new THREE.Mesh(neonStripGeo, neonStripMat);
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.y = 1.65;
      pylon.add(body, strip, beacon);
      this.vrArenaGroup.add(pylon);
    }

    // 12 distant 360-degree VR horizon monoliths for strong head-turn parallax
    const monoGeo = new THREE.BoxGeometry(0.75, 7.5, 0.75);
    const monoMat = new THREE.MeshStandardMaterial({
      color: 0x0b1530,
      emissive: 0x1e3a8a,
      emissiveIntensity: 0.45,
      roughness: 0.4,
      metalness: 0.65,
      transparent: true,
      opacity: 0.82,
    });
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const dist = 12.2 + (i % 3) * 1.8;
      const hScale = 0.7 + (i % 4) * 0.35;
      const mono = new THREE.Mesh(monoGeo, monoMat);
      mono.scale.set(1, hScale, 1);
      mono.position.set(Math.sin(angle) * dist, (7.5 * hScale) / 2 - 0.5, -Math.cos(angle) * dist);
      mono.lookAt(0, mono.position.y, 0);
      mono.xb = {pointerEvents: 'none'};
      this.vrArenaGroup.add(mono);
    }

    // Dual counter-rotating overhead VR orbital halo rings
    const haloGeoA = new THREE.TorusGeometry(5.6, 0.025, 10, 84);
    const haloMatA = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.38,
    });
    this.haloRingA = new THREE.Mesh(haloGeoA, haloMatA);
    this.haloRingA.position.y = 4.2;
    this.haloRingA.rotation.x = Math.PI / 2 + 0.18;
    this.haloRingA.xb = {pointerEvents: 'none'};

    const haloGeoB = new THREE.TorusGeometry(7.2, 0.022, 10, 96);
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
      monoGeo,
      monoMat,
      haloGeoA,
      haloMatA,
      haloGeoB,
      haloMatB
    );
    this.add(this.vrArenaGroup);
  }

  private createDeckFloorTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(0, 0, 512, 512);

      // Radial concentric rings
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.lineWidth = 2;
      for (let r = 48; r <= 240; r += 48) {
        ctx.beginPath();
        ctx.arc(256, 256, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Radial spokes
      for (let a = 0; a < 12; a++) {
        const rad = (a / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(256 + Math.cos(rad) * 32, 256 + Math.sin(rad) * 32);
        ctx.lineTo(256 + Math.cos(rad) * 246, 256 + Math.sin(rad) * 246);
        ctx.stroke();
      }

      // Outer subtle glow border
      const grad = ctx.createRadialGradient(256, 256, 180, 256, 256, 256);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0)');
      grad.addColorStop(0.85, 'rgba(56, 189, 248, 0.12)');
      grad.addColorStop(1, 'rgba(99, 102, 241, 0.4)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(256, 256, 256, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    if (renderer?.capabilities) {
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }
    this.disposables.push(texture);
    return texture;
  }

  private buildRadialDeck(): void {
    this.floorGroup.name = 'VR Lounge Deck';
    this.floorGroup.xb = {pointerEvents: 'none'};

    // 1. Main circular floor plate
    const floorGeo = new THREE.CylinderGeometry(4.4, 4.6, 0.08, 64);
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.createDeckFloorTexture(),
      roughness: 0.42,
      metalness: 0.55,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.y = -0.04;
    this.floorGroup.add(floorMesh);

    // 2. Outer metallic bezel ring
    const outerRingGeo = new THREE.TorusGeometry(4.45, 0.06, 16, 72);
    const outerRingMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.2,
      metalness: 0.9,
    });
    const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRing.rotation.x = Math.PI / 2;
    outerRing.position.y = 0.01;
    this.floorGroup.add(outerRing);

    // 3. Inner neon accent ring
    const neonRingGeo = new THREE.TorusGeometry(2.3, 0.018, 12, 64);
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
    this.floorGroup.add(neonRing);

    // 4. Outer ambient ground plane extending into horizon fog
    const horizonGeo = new THREE.CircleGeometry(38, 48);
    const horizonMat = new THREE.MeshStandardMaterial({
      color: 0x050811,
      roughness: 0.92,
      metalness: 0.08,
    });
    const horizonFloor = new THREE.Mesh(horizonGeo, horizonMat);
    horizonFloor.rotation.x = -Math.PI / 2;
    horizonFloor.position.y = -0.085;
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

    const tickGeo = new THREE.BoxGeometry(0.015, 0.008, 0.08);
    const tickMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      emissive: 0x1e293b,
      roughness: 0.5,
      metalness: 0.5,
    });
    this.disposables.push(tickGeo, tickMat);

    for (let i = 0; i < 36; i++) {
      if (i % 9 === 0) continue;
      const angle = (i / 36) * Math.PI * 2;
      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.position.set(Math.sin(angle) * radius, 0, -Math.cos(angle) * radius);
      tick.rotation.y = -angle;
      this.compassRingGroup.add(tick);
    }

    for (const c of cardinals) {
      const badgeCanvas = document.createElement('canvas');
      badgeCanvas.width = 128;
      badgeCanvas.height = 128;
      const ctx = badgeCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.beginPath();
        ctx.arc(64, 64, 54, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 62px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.label, 64, 66);
      }
      const tex = new THREE.CanvasTexture(badgeCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({map: tex, transparent: true});
      const geo = new THREE.PlaneGeometry(0.22, 0.22);
      const badge = new THREE.Mesh(geo, mat);
      badge.position.set(Math.sin(c.angle) * radius, 0.01, -Math.cos(c.angle) * radius);
      badge.rotation.x = -Math.PI / 2;
      this.compassRingGroup.add(badge);
      this.disposables.push(tex, mat, geo);
    }

    this.add(this.compassRingGroup);
  }

  private buildCurvedTheaterAssembly(): void {
    this.theaterGroup.name = 'Curved VR Theater';
    this.theaterGroup.position.set(0, 1.95, -0.4);

    // 1. Curved screen surface (arc facing user at origin)
    const screenRadius = 3.2;
    const arcAngle = 0.92; // ~53 deg wide curved IMAX arc
    const screenHeight = 1.65;

    const screenGeo = new THREE.CylinderGeometry(
      screenRadius,
      screenRadius,
      screenHeight,
      48,
      1,
      true,
      Math.PI - arcAngle / 2,
      arcAngle
    );
    // Flip horizontal UV so canvas draws left-to-right on inside of cylinder
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
    this.theaterGroup.add(this.screenMesh);

    // 2. Curved metallic outer frame shell behind screen
    const frameGeo = new THREE.CylinderGeometry(
      screenRadius + 0.05,
      screenRadius + 0.05,
      screenHeight + 0.14,
      48,
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
      48,
      1,
      true,
      Math.PI - arcAngle / 2,
      arcAngle
    );
    this.screenGlowBarTop = new THREE.Mesh(barGeo, barMat);
    this.screenGlowBarTop.position.y = screenHeight / 2 + 0.035;
    this.screenGlowBarTop.xb = {pointerEvents: 'none'};

    this.screenGlowBarBottom = new THREE.Mesh(barGeo, barMat);
    this.screenGlowBarBottom.position.y = -screenHeight / 2 - 0.035;
    this.screenGlowBarBottom.xb = {pointerEvents: 'none'};

    this.theaterGroup.add(this.screenGlowBarTop, this.screenGlowBarBottom);

    // 4. Left & right spatial speaker towers (multi-part)
    const speakerMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.45,
      metalness: 0.75,
    });
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.7,
      metalness: 0.2,
    });
    const towerGeo = new THREE.BoxGeometry(0.24, 1.45, 0.22);
    const coneGeo = new THREE.CylinderGeometry(0.075, 0.055, 0.04, 24);
    const ringTrimGeo = new THREE.TorusGeometry(0.078, 0.008, 10, 24);

    for (const side of [-1, 1]) {
      const tower = new THREE.Group();
      const angle = Math.PI + side * (arcAngle / 2 + 0.09);
      tower.position.set(Math.sin(angle) * screenRadius, -0.05, Math.cos(angle) * screenRadius);
      tower.lookAt(0, -0.05, 0);
      tower.xb = {pointerEvents: 'none'};

      const body = new THREE.Mesh(towerGeo, speakerMat);
      tower.add(body);

      for (const yOff of [-0.36, 0.04, 0.42]) {
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.rotation.x = Math.PI / 2;
        cone.position.set(0, yOff, 0.11);
        const trim = new THREE.Mesh(ringTrimGeo, barMat);
        trim.position.set(0, yOff, 0.125);
        tower.add(cone, trim);
      }
      this.theaterGroup.add(tower);
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
      coneMat,
      towerGeo,
      coneGeo,
      ringTrimGeo
    );
    this.add(this.theaterGroup);
  }

  private createPlaceholderScreenTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#090d1a';
      ctx.fillRect(0, 0, 1024, 512);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 42px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('POCKETVR PLAY THEATER', 512, 240);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '24px sans-serif';
      ctx.fillText('Install an app from the Play Store or launch a game', 512, 290);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
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

  public setQualityProfile(profile: QualityProfileConfig): void {
    this.currentProfile = profile;
    if (this.starMesh) {
      this.starMesh.count = Math.max(48, Math.round(STAR_COUNT * profile.starRatio));
    }
    if (!this.arPassthrough) {
      if (this.vrArenaGroup) {
        this.vrArenaGroup.visible = profile.showSecondaryProps;
      }
      const scene = xb.core.scene;
      if (scene) {
        scene.fog = profile.enableFog ? new THREE.FogExp2(0x060914, 0.026) : null;
      }
    }
  }

  isARPassthrough(): boolean {
    return this.arPassthrough;
  }

  update(): void {
    const dt = xb.getDeltaTime();
    this.elapsed += dt;

    // Smooth lighting dim transitions
    this.dimLevel = THREE.MathUtils.damp(this.dimLevel, this.targetDimLevel, 4.0, dt);
    this.hemiLight.intensity = THREE.MathUtils.lerp(2.2, 0.45, this.dimLevel);
    this.keyLight.intensity = THREE.MathUtils.lerp(2.4, 0.35, this.dimLevel);
    this.rimLight.intensity = THREE.MathUtils.lerp(4.5, 2.0, this.dimLevel);

    // Gentle starfield & orbital VR halo rotation
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
