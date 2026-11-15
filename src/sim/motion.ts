import type { Pose } from './geometry';
import { polygonsOverlap, polyToWorld } from './geometry';
import type { Footprint, WheelId } from './footprint';
import { buildFootprint, wheelPolys } from './footprint';
import type { VehicleSpec } from './specs';
import { maxSteerAngle } from './vehicle';
import type { Collision, WorldElement } from './world';
import { findCollision, findWheelBlock, near } from './world';

// 이동 판정 (계약서 §1.5). 게임(main.ts)과 모든 해결 가능성 테스트가 이 규칙 하나를 쓴다.
// 휠스톱·연석은 바퀴만 막고, 차체·미러는 그 위를 지나간다
// (계획서 규칙. 지상고가 연석 높이보다 낮아도 마찬가지인 단순화).

export interface MotionCtx {
  spec: VehicleSpec;
  fp: Footprint;
  elements: WorldElement[];
  /** maxSteerAngle(spec) */
  maxSteer: number;
}

export function motionCtx(spec: VehicleSpec, elements: WorldElement[]): MotionCtx {
  return { spec, fp: buildFootprint(spec), elements, maxSteer: maxSteerAngle(spec) };
}

export type MoveResult =
  | { kind: 'ok' }
  /** 거부: 차는 그대로, 속도 → 0 (휠스톱 또는 연석) */
  | { kind: 'wheel'; wheel: WheelId; element: WorldElement }
  /** 충돌 */
  | { kind: 'collision'; hit: Collision };

function wheelHit(ctx: MotionCtx, pose: Pose, steerNorm: number): MoveResult | null {
  const w = findWheelBlock(ctx.spec, pose, steerNorm * ctx.maxSteer, ctx.elements);
  return w ? { kind: 'wheel', wheel: w.wheel, element: w.element } : null;
}

function solidHit(ctx: MotionCtx, pose: Pose): MoveResult {
  const hit = findCollision(ctx.fp, pose, ctx.elements);
  return hit ? { kind: 'collision', hit } : { kind: 'ok' };
}

/** 엄격한 상태 판정: 타이어(앞바퀴는 steerNorm·maxSteer)가 휠스톱·연석에 겹치지 않고, 차체·미러가 solid에 닿지 않는다. */
export function poseClear(ctx: MotionCtx, pose: Pose, steerNorm: number): MoveResult {
  return wheelHit(ctx, pose, steerNorm) ?? solidHit(ctx, pose);
}

/** 게임 스텝 규칙 (v1 의미): `to`에서 타이어가 겹치고 `from`에서는 안 겹치면 'wheel', 그다음 `to`가 solid에 닿으면 'collision', 아니면 'ok'. */
export function checkMove(ctx: MotionCtx, from: Pose, to: Pose, steerNorm: number): MoveResult {
  const w = wheelHit(ctx, to, steerNorm);
  if (w && !wheelHit(ctx, from, steerNorm)) return w;
  return solidHit(ctx, to);
}

const REACH = 6; // world.ts의 CAR_REACH와 같은 값: 뒤축 중심에서 차 외곽까지 최대 거리 근사 (m)
const FRONT: WheelId[] = ['FL', 'FR'];

/** 앞바퀴마다 휠스톱·연석에 겹치는지 */
function frontTyreHits(ctx: MotionCtx, pose: Pose, steerNorm: number): boolean[] {
  const polys = wheelPolys(ctx.spec, steerNorm * ctx.maxSteer);
  const tyres = FRONT.map((id) => polyToWorld(polys[id], pose));
  const hits = FRONT.map(() => false);
  for (const el of ctx.elements) {
    if ((el.kind !== 'wheelStop' && el.kind !== 'curb') || !near(el, pose, REACH)) continue;
    tyres.forEach((t, i) => {
      if (!hits[i] && polygonsOverlap(t, el.poly)) hits[i] = true;
    });
  }
  return hits;
}

/**
 * 제자리 조향. 새 앞바퀴 각도에서 예전 각도에는 없던 타이어 겹침이 생기면 false.
 * v1 허점 차단: 정지 상태에서 앞바퀴를 연석 안으로 돌린 뒤 "이미 걸침" 예외로 연석을 넘어가던 것.
 */
export function canSteer(ctx: MotionCtx, pose: Pose, fromNorm: number, toNorm: number): boolean {
  const after = frontTyreHits(ctx, pose, toNorm);
  if (!after.includes(true)) return true;
  const before = frontTyreHits(ctx, pose, fromNorm);
  return after.every((hit, i) => !hit || before[i]);
}
