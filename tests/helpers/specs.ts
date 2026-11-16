import type { VehicleSpec } from '../../src/sim/specs';
import { CUSTOM_ID, getSpec, type CustomDims } from '../../src/sim/vehicles';
import { allSpecs } from './drive';

// 직접 입력 극단 치수 3종 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md A.6). tests/extremes.test.ts가 유효성을 확인한다.
// 증명 범위: 새 코스(골목·유턴·발권기)는 allSpecs() 8대 + 이 3종. 출차와 '옆 차 비뚤게'는 프리셋만 증명하고 이 3종은 출발 자세만 본다.
// 셋 다 spec.id가 'custom'이라 테스트 이름과 KNOWN_TIGHT의 vehicle에는 name을 쓴다.

/** 직접 입력 최대급 차 (tests/narrowRamp.test.ts·topView.test.ts의 OVERSIZED와 같은 값). 뒤축 회전 반경 R ≈ 5.40 m */
export const OVERSIZED_DIMS: CustomDims = {
  lengthMm: 6000,
  widthMm: 2200,
  widthMirrorsMm: 2600,
  heightMm: 2000,
  wheelbaseMm: 3800,
  frontOverhangMm: 1300,
  trackMm: 1900,
  turningDiameterM: 15.0,
};

/** 직접 입력 최소급 차: 모든 값이 입력 하한 (뒤 오버행 0.5 m, 미러 +50 mm, 최대 조향각 약 36°) */
export const UNDERSIZED_DIMS: CustomDims = {
  lengthMm: 3000,
  widthMm: 1400,
  widthMirrorsMm: 1450,
  heightMm: 1200,
  wheelbaseMm: 2000,
  frontOverhangMm: 500,
  trackMm: 1200,
  turningDiameterM: 8.0,
};

/** 가장 크게 도는 차: 최소 윤거에 회전 직경 15 m라 R ≈ 6.11 m (OVERSIZED보다 큼), 뒤 오버행 1.6 m (상한) */
export const WIDE_SWING_DIMS: CustomDims = {
  lengthMm: 6000,
  widthMm: 2200,
  widthMirrorsMm: 2600,
  heightMm: 2000,
  wheelbaseMm: 3100,
  frontOverhangMm: 1300,
  trackMm: 1200,
  turningDiameterM: 15.0,
};

export const OVERSIZED: VehicleSpec = getSpec(CUSTOM_ID, OVERSIZED_DIMS);
export const UNDERSIZED: VehicleSpec = getSpec(CUSTOM_ID, UNDERSIZED_DIMS);
export const WIDE_SWING: VehicleSpec = getSpec(CUSTOM_ID, WIDE_SWING_DIMS);

/** 극단 치수 3종 (이름, 입력 치수, 차) */
export const EXTREMES: readonly { name: string; dims: CustomDims; spec: VehicleSpec }[] = [
  { name: 'OVERSIZED', dims: OVERSIZED_DIMS, spec: OVERSIZED },
  { name: 'UNDERSIZED', dims: UNDERSIZED_DIMS, spec: UNDERSIZED },
  { name: 'WIDE_SWING', dims: WIDE_SWING_DIMS, spec: WIDE_SWING },
];

/** 11대: allSpecs() 8대(name = spec.id) + 극단 치수 3종(name = 위 이름) */
export function allCars(): { name: string; spec: VehicleSpec }[] {
  return [...allSpecs().map((spec) => ({ name: spec.id, spec })), ...EXTREMES.map(({ name, spec }) => ({ name, spec }))];
}
