import type { Pose } from '../sim/geometry';
import { aabbRect } from '../sim/geometry';
import type { WorldElement } from '../sim/world';
import { rectFromAabb } from '../sim/goal';
import type { FloorPatch, ParallelOptions, Scenario } from './types';
import {
  CEILING,
  elementAdder,
  LINE_WIDTH,
  lineEl,
  mulberry32,
  PARKED_COLORS,
  parkedCar,
  parkedCarDims,
  WALL_T,
} from './common';

/**
 * 평행 주차: 지하주차장 벽면을 따라 보행통로와 연석이 있고, 그 옆에 평행 주차 열과 차로가 있다 (계약서 §1.8.3).
 *
 * 월드 좌표: 연석면 y = 0, 주차 열 y 0 ~ SLOT_W (+ 선 폭 절반), 차로 y SLOT_W ~ SLOT_W + AISLE_W.
 * 차는 +x(동쪽)로 다니므로 칸은 운전자 오른쪽에 있다.
 * 칸 길이 L = opt.slotLength. 칸 k는 x ∈ [k·L, (k+1)·L] (가로선 중심), 목표는 가운데 칸(TARGET_SLOT).
 */

/** 평행주차형식 일반형 2.0 × 6.0 (주차장법 시행규칙 제3조제1항제1호): 연석면 → 차로 쪽 선 중심 */
export const SLOT_W = 2.0;
/** 차로 너비 5.0 m: 제6조제1항제3호나목2) 평행주차, 출입구 1개 (3.3 m는 출입구 2개 이상, 계약서 §B) */
export const AISLE_W = 5.0;
const N_SLOTS = 5;
const TARGET_SLOT = 2;
/** 연석: 깊이(y) 0.15 m, 높이 0.15 m, 연회색 */
const CURB_W = 0.15;
const CURB_H = 0.15;
const CURB_COLOR = 0xc8c8c8;
/** 보행통로 쪽 벽면 y (보행통로 = 연석 바깥 ~ 벽, 바닥 높이 = 연석 높이) */
const WALKWAY_WALL_Y = -1.5;
/** 이웃 차: 오른쪽 면 ↔ 연석면, 목표 칸 쪽 범퍼 ↔ 칸 선 바깥 가장자리 */
const NEIGHBOUR_CURB_GAP = 0.15;
const NEIGHBOUR_LINE_GAP = 0.1;
/** 서쪽 끝 벽 바깥면, 마지막 칸 끝 → 동쪽 끝 벽 바깥면 */
const X_MIN = -6;
const END_RUN = 8;

export function buildParallel(opt: ParallelOptions): Scenario {
  const L = opt.slotLength;
  const lw = LINE_WIDTH;
  const rnd = mulberry32(opt.seed ?? 7);
  const xMin = X_MIN;
  const xMax = N_SLOTS * L + END_RUN;
  const yLane = SLOT_W; // 차로 쪽 선 중심 = 차로 시작
  const yFar = SLOT_W + AISLE_W; // 맞은편 벽면
  const yBack = WALKWAY_WALL_Y - WALL_T; // 보행통로 쪽 벽 바깥면
  const els: WorldElement[] = [];
  const add = elementAdder(els);

  // 벽: 보행통로 뒤, 차로 맞은편, 양 끝 (끝 벽은 xMin..xMax 안쪽, 직각 차고와 같은 방식)
  const wall = (x0: number, y0: number, x1: number, y1: number) =>
    add({ kind: 'solid', tag: 'wall', poly: aabbRect(x0, y0, x1, y1), hMin: 0, hMax: CEILING });
  wall(xMin, yBack, xMax, WALKWAY_WALL_Y);
  wall(xMin, yFar, xMax, yFar + WALL_T);
  wall(xMin, yBack, xMin + WALL_T, yFar + WALL_T);
  wall(xMax - WALL_T, yBack, xMax, yFar + WALL_T);

  // 연석: 바퀴만 막는다 (§1.7). dir 0 → 센서가 측면 거리(하늘색)로 잰다
  add({ kind: 'curb', poly: aabbRect(xMin, -CURB_W, xMax, 0), hMin: 0, hMax: CURB_H, dir: 0, meta: { color: CURB_COLOR } });

  // 주차선: 칸 경계 가로선 (연석면 → 차로 쪽 선 바깥 가장자리) + 차로 쪽 세로선 하나
  for (let k = 0; k <= N_SLOTS; k++) {
    add(lineEl(aabbRect(k * L - lw / 2, 0, k * L + lw / 2, yLane + lw / 2), Math.PI / 2));
  }
  add(lineEl(aabbRect(-lw / 2, yLane - lw / 2, N_SLOTS * L + lw / 2, yLane + lw / 2), 0));

  // 이웃 차 (모두 동쪽을 향함). 칸 순서대로 rnd(): 크기 3회, 색 1회.
  // 목표 칸 양옆은 목표 쪽 선에서 0.10 m에 범퍼를 두고(빈 길이 = L + lw + 0.20), 나머지는 칸 가운데.
  for (let k = 0; k < N_SLOTS; k++) {
    if (k === TARGET_SLOT) continue;
    const d = parkedCarDims(rnd);
    const color = PARKED_COLORS[Math.floor(rnd() * PARKED_COLORS.length)];
    let cx = (k + 0.5) * L;
    if (k === TARGET_SLOT - 1) cx = TARGET_SLOT * L - lw / 2 - NEIGHBOUR_LINE_GAP - d.length / 2;
    else if (k === TARGET_SLOT + 1) cx = (TARGET_SLOT + 1) * L + lw / 2 + NEIGHBOUR_LINE_GAP + d.length / 2;
    add(parkedCar(cx, NEIGHBOUR_CURB_GAP + d.width / 2, 0, d, color));
  }

  // 천장 조명: 주차 열 위와 차로 가운데, 3 m 간격
  const lamps: Pose[] = [];
  for (let lx = xMin + 2; lx < xMax - 1; lx += 3) {
    for (const ly of [1.0, yLane + AISLE_W / 2]) lamps.push({ x: lx, y: ly, heading: 0 });
  }

  const floor: FloorPatch[] = [
    { poly: aabbRect(xMin, yLane, xMax, yFar), tone: 'aisle' },
    // 보행통로: 연석 높이의 단 (시각 표현 전용, 요소 아님)
    { poly: aabbRect(xMin, WALKWAY_WALL_Y, xMax, -CURB_W), tone: 'walkway', h: CURB_H },
  ];

  return {
    kind: 'parallel',
    elements: els,
    // 출발: 목표 칸 9 m 뒤, 차로 가운데에서 동쪽을 향함
    start: { x: TARGET_SLOT * L - 9, y: yLane + AISLE_W / 2, heading: 0 },
    // 앞뒤 = 칸 선 안쪽 가장자리, 좌우 = 연석면 ~ 차로 쪽 선 바깥 가장자리 (선을 밟아도 칸 안). 요구 방향 0
    goal: {
      kind: 'slot',
      rect: rectFromAabb(TARGET_SLOT * L + lw / 2, 0, (TARGET_SLOT + 1) * L - lw / 2, yLane + lw / 2, 0),
      maxAngleDeg: 15,
    },
    bounds: { x0: xMin, x1: xMax, y0: yBack, y1: yFar + WALL_T },
    ceilingHeight: CEILING,
    floor,
    lamps,
  };
}
