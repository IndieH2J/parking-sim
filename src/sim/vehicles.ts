import type { VehicleSpec } from './specs';
import { MODEL_Y_2025 } from './specs';
import { PRESET_DIMS } from './presets';
import { maxSteerAngle } from './vehicle';

// 차종 등록부, 공개 치수에서 추정값을 채우는 completeSpec, 직접 입력 치수. 계약서 §2.2–2.4.

/** 공개 치수 (모두 m) */
export interface PrimaryDims {
  length: number;
  width: number;
  widthMirrors: number;
  height: number;
  wheelbase: number;
  frontOverhang: number;
  rearOverhang: number;
  trackFront: number;
  trackRear: number;
  groundClearance: number;
  tireWidth: number;
  tireDiameter: number;
  turningDiameter: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 추정값: 눈 → 앞축 거리 (m). 모델 Y 1.358 */
export function eyeToFrontAxle(d: Pick<PrimaryDims, 'wheelbase' | 'height'>): number {
  return clamp(0.47 * d.wheelbase + 0.5 * (1.624 - d.height), 1.1, 1.6);
}

/**
 * 공개 치수로 VehicleSpec을 만든다. 미러 박스·눈 위치·록투록은 추정값이고, 모델 Y 수작업 값에 맞춘 식이다
 * (모델 Y 치수를 넣으면 미러·눈 값이 MODEL_Y_2025와 0.01 m 안에서 같다).
 * 뒤 오버행은 전장 − 축거 − 앞 오버행으로 다시 구한다. 차체 외곽 길이가 공식 전장과 같아야 하기 때문이다.
 * (투싼·쏘렌토 프리셋은 미국 인치 값 반올림 탓에 오버행 + 축거가 전장보다 1 mm 짧다.)
 */
export function completeSpec(id: string, name: { ko: string; en: string }, d: PrimaryDims): VehicleSpec {
  const e2fa = eyeToFrontAxle(d);
  const mirrorXRear = d.wheelbase - e2fa + 0.59;
  return {
    id,
    name,
    length: d.length,
    width: d.width,
    widthMirrors: d.widthMirrors,
    height: d.height,
    wheelbase: d.wheelbase,
    frontOverhang: d.frontOverhang,
    rearOverhang: d.length - d.wheelbase - d.frontOverhang,
    trackFront: d.trackFront,
    trackRear: d.trackRear,
    groundClearance: d.groundClearance,
    turningDiameter: d.turningDiameter,
    tireWidth: d.tireWidth,
    tireDiameter: d.tireDiameter,
    // 추정값: 미러는 눈보다 0.59 m 앞에서 뒤끝, 하우징 길이 0.18 m, 차체에서 0.1 m 안쪽부터, 높이는 전고 비례
    mirror: {
      xFront: mirrorXRear + 0.18,
      xRear: mirrorXRear,
      yInner: d.width / 2 - 0.1,
      hBottom: 0.6 * d.height,
      hTop: 0.69 * d.height,
    },
    // 추정값: 앞범퍼 → 눈 = 앞 오버행 + 눈→앞축, 중심선 왼쪽 0.193·전폭, 눈 높이는 전고 비례 (지붕 아래 0.25 m 이상)
    eye: {
      fromFront: d.frontOverhang + e2fa,
      lateral: 0.193 * d.width,
      height: Math.min(0.39 + 0.5 * d.height, d.height - 0.25),
    },
    // 추정값
    steeringTurnsLockToLock: 2.5,
  };
}

// ---- 직접 입력 (§2.3) ----

export interface CustomDims {
  lengthMm: number;
  widthMm: number;
  widthMirrorsMm: number;
  heightMm: number;
  wheelbaseMm: number;
  frontOverhangMm: number;
  trackMm: number;
  turningDiameterM: number;
}

/** 모델 Y */
export const DEFAULT_CUSTOM_DIMS: CustomDims = {
  lengthMm: 4790,
  widthMm: 1920,
  widthMirrorsMm: 2129,
  heightMm: 1624,
  wheelbaseMm: 2890,
  frontOverhangMm: 889,
  trackMm: 1636,
  turningDiameterM: 12.13,
};

export const CUSTOM_LIMITS: Record<keyof CustomDims, { min: number; max: number; step: number }> = {
  lengthMm: { min: 3000, max: 6000, step: 1 },
  widthMm: { min: 1400, max: 2200, step: 1 },
  widthMirrorsMm: { min: 1450, max: 2600, step: 1 },
  heightMm: { min: 1200, max: 2200, step: 1 },
  wheelbaseMm: { min: 2000, max: 3800, step: 1 },
  frontOverhangMm: { min: 500, max: 1300, step: 1 },
  trackMm: { min: 1200, max: 1900, step: 1 },
  turningDiameterM: { min: 8.0, max: 15.0, step: 0.01 },
};

export type DimErrorKey = 'errRange' | 'errRearOverhang' | 'errMirrors' | 'errTrack' | 'errTurning';

const CUSTOM_NAME = { ko: '직접 입력', en: 'Custom' };

/** 직접 입력 → 공개 치수. 뒤 오버행은 계산, 앞뒤 윤거는 같게 둔다. */
export function customToPrimary(c: CustomDims): PrimaryDims {
  return {
    length: c.lengthMm / 1000,
    width: c.widthMm / 1000,
    widthMirrors: c.widthMirrorsMm / 1000,
    height: c.heightMm / 1000,
    wheelbase: c.wheelbaseMm / 1000,
    frontOverhang: c.frontOverhangMm / 1000,
    rearOverhang: (c.lengthMm - c.wheelbaseMm - c.frontOverhangMm) / 1000,
    trackFront: c.trackMm / 1000,
    trackRear: c.trackMm / 1000,
    // 추정값: 입력받지 않는 치수
    groundClearance: 0.16,
    tireWidth: 0.235,
    tireDiameter: 0.68,
    turningDiameter: c.turningDiameterM,
  };
}

/**
 * [] = 유효. 범위 밖은 errRange. 교차 검사는 관련 필드가 모두 범위 안일 때만 하므로 필드마다 오류는 하나다.
 * 교차 검사 오류는 표의 해당 행 필드에 붙인다 (뒤 오버행은 전장).
 */
export function validateCustomDims(c: CustomDims): { field: keyof CustomDims; key: DimErrorKey }[] {
  const errors: { field: keyof CustomDims; key: DimErrorKey }[] = [];
  const bad = new Set<keyof CustomDims>();
  for (const f of Object.keys(CUSTOM_LIMITS) as (keyof CustomDims)[]) {
    const v = c[f];
    if (!(typeof v === 'number' && v >= CUSTOM_LIMITS[f].min && v <= CUSTOM_LIMITS[f].max)) {
      bad.add(f);
      errors.push({ field: f, key: 'errRange' });
    }
  }
  const ok = (...fs: (keyof CustomDims)[]) => fs.every((f) => !bad.has(f));
  if (ok('lengthMm', 'wheelbaseMm', 'frontOverhangMm')) {
    const rear = c.lengthMm - c.wheelbaseMm - c.frontOverhangMm;
    if (rear < 400 || rear > 1600) errors.push({ field: 'lengthMm', key: 'errRearOverhang' });
  }
  if (ok('widthMm', 'widthMirrorsMm') && (c.widthMirrorsMm < c.widthMm + 50 || c.widthMirrorsMm > c.widthMm + 400)) {
    errors.push({ field: 'widthMirrorsMm', key: 'errMirrors' });
  }
  if (ok('widthMm', 'trackMm') && c.trackMm + 235 > c.widthMm + 60) {
    errors.push({ field: 'trackMm', key: 'errTrack' });
  }
  if (ok('wheelbaseMm', 'trackMm', 'turningDiameterM')) {
    const deg = (maxSteerAngle(completeSpec(CUSTOM_ID, CUSTOM_NAME, customToPrimary(c))) * 180) / Math.PI;
    if (!(Number.isFinite(deg) && deg >= 20 && deg <= 45)) errors.push({ field: 'turningDiameterM', key: 'errTurning' });
  }
  return errors;
}

// ---- 등록부 (§2.4) ----

export type GhostAlign = 'driver' | 'rearAxle';
export const CUSTOM_ID = 'custom';
export const DEFAULT_VEHICLE_ID = 'model-y-2025';
export const DEFAULT_GHOST_ID = 'avante';

export interface VehicleEntry {
  id: string;
  name: { ko: string; en: string };
  segment: string | null;
  estimated: string[];
  spec: VehicleSpec;
}

const ENTRIES: VehicleEntry[] = [
  { id: MODEL_Y_2025.id, name: MODEL_Y_2025.name, segment: null, estimated: [], spec: MODEL_Y_2025 },
  ...PRESET_DIMS.map((p) => {
    const name = { ko: p.nameKo, en: p.nameEn };
    return { id: p.id, name, segment: p.segment, estimated: [...p.estimated], spec: completeSpec(p.id, name, p) };
  }),
];

/** [모델 Y, ...PRESET_DIMS 순서의 프리셋]. 직접 입력은 빠진다. */
export function listVehicles(): VehicleEntry[] {
  return [...ENTRIES];
}

/** 'custom'은 치수가 유효할 때만 그 차, 아니면 모델 Y. 모르는 id도 모델 Y. */
export function getSpec(id: string, custom: CustomDims): VehicleSpec {
  if (id === CUSTOM_ID) {
    return validateCustomDims(custom).length === 0 ? completeSpec(CUSTOM_ID, CUSTOM_NAME, customToPrimary(custom)) : MODEL_Y_2025;
  }
  return ENTRIES.find((e) => e.id === id)?.spec ?? MODEL_Y_2025;
}

/** 기록 키에 쓰는 차량 키. 직접 입력 → 'custom:4790x1920x2129x1624x2890x889x1636x1213' (회전 직경은 cm). 실제로 쓰이는 차의 키를 돌려준다. */
export function vehicleKey(id: string, custom: CustomDims): string {
  if (id === CUSTOM_ID && validateCustomDims(custom).length === 0) {
    const c = custom;
    const parts = [c.lengthMm, c.widthMm, c.widthMirrorsMm, c.heightMm, c.wheelbaseMm, c.frontOverhangMm, c.trackMm, c.turningDiameterM * 100];
    return `${CUSTOM_ID}:${parts.map((v) => Math.round(v)).join('x')}`;
  }
  return getSpec(id, custom).id;
}
