import type { Pose } from '../sim/geometry';
import { aabbRect, rect } from '../sim/geometry';
import type { WorldElement } from '../sim/world';
import { rectFromAabb } from '../sim/goal';
import type { FloorPatch, PerpOptions, Scenario } from './types';
import {
  CEILING,
  elementAdder,
  LINE_WIDTH,
  lineEl,
  mulberry32,
  PARKED_COLORS,
  parkedCar,
  parkedCarDims,
  PILLAR,
  WALL_T,
} from './common';

/**
 * 지하주차장 직각 주차. 차고(buildGarage)는 후면·전면 직각이 함께 쓴다.
 *
 * 월드 좌표: 통로가 x축을 따라 놓이고(y = 0 ~ -AISLE), 북쪽(y > 0) 열이 목표 열이다.
 * 주차칸 폭은 라인 중심 간 거리. 기둥 사이에 3칸씩 묶인다.
 *
 * 차로 너비 6.0 m: 주차장법 시행규칙 제6조제1항제3호나목2) 직각주차 최소값 (law.go.kr 원문 확인, 계약서 §B).
 */

export interface GarageConfig {
  /** 뒷선 중심 → 모든 휠스톱의 통로 쪽 면 (m). null = 휠스톱 없음 */
  stopFromBack: number | null;
}

export interface Garage {
  elements: WorldElement[];
  bounds: Scenario['bounds'];
  ceilingHeight: number;
  floor: FloorPatch[];
  lamps: Pose[];
  /** 목표 칸 (라인 중심). 칸은 y ∈ [0, slotLen] (북쪽 열) */
  target: { x0: number; x1: number; slotLen: number };
  /** x0 + lw/2 .. x1 − lw/2, y 0 .. slotLen + lw/2 (뒤 경계 = 뒷선 바깥 가장자리) */
  inner: { x0: number; x1: number; y0: number; y1: number };
}

export const AISLE = 6.0;
/** 후면 주차 휠스톱: 통로 쪽 면이 뒷선에서 0.8 m. 모델 Y가 닿으면 뒤범퍼가 뒷선 안쪽 약 0.15 m에 온다. */
export const REAR_STOP_FROM_BACK = 0.8;
export { LINE_WIDTH } from './common';

const SLOTS_PER_GROUP = 3;
const GROUPS = 3;

export function buildGarage(opt: PerpOptions, cfg: GarageConfig): Garage {
  const rnd = mulberry32(opt.seed ?? 7);
  const W = opt.slotWidth;
  const slotLen = W >= 2.6 ? 5.2 : 5.0;
  const lw = LINE_WIDTH;
  const els: WorldElement[] = [];
  const add = elementAdder(els);

  // 칸 x 좌표 계산: [기둥][3칸][기둥][3칸][기둥][3칸][기둥]
  const slotXs: { x0: number; x1: number; group: number; idx: number }[] = [];
  const pillarXs: number[] = [];
  let x = 0;
  for (let g = 0; g < GROUPS; g++) {
    pillarXs.push(x);
    x += PILLAR;
    for (let s = 0; s < SLOTS_PER_GROUP; s++) {
      slotXs.push({ x0: x, x1: x + W, group: g, idx: s });
      x += W;
    }
  }
  pillarXs.push(x);
  const rowEnd = x + PILLAR;
  const xMin = -PILLAR - 6;
  const xMax = rowEnd + 6;

  // 목표 칸: 가운데 묶음의 가운데 칸(양옆 차량) 또는 첫 칸(왼쪽이 기둥)
  const targetIdx = SLOTS_PER_GROUP * 1 + (opt.target === 'pillar' ? 0 : 1);

  for (const side of [1, -1] as const) {
    // side 1: 북쪽 열(y 0 → slotLen), side -1: 남쪽 열(y -AISLE → -AISLE - slotLen)
    const yFront = side === 1 ? 0 : -AISLE;
    const yBack = yFront + side * slotLen;
    const ys = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;

    // 기둥: 통로 쪽 앞부분에 위치
    for (const px of pillarXs) {
      const [y0, y1] = ys(yFront + side * 0.1, yFront + side * (0.1 + PILLAR));
      add({ kind: 'solid', tag: 'pillar', poly: aabbRect(px, y0, px + PILLAR, y1), hMin: 0, hMax: CEILING });
    }
    // 뒷벽
    {
      const [y0, y1] = ys(yBack + side * 0.3, yBack + side * (0.3 + WALL_T));
      add({ kind: 'solid', tag: 'wall', poly: aabbRect(xMin, y0, xMax, y1), hMin: 0, hMax: CEILING });
    }
    // 주차선: 각 칸 좌우 선 + 뒷선 (ㄷ자)
    const lineXs = new Set<number>();
    for (const s of slotXs) {
      lineXs.add(+s.x0.toFixed(4));
      lineXs.add(+s.x1.toFixed(4));
    }
    const [ly0, ly1] = ys(yFront, yBack);
    for (const lx of lineXs) add(lineEl(aabbRect(lx - lw / 2, ly0, lx + lw / 2, ly1), Math.PI / 2));
    for (const s of slotXs) {
      const [y0, y1] = ys(yBack - (side * lw) / 2, yBack + (side * lw) / 2);
      add(lineEl(aabbRect(s.x0, y0, s.x1, y1), 0));
    }

    slotXs.forEach((s, i) => {
      const cx = (s.x0 + s.x1) / 2;
      // 휠스톱 (깊이 0.15 m): 통로 쪽 면이 뒷선 중심에서 stopFromBack
      if (cfg.stopFromBack !== null) {
        const stopY = yBack - side * (cfg.stopFromBack - 0.075);
        for (const dx of [-0.6, 0.6]) {
          add({ kind: 'wheelStop', poly: rect(cx + dx, stopY, 0.5, 0.15), hMin: 0, hMax: 0.12 });
        }
      }
      const isTarget = side === 1 && i === targetIdx;
      // 반대편 열은 몇 칸 비워 둔다
      const empty = isTarget || (side === -1 && rnd() < 0.25);
      if (empty) return;
      const d = parkedCarDims(rnd);
      const noseOut = rnd() < 0.7; // 대부분 후면 주차
      const back = yBack - side * 0.2; // 차 뒤끝(또는 앞끝)이 칸 끝에서 0.2 m
      const cy = back - side * (d.length / 2);
      const offX = (rnd() - 0.5) * 0.3;
      const ang = (rnd() - 0.5) * 0.05;
      const heading = (side === 1 ? -Math.PI / 2 : Math.PI / 2) + (noseOut ? 0 : Math.PI) + ang;
      const color = PARKED_COLORS[Math.floor(rnd() * PARKED_COLORS.length)];
      add(parkedCar(cx + offX, cy, heading, d, color));
    });
  }

  // 통로 양 끝 벽 (남북 뒷벽 사이를 막는다)
  const y0 = -AISLE - slotLen - 0.3 - WALL_T;
  const y1 = slotLen + 0.3 + WALL_T;
  add({ kind: 'solid', tag: 'wall', poly: aabbRect(xMin, y0, xMin + WALL_T, y1), hMin: 0, hMax: CEILING });
  add({ kind: 'solid', tag: 'wall', poly: aabbRect(xMax - WALL_T, y0, xMax, y1), hMin: 0, hMax: CEILING });

  // 천장 조명줄 (v1 scene.ts의 배치)
  const lamps: Pose[] = [];
  for (let lx = xMin + 2; lx < xMax - 1; lx += 3) {
    for (const ly of [-1.5, -4.5, 2.5, -8.5]) lamps.push({ x: lx, y: ly, heading: 0 });
  }

  const t = slotXs[targetIdx];
  return {
    elements: els,
    bounds: { x0: xMin, x1: xMax, y0, y1 },
    ceilingHeight: CEILING,
    floor: [{ poly: aabbRect(xMin, -AISLE, xMax, 0), tone: 'aisle' }],
    lamps,
    target: { x0: t.x0, x1: t.x1, slotLen },
    inner: { x0: t.x0 + lw / 2, x1: t.x1 - lw / 2, y0: 0, y1: slotLen + lw / 2 },
  };
}

/** 후면 직각 주차: 뒤로 넣어야 성공 (v1은 방향을 보지 않았다). */
export function buildRearPerpendicular(opt: PerpOptions): Scenario {
  const g = buildGarage(opt, { stopFromBack: REAR_STOP_FROM_BACK });
  const { target: t, inner } = g;
  return {
    kind: 'rearPerp',
    elements: g.elements,
    // 출발: 목표 칸을 지나기 전, 통로 중앙에서 동쪽을 향함 (v1과 같음)
    start: { x: (t.x0 + t.x1) / 2 - 9, y: -AISLE / 2, heading: 0 },
    // 요구 방향 −π/2 (앞이 통로 쪽). 옆 = 선 안쪽 가장자리, 입구 = y 0, 뒤 = 뒷선 바깥 가장자리
    goal: { kind: 'slot', rect: rectFromAabb(inner.x0, inner.y0, inner.x1, inner.y1, -Math.PI / 2), maxAngleDeg: 15 },
    bounds: g.bounds,
    ceilingHeight: g.ceilingHeight,
    floor: g.floor,
    lamps: g.lamps,
  };
}
