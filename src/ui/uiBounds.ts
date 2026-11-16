import * as THREE from 'three';

interface UIKitNodeLike extends THREE.Object3D {
  displayed?: {peek?: () => boolean};
  isClipped?: {peek?: () => boolean};
  size?: {peek?: () => [number, number] | undefined};
}

const _c0 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _c3 = new THREE.Vector3();

/**
 * Computes a crash-proof, zero-GC world-space AABB for any XR Blocks / UIKit presentation
 * object without calling `THREE.Box3.setFromObject`, which can throw on uninitialized
 * child icon/glyph geometries.
 */
export function computeSafeUIWorldBounds(
  pres: THREE.Object3D | undefined,
  outBox: THREE.Box3
): boolean {
  if (!pres || !pres.visible) return false;

  const node = pres as UIKitNodeLike;
  if (node.displayed?.peek && node.displayed.peek() === false) return false;
  if (node.isClipped?.peek && node.isClipped.peek() === true) return false;

  const size = node.size?.peek?.();
  if (size && (size[0] <= 0 || size[1] <= 0)) return false;

  pres.updateWorldMatrix(true, false);
  if (Math.abs(pres.matrixWorld.determinant()) < 1e-10) return false;

  _c0.set(-0.5, -0.5, 0).applyMatrix4(pres.matrixWorld);
  _c1.set(0.5, -0.5, 0).applyMatrix4(pres.matrixWorld);
  _c2.set(0.5, 0.5, 0).applyMatrix4(pres.matrixWorld);
  _c3.set(-0.5, 0.5, 0).applyMatrix4(pres.matrixWorld);

  outBox.makeEmpty();
  outBox.expandByPoint(_c0);
  outBox.expandByPoint(_c1);
  outBox.expandByPoint(_c2);
  outBox.expandByPoint(_c3);

  return !outBox.isEmpty();
}
