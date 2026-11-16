import { clearance } from '../sim/clearance';
import { buildFootprint } from '../sim/footprint';
import type { Pose, Vec2 } from '../sim/geometry';
import { rectFromAabb } from '../sim/goal';
import type { VehicleSpec } from '../sim/specs';
import type { WorldElement } from '../sim/world';
import { prepare } from '../sim/world';
import { crookNeighbours } from './crooked';
import { FRONT_STOP_FROM_BACK } from './frontPerpendicular';
import { AISLE_W, buildParallel, SLOT_W } from './parallel';
import { AISLE, buildGarage, REAR_STOP_FROM_BACK } from './rearPerpendicular';
import type { FloorPatch, ParallelOptions, PerpOptions, Scenario } from './types';

// 출차 3종 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C1).
// 배치 = 주차 빌더와 같은 차고·평행 열 (같은 rnd() 순서) → 옆 차 비뚤게(crooked.ts, 켰을 때) → ensureRoom.
// 출발 = 칸 안에 주차한 자세 (프리셋은 주차 해결 가능성 테스트의 목표 자세 G와 같다). 목표 = 통로의 출구 구역 (zone, 30°).
// 프리셋 8종은 모든 옵션에서 ensureRoom이 아무것도 바꾸지 않아 배치가 주차와 똑같다 (tests/rearPerpOut.test.ts 등).

/**
 * 출발 자세의 옆 여유(차체·미러 → 한쪽 solid)가 이보다 작으면 그쪽을 벌린다 (m).
 * 설계 C1 규칙: 0.05에서 시작해, 프리셋이 그보다 작으면 (프리셋 최솟값 − 0.005)로 낮춘다.
 * 프리셋 최솟값 0.0381 = 쏘렌토, 전면 직각 출차, 칸 폭 2.10 m(직접 입력 하한), pillar (칸 폭 2.10~3.20 m 전체에서 잼)
 */
export const C_TRIG = 0.033;
/** 벌린 뒤 옆 여유 (m) */
export const C_SET = 0.1;
/** 벌리는 단위 (m) */
const SPREAD_STEP = 0.02;

interface Lot {
  elements: WorldElement[];
  bounds: Scenario['bounds'];
  floor: FloorPatch[];
  lamps: Pose[];
}

const xRange = (poly: Vec2[]) => [Math.min(...poly.map((p) => p.x)), Math.max(...poly.map((p) => p.x))] as const;
/** 축 정렬 사각형인지 (변마다 x나 y가 같다) */
const isAabb = (poly: Vec2[]) => poly.length === 4 && poly.every((p, i) => p.x === poly[(i + 1) % 4].x || p.y === poly[(i + 1) % 4].y);

/** 출구 구역 길이: 램프와 같다 */
const zoneLen = (spec: VehicleSpec) => Math.max(5, spec.length + 1);

/**
 * x = at에서 배치를 가른다: 통째로 서쪽(x ≤ at)인 요소·바닥은 −dNeg, 동쪽(x ≥ at)은 +dPos만큼 옮기고,
 * at에 걸친 축 정렬 사각형(벽·선·연석·바닥)은 그만큼 늘인다. 걸친 주차 차량(통로 건너편 칸)은 그대로 둔다 (칸만 넓어진다).
 * 조명과 범위도 같이 옮긴다.
 */
function spreadX(lot: Lot, at: number, dNeg: number, dPos: number): Lot {
  if (dNeg === 0 && dPos === 0) return lot;
  const shift = (poly: Vec2[]): number | null => {
    const [x0, x1] = xRange(poly);
    return x1 <= at ? -dNeg : x0 >= at ? dPos : null;
  };
  const stretch = (poly: Vec2[]) => poly.map((p) => ({ x: p.x < at ? p.x - dNeg : p.x + dPos, y: p.y }));
  const elements = lot.elements.map((e) => {
    const d = shift(e.poly);
    if (d === null) return isAabb(e.poly) ? prepare({ ...e, poly: stretch(e.poly) }) : e;
    const meta = e.meta?.cx === undefined ? {} : { meta: { ...e.meta, cx: Number(e.meta.cx) + d } };
    return prepare({ ...e, poly: e.poly.map((p) => ({ x: p.x + d, y: p.y })), ...meta });
  });
  const floor = lot.floor.map((f) => {
    const d = shift(f.poly);
    return { ...f, poly: d === null ? stretch(f.poly) : f.poly.map((p) => ({ x: p.x + d, y: p.y })) };
  });
  const lamps = lot.lamps.map((l) => ({ ...l, x: l.x < at ? l.x - dNeg : l.x + dPos }));
  const b = lot.bounds;
  return { elements, floor, lamps, bounds: { ...b, x0: b.x0 - dNeg, x1: b.x1 + dPos } };
}

/**
 * 출발 자세가 지나치게 끼어 있으면 x = at(칸 중심)의 양쪽을 벌린다 (설계 C1 ensureRoom, override 2).
 * 쪽마다 출발 차체·미러에서 그쪽 solid(통째로 at 서쪽 또는 동쪽)까지 여유를 재고, C_TRIG보다 작으면
 * 여유가 C_SET 이상이 될 때까지 SPREAD_STEP씩 벌린다. 요소를 바깥으로 d 민 것 = 차를 반대로 d 민 것이라 차를 옮겨 잰다.
 * (차를 그쪽에서 멀리 밀면 x 간격만으로도 결국 C_SET을 넘으므로 반복은 끝난다.)
 * 기둥·선·휠스톱도 자기 쪽과 함께 움직여 기둥에 끼는 일이 없다. 프리셋은 모든 옵션에서 벌리지 않는다.
 */
function ensureRoom(lot: Lot, at: number, start: Pose, spec: VehicleSpec): Lot & { dPos: number } {
  const fp = buildFootprint(spec);
  const need = (side: WorldElement[], away: 1 | -1) => {
    if (clearance(fp, start, side) >= C_TRIG) return 0;
    let k = 1;
    while (clearance(fp, { ...start, x: start.x + away * k * SPREAD_STEP }, side) < C_SET) k++;
    return k * SPREAD_STEP;
  };
  const dNeg = need(lot.elements.filter((e) => xRange(e.poly)[1] <= at), 1);
  const dPos = need(lot.elements.filter((e) => xRange(e.poly)[0] >= at), -1);
  return { ...spreadX(lot, at, dNeg, dPos), dPos };
}

/** 직각 출차 공용: rear = 후면 직각(뒤로 넣은 자세에서 앞으로 나감), 아니면 전면 직각(앞으로 넣은 자세에서 후진으로 나감) */
function buildPerpOut(rear: boolean, opt: PerpOptions, spec: VehicleSpec): Scenario {
  const stopFromBack = rear ? REAR_STOP_FROM_BACK : FRONT_STOP_FROM_BACK;
  const g = buildGarage(opt, { stopFromBack });
  const t = g.target;
  // 칸 중심 = 주차 목표 rect.cx (withCrooked가 쓰는 값과 같다)
  const bayCx = (g.inner.x0 + g.inner.x1) / 2;
  const face = t.slotLen - stopFromBack; // 휠스톱의 통로 쪽 면
  const wall = t.slotLen + 0.3; // 뒷벽 면
  const d = spec.tireDiameter;
  // 바퀴는 휠스톱 면 0.03 m 앞 (주차 테스트의 G), 큰 차는 범퍼를 뒷벽에서 0.05 m 떼는 쪽이 먼저 걸린다
  const start: Pose = rear
    ? { x: bayCx, y: Math.min(face - 0.03 - d / 2, wall - 0.05 - spec.rearOverhang), heading: -Math.PI / 2 }
    : {
        x: bayCx,
        y: Math.min(face - 0.03 - spec.wheelbase - d / 2, wall - 0.05 - spec.wheelbase - spec.frontOverhang),
        heading: Math.PI / 2,
      };
  const elements = opt.crooked ? crookNeighbours(g.elements, bayCx, opt, spec) : g.elements;
  const room = ensureRoom({ elements, bounds: g.bounds, floor: g.floor, lamps: g.lamps }, bayCx, start, spec);
  // 출구 구역: 목표 칸 동쪽 선에서 6 m 동쪽부터, 통로 전체 폭, 동쪽 방향
  const zx = t.x1 + room.dPos + 6;
  return {
    kind: rear ? 'rearPerpOut' : 'frontPerpOut',
    elements: room.elements,
    start,
    goal: { kind: 'zone', rect: rectFromAabb(zx, -AISLE, zx + zoneLen(spec), 0, 0), maxAngleDeg: 30 },
    bounds: room.bounds,
    ceilingHeight: g.ceilingHeight,
    floor: room.floor,
    lamps: room.lamps,
  };
}

/** 후면 직각 출차: 뒤로 넣은 칸에서 앞으로 나와 왼쪽(동쪽) 출구로 */
export function buildRearPerpOut(opt: PerpOptions, spec: VehicleSpec): Scenario {
  return buildPerpOut(true, opt, spec);
}

/** 전면 직각 출차: 앞으로 넣은 칸에서 후진으로 나와 오른쪽(동쪽) 출구로 */
export function buildFrontPerpOut(opt: PerpOptions, spec: VehicleSpec): Scenario {
  return buildPerpOut(false, opt, spec);
}

/** 평행 출차: 앞뒤 차 사이 칸에서 앞쪽(동쪽) 출구로 */
export function buildParallelOut(opt: ParallelOptions, spec: VehicleSpec): Scenario {
  const p = buildParallel(opt);
  const r = p.goal.rect; // 주차 칸: 연석면(y = 0) ~ 차로 쪽 선 바깥 가장자리
  const mid = (spec.wheelbase + spec.frontOverhang - spec.rearOverhang) / 2; // 뒤축 → 차체 가운데
  const tyre = Math.max(spec.trackFront, spec.trackRear) / 2 + spec.tireWidth / 2;
  // 차체 가운데 = 칸 가운데 (= 앞뒤 차 사이 빈 곳 가운데), 차체 왼쪽 면은 차로 쪽 선 바깥 가장자리 0.02 m 안 (주차 테스트의 G).
  // 폭이 넓은 차는 오른쪽 바퀴를 연석면에서 0.03 m 떼는 쪽이 먼저 걸린다
  const start: Pose = { x: r.cx - mid, y: Math.max(r.cy + r.halfW - 0.02 - spec.width / 2, 0.03 + tyre), heading: 0 };
  const room = ensureRoom({ elements: p.elements, bounds: p.bounds, floor: p.floor, lamps: p.lamps }, r.cx, start, spec);
  // 출구 구역: 앞차 앞범퍼 1 m 앞과 다음 칸 시작(4L) 중 먼 쪽부터, 차로 전체 폭, 동쪽 방향
  const front = room.elements
    .filter((e) => e.tag === 'car' && e.bc!.x > r.cx)
    .reduce((a, b) => (a.bc!.x < b.bc!.x ? a : b));
  const zx = Math.max(4 * opt.slotLength + room.dPos, xRange(front.poly)[1] + 1);
  const yLane = r.cy + r.halfW;
  return {
    kind: 'parallelOut',
    elements: room.elements,
    start,
    goal: { kind: 'zone', rect: rectFromAabb(zx, yLane, zx + zoneLen(spec), SLOT_W + AISLE_W, 0), maxAngleDeg: 30 },
    bounds: room.bounds,
    ceilingHeight: p.ceilingHeight,
    floor: room.floor,
    lamps: room.lamps,
  };
}
