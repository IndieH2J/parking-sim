import type { Vec2 } from '../sim/geometry';
import { rect } from '../sim/geometry';
import type { WorldElement } from '../sim/world';
import { prepare } from '../sim/world';
import type { Scenario } from './types';

// 시나리오 빌더 공용 도구 (계약서 §1.3). v1 rearPerpendicular.ts에서 뽑아냈다.
// rnd() 호출 순서가 v1과 같아야 한다 (배치 동일성 테스트, tests/goal.test.ts).

export const LINE_WIDTH = 0.15;
export const WALL_T = 0.3;
export const CEILING = 2.7;
/** 기둥 한 변 */
export const PILLAR = 0.8;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PARKED_COLORS: readonly number[] = [0x2b2f36, 0xd9dbde, 0x8a9099, 0x1f3b63, 0x6b1d1d, 0xf0f0f0, 0x44505c, 0x9aa3ad];

/** 주차 차량의 대략적인 크기 범위 (준중형~중형 SUV). rnd() 3회: 길이, 폭, 높이 (v1 순서) */
export function parkedCarDims(rnd: () => number): { length: number; width: number; height: number } {
  const length = 4.55 + rnd() * 0.4;
  const width = 1.8 + rnd() * 0.12;
  const height = 1.42 + rnd() * 0.3;
  return { length, width, height };
}

/** prepare()를 거쳐 list에 넣고 id `e${n}`을 붙이는 함수 (n = 넣기 전 list 길이) */
export function elementAdder(list: WorldElement[]): (e: Omit<WorldElement, 'id'>) => WorldElement {
  return (e) => {
    const el = prepare({ ...e, id: `e${list.length}` });
    list.push(el);
    return el;
  };
}

/** 주차 차량: solid, tag 'car', 렌더링용 meta (v1과 같은 키 순서) */
export function parkedCar(
  cx: number,
  cy: number,
  heading: number,
  d: { length: number; width: number; height: number },
  color: number,
): Omit<WorldElement, 'id'> {
  return {
    kind: 'solid',
    tag: 'car',
    poly: rect(cx, cy, d.length, d.width, heading),
    hMin: 0,
    hMax: d.height,
    meta: { cx, cy, heading, length: d.length, width: d.width, height: d.height, color },
  };
}

/** 바닥 선 (높이 0..0.003). dir = 선 방향 (센서가 평행 판정에 쓴다) */
export function lineEl(poly: Vec2[], dir: number): Omit<WorldElement, 'id'> {
  return { kind: 'line', poly, hMin: 0, hMax: 0.003, dir };
}

/** 모든 요소 꼭짓점의 외접 사각형 + pad */
export function boundsOf(elements: WorldElement[], pad: number): Scenario['bounds'] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const el of elements) {
    for (const p of el.poly) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  }
  return { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad };
}

/** 볼록 다각형인지 (테스트용). 꼭짓점 순서는 어느 방향이든 되고, 한 직선 위 꼭짓점은 허용한다. */
export function isConvex(poly: Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  let turn = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const c = poly[(i + 2) % n];
    const e1x = b.x - a.x;
    const e1y = b.y - a.y;
    const e2x = c.x - b.x;
    const e2y = c.y - b.y;
    const cross = e1x * e2y - e1y * e2x;
    if (Math.abs(cross) > 1e-12) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    turn += Math.atan2(cross, e1x * e2x + e1y * e2y);
  }
  // 같은 방향으로만 꺾여도 별 모양처럼 두 바퀴 도는 경우를 걸러낸다
  return sign !== 0 && Math.abs(Math.abs(turn) - 2 * Math.PI) < 1e-6;
}

// ---- 상황 추가 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C0). 위 함수들은 그대로 두고 덧붙이기만 한다 ----

/**
 * 정팔각형 (반시계, 볼록). r = 중심에서 각 변까지 거리라 같은 지름의 원을 감싼다:
 * x·y축에 수직인 변이 x = cx ± r, y = cy ± r에 놓이고, 꼭짓점은 중심에서 r / cos(π/8).
 */
export function octagon(cx: number, cy: number, r: number): Vec2[] {
  const R = r / Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, i) => {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });
}
