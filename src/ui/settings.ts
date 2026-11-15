import type { Lang } from './i18n';
import type { AnyScenarioOptions, ScenarioKind, TargetKind } from '../scenarios/types';
import { PARALLEL_LENGTH_RANGE, PERP_SLOT_RANGE, RAMP_RADIUS_OPTIONS, SCENARIO_KINDS } from '../scenarios/types';
import type { CustomDims, GhostAlign } from '../sim/vehicles';
import {
  CUSTOM_ID,
  CUSTOM_LIMITS,
  DEFAULT_CUSTOM_DIMS,
  DEFAULT_GHOST_ID,
  DEFAULT_VEHICLE_ID,
  listVehicles,
  validateCustomDims,
} from '../sim/vehicles';

// 설정 v2 (계약서 §2.5): 순수 함수 + 저장소를 인자로 받는 얇은 저장 함수.

export interface Settings {
  lang: Lang | null; // null이면 브라우저 언어
  aids: { mirrors: boolean; minimap: boolean; distance: boolean; rearCam: boolean; guides: boolean };
  driverHeightCm: number; // 키
  seatHeightCm: number; // 기본값 대비 오프셋
  seatForeCm: number; // + = 앞으로
  fov: number; // 수직 FOV (deg)
  calibMarks: boolean;
  /** R에서 양쪽 사이드미러를 아래로 숙인다 (테슬라 Mirror Auto-Tilt 같은 기능). 기본 꺼짐, 이 필드가 없는 저장값도 꺼짐 */
  mirrorTiltReverse: boolean;
  scenario: ScenarioKind;
  /** 후면·전면 직각이 함께 쓴다 */
  perp: { slotWidth: number; target: TargetKind };
  parallel: { slotLength: number };
  ramp: { innerRadius: number };
  /** DEFAULT_VEHICLE_ID, 프리셋 id 또는 'custom' */
  vehicle: string;
  customDims: CustomDims;
  /** vehicle은 모델 Y, 프리셋 id 또는 'custom'(customDims 사용) */
  ghost: { enabled: boolean; vehicle: string; align: GhostAlign };
}

export const SETTINGS_KEY = 'parking-sim.settings.v2';
export const SETTINGS_KEY_V1 = 'parking-sim.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  lang: null,
  aids: { mirrors: true, minimap: true, distance: true, rearCam: true, guides: true },
  driverHeightCm: 175,
  seatHeightCm: 0,
  seatForeCm: 0,
  fov: 60,
  calibMarks: false,
  mirrorTiltReverse: false,
  scenario: 'rearPerp',
  perp: { slotWidth: 2.5, target: 'between' },
  parallel: { slotLength: 6.0 },
  ramp: { innerRadius: 6 },
  vehicle: DEFAULT_VEHICLE_ID,
  customDims: { ...DEFAULT_CUSTOM_DIMS },
  ghost: { enabled: false, vehicle: DEFAULT_GHOST_ID, align: 'driver' },
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const clampNum = (v: unknown, def: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
const oneOf = <T>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);

const TARGETS: readonly TargetKind[] = ['between', 'pillar'];
const ALIGNS: readonly GhostAlign[] = ['driver', 'rearAxle'];

/** 숫자 필드만 기본값 위에 덮고, 검증에 실패하면 통째로 기본값 */
function sanitizeCustomDims(raw: unknown): CustomDims {
  const r = obj(raw);
  const c = { ...DEFAULT_CUSTOM_DIMS };
  for (const k of Object.keys(CUSTOM_LIMITS) as (keyof CustomDims)[]) {
    const v = r[k];
    if (typeof v === 'number') c[k] = v;
  }
  return validateCustomDims(c).length === 0 ? c : { ...DEFAULT_CUSTOM_DIMS };
}

/** 기본값에 깊이 병합한다. 숫자는 범위로 자르고, 열거값·차량 id는 검사한다. 잘못된 customDims는 기본값. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS;
  const rawAids = obj(r.aids);
  const aids = { ...d.aids };
  for (const k of Object.keys(aids) as (keyof Settings['aids'])[]) aids[k] = bool(rawAids[k], aids[k]);
  const perp = obj(r.perp);
  const ghost = obj(r.ghost);
  const vehicleIds = [...listVehicles().map((v) => v.id), CUSTOM_ID];
  return {
    lang: r.lang === 'ko' || r.lang === 'en' ? r.lang : null,
    aids,
    driverHeightCm: clampNum(r.driverHeightCm, d.driverHeightCm, 150, 195),
    seatHeightCm: clampNum(r.seatHeightCm, d.seatHeightCm, -6, 6),
    seatForeCm: clampNum(r.seatForeCm, d.seatForeCm, -12, 12),
    fov: clampNum(r.fov, d.fov, 45, 75),
    calibMarks: bool(r.calibMarks, d.calibMarks),
    mirrorTiltReverse: bool(r.mirrorTiltReverse, d.mirrorTiltReverse),
    scenario: oneOf(r.scenario, SCENARIO_KINDS, d.scenario),
    perp: {
      slotWidth: clampNum(perp.slotWidth, d.perp.slotWidth, PERP_SLOT_RANGE.min, PERP_SLOT_RANGE.max),
      target: oneOf(perp.target, TARGETS, d.perp.target),
    },
    parallel: {
      slotLength: clampNum(obj(r.parallel).slotLength, d.parallel.slotLength, PARALLEL_LENGTH_RANGE.min, PARALLEL_LENGTH_RANGE.max),
    },
    ramp: { innerRadius: oneOf(obj(r.ramp).innerRadius, RAMP_RADIUS_OPTIONS, d.ramp.innerRadius) },
    vehicle: oneOf(r.vehicle, vehicleIds, d.vehicle),
    customDims: sanitizeCustomDims(r.customDims),
    ghost: {
      enabled: bool(ghost.enabled, d.ghost.enabled),
      vehicle: oneOf(ghost.vehicle, vehicleIds, d.ghost.vehicle),
      align: oneOf(ghost.align, ALIGNS, d.ghost.align),
    },
  };
}

/** v1 필드를 옮긴다. slotWidth → perp.slotWidth, target → perp.target */
export function migrateV1(raw: unknown): Settings {
  const r = obj(raw);
  return sanitizeSettings({
    lang: r.lang,
    aids: r.aids,
    driverHeightCm: r.driverHeightCm,
    seatHeightCm: r.seatHeightCm,
    seatForeCm: r.seatForeCm,
    fov: r.fov,
    calibMarks: r.calibMarks,
    perp: { slotWidth: r.slotWidth, target: r.target },
  });
}

/** 브라우저 localStorage. 없거나 접근이 막히면(사생활 보호 모드 등) null */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** v2 키 → 정리. 없으면 v1 키 → 옮겨서 v2로 저장 (v1 키는 그대로 둔다). 둘 다 없으면 기본값. */
export function loadSettings(storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage()): Settings {
  try {
    const v2 = storage?.getItem(SETTINGS_KEY) ?? null;
    if (v2 !== null) return sanitizeSettings(JSON.parse(v2));
    const v1 = storage?.getItem(SETTINGS_KEY_V1) ?? null;
    if (v1 !== null) {
      const s = migrateV1(JSON.parse(v1));
      saveSettings(s, storage);
      return s;
    }
  } catch {
    // 저장소 접근 불가·손상된 JSON: 기본값
  }
  return sanitizeSettings(null);
}

export function saveSettings(s: Settings, storage: Pick<Storage, 'setItem'> | null = browserStorage()): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 저장 불가(사생활 보호 모드 등)여도 동작에는 지장 없다.
  }
}

/** 설정의 시나리오 종류와 그 옵션. 호출: `const o = optionsFor(s); buildScenario(o.kind, o.opts, spec)` */
export function optionsFor(s: Settings): { kind: ScenarioKind; opts: AnyScenarioOptions } {
  switch (s.scenario) {
    case 'rearPerp':
    case 'frontPerp':
      return { kind: s.scenario, opts: { slotWidth: s.perp.slotWidth, target: s.perp.target } };
    case 'parallel':
      return { kind: 'parallel', opts: { slotLength: s.parallel.slotLength } };
    case 'ramp':
      return { kind: 'ramp', opts: { innerRadius: s.ramp.innerRadius } };
  }
}
