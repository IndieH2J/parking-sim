import * as THREE from 'three';
import type { Vec2 } from '../sim/geometry';

// 시뮬레이션 좌표 (x 전방/동, y 왼쪽/북, h 높이) → Three.js 좌표 (x, h, -y)
export function L(x: number, y: number, h: number): THREE.Vector3 {
  return new THREE.Vector3(x, h, -y);
}

const matCache = new Map<number, THREE.MeshLambertMaterial>();
/** 여러 메시가 계속 함께 쓰는 재질 (mat() 캐시 등). disposeObject가 건너뛴다. */
const sharedMats = new WeakSet<THREE.Material>();

export function mat(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    matCache.set(color, m);
    sharedMats.add(m);
  }
  return m;
}

/** 모듈 수준에서 한 번 만들어 계속 쓰는 재질을 공유 재질로 등록한다. */
export function markShared<T extends THREE.Material>(m: T): T {
  sharedMats.add(m);
  return m;
}

export function isSharedMaterial(m: THREE.Material): boolean {
  return sharedMats.has(m);
}

/**
 * root 아래 모든 geometry와, 공유 재질이 아닌 재질과 그 map 텍스처(스프라이트 CanvasTexture 포함)를 해제한다.
 * 같은 geometry를 두 번 해제해도 문제없다 (다시 쓰면 three가 다시 올린다).
 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const r = o as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    r.geometry?.dispose();
    const mats = Array.isArray(r.material) ? r.material : r.material ? [r.material] : [];
    for (const m of mats) {
      if (isSharedMaterial(m)) continue;
      (m as THREE.Material & { map?: THREE.Texture | null }).map?.dispose();
      m.dispose();
    }
  });
}

/** 시뮬레이션 좌표의 축 정렬 상자 */
export function box(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  h0: number,
  h1: number,
  material: THREE.Material,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h1 - h0, y1 - y0), material);
  m.position.copy(L((x0 + x1) / 2, (y0 + y1) / 2, (h0 + h1) / 2));
  return m;
}

/** 평면도 폴리곤을 h0~h1 높이로 세운다. */
export function extrudePoly(poly: Vec2[], h0: number, h1: number, material: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: h1 - h0, bevelEnabled: false });
  // shape (x, y, z=높이) → rotateX(-90°) → (x, z, -y)
  g.rotateX(-Math.PI / 2);
  g.translate(0, h0, 0);
  return new THREE.Mesh(g, material);
}

/**
 * 평면도 폴리곤의 옆면만 세운다 (위·아래 뚜껑 없음, 바깥쪽 면만).
 * 차체 외피용: 실내(운전석)에서는 뒷면이라 보이지 않고, 거울·후방카메라에서는 보인다.
 */
export function wallsOnly(poly: Vec2[], h0: number, h1: number, material: THREE.Material): THREE.Mesh {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.y - b.x * a.y;
  }
  const pts = area >= 0 ? poly : [...poly].reverse(); // 반시계로 맞춘다
  const pos: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const a = [p.x, h0, -p.y];
    const b = [q.x, h0, -q.y];
    const c = [q.x, h1, -q.y];
    const d = [p.x, h1, -p.y];
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, material);
}

/** 측면 실루엣 (x, h) 을 폭 방향(-w/2 ~ w/2)으로 밀어낸다. */
export function extrudeProfile(profile: [number, number][], width: number, material: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(profile.map(([x, h]) => new THREE.Vector2(x, h)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  g.translate(0, 0, -width / 2);
  return new THREE.Mesh(g, material);
}

/** 두 점을 잇는 각기둥 (기둥·프레임용). 점은 Three 좌표. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, thickness: number, material: THREE.Material, depth = thickness) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(thickness, len, depth), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}
