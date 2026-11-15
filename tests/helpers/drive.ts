import type { Footprint } from '../../src/sim/footprint';
import type { Pose } from '../../src/sim/geometry';
import { evaluateGoal, type ORect } from '../../src/sim/goal';
import { poseClear, type MotionCtx } from '../../src/sim/motion';
import type { VehicleSpec } from '../../src/sim/specs';
import { integratePose } from '../../src/sim/vehicle';
import { listVehicles } from '../../src/sim/vehicles';

// 해결 가능성 테스트용 운전 도구 (계약서 §8.1). 코어 A 소유, 다른 에이전트는 읽기만 한다.
// src/scenarios/index.ts는 import하지 않는다 (§A.5).
//
// 목표 자세에서 빠져나오는 경로를 거꾸로 돌려도 게임이 받아들이는 이유:
// 지나간 모든 (자세, 조향) 쌍이 엄격한 poseClear를 통과한다(checkMove의 "이미 걸침" 예외를 쓰지 않음).
// 그래서 역방향 이동은 checkMove, 조향 되돌리기는 canSteer를 통과하고, 자전거 모델은 시간 가역이며 제자리 조향이 허용된다.

export const DS = 0.02;

/** 모델 Y + 모든 프리셋 */
export function allSpecs(): VehicleSpec[] {
  return listVehicles().map((v) => v.spec);
}

export interface Drive {
  ctx: MotionCtx;
  pose: Pose;
  steer: number;
  /** 지나간 자세 (시작 자세 포함, DS마다 하나) */
  path: Pose[];
  /** 움직인 구간 (조향, 부호 있는 거리). 같은 조향·같은 방향으로 이어지는 이동은 한 구간으로 합친다 */
  segments: { steer: number; dist: number }[];
}

const clear = (d: Drive, pose: Pose, steer: number) => poseClear(d.ctx, pose, steer).kind === 'ok';

/** 한 스텝 이동을 기록한다 */
function advance(d: Drive, pose: Pose, dist: number) {
  d.pose = pose;
  d.path.push(pose);
  const last = d.segments[d.segments.length - 1];
  if (last && last.steer === d.steer && Math.sign(last.dist) === Math.sign(dist)) last.dist += dist;
  else d.segments.push({ steer: d.steer, dist });
}

/** poseClear(pose, steer)가 'ok'가 아니면 throw */
export function startDrive(ctx: MotionCtx, pose: Pose, steer = 0): Drive {
  const r = poseClear(ctx, pose, steer);
  if (r.kind !== 'ok') throw new Error(`startDrive: pose is not clear (${r.kind})`);
  const p = { x: pose.x, y: pose.y, heading: pose.heading };
  return { ctx, pose: p, steer, path: [p], segments: [] };
}

/** 제자리 조향. 새 각도에서 poseClear가 'ok'여야 한다. false = 거부, 조향은 그대로 */
export function setSteer(d: Drive, steer: number): boolean {
  if (!clear(d, d.pose, steer)) return false;
  d.steer = steer;
  return true;
}

/**
 * 지금 조향으로 dist(부호 있음, + = 전진)만큼 DS 단위로 움직인다.
 * poseClear가 'ok'가 아닌 첫 스텝 전에 멈추고, 실제로 움직인 거리(부호 있음)를 돌려준다.
 */
export function move(d: Drive, dist: number): number {
  const dir = Math.sign(dist);
  const total = Math.abs(dist);
  let moved = 0;
  while (total - moved > 1e-9) {
    const step = Math.min(DS, total - moved);
    const next = integratePose(d.pose, d.ctx.spec, d.steer, dir * step, 1);
    if (!clear(d, next, d.steer)) break;
    advance(d, next, dir * step);
    moved += step;
  }
  return dir * moved;
}

/**
 * dir 방향으로 막히거나 maxDist에 이를 때까지 움직이고, 막혔으면 같은 원호에서 clearance(기본 0.10 m)만큼 덜 간 자리에 선다.
 * 실제로 되돌아가지 않고 그 자리에서 멈추므로 segments·dirChanges에 방향 전환이 생기지 않는다.
 * maxDist까지 막히지 않았으면 물러나지 않는다. 움직인 거리(부호 있음)를 돌려준다.
 * 갈 수 있는 거리가 clearance 이하이면 0을 돌려주고 움직이지 않는다 (탐색 반복문이 같은 자리에서 맴돌지 않게 확인할 것,
 * 필요하면 clearance를 작게 주거나 move를 쓴다).
 */
export function moveUntilBlocked(d: Drive, dir: 1 | -1, maxDist: number, clearance = 0.1): number {
  const probe: Drive = { ...d, path: [], segments: [] };
  const reach = Math.abs(move(probe, dir * maxDist));
  const blocked = maxDist - reach > 1e-9;
  return move(d, dir * (blocked ? Math.max(0, reach - clearance) : reach));
}

/**
 * 조향을 target 쪽으로 ratePerM(정규화 조향/m, 기본 1.0 ≈ 서행 중 키보드 속도)씩 바꾸며 dist(부호 있음)만큼 서행한다.
 * DS마다 먼저 setSteer(다음 값)를 시도하고(거부되면 이전 조향 유지) DS만큼 움직인다.
 * poseClear가 'ok'가 아닌 첫 자세 전에 멈추고, 움직인 거리(부호 있음)를 돌려준다.
 * 정지 상태에서 끝까지 조향할 수 없는 곳(연석 옆, §1.5)에서 쓴다.
 */
export function moveSteering(d: Drive, target: number, dist: number, ratePerM = 1.0): number {
  const dir = Math.sign(dist);
  const total = Math.abs(dist);
  let moved = 0;
  while (total - moved > 1e-9) {
    const step = Math.min(DS, total - moved);
    const delta = target - d.steer;
    const maxStep = ratePerM * step;
    if (delta !== 0) setSteer(d, Math.abs(delta) <= maxStep ? target : d.steer + Math.sign(delta) * maxStep);
    const next = integratePose(d.pose, d.ctx.spec, d.steer, dir * step, 1);
    if (!clear(d, next, d.steer)) break;
    advance(d, next, dir * step);
    moved += step;
  }
  return dir * moved;
}

/** segments에서 움직인 거리의 부호가 바뀐 횟수 (조향 변화는 세지 않는다) */
export function dirChanges(d: Drive): number {
  let n = 0;
  let last = 0;
  for (const s of d.segments) {
    const sign = Math.sign(s.dist);
    if (sign === 0) continue;
    if (last !== 0 && sign !== last) n++;
    last = sign;
  }
  return n;
}

/** evaluateGoal에 임시 zone 목표를 넣어 판정한다. 요구 방향 = rect.angle */
export function inRect(fp: Footprint, pose: Pose, rect: ORect, maxAngleDeg: number): boolean {
  return evaluateGoal({ kind: 'zone', rect, maxAngleDeg }, fp, pose).success;
}
