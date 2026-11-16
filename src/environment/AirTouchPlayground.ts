import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';

interface HoloToy {
  id: number;
  name: string;
  mesh: THREE.Mesh;
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
 * Lets the user touch, poke, spin, and chime 3D objects in mid-air via either
 * Back-Camera Hand Tracking or WebXR Hands/Controllers.
 */
export class AirTouchPlayground extends xb.Script {
  private readonly sound: SoundEngine;
  private toys: HoloToy[] = [];
  private rippleMesh!: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private rippleLife = 0;

  private readonly disposables: Array<{dispose: () => void}> = [];
  private readonly _tmpVec = new THREE.Vector3();
  private elapsed = 0;

  constructor(sound: SoundEngine) {
    super();
    this.sound = sound;
  }

  init(): void {
    const defs = [
      {
        name: 'Holo Crystal',
        pos: new THREE.Vector3(-0.34, 1.32, -0.72),
        geo: new THREE.OctahedronGeometry(0.075, 0),
        color: 0x38bdf8,
      },
      {
        name: 'Quantum Cube',
        pos: new THREE.Vector3(0.0, 1.18, -0.68),
        geo: new THREE.BoxGeometry(0.11, 0.11, 0.11),
        color: 0xa855f7,
      },
      {
        name: 'Solar Orb',
        pos: new THREE.Vector3(0.34, 1.32, -0.72),
        geo: new THREE.IcosahedronGeometry(0.075, 1),
        color: 0xf472b6,
      },
      {
        name: 'Emerald Knot',
        pos: new THREE.Vector3(0.0, 1.56, -0.82),
        geo: new THREE.TorusKnotGeometry(0.052, 0.017, 64, 10),
        color: 0x34d399,
      },
    ];

    const ringGeo = new THREE.TorusGeometry(0.115, 0.008, 10, 32);
    this.disposables.push(ringGeo);

    defs.forEach((def, idx) => {
      const mat = new THREE.MeshStandardMaterial({
        color: def.color,
        emissive: def.color,
        emissiveIntensity: 0.45,
        roughness: 0.2,
        metalness: 0.75,
      });
      const mesh = new THREE.Mesh(def.geo, mat);
      mesh.position.copy(def.pos);
      mesh.name = def.name;
      mesh.userData.airTouchId = idx;

      const ringMat = new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0.45,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.xb = {pointerEvents: 'none'};
      mesh.add(ring);

      this.add(mesh);
      this.disposables.push(def.geo, mat, ringMat);

      this.toys.push({
        id: idx,
        name: def.name,
        mesh,
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

    const rippleGeo = new THREE.RingGeometry(0.04, 0.065, 32);
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
    const hitPoint = event.intersection?.point ?? toy.mesh.position;
    this.triggerToyTouch(toy, hitPoint);
    event.stopPropagation();
  }

  public getTouchableMeshes(): THREE.Object3D[] {
    return this.toys.map((t) => t.mesh);
  }

  public setHoveredObject(obj: THREE.Object3D | null): void {
    for (const toy of this.toys) {
      toy.hovered = obj === toy.mesh;
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
    for (const toy of this.toys) {
      if (worldPoint.distanceTo(toy.mesh.position) <= touchRadius) {
        this._tmpVec.copy(toy.mesh.position).sub(worldPoint).normalize();
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

  update(): void {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.elapsed += dt;

    for (const toy of this.toys) {
      const floatY = Math.sin(this.elapsed * 1.8 + toy.id * 1.5) * 0.025;
      // Spring return to home position
      this._tmpVec.copy(toy.homePos);
      this._tmpVec.y += floatY;
      this._tmpVec.sub(toy.mesh.position).multiplyScalar(7.5 * dt);
      toy.velocity.add(this._tmpVec);
      toy.velocity.multiplyScalar(Math.exp(-4.2 * dt));
      toy.mesh.position.addScaledVector(toy.velocity, dt);

      toy.spinSpeed.lerp(this._tmpVec.set(0.35, 0.75, 0.2), dt * 1.6);
      toy.mesh.rotation.x += toy.spinSpeed.x * dt;
      toy.mesh.rotation.y += toy.spinSpeed.y * dt;
      toy.mesh.rotation.z += toy.spinSpeed.z * dt;
      toy.ring.rotation.z += dt * 1.4;

      if (toy.flash > 0) {
        toy.flash = Math.max(0, toy.flash - dt * 2.5);
      }

      const targetScale = toy.hovered ? 1.24 : 1.0 + toy.flash * 0.25;
      toy.mesh.scale.setScalar(THREE.MathUtils.lerp(toy.mesh.scale.x, targetScale, dt * 12));

      const mat = toy.mesh.material as THREE.MeshStandardMaterial;
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
