import type { Pose, Vec2 } from './geometry';
import { toWorld } from './geometry';
import type { VehicleSpec } from './specs';
import type { GhostAlign } from './vehicles';
import { eyeLocal } from './driver';

// 고스트 비교 (계약서 §4): 이전 차(고스트)를 주 차량과 같은 방향으로 겹쳐 놓는다.

/**
 * 고스트 뒤축 위치 (주 차량 틀: 주 차량 뒤축 원점, +x 전방, +y 왼쪽).
 * - 'rearAxle': 두 뒤축이 겹친다 → (0, 0).
 * - 'driver': 평면도에서 두 차의 눈이 겹친다 → 주 차량 눈 − 고스트 눈.
 *   기준 운전자(키 175 cm, 시트 0)로 잰다. 키·시트 조절은 두 차의 눈을 똑같이 옮기므로(driver.ts) 결과는 같다.
 */
export function ghostOffset(main: VehicleSpec, ghost: VehicleSpec, align: GhostAlign): Vec2 {
  if (align === 'rearAxle') return { x: 0, y: 0 };
  const eM = eyeLocal(main, 175, 0, 0);
  const eG = eyeLocal(ghost, 175, 0, 0);
  return { x: eM.x - eG.x, y: eM.y - eG.y };
}

/** 고스트 자세 (고스트 뒤축 기준). 방향은 주 차량과 같다. */
export function ghostPose(main: VehicleSpec, ghost: VehicleSpec, pose: Pose, align: GhostAlign): Pose {
  const p = toWorld(ghostOffset(main, ghost, align), pose);
  return { x: p.x, y: p.y, heading: pose.heading };
}
