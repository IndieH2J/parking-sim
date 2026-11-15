// 차량 제원. 모든 길이 단위는 m.
// 좌표계(차량 로컬): 원점 = 뒤축 중심, +x = 전방, +y = 왼쪽, h = 지면 위 높이.

export interface VehicleSpec {
  id: string;
  name: { ko: string; en: string };
  length: number;
  width: number; // 차체 폭(미러 제외)
  widthMirrors: number; // 미러 펼친 폭
  height: number;
  wheelbase: number;
  frontOverhang: number;
  rearOverhang: number;
  trackFront: number;
  trackRear: number;
  groundClearance: number;
  turningDiameter: number; // 최소 회전 직경(curb-to-curb, 바깥 앞타이어 외곽 기준)
  tireWidth: number;
  tireDiameter: number;
  // ---- 이하 공개 자료가 없어 추정한 값. 설정에서 조절 가능하게 노출한다. ----
  mirror: {
    xFront: number; // 미러 하우징 앞 끝(뒤축 기준 x)
    xRear: number; // 미러 하우징 뒤 끝 (유리면 위치)
    yInner: number; // 하우징 안쪽 끝(차 중심선 기준 |y|)
    hBottom: number;
    hTop: number;
  };
  eye: {
    fromFront: number; // 앞범퍼에서 눈까지 뒤쪽 거리 (키 175cm 기준)
    lateral: number; // 차 중심선에서 왼쪽으로 (좌핸들)
    height: number; // 지면에서 눈 높이
  };
  steeringTurnsLockToLock: number;
}

/**
 * 테슬라 모델 Y (Juniper, 2025~)
 * 출처:
 *  - https://www.auto-data.net/en/tesla-model-y-juniper-facelift-2025-long-range-79-kwh-440hp-dual-motor-awd-53766
 *    (전장 4790, 전폭 1920, 미러 접힘 1982, 미러 포함 2129, 전고 1624, 축거 2890,
 *     앞/뒤 오버행 889/1011, 윤거 1636/1636, 지상고 167, 회전 직경 12.13 m, 255/45 R19)
 *  - https://www.carexpert.co.nz/tesla/model-y/2025/premium-rear-wheel-drive/exterior-and-dimensions
 *    (교차 확인. 회전 직경은 12.1 m로 표기)
 * 해외 시장 기준 수치이며 한국 출시 사양과 동일한지는 확인하지 못했다.
 */
export const MODEL_Y_2025: VehicleSpec = {
  id: 'model-y-2025',
  name: { ko: '테슬라 모델 Y (2025)', en: 'Tesla Model Y (2025)' },
  length: 4.79,
  width: 1.92,
  widthMirrors: 2.129,
  height: 1.624,
  wheelbase: 2.89,
  frontOverhang: 0.889,
  rearOverhang: 1.011,
  trackFront: 1.636,
  trackRear: 1.636,
  groundClearance: 0.167,
  turningDiameter: 12.13,
  tireWidth: 0.255,
  tireDiameter: 0.712, // 255/45 R19: 19*0.0254 + 2*0.255*0.45
  // 추정값: 미러는 A필러 하단(카울) 바로 뒤, 차체에서 0.1 m 남짓 돌출
  mirror: { xFront: 2.3, xRear: 2.12, yInner: 0.86, hBottom: 0.97, hTop: 1.12 },
  // 추정값: 눈 높이 약 1.2 m, 중심선 왼쪽 0.37 m, 앞범퍼에서 2.25 m 뒤
  eye: { fromFront: 2.25, lateral: 0.37, height: 1.2 },
  // 추정값
  steeringTurnsLockToLock: 2.5,
};

export const DEFAULT_SPEC = MODEL_Y_2025;
