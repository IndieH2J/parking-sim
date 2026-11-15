import { describe, expect, it } from 'vitest';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { PRESET_DIMS } from '../src/sim/presets';
import { buildFootprint } from '../src/sim/footprint';
import { eyeLocal } from '../src/sim/driver';
import { maxSteerAngle } from '../src/sim/vehicle';
import {
  completeSpec,
  CUSTOM_ID,
  CUSTOM_LIMITS,
  customToPrimary,
  DEFAULT_CUSTOM_DIMS,
  DEFAULT_GHOST_ID,
  DEFAULT_VEHICLE_ID,
  eyeToFrontAxle,
  getSpec,
  listVehicles,
  validateCustomDims,
  vehicleKey,
  type CustomDims,
  type PrimaryDims,
} from '../src/sim/vehicles';

const DEG = 180 / Math.PI;

/** 계약서 §2.4 불변식 */
function checkInvariants(spec: VehicleSpec) {
  const tag = spec.id;
  // 차체 외곽 = 전장 × 전폭
  const b = buildFootprint(spec).body.poly;
  const xs = b.map((p) => p.x);
  const ys = b.map((p) => p.y);
  expect(Math.abs(Math.max(...xs) - Math.min(...xs) - spec.length), `${tag} length`).toBeLessThan(1e-6);
  expect(Math.abs(Math.max(...ys) - Math.min(...ys) - spec.width), `${tag} width`).toBeLessThan(1e-6);
  // 미러 박스 (carMesh 유리 폭이 양수)
  const m = spec.mirror;
  expect(spec.widthMirrors / 2 - m.yInner, `${tag} mirror width`).toBeGreaterThanOrEqual(0.12);
  expect(m.xFront, `${tag} mirror x`).toBeGreaterThan(m.xRear);
  expect(m.hTop - m.hBottom, `${tag} mirror h`).toBeGreaterThanOrEqual(0.1);
  // 눈이 실내에 있다 (eyeLocal의 지붕 클램프에 기대지 않고)
  const e = eyeLocal(spec, 175, 0, 0);
  expect(e.h, `${tag} eye h`).toBeLessThanOrEqual(spec.height - 0.25);
  expect(e.x, `${tag} eye x rear`).toBeGreaterThan(-spec.rearOverhang + 0.75);
  expect(e.x, `${tag} eye x front`).toBeLessThan(spec.wheelbase - 1.0);
  expect(Math.abs(e.y), `${tag} eye y`).toBeLessThan(spec.width / 2 - 0.15);
  // 최대 조향각
  const deg = maxSteerAngle(spec) * DEG;
  expect(Number.isFinite(deg), `${tag} steer finite`).toBe(true);
  expect(deg, `${tag} steer min`).toBeGreaterThanOrEqual(20);
  expect(deg, `${tag} steer max`).toBeLessThanOrEqual(45);
}

/** CUSTOM_LIMITS 상자의 꼭짓점 2^8개 */
function customCorners(): CustomDims[] {
  const keys = Object.keys(CUSTOM_LIMITS) as (keyof CustomDims)[];
  const out: CustomDims[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const c = { ...DEFAULT_CUSTOM_DIMS };
    keys.forEach((k, i) => (c[k] = mask & (1 << i) ? CUSTOM_LIMITS[k].max : CUSTOM_LIMITS[k].min));
    out.push(c);
  }
  return out;
}

const primaryOf = (s: VehicleSpec): PrimaryDims => ({
  length: s.length,
  width: s.width,
  widthMirrors: s.widthMirrors,
  height: s.height,
  wheelbase: s.wheelbase,
  frontOverhang: s.frontOverhang,
  rearOverhang: s.rearOverhang,
  trackFront: s.trackFront,
  trackRear: s.trackRear,
  groundClearance: s.groundClearance,
  tireWidth: s.tireWidth,
  tireDiameter: s.tireDiameter,
  turningDiameter: s.turningDiameter,
});

describe('프리셋 (src/sim/presets.ts)', () => {
  it('id와 순서, 극값 차종', () => {
    expect(PRESET_DIMS.map((p) => p.id)).toEqual(['avante', 'k3', 'k5', 'sonata', 'tucson', 'sorento', 'morning']);
    const by = (f: (p: (typeof PRESET_DIMS)[number]) => number) => [...PRESET_DIMS].sort((a, b) => f(a) - f(b));
    expect(by((p) => p.height)[0]).toMatchObject({ id: 'avante', height: 1.42 });
    expect(by((p) => p.length)[0]).toMatchObject({ id: 'morning', length: 3.595 });
    expect(by((p) => -p.height)[0]).toMatchObject({ id: 'sorento', height: 1.695 });
    expect(by((p) => -p.length)[0]).toMatchObject({ id: 'sonata', length: 4.91 });
    expect(by((p) => -p.widthMirrors)[0]).toMatchObject({ id: 'sorento', widthMirrors: 2.17 });
  });

  it('뒤 오버행은 전장 − 축거 − 앞 오버행으로 다시 구하고, 자료 값과 1.5 mm 안에서 같다', () => {
    for (const p of PRESET_DIMS) {
      const spec = getSpec(p.id, DEFAULT_CUSTOM_DIMS);
      expect(spec.rearOverhang).toBeCloseTo(p.length - p.wheelbase - p.frontOverhang, 12);
      expect(Math.abs(spec.rearOverhang - p.rearOverhang), p.id).toBeLessThanOrEqual(0.0015);
      expect(spec.length).toBe(p.length);
    }
  });
});

describe('completeSpec 불변식 (§2.4)', () => {
  for (const v of listVehicles()) {
    it(`${v.id}`, () => checkInvariants(v.spec));
  }

  it('직접 입력 상자의 유효한 꼭짓점 전부', () => {
    const valid = customCorners().filter((c) => validateCustomDims(c).length === 0);
    expect(valid.length).toBe(12);
    for (const c of valid) {
      const spec = getSpec(CUSTOM_ID, c);
      expect(spec.id).toBe(CUSTOM_ID);
      checkInvariants(spec);
    }
  });

  it('모델 Y 치수를 넣으면 미러·눈 값이 수작업 값과 0.01 m 안에서 같다', () => {
    const s = completeSpec('my', MODEL_Y_2025.name, primaryOf(MODEL_Y_2025));
    for (const k of Object.keys(MODEL_Y_2025.mirror) as (keyof VehicleSpec['mirror'])[]) {
      expect(Math.abs(s.mirror[k] - MODEL_Y_2025.mirror[k]), `mirror.${k}`).toBeLessThanOrEqual(0.01);
    }
    for (const k of Object.keys(MODEL_Y_2025.eye) as (keyof VehicleSpec['eye'])[]) {
      expect(Math.abs(s.eye[k] - MODEL_Y_2025.eye[k]), `eye.${k}`).toBeLessThanOrEqual(0.01);
    }
    expect(s.steeringTurnsLockToLock).toBe(2.5);
    expect(s.rearOverhang).toBeCloseTo(MODEL_Y_2025.rearOverhang, 12);
    expect(eyeToFrontAxle(MODEL_Y_2025)).toBeCloseTo(1.358, 3);
  });

  it('eyeToFrontAxle는 1.10 ~ 1.60으로 자른다', () => {
    expect(eyeToFrontAxle({ wheelbase: 2.0, height: 2.2 })).toBe(1.1);
    expect(eyeToFrontAxle({ wheelbase: 3.8, height: 1.2 })).toBe(1.6);
  });
});

describe('직접 입력 검증 (§2.3)', () => {
  const d = DEFAULT_CUSTOM_DIMS;
  const errs = (patch: Partial<CustomDims>) => validateCustomDims({ ...d, ...patch });

  it('기본값(모델 Y)은 유효', () => {
    expect(d).toEqual({
      lengthMm: 4790, widthMm: 1920, widthMirrorsMm: 2129, heightMm: 1624,
      wheelbaseMm: 2890, frontOverhangMm: 889, trackMm: 1636, turningDiameterM: 12.13,
    });
    expect(validateCustomDims(d)).toEqual([]);
  });

  it('범위 밖은 errRange, 그 필드가 걸린 교차 검사는 하지 않는다', () => {
    expect(errs({ widthMm: 2500 })).toEqual([{ field: 'widthMm', key: 'errRange' }]);
    expect(errs({ heightMm: 1199 })).toEqual([{ field: 'heightMm', key: 'errRange' }]);
    expect(errs({ turningDiameterM: 15.01 })).toEqual([{ field: 'turningDiameterM', key: 'errRange' }]);
    expect(errs({ trackMm: Number.NaN })).toEqual([{ field: 'trackMm', key: 'errRange' }]);
  });

  it('교차 검사: 뒤 오버행(전장에 표시), 미러 폭, 윤거, 회전 직경', () => {
    expect(errs({ lengthMm: 4178 })).toEqual([{ field: 'lengthMm', key: 'errRearOverhang' }]); // 뒤 399
    expect(errs({ lengthMm: 4179 })).toEqual([]); // 뒤 400
    expect(errs({ lengthMm: 5380 })).toEqual([{ field: 'lengthMm', key: 'errRearOverhang' }]); // 뒤 1601
    expect(errs({ widthMirrorsMm: 1969 })).toEqual([{ field: 'widthMirrorsMm', key: 'errMirrors' }]);
    expect(errs({ widthMirrorsMm: 1970 })).toEqual([]);
    expect(errs({ widthMirrorsMm: 2321 })).toEqual([{ field: 'widthMirrorsMm', key: 'errMirrors' }]);
    expect(errs({ trackMm: 1746 })).toEqual([{ field: 'trackMm', key: 'errTrack' }]);
    expect(errs({ trackMm: 1745 })).toEqual([]);
    expect(errs({ turningDiameterM: 8.0 })).toEqual([{ field: 'turningDiameterM', key: 'errTurning' }]); // 조향각 > 45°
    expect(errs({ wheelbaseMm: 2000, lengthMm: 3900, turningDiameterM: 15 })).toEqual([
      { field: 'turningDiameterM', key: 'errTurning' }, // 조향각 < 20°
    ]);
  });

  it('customToPrimary: 뒤 오버행 계산, 앞뒤 윤거 같음, 입력 없는 치수는 추정값', () => {
    const p = customToPrimary(d);
    expect(p.rearOverhang).toBeCloseTo(1.011, 12);
    expect(p.trackFront).toBe(1.636);
    expect(p.trackRear).toBe(1.636);
    expect(p).toMatchObject({ groundClearance: 0.16, tireWidth: 0.235, tireDiameter: 0.68, turningDiameter: 12.13 });
  });

  it('계약서 §8.2의 큰 직접 입력 차는 유효', () => {
    const big: CustomDims = {
      lengthMm: 6000, widthMm: 2200, widthMirrorsMm: 2600, heightMm: 2000,
      wheelbaseMm: 3800, frontOverhangMm: 1300, trackMm: 1900, turningDiameterM: 15.0,
    };
    expect(validateCustomDims(big)).toEqual([]);
    checkInvariants(getSpec(CUSTOM_ID, big));
  });
});

describe('차종 등록부 (§2.4)', () => {
  it('listVehicles = [모델 Y, 프리셋 순서], 직접 입력 제외', () => {
    const list = listVehicles();
    expect(list.map((v) => v.id)).toEqual([DEFAULT_VEHICLE_ID, ...PRESET_DIMS.map((p) => p.id)]);
    expect(list[0].spec).toBe(MODEL_Y_2025);
    expect(list[0]).toMatchObject({ segment: null, estimated: [] });
    const avante = list.find((v) => v.id === DEFAULT_GHOST_ID)!;
    expect(avante.name).toEqual({ ko: PRESET_DIMS[0].nameKo, en: PRESET_DIMS[0].nameEn });
    expect(avante.segment).toBe('C-sedan');
    expect(avante.estimated).toEqual(PRESET_DIMS[0].estimated);
    expect(avante.spec).toMatchObject({ id: 'avante', length: 4.71, width: 1.825, turningDiameter: 10.995 });
    expect(list.some((v) => v.id === CUSTOM_ID)).toBe(false);
  });

  it('getSpec: 프리셋, 직접 입력(유효할 때만), 모르는 id는 모델 Y', () => {
    expect(getSpec(DEFAULT_VEHICLE_ID, DEFAULT_CUSTOM_DIMS)).toBe(MODEL_Y_2025);
    expect(getSpec('sorento', DEFAULT_CUSTOM_DIMS).widthMirrors).toBe(2.17);
    expect(getSpec('casper', DEFAULT_CUSTOM_DIMS)).toBe(MODEL_Y_2025);
    const c = getSpec(CUSTOM_ID, { ...DEFAULT_CUSTOM_DIMS, widthMm: 1800, widthMirrorsMm: 2050, trackMm: 1550 });
    expect(c).toMatchObject({ id: CUSTOM_ID, width: 1.8, widthMirrors: 2.05, trackFront: 1.55, trackRear: 1.55 });
    expect(getSpec(CUSTOM_ID, { ...DEFAULT_CUSTOM_DIMS, widthMm: 2500 })).toBe(MODEL_Y_2025);
  });

  it('vehicleKey', () => {
    expect(vehicleKey(CUSTOM_ID, DEFAULT_CUSTOM_DIMS)).toBe('custom:4790x1920x2129x1624x2890x889x1636x1213');
    expect(vehicleKey('k5', DEFAULT_CUSTOM_DIMS)).toBe('k5');
    expect(vehicleKey(DEFAULT_VEHICLE_ID, DEFAULT_CUSTOM_DIMS)).toBe('model-y-2025');
    expect(vehicleKey('nope', DEFAULT_CUSTOM_DIMS)).toBe(DEFAULT_VEHICLE_ID);
    expect(vehicleKey(CUSTOM_ID, { ...DEFAULT_CUSTOM_DIMS, widthMm: 2500 })).toBe(DEFAULT_VEHICLE_ID);
  });
});
