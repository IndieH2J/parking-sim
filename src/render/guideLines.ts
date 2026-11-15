import * as THREE from 'three';
import type { VehicleSpec } from '../sim/specs';
import type { VehicleState } from '../sim/vehicle';
import { integratePose } from '../sim/vehicle';
import { bodyExtents } from '../sim/footprint';
import { toWorld, type Vec2 } from '../sim/geometry';

export const GUIDE_LAYER = 1;
const MAX_DIST = 3.5; // m
const STEP = 0.1;
const RIBBON_W = 0.06;
const MARKS: [number, number][] = [
  [0.5, 0xff3b30],
  [1.0, 0xffcc00],
  [2.0, 0x34c759],
];

/** 후진 시 현재 조향각 그대로 갈 때 뒤범퍼 양 끝이 지나갈 경로 (월드 좌표) */
export function predictRearPath(state: VehicleState, spec: VehicleSpec, dist = MAX_DIST): { left: Vec2[]; right: Vec2[] } {
  return predictPath(state, spec, -1, dist);
}

/** dir=+1 전진(앞범퍼 양 끝), -1 후진(뒤범퍼 양 끝) */
export function predictPath(state: VehicleState, spec: VehicleSpec, dir: 1 | -1, dist = MAX_DIST) {
  const { xr, xf, hw } = bodyExtents(spec);
  const x = dir > 0 ? xf : xr;
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let s = 0; s <= dist + 1e-9; s += STEP) {
    const p = integratePose(state, spec, state.steer, dir * s, 1);
    left.push(toWorld({ x, y: hw }, p));
    right.push(toWorld({ x, y: -hw }, p));
  }
  return { left, right };
}

function ribbon(points: Vec2[], width: number, h: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);
    const quad = [
      [a.x + nx, a.y + ny],
      [a.x - nx, a.y - ny],
      [b.x - nx, b.y - ny],
      [b.x + nx, b.y + ny],
    ];
    for (const idx of [0, 1, 2, 0, 2, 3]) pos.push(quad[idx][0], h, -quad[idx][1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** 후방카메라에만 보이는 예상 궤적 리본과 거리 표시선 */
export class GuideLines {
  readonly group = new THREE.Group();
  private readonly pathMat = new THREE.MeshBasicMaterial({ color: 0xffd60a, side: THREE.DoubleSide });
  private readonly paths: THREE.Mesh[] = [];
  private readonly marks: THREE.Mesh[] = [];

  constructor() {
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.pathMat);
      m.layers.set(GUIDE_LAYER);
      m.frustumCulled = false;
      this.paths.push(m);
      this.group.add(m);
    }
    for (const [, color] of MARKS) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.layers.set(GUIDE_LAYER);
      m.frustumCulled = false;
      this.marks.push(m);
      this.group.add(m);
    }
  }

  update(state: VehicleState, spec: VehicleSpec) {
    const { left, right } = predictRearPath(state, spec);
    const h = 0.012;
    this.paths[0].geometry.dispose();
    this.paths[0].geometry = ribbon(left, RIBBON_W, h);
    this.paths[1].geometry.dispose();
    this.paths[1].geometry = ribbon(right, RIBBON_W, h);
    MARKS.forEach(([d], i) => {
      const idx = Math.round(d / STEP);
      this.marks[i].geometry.dispose();
      this.marks[i].geometry = ribbon([left[idx], right[idx]], 0.05, h + 0.002);
    });
  }
}
