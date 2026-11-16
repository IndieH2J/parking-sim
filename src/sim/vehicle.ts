import type { Pose } from './geometry';
import type { VehicleSpec } from './specs';

export type Gear = 'P' | 'R' | 'N' | 'D';

export interface VehicleState {
  x: number; // 뒤축 중심 (월드)
  y: number;
  heading: number;
  speed: number; // m/s, 전진 +, 후진 -
  steer: number; // 정규화 조향 -1..1 (+ = 왼쪽)
  gear: Gear;
}

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // 목표 정규화 조향 -1..1
}

// 주차 상황용 단순 종방향 모델 파라미터 (체감용 근사값)
const MAX_ACCEL = 2.5; // m/s²
const MAX_BRAKE = 6.0; // m/s²
const ROLL_DECEL = 0.25; // m/s²
// 추정값. 테슬라의 'Hold' 정지 모드에 빗댄 것(가속 페달을 떼면 회생제동으로 멈추고 정지를 유지) — 실측값이 아니다.
const HOLD_DECEL = 2.0; // m/s², 기어 D/R에서 가속 페달을 뗐을 때
const MAX_FWD = 20 / 3.6;
const MAX_REV = 10 / 3.6;
const SHIFT_MAX_SPEED = 2.0; // 이 속도 이하에서만 변속 허용

/**
 * 회전 직경으로부터 최대 조향각(가상 중앙 앞바퀴 기준, 자전거 모델)을 역산한다.
 * 회전 직경은 바깥 앞타이어 외곽이 그리는 원 기준이다.
 */
export function maxSteerAngle(spec: VehicleSpec): number {
  const rOuter = spec.turningDiameter / 2;
  const off = spec.trackFront / 2 + spec.tireWidth / 2;
  const L = spec.wheelbase;
  const rRear = Math.sqrt(rOuter * rOuter - L * L) - off;
  return Math.atan(L / rRear);
}

/** 핸들 최대 회전각(rad, 한쪽 방향) */
export function maxWheelAngle(spec: VehicleSpec): number {
  return (spec.steeringTurnsLockToLock / 2) * Math.PI * 2;
}

export function initialState(x: number, y: number, heading: number): VehicleState {
  return { x, y, heading, speed: 0, steer: 0, gear: 'P' };
}

export function canShift(state: VehicleState): boolean {
  return Math.abs(state.speed) <= SHIFT_MAX_SPEED;
}

/** 종방향 속도 갱신 */
export function updateSpeed(state: VehicleState, c: Controls, dt: number): number {
  let v = state.speed;
  if (state.gear === 'P') return 0;
  const dir = state.gear === 'D' ? 1 : state.gear === 'R' ? -1 : 0;
  let a = 0;
  let drag = ROLL_DECEL;
  if (dir !== 0) {
    a += dir * c.throttle * MAX_ACCEL;
    // 크리프 없음: 가속 페달을 밟지 않으면 출발하지 않고, 떼면 구름저항 대신 HOLD_DECEL로 멈춘 뒤 정지를 유지한다.
    if (c.throttle === 0) drag = HOLD_DECEL;
  }
  // 브레이크·구름저항(또는 HOLD_DECEL)은 기어 방향이 아니라 실제 진행 방향 반대로, 속도를 0 너머로 넘기지 않는다.
  const resist = c.brake * MAX_BRAKE + drag;
  const vNew = v + a * dt;
  if (vNew > 0) v = Math.max(0, vNew - resist * dt);
  else if (vNew < 0) v = Math.min(0, vNew + resist * dt);
  else v = 0;
  return Math.max(-MAX_REV, Math.min(MAX_FWD, v));
}

/** 자전거 모델의 정확한 원호 적분으로 위치를 이동한 새 상태를 돌려준다. */
export function integratePose(
  state: Pose,
  spec: VehicleSpec,
  steerNorm: number,
  speed: number,
  dt: number,
): { x: number; y: number; heading: number } {
  const delta = steerNorm * maxSteerAngle(spec);
  const ds = speed * dt;
  const k = Math.tan(delta) / spec.wheelbase; // 곡률
  const th = state.heading;
  if (Math.abs(k) < 1e-9) {
    return { x: state.x + ds * Math.cos(th), y: state.y + ds * Math.sin(th), heading: th };
  }
  const R = 1 / k;
  const th2 = th + ds * k;
  return {
    x: state.x + R * (Math.sin(th2) - Math.sin(th)),
    y: state.y - R * (Math.cos(th2) - Math.cos(th)),
    heading: th2,
  };
}

/** 키보드처럼 목표 조향으로 일정 속도로 따라가는 경우 사용 (rad/s가 아닌 정규화 단위/s) */
export function approachSteer(current: number, target: number, ratePerSec: number, dt: number): number {
  const d = target - current;
  const step = ratePerSec * dt;
  if (Math.abs(d) <= step) return target;
  return current + Math.sign(d) * step;
}
