import { HOLD_DECEL, initialState, pedalStep, updateSpeed, type VehicleState } from '../../src/sim/vehicle';

// 구간 시간 1D 복제 (속도 상한의 시간 기준 가드, 계약서 개정 2026-11-16 controls).
// 페달 값은 main.ts step()처럼 pedalStep으로 만든다: 가속 키를 누르는 동안 throttle이 0.8/s로 1까지 오르고,
// 떼면 바로 정확히 0. 브레이크는 밟지 않는다 (0 그대로).

/** main.ts DT (main.ts는 three·DOM을 불러와 테스트에서 import하지 않는다) */
const DT = 1 / 60;

/**
 * 정지 상태에서 기어 D로 거리 L(m, 뒤축이 지나는 경로 길이)을 가는 데 걸리는 시간(초). 조향은 보지 않는다.
 * 시간은 AttemptTracker처럼 처음으로 v > 0인 스텝부터 세고, 끝나는 스텝도 센다.
 * - endMoving = true: 구역 목표는 움직이는 채로 성공하므로 가속 키를 끝까지 누르고, 지난 거리가 L에 이른 스텝에서 끝난다.
 *   (아래처럼 떼고 서면 L 바로 앞에서 서서 L에 이르지 못할 수 있다.)
 * - endMoving = false: 남은 거리가 HOLD 제동 거리 v²/(2·HOLD_DECEL) 이하가 되면 가속 키를 떼고, 속도가 0이 된 스텝에서 끝난다.
 *   스텝 단위로 떼고 스텝 적분의 제동 거리가 v²/(2·HOLD_DECEL)와 조금 달라 정확히 L이 아니라 L − 1.2 cm ~ L + 3.7 cm에서 선다
 *   (가장 많이 지나치는 곳은 다 가속하기 전에 떼는 1 m 안팎의 짧은 구간, tests/timing.test.ts가 이 범위를 고정한다).
 */
export function legTime(L: number, endMoving: boolean): number {
  return legRun(L, endMoving).t;
}

/** legTime과 같은 1D 복제의 끝 상태: 걸린 시간 t (초), 지난 거리 x (m), 끝 속도 v (m/s) */
export function legRun(L: number, endMoving: boolean): { t: number; x: number; v: number } {
  const s: VehicleState = { ...initialState(0, 0, 0), gear: 'D' };
  let throttle = 0;
  let brake = 0;
  let released = false;
  let x = 0;
  let t = 0;
  let started = false;
  for (let i = 0; i < 1e6; i++) {
    if (!endMoving && L - x <= (s.speed * s.speed) / (2 * HOLD_DECEL)) released = true;
    ({ throttle, brake } = pedalStep(throttle, brake, !released, false, DT));
    s.speed = updateSpeed(s, { throttle, brake, steer: 0 }, DT);
    x += s.speed * DT;
    if (s.speed > 0) started = true;
    if (started) t += DT;
    if (endMoving ? x >= L : released && s.speed === 0) return { t, x, v: s.speed };
  }
  throw new Error(`legTime: ${L} m 구간이 끝나지 않음`);
}
