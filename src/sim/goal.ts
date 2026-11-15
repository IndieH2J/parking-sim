import type { Pose, Vec2 } from './geometry';
import { polyToWorld } from './geometry';
import type { Footprint } from './footprint';

// 목표(주차칸·출구 구역)와 판정. 계약서 §1.4.

/** 회전 사각형. 로컬 u = angle 방향, v = 그 왼쪽. */
export interface ORect {
  cx: number;
  cy: number;
  angle: number;
  halfL: number;
  halfW: number;
}

/** 각도를 (−π, π]로 정규화한다. */
export function wrapPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** 월드 좌표 꼭짓점 (반시계) */
export function rectCorners(r: ORect): Vec2[] {
  const local: Vec2[] = [
    { x: -r.halfL, y: -r.halfW },
    { x: r.halfL, y: -r.halfW },
    { x: r.halfL, y: r.halfW },
    { x: -r.halfL, y: r.halfW },
  ];
  return polyToWorld(local, { x: r.cx, y: r.cy, heading: r.angle });
}

/** 축 정렬 범위 → ORect. angle ∈ {0, ±π/2, π}. halfL은 angle 방향 길이의 절반 (0·π면 x, ±π/2면 y). */
export function rectFromAabb(x0: number, y0: number, x1: number, y1: number, angle: number): ORect {
  const ex = Math.abs(x1 - x0) / 2;
  const ey = Math.abs(y1 - y0) / 2;
  const alongX = Math.abs(Math.cos(angle)) > 0.5;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, angle, halfL: alongX ? ex : ey, halfW: alongX ? ey : ex };
}

/** slot: P로 바꿀 때 판정. zone: 매 시뮬레이션 스텝 판정. */
export type GoalKind = 'slot' | 'zone';

export interface Goal {
  kind: GoalKind;
  /** rect.angle이 곧 요구 차량 방향이다 (후면 직각 −π/2: 앞이 통로 쪽). */
  rect: ORect;
  /** slot 15, zone 30 */
  maxAngleDeg: number;
}

export interface GoalEval {
  /** 차체 폴리곤 꼭짓점이 모두 rect 안 (경계 포함, eps 1e-9). 미러는 보지 않는다 (v1 규칙). */
  inside: boolean;
  /** |wrapPi(heading − rect.angle)| (도). 0..180, 반대 방향이면 약 180 */
  angleErrDeg: number;
  headingOk: boolean;
  success: boolean;
  /** 차체 → rect 각 변까지 m. 음수 = 밖으로 나감 */
  margin: { front: number; back: number; left: number; right: number };
  /** 미러 박스 → 옆 변까지 m */
  mirrorMargin: { left: number; right: number };
  /** 차체 (u, v) 외접 사각형 중심 − rect 중심. + = 앞·왼쪽 */
  offset: { along: number; across: number };
}

const EPS = 1e-9;

export function evaluateGoal(goal: Goal, fp: Footprint, pose: Pose): GoalEval {
  const r = goal.rect;
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  // rect 틀 (u, v)로 옮긴 꼭짓점의 범위
  const range = (poly: Vec2[]) => {
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of polyToWorld(poly, pose)) {
      const dx = p.x - r.cx;
      const dy = p.y - r.cy;
      const u = dx * c + dy * s;
      const v = -dx * s + dy * c;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    return { u0, u1, v0, v1 };
  };
  const b = range(fp.body.poly);
  const margin = {
    front: r.halfL - b.u1,
    back: r.halfL + b.u0,
    left: r.halfW - b.v1,
    right: r.halfW + b.v0,
  };
  const mirrorMargin = {
    left: r.halfW - range(fp.mirrorLeft.poly).v1,
    right: r.halfW + range(fp.mirrorRight.poly).v0,
  };
  const inside = Math.min(margin.front, margin.back, margin.left, margin.right) >= -EPS;
  const angleErrDeg = (Math.abs(wrapPi(pose.heading - r.angle)) * 180) / Math.PI;
  const headingOk = angleErrDeg <= goal.maxAngleDeg;
  return {
    inside,
    angleErrDeg,
    headingOk,
    success: inside && headingOk,
    margin,
    mirrorMargin,
    offset: { along: (b.u0 + b.u1) / 2, across: (b.v0 + b.v1) / 2 },
  };
}
