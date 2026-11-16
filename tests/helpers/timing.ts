import { initialState, updateSpeed, type VehicleState } from '../../src/sim/vehicle';

// 구간 시간 1D 복제 (D8 속도 상한의 시간 기준 가드, .dev/v4-design-controls.md §7).
// main.ts:676-677의 지금 페달 처리를 그대로 옮긴 것이다: 가속 키를 누르는 동안 throttle이 0.8/s로 1까지 오르고,
// 떼면 바로 정확히 0. 브레이크는 쓰지 않는다 (approach(0, 0, 6, dt)라 0 그대로).
// 다음 단계에서 vehicle.ts에 pedalStep이 생기면 이 복제 대신 pedalStep을 쓰도록 바꿔야 한다.

/** main.ts DT */
const DT = 1 / 60;
/** vehicle.ts HOLD_DECEL (m/s², 추정값). 바꾸면 여기도 바꾼다. */
const HOLD = 2.0;

/**
 * 정지 상태에서 기어 D로 거리 L(m, 뒤축이 지나는 경로 길이)을 가는 데 걸리는 시간(초). 조향은 보지 않는다.
 * 시간은 AttemptTracker처럼 처음으로 v > 0인 스텝부터 세고, 끝나는 스텝도 센다.
 * - endMoving = true: 구역 목표는 움직이는 채로 성공하므로 가속 키를 끝까지 누르고, 지난 거리가 L에 이른 스텝에서 끝난다.
 *   (아래처럼 떼고 서면 L 바로 앞에서 서서 L에 이르지 못할 수 있다.)
 * - endMoving = false: 남은 거리가 HOLD 제동 거리 v²/(2·2.0) 이하가 되면 가속 키를 떼고, 속도가 0이 된 스텝에서 끝난다.
 *   스텝 단위로 떼고 스텝 적분의 제동 거리가 v²/(2·2.0)와 조금 달라 L에서 약 1 cm 안(앞 또는 뒤)에서 서지만, 시간 차이는 한 스텝 안팎이다.
 */
export function legTime(L: number, endMoving: boolean): number {
  const s: VehicleState = { ...initialState(0, 0, 0), gear: 'D' };
  let throttle = 0;
  let released = false;
  let x = 0;
  let t = 0;
  let started = false;
  for (let i = 0; i < 1e6; i++) {
    if (!endMoving && L - x <= (s.speed * s.speed) / (2 * HOLD)) released = true;
    // main.ts: throttle = input.accel ? approach(throttle, 1, 0.8, dt) : 0 (throttle ≤ 1이라 min과 같다)
    throttle = released ? 0 : Math.min(1, throttle + 0.8 * DT);
    s.speed = updateSpeed(s, { throttle, brake: 0, steer: 0 }, DT);
    x += s.speed * DT;
    if (s.speed > 0) started = true;
    if (started) t += DT;
    if (endMoving ? x >= L : released && s.speed === 0) return t;
  }
  throw new Error(`legTime: ${L} m 구간이 끝나지 않음`);
}
