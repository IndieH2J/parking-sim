import type { Footprint } from './footprint';
import type { Pose } from './geometry';
import { toWorld } from './geometry';
import type { Goal, GoalEval } from './goal';
import { evaluateGoal } from './goal';
import type { VehicleSpec } from './specs';

// 발권기 앞 정차 판정 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C0·C4).
// 목표 종류는 slot이라 P로 바꿀 때 판정하지만, 차 전체가 아니라 운전석 창문(눈의 x)에서 잰다.
// 차로는 +x 방향이고 발권기는 차 왼쪽(+y)에 있다. 허용치는 추정값이다.

/** 창문(눈)과 발권기 중심의 앞뒤 차이 허용 (m) */
export const KIOSK_ALONG_MAX = 0.4;
/** 창문 쪽 차체에서 발권기 앞면까지 허용 거리 (m) */
export const KIOSK_REACH_MAX = 0.3;
/** 차로 방향과의 각도 오차 허용 (°) */
export const KIOSK_ANGLE_MAX = 10;

export type KioskEval = GoalEval & {
  /** 발권기 앞면 y − 창문 높이의 차체 왼쪽 옆면 y (m). 작을수록 가깝다 */
  reach: number;
  /** 눈 x − 발권기 중심 x (m). + = 창문이 발권기를 지남 */
  along: number;
};

/**
 * evaluateGoal의 margin·offset·angleErrDeg에 발권기 기준 판정을 더한다.
 * xe = 앞범퍼에서 눈까지 뒤쪽 거리로 구한 눈의 차량 x. W = 그 x의 왼쪽 옆면 점, E = 눈 점 (월드).
 * inside = |along| ≤ 0.40 && reach ≤ 0.30, headingOk = angleErrDeg ≤ 10, success = 둘 다.
 * goal은 화면 표시와 각도용 (rect.angle = 차로 방향).
 */
export function kioskEval(goal: Goal, fp: Footprint, spec: VehicleSpec, pose: Pose, k: { x: number; faceY: number }): KioskEval {
  const xe = spec.wheelbase + spec.frontOverhang - spec.eye.fromFront;
  const W = toWorld({ x: xe, y: spec.width / 2 }, pose);
  const E = toWorld({ x: xe, y: spec.eye.lateral }, pose);
  const reach = k.faceY - W.y;
  const along = E.x - k.x;
  const ev = evaluateGoal(goal, fp, pose);
  const inside = Math.abs(along) <= KIOSK_ALONG_MAX && reach <= KIOSK_REACH_MAX;
  const headingOk = ev.angleErrDeg <= KIOSK_ANGLE_MAX;
  return { ...ev, inside, headingOk, success: inside && headingOk, reach, along };
}
