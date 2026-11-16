import { wheelPolys } from '../../src/sim/footprint';
import { aabbRect, polygonDistance, polyToWorld, type Pose, type Vec2 } from '../../src/sim/geometry';
import { rectFromAabb, wrapPi, type ORect } from '../../src/sim/goal';
import { motionCtx, type MotionCtx } from '../../src/sim/motion';
import type { VehicleSpec } from '../../src/sim/specs';
import { prepare, type WorldElement } from '../../src/sim/world';
import { LINE_WIDTH } from '../../src/scenarios/common';
import { AISLE_W, SLOT_W } from '../../src/scenarios/parallel';
import { AISLE } from '../../src/scenarios/rearPerpendicular';
import type { Scenario } from '../../src/scenarios/types';
import { inRect, move, moveSteering, moveUntilBlocked, setSteer, startDrive, type Drive } from './drive';
import { pursue, type PursuitResult } from './pursuit';

// 출차 3종과 '옆 차 비뚤게'의 해결 가능성 증명 도구 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md D 'Bays agent').
// 계약서 §8.2의 탈출 스크립트를 옮겨 적었다 (복사, 원본 테스트 파일은 그대로 둔다):
// - rearPerpExit: tests/rearPerpendicular.test.ts driveOut
// - frontPerpExit: tests/frontPerpendicular.test.ts tryExit·driveOut
// - parallelExit: tests/parallel.test.ts driveOut과 그 도구 (계획 세계, stroke, straighten, findExit ...)
// 원본과 다른 점: 출발 자세 G와 통로를 인자로 받고, 평행 탈출은 펴고 난 자리를 받아들일지 정하는 accept를 더 받는다
// (기본값은 원본 동작. 출차 증명은 그 자리에서 출구 구역까지 갈 수 있는 자리만 받는다, provePullOut).
// provePullOut은 출차 증명 하나 = 탈출 스크립트 → 같은 Drive로 통로를 따라 출구 구역까지 순수 추종(pursuit.ts).
// 테스트와 기준값 계산 스크립트가 같은 코드를 쓰도록 여기에 둔다. src/scenarios/index.ts는 import하지 않는다 (§A.5).

const DEG = Math.PI / 180;
const lw = LINE_WIDTH;

// ---- 출차·비뚤게 테스트가 같이 쓰는 측정 ----

/** 목표 칸 휠스톱의 통로 쪽 면 (y). tests/rearPerpendicular.test.ts stopFace와 같다 (칸 = goal.rect 또는 bayCx 근처) */
export function stopFace(elements: WorldElement[], bayCx: number, halfW: number): number {
  const stops = elements.filter((e) => e.kind === 'wheelStop' && e.bc!.y > 0 && Math.abs(e.bc!.x - bayCx) < halfW);
  return Math.min(...stops.flatMap((e) => e.poly.map((p) => p.y)));
}

/** 조향 0인 네 타이어(접지 영역)에서 휠스톱·연석까지 가장 가까운 거리 (m) */
export function tyreGap(spec: VehicleSpec, pose: Pose, elements: WorldElement[]): number {
  const tyres = Object.values(wheelPolys(spec, 0)).map((w) => polyToWorld(w, pose));
  let g = Infinity;
  for (const e of elements) {
    if (e.kind !== 'wheelStop' && e.kind !== 'curb') continue;
    for (const t of tyres) g = Math.min(g, polygonDistance(t, e.poly));
  }
  return g;
}

/**
 * 옆 차 비뚤게(crooked)가 바꿀 수 있는 요소: 목표 칸(중심 x = bayCx) 양옆의 북쪽 열 주차 차량 id (서쪽, 동쪽 순).
 * pillar 목표는 서쪽 이웃이 기둥이고 기둥은 움직이지 않으므로 동쪽 차 하나.
 */
export function neighbourIds(elements: WorldElement[], bayCx: number, target: 'between' | 'pillar'): string[] {
  const north = elements.filter((e) => e.tag === 'car' && e.bc!.y > 0);
  const nearest = (side: 1 | -1) =>
    north.filter((e) => side * (e.bc!.x - bayCx) > 0).reduce((a, b) => (Math.abs(a.bc!.x - bayCx) < Math.abs(b.bc!.x - bayCx) ? a : b));
  return target === 'between' ? [nearest(-1).id, nearest(1).id] : [nearest(1).id];
}

/** 같은 순서의 두 요소 배열에서 내용이 다른 요소의 id (길이·id 순서가 같아야 한다) */
export function changedIds(a: WorldElement[], b: WorldElement[]): string[] {
  if (a.length !== b.length || a.some((e, i) => e.id !== b[i].id)) throw new Error('changedIds: 요소 목록이 다름');
  return a.filter((e, i) => JSON.stringify(e) !== JSON.stringify(b[i])).map((e) => e.id);
}

// ---- 후면 직각 (tests/rearPerpendicular.test.ts) ----

/**
 * 앞으로 s0 m 직진한 뒤 왼쪽 끝까지 꺾고 heading이 corridor.angle이 될 때까지 전진 (§8.2 rearPerp 행).
 * s0를 0..4 m에서 0.1 m 간격으로 보고, 처음으로 통로에 들어가는 운전을 돌려준다.
 */
export function rearPerpExit(ctx: MotionCtx, G: Pose, corridor: ORect): Drive | null {
  const arc = wrapPi(corridor.angle - G.heading) / (Math.tan(ctx.maxSteer) / ctx.spec.wheelbase);
  for (let i = 0; i <= 40; i++) {
    const s0 = i / 10;
    const d = startDrive(ctx, G);
    if (move(d, s0) < s0 - 1e-9 || !setSteer(d, 1) || move(d, arc) < arc - 1e-9) continue;
    if (inRect(ctx.fp, d.pose, corridor, 20)) return d;
  }
  return null;
}

// ---- 전면 직각 (tests/frontPerpendicular.test.ts) ----

/**
 * 후진 다점 탈출 한 번 (§8.2 frontPerp 행). heading이 corridor.angle 쪽으로만 돈다.
 * 1) s0 m 곧게 후진  2) 조향 st1로 후진  3) 통로에 들 때까지 끝 조향 전진 ↔ 끝 조향 후진.
 * 다리마다 목표 heading에 닿거나 막힐 때까지 간다 (막히면 0.10 m 덜 간 자리에 선다).
 */
function tryExit(ctx: MotionCtx, G: Pose, corridor: ORect, s0: number, st1: number): Drive | null {
  const d = startDrive(ctx, G);
  if (move(d, -s0) > -s0 + 1e-9) return null;
  for (let leg = 0; leg < 12; leg++) {
    if (inRect(ctx.fp, d.pose, corridor, 20)) return d;
    const rem = wrapPi(corridor.angle - d.pose.heading); // 남은 회전 (+ = 반시계)
    if (Math.abs(rem) < 1e-6) return null; // 방향은 맞췄는데 통로 밖
    const dir = leg % 2 === 0 ? -1 : 1; // 후진부터 번갈아
    const steer = (leg === 0 ? st1 : 1) * Math.sign(rem) * dir; // heading 변화 = 이동 거리 × 곡률
    if (!setSteer(d, steer)) return null;
    const curvature = Math.tan(Math.abs(steer) * ctx.maxSteer) / ctx.spec.wheelbase;
    if (moveUntilBlocked(d, dir, Math.abs(rem) / curvature) === 0) return null;
  }
  return inRect(ctx.fp, d.pose, corridor, 20) ? d : null;
}

/** 처음 통하는 탈출: s0 0..4 m (0.1 m 간격) × 첫 후진 조향 1, 0.8, 0.6, 0.4 */
export function frontPerpExit(ctx: MotionCtx, G: Pose, corridor: ORect): Drive | null {
  for (let i = 0; i <= 40; i++) {
    for (const st1 of [1, 0.8, 0.6, 0.4]) {
      const d = tryExit(ctx, G, corridor, i / 10, st1);
      if (d) return d;
    }
  }
  return null;
}

// ---- 평행 (tests/parallel.test.ts) ----

function bbox(poly: Vec2[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * 계획용 세계: solid마다 외접 사각형을 MARGIN만큼 키운다 (연석은 그대로).
 * 여기서 poseClear를 통과하는 자세는 실제 세계에서도 통과하고(solid는 커지기만 함), 이웃 차·벽과 늘 MARGIN 이상 떨어진다.
 * 그래서 DS 간격 사이의 스침이 없고, 사람이 따라 할 만한 여유가 있는 길만 증명한다.
 */
const MARGIN = 0.1;
/** 막힌 자리에서 물러서는 원호 길이 */
const BACKOFF = 0.1;
/** 한 번 꺾어 움직이는 최대 거리 */
const STROKE_MAX = 3;
/** 빠져나가기 탐색 조각 */
const CH = 0.1;
/** 펴기를 끝내는 방향 */
const HDG_DONE = 2 * DEG;

export function inflated(elements: WorldElement[]): WorldElement[] {
  return elements.map((e) => {
    if (e.kind !== 'solid') return e;
    const b = bbox(e.poly);
    return prepare({ ...e, poly: aabbRect(b.x0 - MARGIN, b.y0 - MARGIN, b.x1 + MARGIN, b.y1 + MARGIN) });
  });
}

const blocked = (moved: number) => Math.abs(moved) < CH - 1e-9;
/** d를 건드리지 않는 탐색용 사본 */
const probeOf = (d: Drive): Drive => startDrive(d.ctx, d.pose, d.steer);

/** 정지 상태에서 target 쪽으로 0.05씩 거부되기 전까지 돌린다 (연석 옆에서는 일부만 된다, §1.5) */
function steerStill(d: Drive, target: number): void {
  while (d.steer !== target) {
    const next = Math.abs(target - d.steer) <= 0.05 ? target : d.steer + Math.sign(target - d.steer) * 0.05;
    if (!setSteer(d, next)) return;
  }
}

/** target 쪽 끝까지 조향하며(정지 상태에서 되는 만큼, 나머지는 움직이며) dir로 막힐 때까지 가서 BACKOFF만큼 덜 간 자리에 선다 */
function stroke(d: Drive, target: 1 | -1, dir: 1 | -1): number {
  steerStill(d, target);
  const reach = Math.abs(moveSteering(probeOf(d), target, dir * STROKE_MAX));
  return moveSteering(d, target, dir * (reach < STROKE_MAX - 1e-9 ? Math.max(0, reach - BACKOFF) : reach));
}

/** 오른쪽 끝으로 돌며 방향이 HDG_DONE 이하가 될 때까지 전진하고, 곧게 최대 2 m 더 가며 통로에 들어가면 true */
function straighten(d: Drive, corridor: ORect): boolean {
  if (d.pose.heading > HDG_DONE) {
    steerStill(d, -1);
    for (let i = 0; i < 100 && d.pose.heading > HDG_DONE; i++) if (blocked(moveSteering(d, -1, CH))) return false;
  }
  steerStill(d, 0);
  for (let i = 0; i < 20; i++) {
    if (inRect(d.ctx.fp, d.pose, corridor, 20)) return true;
    if (blocked(moveSteering(d, 0, CH))) return false;
  }
  return inRect(d.ctx.fp, d.pose, corridor, 20);
}

/**
 * 지금 자리에서 빠져나가기를 사본으로 시험한다: 왼쪽 끝으로 돌며 CH씩 전진하다가, 끝까지 오른쪽으로 펴면 차체 오른쪽 면이
 * 통로 안에 들 만큼 나왔으면 펴기를 시험한다. 성공하는 가장 짧은 왼쪽 조각 수, 없으면 null.
 * accept(원본에는 없음): 편 뒤의 사본을 받아 그 자리를 받아들일지 정한다 (출차 증명은 이어서 출구 구역까지 갈 수 있는지 본다).
 */
function findExit(d: Drive, corridor: ORect, accept: (q: Drive) => boolean): number | null {
  const p = probeOf(d);
  const R = p.ctx.spec.wheelbase / Math.tan(p.ctx.maxSteer); // 끝까지 돌렸을 때 뒤축 중심 회전 반경
  steerStill(p, 1);
  for (let n = 1; n <= 60; n++) {
    if (blocked(moveSteering(p, 1, CH))) return null;
    const rightSide = p.pose.y + R * (1 - Math.cos(p.pose.heading)) - p.ctx.spec.width / 2;
    if (rightSide >= corridor.cy - corridor.halfW) {
      const q = probeOf(p);
      if (straighten(q, corridor) && accept(q)) return n;
    }
  }
  return null;
}

/**
 * G → 통로: 뒤차에서 0.15 m까지 곧게 후진, 빠져나갈 수 있으면 나가고, 아니면 왼쪽 전진 · 오른쪽 후진을 한 번 더 한다.
 * 실제 움직임은 helpers/drive.ts의 startDrive·setSteer·moveUntilBlocked·moveSteering만 쓴다. 사본(probeOf)은 미리 보기용이고,
 * 같은 호출을 같은 순서로 하므로 실제 차도 사본과 똑같이 움직인다. 운전은 계획 세계(inflated)에서 한다.
 * accept는 findExit로 넘긴다 (기본: 원본처럼 통로에 들면 받아들임).
 */
export function parallelExit(
  elements: WorldElement[],
  G: Pose,
  spec: VehicleSpec,
  corridor: ORect,
  accept: (q: Drive) => boolean = () => true,
): Drive {
  const d = startDrive(motionCtx(spec, inflated(elements)), G, 0);
  moveUntilBlocked(d, -1, STROKE_MAX, 0.15 - MARGIN);
  for (let i = 0; i < 6; i++) {
    const n = findExit(d, corridor, accept);
    if (n !== null) {
      steerStill(d, 1);
      for (let k = 0; k < n; k++) moveSteering(d, 1, CH);
      straighten(d, corridor);
      break;
    }
    const f = stroke(d, 1, 1); // 왼쪽으로 앞차 앞까지
    const r = stroke(d, -1, -1); // 오른쪽으로 뒤차·연석 앞까지
    if (Math.abs(f) + Math.abs(r) < 0.05) break;
  }
  return d;
}

// ---- 통로 (원본 테스트의 corridor와 같은 범위, rect 각도 = 출구 방향 동쪽 0) ----

/** 직각 차고 통로: 양 끝벽 안쪽, y −6..0 */
export const perpCorridor = (sc: Scenario): ORect => rectFromAabb(sc.bounds.x0 + 0.3, -AISLE, sc.bounds.x1 - 0.3, 0, 0);
/** 평행 열 통로: 양 끝벽 안쪽, y 2.0 + lw/2 .. 7.0 */
export const parallelCorridor = (sc: Scenario): ORect =>
  rectFromAabb(sc.bounds.x0 + 0.3, SLOT_W + lw / 2, sc.bounds.x1 - 0.3, SLOT_W + AISLE_W, 0);

// ---- 출차 증명: 탈출 → 통로 가운데 선으로 옮겨 출구 구역까지 추종 ----

/** 가운데 선으로 옮겨 가는 거리 (m): 코사인 곡선으로 옆으로 Δ만큼 옮기면 최대 곡률 (π/S)²·Δ/2 */
const BLEND = 8;

/**
 * 뒤축 꺾은선: from에서 동쪽으로 가며 BLEND m 동안 y를 yc로 매끄럽게(코사인) 옮기고, 그다음 xEnd까지 곧게.
 * from의 y를 그대로 따라가지 않는다: 탈출이 끝난 자리는 통로 가장자리라 다음 주차 차량(통로로 튀어나온 차, 계획 세계에서 키운 차)에 걸릴 수 있다.
 */
export function aislePath(from: Vec2, yc: number, xEnd: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let s = 0; s <= BLEND + 1e-9; s += 0.5) {
    pts.push({ x: from.x + s, y: from.y + ((yc - from.y) * (1 - Math.cos((Math.PI * s) / BLEND))) / 2 });
  }
  pts.push({ x: xEnd, y: yc });
  return pts;
}

export interface PullOutProof {
  /** 탈출 스크립트가 통로에 닿지 못하면 null */
  d: Drive | null;
  /** 통로에서 출구 구역까지 추종 결과 (탈출 실패면 null) */
  r: PursuitResult | null;
}

/**
 * 출차 증명: sc.start에서 그 종류의 탈출 스크립트로 통로까지 나온 뒤, 같은 Drive로 통로 가운데 선을 따라 sc.goal(zone)까지 추종한다.
 * 평행 출차는 탈출과 추종 모두 계획 세계(MARGIN만큼 키운 solid)에서 한다 (원본 평행 증명과 같은 기준).
 * 평행 탈출은 통로에 들었어도 미러가 아직 앞차 높이 아래에 있으면 앞으로 더 갈 수 없으므로 (모닝, 7.0 m),
 * 펴고 난 자리에서 출구 구역까지 추종이 되는 가장 짧은 왼쪽 조각 수를 고른다 (findExit의 accept).
 */
export function provePullOut(sc: Scenario, spec: VehicleSpec): PullOutProof {
  const parallel = sc.kind === 'parallelOut';
  const corridor = parallel ? parallelCorridor(sc) : perpCorridor(sc);
  const z = sc.goal.rect;
  const xEnd = z.cx + z.halfL + 2; // 구역 동쪽 끝을 지나서까지
  // 통로에 나온 자리에서 가운데 선(y = 통로 가운데)으로 옮겨 출구 구역까지
  const toZone = (q: Drive) => pursue(q, aislePath(q.pose, corridor.cy, xEnd), { goal: sc.goal });
  let d: Drive | null;
  if (parallel) {
    d = parallelExit(sc.elements, sc.start, spec, corridor, (q) => toZone(q).end === 'goal');
    if (!inRect(d.ctx.fp, d.pose, corridor, 20)) d = null;
  } else {
    const ctx = motionCtx(spec, sc.elements);
    d = sc.kind === 'rearPerpOut' ? rearPerpExit(ctx, sc.start, corridor) : frontPerpExit(ctx, sc.start, corridor);
  }
  return d ? { d, r: toZone(d) } : { d: null, r: null };
}
