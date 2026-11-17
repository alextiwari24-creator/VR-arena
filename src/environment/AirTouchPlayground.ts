import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';

interface HoloToy {
  id: number;
  name: string;
  lod: THREE.LOD;
  highMesh: THREE.Mesh;
  midMesh: THREE.Mesh;
  lowMesh: THREE.Mesh;
  ring: THREE.Mesh;
  homePos: THREE.Vector3;
  velocity: THREE.Vector3;
  spinSpeed: THREE.Vector3;
  baseColor: THREE.Color;
  flash: number;
  hovered: boolean;
  lastTouchAt: number;
}

/**
 * Floating 3D Holographic Air-Touch Playground inside VR reach space.
 * Optimized with 3-tier THREE.LOD (High PBR+Ring -> Mid Lambert -> Low-Poly Basic proxy),
 * shared materials/geometries across LOD tiers, and zero-allocation raycast/update paths.
 */
export class AirTouchPlayground extends xb.Script {
  private readonly sound: SoundEngine;
  private toys: HoloToy[] = [];
  private readonly touchableRoots: THREE.Object3D[] = [];
  private rippleMesh!: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private rippleLife = 0;

  private readonly disposables: Array<{dispose: () => void}> = [];
  private readonly _tmpVec = new THREE.Vector3();
  private elapsed = 0;
  private lodBias = 1.0;

  constructor(sound: SoundEngine) {
    super();
    this.sound = sound;
  }

  init(): void {
    const defs = [
      {
        name: 'Holo Crystal',
        pos: new THREE.Vector3(-0.34, 1.32, -0.72),
        highGeo: new THREE.OctahedronGeometry(0.075, 1),
        midGeo: new THREE.OctahedronGeometry(0.075, 0),
        lowGeo: new THREE.TetrahedronGeometry(0.072, 0),
        color: 0x38bdf8,
      },
      {
        name: 'Quantum Cube',
        pos: new THREE.Vector3(0.0, 1.18, -0.68),
        highGeo: new THREE.BoxGeometry(0.11, 0.11, 0.11, 2, 2, 2),
        midGeo: new THREE.BoxGeometry(0.11, 0.11, 0.11),
        lowGeo: new THREE.BoxGeometry(0.105, 0.105, 0.105),
        color: 0xa855f7,
      },
      {
        name: 'Solar Orb',
        pos: new THREE.Vector3(0.34, 1.32, -0.72),
        highGeo: new THREE.IcosahedronGeometry(0.075, 2),
        midGeo: new THREE.IcosahedronGeometry(0.075, 0),
        lowGeo: new THREE.OctahedronGeometry(0.072, 0),
        color: 0xf472b6,
      },
      {
        name: 'Emerald Knot',
        pos: new THREE.Vector3(0.0, 1.56, -0.82),
        highGeo: new THREE.TorusKnotGeometry(0.052, 0.017, 64, 10),
        midGeo: new THREE.TorusKnotGeometry(0.052, 0.017, 24, 5),
        lowGeo: new THREE.OctahedronGeometry(0.068, 0),
        color: 0x34d399,
      },
    ];

    const ringGeo = new THREE.TorusGeometry(0.115, 0.008, 8, 28);
    this.disposables.push(ringGeo);

    defs.forEach((def, idx) => {
      // LOD 0: Full PBR Material + Glowing Holo Ring (< 1.35m)
      const highMat = new THREE.MeshStandardMaterial({
        color: def.color,
        emissive: def.color,
        emissiveIntensity: 0.45,
        roughness: 0.2,
        metalness: 0.75,
      });
      const highGroup = new THREE.Group();
      highGroup.userData.airTouchId = idx;

      const highMesh = new THREE.Mesh(def.highGeo, highMat);
      highMesh.name = def.name;
      highMesh.userData.airTouchId = idx;

      const ringMat = new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0.45,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.xb = {pointerEvents: 'none'};
      highGroup.add(highMesh, ring);

      // LOD 1: Mid-poly diffuse Lambert shader (no PBR env map lookup, >= 1.35m)
      const midMat = new THREE.MeshLambertMaterial({
        color: def.color,
        emissive: def.color,
        emissiveIntensity: 0.3,
      });
      const midMesh = new THREE.Mesh(def.midGeo, midMat);
      midMesh.name = def.name;
      midMesh.userData.airTouchId = idx;

      // LOD 2: Ultra-low-poly unlit Basic proxy (>= 2.8m)
      const lowMat = new THREE.MeshBasicMaterial({
        color: def.color,
      });
      const lowMesh = new THREE.Mesh(def.lowGeo, lowMat);
      lowMesh.name = def.name;
      lowMesh.userData.airTouchId = idx;

      const lod = new THREE.LOD();
      lod.position.copy(def.pos);
      lod.name = def.name;
      lod.userData.airTouchId = idx;
      lod.addLevel(highGroup, 0);
      lod.addLevel(midMesh, 1.35);
      lod.addLevel(lowMesh, 2.8);

      this.add(lod);
      this.touchableRoots.push(lod);
      this.disposables.push(def.highGeo, def.midGeo, def.lowGeo, highMat, midMat, lowMat, ringMat);

      this.toys.push({
        id: idx,
        name: def.name,
        lod,
        highMesh,
        midMesh,
        lowMesh,
        ring,
        homePos: def.pos.clone(),
        velocity: new THREE.Vector3(),
        spinSpeed: new THREE.Vector3(0.4, 0.75, 0.25),
        baseColor: new THREE.Color(def.color),
        flash: 0,
        hovered: false,
        lastTouchAt: 0,
      });
    });

    const rippleGeo = new THREE.RingGeometry(0.04, 0.065, 24);
    const rippleMat = new THREE.MeshBasicMaterial({
      color: 0x5eead4,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.rippleMesh = new THREE.Mesh(rippleGeo, rippleMat);
    this.rippleMesh.visible = false;
    this.rippleMesh.xb = {pointerEvents: 'none'};
    this.add(this.rippleMesh);
    this.disposables.push(rippleGeo, rippleMat);
  }

  onSelectStart(event: xb.SelectEvent): void {
    const toy = this.findToyByObject(event.target as THREE.Object3D | undefined);
    if (!toy) return;
    const hitPoint = event.intersection?.point ?? toy.lod.position;
    this.triggerToyTouch(toy, hitPoint);
    event.stopPropagation();
  }

  public getTouchableMeshes(): THREE.Object3D[] {
    return this.touchableRoots;
  }

  public setHoveredObject(obj: THREE.Object3D | null): void {
    const hitToy = this.findToyByObject(obj ?? undefined);
    for (let i = 0; i < this.toys.length; i++) {
      this.toys[i].hovered = this.toys[i] === hitToy;
    }
  }

  /**
   * Checks both direct 3D fingertip proximity AND raycast hit against floating holo objects.
   */
  public touchObject(
    obj: THREE.Object3D,
    worldPoint: THREE.Vector3,
    impulseDir?: THREE.Vector3
  ): string | null {
    const toy = this.findToyByObject(obj);
    if (!toy) return null;
    return this.triggerToyTouch(toy, worldPoint, impulseDir);
  }

  public checkDirectFingertipTouch(worldPoint: THREE.Vector3, touchRadius = 0.11): string | null {
    for (let i = 0; i < this.toys.length; i++) {
      const toy = this.toys[i];
      if (worldPoint.distanceTo(toy.lod.position) <= touchRadius) {
        this._tmpVec.copy(toy.lod.position).sub(worldPoint).normalize();
        return this.triggerToyTouch(toy, worldPoint, this._tmpVec);
      }
    }
    return null;
  }

  private findToyByObject(obj: THREE.Object3D | undefined): HoloToy | undefined {
    let curr: THREE.Object3D | null | undefined = obj;
    while (curr) {
      if (typeof curr.userData?.airTouchId === 'number') {
        return this.toys[curr.userData.airTouchId as number];
      }
      curr = curr.parent;
    }
    return undefined;
  }

  private triggerToyTouch(
    toy: HoloToy,
    worldPoint: THREE.Vector3,
    impulseDir?: THREE.Vector3
  ): string | null {
    const now = performance.now();
    if (now - toy.lastTouchAt < 240) return null;
    toy.lastTouchAt = now;

    if (impulseDir) {
      toy.velocity.addScaledVector(impulseDir, 0.85);
    } else {
      toy.velocity.y += 0.55;
      toy.velocity.z -= 0.45;
    }
    toy.spinSpeed.set(
      (Math.random() - 0.5) * 8 + 2.5,
      (Math.random() - 0.5) * 8 + 3.5,
      (Math.random() - 0.5) * 6
    );
    toy.flash = 1.0;

    this.rippleMesh.position.copy(worldPoint);
    if (xb.core.camera) {
      this.rippleMesh.lookAt(xb.core.camera.position);
    }
    this.rippleMesh.scale.setScalar(0.8);
    this.rippleMesh.visible = true;
    this.rippleLife = 1.0;

    this.sound.playAirTouchChime(toy.id);
    return toy.name;
  }

  public setLodBias(bias: number): void {
    const b = Math.max(0.4, bias);
    if (Math.abs(b - this.lodBias) < 0.02) return;
    this.lodBias = b;
    for (let i = 0; i < this.toys.length; i++) {
      const levels = this.toys[i].lod.levels;
      if (levels.length >= 3) {
        levels[1].distance = 1.35 * b;
        levels[2].distance = 2.8 * b;
      }
    }
  }

  public updateLODs(camera: THREE.Camera, outCounts?: {high: number; mid: number; low: number}): void {
    for (let i = 0; i < this.toys.length; i++) {
      const lod = this.toys[i].lod;
      lod.update(camera);
      if (outCounts) {
        const level = lod.getCurrentLevel();
        if (level === 0) outCounts.high += 1;
        else if (level === 1) outCounts.mid += 1;
        else outCounts.low += 1;
      }
    }
  }

  update(): void {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.elapsed += dt;

    if (xb.core.camera) {
      this.updateLODs(xb.core.camera);
    }

    for (let i = 0; i < this.toys.length; i++) {
      const toy = this.toys[i];
      const floatY = Math.sin(this.elapsed * 1.8 + toy.id * 1.5) * 0.025;
      this._tmpVec.copy(toy.homePos);
      this._tmpVec.y += floatY;
      this._tmpVec.sub(toy.lod.position).multiplyScalar(7.5 * dt);
      toy.velocity.add(this._tmpVec);
      toy.velocity.multiplyScalar(Math.exp(-4.2 * dt));
      toy.lod.position.addScaledVector(toy.velocity, dt);

      toy.spinSpeed.lerp(this._tmpVec.set(0.35, 0.75, 0.2), dt * 1.6);
      toy.lod.rotation.x += toy.spinSpeed.x * dt;
      toy.lod.rotation.y += toy.spinSpeed.y * dt;
      toy.lod.rotation.z += toy.spinSpeed.z * dt;
      if (toy.ring.parent && toy.lod.getCurrentLevel() === 0) {
        toy.ring.rotation.z += dt * 1.4;
      }

      if (toy.flash > 0) {
        toy.flash = Math.max(0, toy.flash - dt * 2.5);
      }

      const targetScale = toy.hovered ? 1.24 : 1.0 + toy.flash * 0.25;
      toy.lod.scale.setScalar(THREE.MathUtils.lerp(toy.lod.scale.x, targetScale, dt * 12));

      const mat = toy.highMesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.45 + (toy.hovered ? 0.55 : 0) + toy.flash * 1.4;
      const ringMat = toy.ring.material as THREE.MeshBasicMaterial;
      ringMat.opacity = 0.35 + (toy.hovered ? 0.45 : 0) + toy.flash * 0.4;
    }

    if (this.rippleLife > 0) {
      this.rippleLife = Math.max(0, this.rippleLife - dt * 3.0);
      this.rippleMesh.scale.setScalar(1 + (1 - this.rippleLife) * 2.4);
      this.rippleMesh.material.opacity = this.rippleLife * 0.85;
      if (this.rippleLife <= 0.01) {
        this.rippleMesh.visible = false;
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
