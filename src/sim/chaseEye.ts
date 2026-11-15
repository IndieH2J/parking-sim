import { bodyExtents } from './footprint';
import type { Pose, Vec2 } from './geometry';
import { pointInConvex } from './geometry';
import type { VehicleSpec } from './specs';
import type { WorldElement } from './world';

// 3D 리플레이 추적 카메라의 눈 자리 (계약서 §5.3, 2026-11-15 개정: 장면 solid로 시선 확보). three·DOM 없음.
//
// 계약 눈(차체 중심 뒤 5.5 m·높이 2.8 m)에서 바라볼 점(차체 중심 앞 2 m·높이 0.6 m)과 지붕 네 모서리까지의 시선이
// solid를 지나면, 같은 수평 거리에서 눈을 시선이 모두 트이는 가장 낮은 높이로 올린다 (최대 CHASE_MAX_H).
// 그 높이로도 안 되면 수평 거리를 SHORTEN_STEP씩 줄이며 다시 올린다.
// 시선이 모든 solid의 윗면 + CLEARANCE보다 높게 지나면 계약 눈 그대로다 (빈 공간에서는 늘 그대로).
//
// - solid는 모두 바닥에 서 있다고 본다 (지금 시나리오의 solid는 모두 hMin 0). 그래서 눈을 올리면 시선도 올라간다.
// - 천장은 아래에서만 보이는 면이라 (scene.ts) 천장보다 높은 눈(2.8 m 이상)에서는 가리지 않는다. 그래서 solid만 본다.
// - 점이 어떤 solid의 평면도 안에 있으면 그 solid는 그 점에 대해 보지 않는다 (작은 차의 바라볼 점이 코앞 벽 속에
//   들어간 경우 등: 그 벽의 겉면이 보이는 것이 맞다). 지붕 점은 차체 안쪽이라 충돌하지 않은 자세에서는 늘 solid 밖이다.

export interface Vec3 {
  x: number;
  y: number;
  h: number;
}

/** 계약 수치 (§5.3): 차체 중심 뒤 behind m·높이 height m에서 차체 중심 앞 ahead m·높이 lookH m를 본다 */
export interface ChaseOffsets {
  behind: number;
  height: number;
  ahead: number;
  lookH: number;
}
export const CHASE_OFFSETS: ChaseOffsets = { behind: 5.5, height: 2.8, ahead: 2, lookH: 0.6 };
/** 눈을 올리는 상한 (m) */
export const CHASE_MAX_H = 12;
/** 시선이 solid 윗면 위로 지나야 하는 여유 (m) */
const CLEARANCE = 0.05;
/** 올려도 안 되면 수평 거리를 줄이는 간격 (m) */
const SHORTEN_STEP = 0.25;
/**
 * 지붕 모서리: 앞뒤 범퍼에서 0.45 m, 옆면에서 0.2 m 안쪽, 높이 = 전고. 렌더링한 지붕 판의 뒤 모서리와 같은 자리다
 * (carMesh roofRearX = xr + 0.45, roofHw = hw − 0.2). 앞 두 점은 같은 규칙으로 보닛 위 지붕 높이에 둔다.
 */
const ROOF_INSET_END = 0.45;
const ROOF_INSET_SIDE = 0.2;

/** 차체 중심 (앞뒤 범퍼 가운데), 바라볼 점, 보여야 할 지붕 네 모서리. 월드 좌표 */
export function chaseTargets(
  pose: Pose,
  spec: VehicleSpec,
  off: ChaseOffsets = CHASE_OFFSETS,
): { centre: Vec2; look: Vec3; roof: Vec3[] } {
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  const { xr, xf, hw } = bodyExtents(spec);
  const centre = (xr + xf) / 2;
  const bx = pose.x + c * centre;
  const by = pose.y + s * centre;
  const roof: Vec3[] = [];
  for (const lx of [xr + ROOF_INSET_END, xf - ROOF_INSET_END]) {
    for (const ly of [hw - ROOF_INSET_SIDE, -(hw - ROOF_INSET_SIDE)]) {
      roof.push({ x: pose.x + lx * c - ly * s, y: pose.y + lx * s + ly * c, h: spec.height });
    }
  }
  return { centre: { x: bx, y: by }, look: { x: bx + c * off.ahead, y: by + s * off.ahead, h: off.lookH }, roof };
}

/**
 * 추적 카메라의 목표 눈 자리와 바라볼 점 (월드 좌표). elements 중 solid만 본다.
 * 바라볼 점은 늘 계약 그대로이고, 눈만 올리거나 (그래도 안 되면) 차 쪽으로 당긴다.
 */
export function chaseEye(
  pose: Pose,
  spec: VehicleSpec,
  elements: readonly WorldElement[],
  off: ChaseOffsets = CHASE_OFFSETS,
): { eye: Vec3; look: Vec3 } {
  const { centre, look, roof } = chaseTargets(pose, spec, off);
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  const targets = [look, ...roof];
  const n = Math.max(1, Math.ceil(off.behind / SHORTEN_STEP));
  for (let k = 0; k <= n; k++) {
    const d = off.behind * (1 - k / n);
    const ex = centre.x - c * d;
    const ey = centre.y - s * d;
    const h = Math.max(off.height, requiredHeight(ex, ey, targets, elements));
    if (h <= CHASE_MAX_H) return { eye: { x: ex, y: ey, h }, look };
  }
  // 차체 중심 바로 위에서도 안 되는 경우 (solid가 차체와 겹친 자세뿐): 차체 중심 위 상한 높이
  return { eye: { x: centre.x, y: centre.y, h: CHASE_MAX_H }, look };
}

/** 눈 (ex, ey)에서 targets까지 시선이 모두 트이는 가장 낮은 눈 높이. 시선이 지나는 solid가 없으면 −Infinity */
function requiredHeight(ex: number, ey: number, targets: readonly Vec3[], elements: readonly WorldElement[]): number {
  let need = -Infinity;
  for (const el of elements) {
    if (el.kind !== 'solid') continue;
    const top = el.hMax + CLEARANCE;
    for (const p of targets) {
      if (pointInConvex(p, el.poly)) continue;
      const span = clipSegment(ex, ey, p.x, p.y, el.poly);
      if (!span) continue;
      // 눈 높이 H에서 시선 높이 h(t) = H·(1 − t) + t·p.h. 직선이라 구간 양 끝에서 top 이상이면 구간 전체가 top 이상이다
      for (const t of span) need = Math.max(need, t < 1 ? (top - t * p.h) / (1 - t) : Infinity);
    }
  }
  return need;
}

/**
 * 평면도 선분 a → b가 볼록 다각형 안을 지나는 매개변수 구간 [t0, t1] ⊂ [0, 1] (Cyrus–Beck).
 * 지나지 않거나 꼭짓점·변에 닿기만 하면 null. 꼭짓점 순서는 어느 방향이든 된다.
 */
function clipSegment(ax: number, ay: number, bx: number, by: number, poly: readonly Vec2[]): [number, number] | null {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    area += p.x * q.y - q.x * p.y;
  }
  const sign = area >= 0 ? 1 : -1;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const ux = q.x - p.x;
    const uy = q.y - p.y;
    // 안쪽: sign · cross(q − p, X − p) > 0. X = a + t·(b − a)를 넣으면 num + den·t
    const num = sign * (ux * (ay - p.y) - uy * (ax - p.x));
    const den = sign * (ux * dy - uy * dx);
    if (den === 0) {
      if (num <= 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}
