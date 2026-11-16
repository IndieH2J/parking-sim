import { aabbRect } from '../sim/geometry';
import { rectFromAabb } from '../sim/goal';
import type { VehicleSpec } from '../sim/specs';
import { maxSteerAngle } from '../sim/vehicle';
import type { WorldElement } from '../sim/world';
import type { Scenario } from './types';
import { boundsOf, elementAdder, mulberry32, octagon, PARKED_COLORS, parkedCar, parkedCarDims, WALL_T } from './common';

/**
 * 좁은 골목 통과 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C2). 야외, 옵션 없음, 크기는 차에 맞춘다.
 *
 * 월드 좌표: 골목은 +x(동쪽)로 뻗고 가운데가 y = 0. 양쪽 벽면 y = ±Wa/2, 서쪽 끝 벽면 x = 0.
 * - 좁은 곳 3군데: 벽 σ = (−1, +1, −1) 쪽에 주차 차(벽면에서 0.15 m)가 있고, 그 차 가운데 x에 전봇대가 있다.
 *   전봇대의 가까운 면은 차 안쪽 면에서 F = 미러 포함 폭 + 2·0.30 (가운데로 지나가면 양쪽 미러 바깥 30 cm).
 *   골목 폭 Wa = F + 2.6이라 전봇대 뒤 벽까지는 2.15 − 주차 차 폭 = 0.23~0.35 m뿐이다 (어떤 차도 돌아가지 못한다).
 *   통로 가운데(차 안쪽 면과 전봇대 면의 가운데)는 주차 차 폭에 따라 약 +0.7, −0.7, +0.7 m로 엇갈린다.
 * - 간격: 첫 차는 출발 앞범퍼 8 m 앞에서 시작한다. 다음 차 시작 = 앞 차 끝 + 전장 + S자 길이 2√(1.5·R·Δy) + 2.0
 *   (R = 뒤축 최소 회전 반경, Δy = 이웃한 통로 가운데의 차이). 앞 차를 뒤범퍼가 지난 뒤 다음 차에 앞범퍼가 닿기 전에 옆으로 옮겨 갈 거리다.
 * - 출발: 뒤범퍼가 서쪽 끝 벽면에서 1.5 m, 첫 통로 가운데, 동쪽을 향함.
 * - 출구 구역: 마지막 차 끝 + 2 m부터 길이 max(5, 전장 + 1), 벽면~벽면, 각도 0, 30°. 동쪽 끝 벽면은 구역 3 m 뒤.
 */

/** 좁은 곳에서 미러 바깥 여유 s (구성 하나, 계획서 덮어쓰기 1) */
const ROOM = 0.3;
/** 골목 폭 = F + 이 값 */
const WIDTH_EXTRA = 2.6;
const WALL_H = 2.0;
/** 주차 차 바깥 면 ↔ 벽면 */
const CAR_WALL_GAP = 0.15;
/** 전봇대: 팔각형 중심 → 면 거리 (지름 0.30 m), 높이 */
const POLE_R = 0.15;
const POLE_H = 7.0;
/** 좁은 곳마다 주차 차가 붙는 벽 (−1 = 남쪽, +1 = 북쪽) */
const SIDES = [-1, 1, -1];
const SEED = 11;
/** 출발 뒤범퍼 ↔ 서쪽 끝 벽면 */
const START_GAP = 1.5;
/** 출발 앞범퍼 → 첫 주차 차 */
const LEAD = 8;
/** S자 원호 반경 = 이 값 × R */
const TURN_K = 1.5;
/** 좁은 곳 사이의 여유 (S자 길이에 더한다) */
const GAP_SPARE = 2.0;
/** 마지막 주차 차 끝 → 출구 구역 */
const ZONE_GAP = 2;
/** 출구 구역 끝 → 동쪽 끝 벽면 */
const END_RUN = 3;

export function buildAlley(spec: VehicleSpec): Scenario {
  const F = spec.widthMirrors + 2 * ROOM;
  const hw = (F + WIDTH_EXTRA) / 2; // 벽면 y = ±hw
  const R = spec.wheelbase / Math.tan(maxSteerAngle(spec));
  const rnd = mulberry32(SEED);
  // 주차 차마다 rnd(): 크기 3회, 색 1회, 방향 1회
  const parked = SIDES.map((side) => {
    const d = parkedCarDims(rnd);
    const color = PARKED_COLORS[Math.floor(rnd() * PARKED_COLORS.length)];
    const heading = rnd() < 0.5 ? 0 : Math.PI;
    const inner = side * (hw - CAR_WALL_GAP - d.width); // 통로 쪽 면 y
    return { side, d, color, heading, inner, yc: inner - (side * F) / 2 };
  });
  // 주차 차 시작 x (서쪽 끝)
  const xs = [START_GAP + spec.length + LEAD];
  for (let k = 1; k < parked.length; k++) {
    const dy = Math.abs(parked[k].yc - parked[k - 1].yc);
    xs.push(xs[k - 1] + parked[k - 1].d.length + spec.length + 2 * Math.sqrt(TURN_K * R * dy) + GAP_SPARE);
  }
  const last = parked.length - 1;
  const zoneLen = Math.max(5, spec.length + 1); // 출구 구역 길이: 전장 + 1 m (최소 5 m)
  const z0 = xs[last] + parked[last].d.length + ZONE_GAP;
  const xEnd = z0 + zoneLen + END_RUN; // 동쪽 끝 벽면

  const els: WorldElement[] = [];
  const add = elementAdder(els);
  const wall = (x0: number, y0: number, x1: number, y1: number) =>
    add({ kind: 'solid', tag: 'wall', poly: aabbRect(x0, y0, x1, y1), hMin: 0, hMax: WALL_H });
  wall(-WALL_T, -hw - WALL_T, xEnd + WALL_T, -hw); // 남
  wall(-WALL_T, hw, xEnd + WALL_T, hw + WALL_T); // 북
  wall(-WALL_T, -hw, 0, hw); // 서 (출발 뒤)
  wall(xEnd, -hw, xEnd + WALL_T, hw); // 동 (구역 뒤)
  parked.forEach((p, k) => {
    const cx = xs[k] + p.d.length / 2;
    add(parkedCar(cx, p.side * (hw - CAR_WALL_GAP - p.d.width / 2), p.heading, p.d, p.color));
    // 전봇대: 가까운 면이 차 안쪽 면에서 F
    add({ kind: 'solid', tag: 'pole', poly: octagon(cx, p.inner - p.side * (F + POLE_R), POLE_R), hMin: 0, hMax: POLE_H });
  });

  return {
    kind: 'alley',
    elements: els,
    start: { x: START_GAP + spec.rearOverhang, y: parked[0].yc, heading: 0 },
    goal: { kind: 'zone', rect: rectFromAabb(z0, -hw, z0 + zoneLen, hw, 0), maxAngleDeg: 30 },
    bounds: boundsOf(els, 1.0),
    // 야외라 천장·조명은 그리지 않는다. 값은 가장 높은 요소(전봇대) 높이로 둔다
    ceilingHeight: POLE_H,
    floor: [{ poly: aabbRect(0, -hw, xEnd, hw), tone: 'road' }],
    lamps: [],
    outdoor: true,
    scorePar: { moves: 0, gapFull: 0.2 },
  };
}
