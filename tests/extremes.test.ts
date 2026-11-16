import { describe, expect, it } from 'vitest';
import type { VehicleSpec } from '../src/sim/specs';
import { maxSteerAngle } from '../src/sim/vehicle';
import { CUSTOM_ID, validateCustomDims } from '../src/sim/vehicles';
import { allSpecs } from './helpers/drive';
import { allCars, EXTREMES, OVERSIZED, UNDERSIZED, WIDE_SWING } from './helpers/specs';

// 직접 입력 극단 치수 3종 (tests/helpers/specs.ts, 계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md A.6).
// 새 코스 증명에 쓰는 차가 실제로 고를 수 있는 입력인지 확인한다 (getSpec은 잘못된 치수를 모델 Y로 바꾼다).

/** 뒤축 중심의 최소 회전 반경 R = 축거 / tan(최대 조향각) (m) */
const turnR = (spec: VehicleSpec) => spec.wheelbase / Math.tan(maxSteerAngle(spec));

describe('극단 치수 3종', () => {
  it.each(EXTREMES.map((e) => [e.name, e] as const))('%s: 검증 오류가 없고 직접 입력 차가 된다 (모델 Y로 대체되지 않음)', (_, e) => {
    expect(validateCustomDims(e.dims)).toEqual([]);
    expect(e.spec.id).toBe(CUSTOM_ID);
    expect(e.spec.length).toBeCloseTo(e.dims.lengthMm / 1000, 9);
    expect(e.spec.width).toBeCloseTo(e.dims.widthMm / 1000, 9);
    expect(e.spec.widthMirrors).toBeCloseTo(e.dims.widthMirrorsMm / 1000, 9);
    expect(e.spec.wheelbase).toBeCloseTo(e.dims.wheelbaseMm / 1000, 9);
    expect(e.spec.trackFront).toBeCloseTo(e.dims.trackMm / 1000, 9);
    expect(e.spec.turningDiameter).toBe(e.dims.turningDiameterM);
  });

  it('WIDE_SWING이 11대 중 가장 크게 돈다: R ≈ 6.11 m > OVERSIZED ≈ 5.40 m, 뒤 오버행 1.6 m', () => {
    expect(turnR(WIDE_SWING)).toBeCloseTo(6.11, 2);
    expect(turnR(OVERSIZED)).toBeCloseTo(5.4, 2);
    expect(turnR(WIDE_SWING)).toBeGreaterThan(turnR(OVERSIZED));
    expect(Math.max(...allCars().map((c) => turnR(c.spec)))).toBe(turnR(WIDE_SWING));
    expect(WIDE_SWING.rearOverhang).toBeCloseTo(1.6, 9);
  });

  it('UNDERSIZED: 뒤 오버행 0.5 m, 최대 조향각 약 36°', () => {
    expect(UNDERSIZED.rearOverhang).toBeCloseTo(0.5, 9);
    expect((maxSteerAngle(UNDERSIZED) * 180) / Math.PI).toBeCloseTo(36.1, 1);
  });

  it('allCars: allSpecs() 8대 다음에 극단 3종, 이름이 모두 다르다', () => {
    const cars = allCars();
    expect(cars).toHaveLength(11);
    expect(cars.slice(0, 8).map((c) => c.spec)).toEqual(allSpecs());
    expect(cars.slice(8).map((c) => c.name)).toEqual(['OVERSIZED', 'UNDERSIZED', 'WIDE_SWING']);
    expect(new Set(cars.map((c) => c.name)).size).toBe(11);
  });
});
