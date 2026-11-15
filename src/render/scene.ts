import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Scenario } from '../scenarios/types';
import type { Vec2 } from '../sim/geometry';
import { rectCorners } from '../sim/goal';
import { buildParkedCar } from './carMesh';
import { extrudePoly, L, markShared, mat } from './util';

// 바닥은 깊이를 조금 뒤로 민다: 1 mm 위의 통로 바닥과 먼 거리에서 깊이 싸움(계단 무늬)이 나지 않게.
const floorMat = markShared(
  new THREE.MeshLambertMaterial({ color: 0x6a6e73, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
);
// 통로 바닥은 조금 더 밝은 에폭시 느낌, 보행통로는 밝은 회색 (계약서 §3.2)
const FLOOR_TONE = { aisle: 0x7b8a82, walkway: 0x9a9da1 } as const;

/**
 * 추적 카메라(3D 리플레이)로 그릴 때만 숨기는 병합 메시 이름: 천장 조명 상자.
 * 추적 카메라 눈은 천장보다 높아 천장 면(아래에서만 보임)은 안 보이는데, 조명 상자는 위에서도 보여 허공에 뜬 흰 막대가 된다.
 */
export const CHASE_HIDDEN = 'chaseHidden';

/** 평면도 볼록 다각형을 높이 h에서 위를 향한 면으로 */
function flatPoly(poly: Vec2[], h: number, material: THREE.Material): THREE.Mesh {
  const g = new THREE.ShapeGeometry(new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y))));
  g.rotateX(-Math.PI / 2); // (x, y, 0) → (x, 0, -y), 법선 +z → 위
  g.translate(0, h, 0);
  return new THREE.Mesh(g, material);
}

/** 시나리오의 정적 요소(바닥·바닥 구역·선·기둥·벽·휠스톱·연석·주차 차량·천장·조명·목표)를 만든다. */
export function buildStatic(sc: Scenario): THREE.Group {
  const g = new THREE.Group();
  const { x0, x1, y0, y1 } = sc.bounds;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(L(cx, cy, 0));
  g.add(floor);
  for (const f of sc.floor) {
    const h = f.h ?? 0.001;
    if (f.tone === 'walkway') g.add(extrudePoly(f.poly, 0, h, mat(FLOOR_TONE.walkway)));
    else g.add(flatPoly(f.poly, h, mat(FLOOR_TONE.aisle)));
  }

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), mat(0x8d9094));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.copy(L(cx, cy, sc.ceilingHeight));
  g.add(ceiling);
  // 천장 조명줄: 긴 축이 heading 방향
  const lamp = new THREE.MeshBasicMaterial({ color: 0xf5f7ff });
  for (const p of sc.lamps) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.12), lamp);
    m.position.copy(L(p.x, p.y, sc.ceilingHeight - 0.03));
    m.rotation.y = p.heading;
    g.add(m);
  }

  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  for (const el of sc.elements) {
    switch (el.kind) {
      case 'line':
        g.add(extrudePoly(el.poly, 0.002, 0.004, lineMat));
        break;
      case 'wheelStop':
        g.add(extrudePoly(el.poly, 0, el.hMax, mat(0xe0b400)));
        break;
      case 'solid':
        if (el.tag === 'car' && el.meta) {
          g.add(buildParkedCar(el.meta));
        } else if (el.tag === 'pillar') {
          g.add(extrudePoly(el.poly, 0, 1.0, mat(0xd8b020)));
          g.add(extrudePoly(el.poly, 1.0, el.hMax, mat(0xb9bcc0)));
        } else {
          g.add(extrudePoly(el.poly, 0, el.hMax, mat(0xa9adb2)));
        }
        break;
      case 'curb': {
        const c = el.meta?.color;
        g.add(extrudePoly(el.poly, 0, el.hMax, mat(typeof c === 'number' ? c : 0xbfbfbf)));
        break;
      }
    }
  }

  // 목표 (주차칸·출구 구역): 바닥에 옅은 초록
  const goalMat = new THREE.MeshBasicMaterial({ color: 0x30d158, transparent: true, opacity: 0.18, depthWrite: false });
  g.add(flatPoly(rectCorners(sc.goal.rect), 0.005, goalMat));

  // 이름은 병합한 뒤의 메시에 붙인다 (병합 전 메시의 이름은 사라진다)
  const out = mergeByMaterial(g);
  for (const o of out.children) if ((o as THREE.Mesh).material === lamp) o.name = CHASE_HIDDEN;
  return out;
}

const ATTRS: readonly string[] = ['position', 'normal', 'uv'];

/**
 * 같은 재질의 정적 메시를 하나로 합친다 (드로우콜 감소, 계약서 §3.2 SHOULD).
 * 변환은 꼭짓점에 굽고, 모두 인덱스 없는 position·normal·uv로 맞춘다 (섞이면 mergeGeometries가 실패한다).
 */
function mergeByMaterial(src: THREE.Group): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  src.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(geo.attributes)) if (!ATTRS.includes(name)) geo.deleteAttribute(name);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    geo.clearGroups();
    const m = mesh.material as THREE.Material;
    const list = buckets.get(m);
    if (list) list.push(geo);
    else buckets.set(m, [geo]);
  });
  const out = new THREE.Group();
  for (const [m, geos] of buckets) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) for (const x of geos) x.dispose();
    if (merged) out.add(new THREE.Mesh(merged, m));
  }
  return out;
}

export function addLights(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x2a2d31);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5a5a, 2.2));
  const d = new THREE.DirectionalLight(0xffffff, 1.2);
  d.position.set(10, 30, 15);
  scene.add(d);
}
