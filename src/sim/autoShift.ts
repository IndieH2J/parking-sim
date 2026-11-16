import type { Gear } from './vehicle';

// 키보드 자동 변속 (계약서 개정 2026-11-16 controls). main.ts step()이 페달 처리(pedalStep) 전에 부른다.
// 기어를 바꾸는 쪽은 main.ts다 (requestGear를 거치지 않는다: P 판정·변속 거부·토스트가 없다).

/** 키보드 운전 키: fwd = W·↑, rev = S·↓, brake = Space (터치 페달은 넣지 않는다) */
export interface DriveKeys {
  fwd: boolean;
  rev: boolean;
  brake: boolean;
}

/** 이번 스텝의 기어와 페달을 밟는지. 페달 값은 pedalStep이 램프로 만든다. */
export interface AutoShiftCmd {
  gear: Gear;
  throttle: boolean;
  brake: boolean;
}

/**
 * W·↑만 = 전진(D), S·↓만 = 후진(R), 둘 다 또는 둘 다 아님 = 방향 없음. 기어가 아니라 실제 속도의 부호로 판단한다.
 * - 방향 없음: 기어 그대로, 가속 없음, 브레이크 = Space 또는 W+S.
 * - 원하는 방향의 반대로 움직이는 중 (speed·want < 0): 기어 그대로, 가속 없음, 브레이크.
 *   가속이 0이면 updateSpeed가 속도를 정확히 0에서 세우므로 반드시 서고, 그다음 스텝에 아래 줄로 변속한다.
 * - 정지 (+0, −0) 또는 원하는 방향으로 움직이는 중: D 또는 R, 가속 = Space를 밟지 않았을 때, 브레이크 = Space.
 * P는 고르지 않는다: 출력이 P이면 입력도 P다 (주차를 끝낼 때는 1·P 키로 직접 바꾼다).
 */
export function autoShift(gear: Gear, speed: number, keys: DriveKeys): AutoShiftCmd {
  const want = keys.fwd === keys.rev ? 0 : keys.fwd ? 1 : -1;
  if (want === 0) return { gear, throttle: false, brake: keys.brake || (keys.fwd && keys.rev) };
  if (speed * want < 0) return { gear, throttle: false, brake: true };
  return { gear: want > 0 ? 'D' : 'R', throttle: !keys.brake, brake: keys.brake };
}
