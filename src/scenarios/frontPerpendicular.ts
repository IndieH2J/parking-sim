import { rectFromAabb } from '../sim/goal';
import type { PerpOptions, Scenario } from './types';
import { AISLE, buildGarage } from './rearPerpendicular';

/**
 * 전면 직각 주차 (계약서 §1.8.2). 후면 직각과 같은 차고에 앞으로 넣는다.
 * 목표 칸·주차 차량·기둥 배치는 후면 직각과 같고 휠스톱 위치만 다르다.
 */

/**
 * 전면 주차 휠스톱: 통로 쪽 면이 뒷선 중심에서 0.60 m.
 * 후면용 0.8 m면 앞바퀴가 너무 일찍 걸려 모델 Y 뒤범퍼가 5.0 m 칸 밖으로 5.7 cm 나온다.
 * 0.60 m면 5.0 m 칸에서 앞축 위치 허용 폭이 모델 Y 14.3 cm, 가장 좁은 K5 약 10.35 cm (tests/frontPerpendicular.test.ts).
 */
export const FRONT_STOP_FROM_BACK = 0.6;

export function buildFrontPerpendicular(opt: PerpOptions): Scenario {
  const g = buildGarage(opt, { stopFromBack: FRONT_STOP_FROM_BACK });
  const { target: t, inner } = g;
  return {
    kind: 'frontPerp',
    elements: g.elements,
    // 출발: 후면 직각과 같은 자리 (목표 칸을 지나기 전, 통로 중앙에서 동쪽을 향함)
    start: { x: (t.x0 + t.x1) / 2 - 9, y: -AISLE / 2, heading: 0 },
    // 요구 방향 +π/2 (앞이 뒷벽 쪽). 옆 = 선 안쪽 가장자리, 입구 = y 0, 안쪽 = 뒷선 바깥 가장자리
    goal: { kind: 'slot', rect: rectFromAabb(inner.x0, inner.y0, inner.x1, inner.y1, Math.PI / 2), maxAngleDeg: 15 },
    bounds: g.bounds,
    ceilingHeight: g.ceilingHeight,
    floor: g.floor,
    lamps: g.lamps,
  };
}
