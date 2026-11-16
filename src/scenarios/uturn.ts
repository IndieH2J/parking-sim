import { buildFootprint } from '../sim/footprint';
import { aabbRect } from '../sim/geometry';
import { rectFromAabb } from '../sim/goal';
import type { VehicleSpec } from '../sim/specs';
import { maxSteerAngle } from '../sim/vehicle';
import type { WorldElement } from '../sim/world';
import type { Scenario } from './types';
import { boundsOf, CEILING, elementAdder, WALL_T } from './common';

/**
 * 막다른 골목 유턴 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C3). 야외, 옵션 없음, 크기는 차에 맞춘다.
 *
 * 좌표 (월드): 막다른 벽면 x = 0, 골목은 서쪽(−x)으로 열려 있다. 옆 벽면 y = ±Wu/2.
 * - 폭 Wu = d_f + d_r + 0.50 + E·R (uturnWidth). d_f·d_r = 뒤축 중심에서 가장 먼 차체·미러 꼭짓점까지 거리 (앞쪽·뒤쪽),
 *   R = 뒤축 최소 회전 반경. E는 11대 모두 3점 회전(전진·후진·전진, 전환 2번)으로 돌 수 있게 보정한 값이다 (UTURN_E).
 * - 출발: 동쪽(heading 0)을 보고 오른쪽(남쪽)에 붙어 선다. 남쪽 벽면에서 차체까지 0.55 m, 앞범퍼가 막다른 벽면에서 R + 2.0 m.
 * - 출구 구역: 서쪽(heading π) 30°, 출발 뒷범퍼에서 2 m 서쪽부터 zoneLen = max(5, 전장 + 1) m, 폭 전체.
 * - 서쪽 끝 벽: 구역 너머 4 m. 이 벽이 없으면 후진으로 빠져나간 차(heading 0)는 성공하지 않은 채 골목 밖으로 나간다.
 */

/**
 * 폭 계수 E = 0.49 + 0.03. 0.49는 탐욕 K턴(전진 왼쪽 끝까지 → 후진 오른쪽 끝까지 → … 다리마다 여유 0.22 m 앞에서 멈춤,
 * heading π가 되면 서쪽으로 추종, tests/uturn.test.ts)이 11대(프리셋 8 + 극단 3) 모두 전환 2번 이하·최소 여유 0.20 m 이상으로
 * 끝나는 가장 작은 값이다 (0.01 간격 보정, WIDE_SWING이 정함. 0.001 간격으로는 0.484). 0.49~0.91은 11대 모두 통과한다.
 * 설계 추정값 0.55는 모델 Y 8.07 m, 이 값은 7.94 m.
 */
export const UTURN_E = 0.52;
/** 폭 여유 (양쪽 0.25 m씩) */
const MARGIN = 0.5;
/** 옆 벽 높이 (야외 담장) */
const WALL_H = 2.0;
/** 출발: 남쪽 벽면 → 차체 오른쪽 */
const START_SIDE = 0.55;
/** 출발: 앞범퍼 → 막다른 벽면 = R + 이 값 */
const START_FRONT = 2.0;
/** 출발 뒷범퍼 → 출구 구역 동쪽 끝 */
const ZONE_GAP = 2;
/** 출구 구역 서쪽 끝 → 서쪽 끝 벽면 */
const END_ROOM = 4;

/** 뒤축 중심의 최소 회전 반경 (m) */
const turnRadius = (spec: VehicleSpec) => spec.wheelbase / Math.tan(maxSteerAngle(spec));

/** 골목 폭 Wu (벽면~벽면, m) = d_f + d_r + 0.50 + E·R */
export function uturnWidth(spec: VehicleSpec): number {
  const fp = buildFootprint(spec);
  let df = 0;
  let dr = 0;
  for (const p of [...fp.body.poly, ...fp.mirrorLeft.poly, ...fp.mirrorRight.poly]) {
    const r = Math.hypot(p.x, p.y);
    if (p.x >= 0) df = Math.max(df, r);
    else dr = Math.max(dr, r);
  }
  return df + dr + MARGIN + UTURN_E * turnRadius(spec);
}

export function buildUturn(spec: VehicleSpec): Scenario {
  const hw = uturnWidth(spec) / 2;
  const R = turnRadius(spec);
  const start = { x: -(R + START_FRONT) - (spec.wheelbase + spec.frontOverhang), y: -hw + START_SIDE + spec.width / 2, heading: 0 };
  const zoneLen = Math.max(5, spec.length + 1); // 출구 구역 길이: 차 길이 + 1 m (최소 5 m)
  const zx1 = start.x - spec.rearOverhang - ZONE_GAP; // 구역 동쪽 끝
  const zx0 = zx1 - zoneLen; // 구역 서쪽 끝
  const xW = zx0 - END_ROOM; // 서쪽 끝 벽면

  const elements: WorldElement[] = [];
  const add = elementAdder(elements);
  const wall = (x0: number, y0: number, x1: number, y1: number) =>
    add({ kind: 'solid', tag: 'wall', poly: aabbRect(x0, y0, x1, y1), hMin: 0, hMax: WALL_H });
  wall(xW - WALL_T, -hw - WALL_T, WALL_T, -hw); // 남
  wall(xW - WALL_T, hw, WALL_T, hw + WALL_T); // 북
  wall(0, -hw, WALL_T, hw); // 동: 막다른 벽
  wall(xW - WALL_T, -hw, xW, hw); // 서: 끝 벽

  return {
    kind: 'uturn',
    elements,
    start,
    // 출구 구역: 요구 방향 서쪽(π), 30°, 벽면~벽면
    goal: { kind: 'zone', rect: rectFromAabb(zx0, -hw, zx1, hw, Math.PI), maxAngleDeg: 30 },
    bounds: boundsOf(elements, 1.0),
    // 야외라 천장은 그리지 않는다 (outdoor). 타입상 필요한 값이라 차고 높이를 둔다
    ceilingHeight: CEILING,
    floor: [{ poly: aabbRect(xW, -hw, 0, hw), tone: 'road' }],
    lamps: [],
    outdoor: true,
    // 전환 기준 2번 (3점 회전), gap 만점 0.20 m
    scorePar: { moves: 2, gapFull: 0.2 },
  };
}
