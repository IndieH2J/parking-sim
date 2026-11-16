import type { Footprint } from './footprint';
import type { Pose } from './geometry';
import { polygonDistance, polyToWorld } from './geometry';
import type { WorldElement } from './world';
import { near } from './world';

// 장애물까지 여유 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C0). 골목·유턴의 gap 점수와 해결 가능성 테스트가 쓴다.

/** 뒤축 중심에서 차 외곽까지 최대 거리 근사 (m). world.ts CAR_REACH, motion.ts REACH와 같은 값 */
const REACH = 6;

/**
 * 차체·양쪽 미러에서 solid까지 가장 가까운 평면 거리 (m), 최대 cap. 겹치면 0.
 * findCollision과 같은 규칙: solid만 보고(연석·휠스톱·선은 무시), 부품과 요소의 높이 범위가 겹칠 때만 잰다.
 * 뒤축에서 REACH + cap 밖의 요소는 near()로 거른다.
 */
export function clearance(fp: Footprint, pose: Pose, elements: WorldElement[], cap = 1): number {
  const parts = [fp.body, fp.mirrorLeft, fp.mirrorRight].map((p) => ({ ...p, poly: polyToWorld(p.poly, pose) }));
  let best = cap;
  for (const el of elements) {
    if (el.kind !== 'solid' || !near(el, pose, REACH + cap)) continue;
    for (const p of parts) {
      if (!(p.hMin < el.hMax && el.hMin < p.hMax)) continue;
      best = Math.min(best, polygonDistance(p.poly, el.poly));
      if (best === 0) return 0;
    }
  }
  return best;
}
