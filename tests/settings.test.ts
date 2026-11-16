import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  migrateV1,
  optionsFor,
  sanitizeSettings,
  saveSettings,
  SETTINGS_KEY,
  SETTINGS_KEY_V1,
  type Settings,
} from '../src/ui/settings';
import { DEFAULT_CUSTOM_DIMS, DEFAULT_GHOST_ID, DEFAULT_VEHICLE_ID } from '../src/sim/vehicles';

/** Map으로 만든 가짜 저장소 */
class MemStorage {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
}

const throwing = {
  getItem(): string | null {
    throw new Error('SecurityError');
  },
  setItem(): void {
    throw new Error('QuotaExceededError');
  },
};

describe('설정 v2 기본값', () => {
  it('계약서 §2.5 기본값', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      lang: null,
      aids: { mirrors: true, minimap: true, distance: true, rearCam: true, guides: true },
      driverHeightCm: 175,
      seatHeightCm: 0,
      seatForeCm: 0,
      fov: 60,
      calibMarks: false,
      mirrorTiltReverse: false,
      autoShift: true,
      scenario: 'rearPerp',
      perp: { slotWidth: 2.5, target: 'between', crooked: false },
      parallel: { slotLength: 6.0 },
      ramp: { innerRadius: 6 },
      vehicle: DEFAULT_VEHICLE_ID,
      customDims: DEFAULT_CUSTOM_DIMS,
      ghost: { enabled: false, vehicle: DEFAULT_GHOST_ID, align: 'driver' },
    });
    expect(SETTINGS_KEY).toBe('parking-sim.settings.v2');
    expect(SETTINGS_KEY_V1).toBe('parking-sim.settings.v1');
  });

  it('정리 결과는 기본값 객체를 공유하지 않는다', () => {
    const s = sanitizeSettings(null);
    s.aids.mirrors = false;
    s.perp.slotWidth = 2.3;
    s.customDims.widthMm = 1800;
    s.ghost.enabled = true;
    expect(DEFAULT_SETTINGS.aids.mirrors).toBe(true);
    expect(DEFAULT_SETTINGS.perp.slotWidth).toBe(2.5);
    expect(DEFAULT_SETTINGS.customDims.widthMm).toBe(1920);
    expect(DEFAULT_SETTINGS.ghost.enabled).toBe(false);
  });
});

describe('v1 → v2 이전', () => {
  const v1 = { slotWidth: 2.3, target: 'pillar', lang: 'en', aids: { minimap: false } };

  it('migrateV1: perp로 옮기고 aids는 기본값에 병합', () => {
    const s = migrateV1(v1);
    expect(s.perp).toEqual({ slotWidth: 2.3, target: 'pillar', crooked: false });
    expect(s.lang).toBe('en');
    expect(s.aids).toEqual({ ...DEFAULT_SETTINGS.aids, minimap: false });
    expect(s.scenario).toBe('rearPerp');
    expect(s.vehicle).toBe(DEFAULT_VEHICLE_ID);
  });

  it('loadSettings: v2 키가 없으면 v1을 옮겨 v2로 저장하고 v1 키는 그대로 둔다', () => {
    const st = new MemStorage();
    const raw = JSON.stringify({ ...v1, driverHeightCm: 182, seatHeightCm: -2, seatForeCm: 5, fov: 70, calibMarks: true });
    st.setItem(SETTINGS_KEY_V1, raw);
    const s = loadSettings(st);
    expect(s).toMatchObject({ lang: 'en', driverHeightCm: 182, seatHeightCm: -2, seatForeCm: 5, fov: 70, calibMarks: true });
    expect(s.perp).toEqual({ slotWidth: 2.3, target: 'pillar', crooked: false });
    expect(st.getItem(SETTINGS_KEY_V1)).toBe(raw);
    expect(JSON.parse(st.getItem(SETTINGS_KEY)!)).toEqual(s);
    // 다음 로드는 v2 키를 읽는다
    st.setItem(SETTINGS_KEY_V1, JSON.stringify({ slotWidth: 2.6 }));
    expect(loadSettings(st).perp.slotWidth).toBe(2.3);
  });

  it('게이트 확인 #15와 같은 v1 값', () => {
    const st = new MemStorage();
    st.setItem(SETTINGS_KEY_V1, '{"slotWidth":2.3,"lang":"en"}');
    const s = loadSettings(st);
    expect(s).toMatchObject({ lang: 'en', scenario: 'rearPerp', perp: { slotWidth: 2.3, target: 'between' } });
  });
});

describe('sanitizeSettings', () => {
  it('엉뚱한 입력은 기본값', () => {
    for (const g of [null, undefined, 42, 'x', [], [1, 2], true, { foo: 1 }]) {
      expect(sanitizeSettings(g)).toEqual(DEFAULT_SETTINGS);
    }
    const junk = {
      lang: 'fr',
      aids: 'all',
      driverHeightCm: 'tall',
      seatHeightCm: Number.NaN,
      seatForeCm: null,
      fov: Infinity,
      calibMarks: 'yes',
      scenario: 'drift',
      perp: { slotWidth: '2.5', target: 'roof' },
      parallel: 7,
      ramp: { innerRadius: '6' },
      vehicle: 42,
      customDims: 'big',
      ghost: { enabled: 1, vehicle: null, align: 'mirror' },
    };
    expect(sanitizeSettings(junk)).toEqual(DEFAULT_SETTINGS);
  });

  it('모르는 차량 id는 기본값', () => {
    const s = sanitizeSettings({ vehicle: 'cybertruck', ghost: { enabled: true, vehicle: 'casper' } });
    expect(s.vehicle).toBe(DEFAULT_VEHICLE_ID);
    expect(s.ghost).toEqual({ enabled: true, vehicle: DEFAULT_GHOST_ID, align: 'driver' });
    expect(sanitizeSettings({ vehicle: 'sorento' }).vehicle).toBe('sorento');
    expect(sanitizeSettings({ vehicle: 'custom', ghost: { vehicle: 'custom' } })).toMatchObject({
      vehicle: 'custom',
      ghost: { vehicle: 'custom' },
    });
    expect(sanitizeSettings({ ghost: { vehicle: DEFAULT_VEHICLE_ID } }).ghost.vehicle).toBe(DEFAULT_VEHICLE_ID);
  });

  it('숫자는 범위로 자르고, 램프 반경은 선택지 중 하나', () => {
    const s = sanitizeSettings({
      driverHeightCm: 300,
      seatHeightCm: -20,
      seatForeCm: 40,
      fov: 10,
      perp: { slotWidth: 5 },
      parallel: { slotLength: 1 },
      ramp: { innerRadius: 5.5 },
    });
    expect(s).toMatchObject({ driverHeightCm: 195, seatHeightCm: -6, seatForeCm: 12, fov: 45 });
    expect(s.perp.slotWidth).toBe(3.2);
    expect(s.parallel.slotLength).toBe(5.8);
    expect(s.ramp.innerRadius).toBe(6);
    expect(sanitizeSettings({ ramp: { innerRadius: 5 } }).ramp.innerRadius).toBe(5);
    expect(sanitizeSettings({ perp: { slotWidth: 2.05 } }).perp.slotWidth).toBe(2.1);
    expect(sanitizeSettings({ parallel: { slotLength: 8.5 } }).parallel.slotLength).toBe(8.0);
  });

  it('customDims: 빠진 필드는 기본값으로 채우고, 검증에 실패하면 통째로 기본값', () => {
    expect(sanitizeSettings({ customDims: { widthMm: 1850 } }).customDims).toEqual({ ...DEFAULT_CUSTOM_DIMS, widthMm: 1850 });
    expect(sanitizeSettings({ customDims: { ...DEFAULT_CUSTOM_DIMS, widthMm: 2500 } }).customDims).toEqual(DEFAULT_CUSTOM_DIMS);
    expect(sanitizeSettings({ customDims: { ...DEFAULT_CUSTOM_DIMS, trackMm: 1800 } }).customDims).toEqual(DEFAULT_CUSTOM_DIMS);
  });
});

describe('저장·불러오기', () => {
  const custom: Settings = {
    lang: 'ko',
    aids: { mirrors: false, minimap: true, distance: false, rearCam: true, guides: false },
    driverHeightCm: 160,
    seatHeightCm: 3,
    seatForeCm: -7,
    fov: 50,
    calibMarks: true,
    mirrorTiltReverse: true,
    autoShift: false,
    scenario: 'parallel',
    perp: { slotWidth: 2.65, target: 'pillar', crooked: true },
    parallel: { slotLength: 6.5 },
    ramp: { innerRadius: 5 },
    vehicle: 'custom',
    customDims: { ...DEFAULT_CUSTOM_DIMS, lengthMm: 4600, widthMm: 1850, widthMirrorsMm: 2080, trackMm: 1600 },
    ghost: { enabled: true, vehicle: 'morning', align: 'rearAxle' },
  };

  it('v2 왕복은 설정을 그대로 보존', () => {
    const st = new MemStorage();
    saveSettings(custom, st);
    expect(loadSettings(st)).toEqual(custom);
  });

  it('예외를 던지는 저장소는 기본값, 저장은 조용히 실패', () => {
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(custom, throwing)).not.toThrow();
  });

  it('저장소 없음·손상된 JSON은 기본값', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(custom, null)).not.toThrow();
    const st = new MemStorage();
    expect(loadSettings(st)).toEqual(DEFAULT_SETTINGS);
    st.setItem(SETTINGS_KEY, '{not json');
    expect(loadSettings(st)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('후진 미러 하향 설정 mirrorTiltReverse (계약서 Amendments 2026-11-15)', () => {
  it('기본값은 꺼짐', () => {
    expect(DEFAULT_SETTINGS.mirrorTiltReverse).toBe(false);
    expect(sanitizeSettings(null).mirrorTiltReverse).toBe(false);
  });

  it('sanitize는 true를 유지하고, 불리언이 아닌 값은 꺼짐', () => {
    expect(sanitizeSettings({ mirrorTiltReverse: true }).mirrorTiltReverse).toBe(true);
    expect(sanitizeSettings({ mirrorTiltReverse: false }).mirrorTiltReverse).toBe(false);
    for (const v of ['true', 1, null, {}]) expect(sanitizeSettings({ mirrorTiltReverse: v }).mirrorTiltReverse).toBe(false);
  });

  it('필드가 없는 v2 저장값(이 설정 전)은 꺼짐으로 읽고 다른 값은 그대로', () => {
    const st = new MemStorage();
    const old: Record<string, unknown> = { ...DEFAULT_SETTINGS, lang: 'en', calibMarks: true, scenario: 'parallel' };
    delete old.mirrorTiltReverse;
    st.setItem(SETTINGS_KEY, JSON.stringify(old));
    const s = loadSettings(st);
    expect(s.mirrorTiltReverse).toBe(false);
    expect(s).toMatchObject({ lang: 'en', calibMarks: true, scenario: 'parallel' });
    // v1에서 옮긴 설정도 꺼짐
    expect(migrateV1({ slotWidth: 2.3 }).mirrorTiltReverse).toBe(false);
  });
});

describe('키보드 자동 변속 설정 autoShift (계약서 개정 2026-11-16 controls)', () => {
  it('기본값은 켬', () => {
    expect(DEFAULT_SETTINGS.autoShift).toBe(true);
    expect(sanitizeSettings(null).autoShift).toBe(true);
  });

  it('sanitize는 false를 유지하고, 불리언이 아닌 값은 켬', () => {
    expect(sanitizeSettings({ autoShift: false }).autoShift).toBe(false);
    expect(sanitizeSettings({ autoShift: true }).autoShift).toBe(true);
    for (const v of ['false', 0, null, {}, [], 'off']) expect(sanitizeSettings({ autoShift: v }).autoShift).toBe(true);
  });

  it('필드가 없는 v2 저장값(이 설정 전)은 켬으로 읽고 다른 값은 그대로, false 저장값은 false로 읽는다', () => {
    const st = new MemStorage();
    const old: Record<string, unknown> = { ...DEFAULT_SETTINGS, lang: 'en', mirrorTiltReverse: true, scenario: 'ramp' };
    delete old.autoShift;
    st.setItem(SETTINGS_KEY, JSON.stringify(old));
    const s = loadSettings(st);
    expect(s.autoShift).toBe(true);
    expect(s).toMatchObject({ lang: 'en', mirrorTiltReverse: true, scenario: 'ramp' });
    st.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, autoShift: false }));
    expect(loadSettings(st).autoShift).toBe(false);
  });

  it('v1에서 옮긴 설정은 켬 (저장 키는 그대로 v2)', () => {
    expect(migrateV1({ slotWidth: 2.3 }).autoShift).toBe(true);
    const st = new MemStorage();
    st.setItem(SETTINGS_KEY_V1, '{"slotWidth":2.3,"lang":"en"}');
    expect(loadSettings(st).autoShift).toBe(true);
    expect(JSON.parse(st.getItem(SETTINGS_KEY)!).autoShift).toBe(true);
  });
});

describe('옆 차 비뚤게 perp.crooked (계약서 개정 2026-11-16 situations)', () => {
  it('기본값은 꺼짐, sanitize는 true를 유지하고 불리언이 아닌 값은 꺼짐', () => {
    expect(DEFAULT_SETTINGS.perp.crooked).toBe(false);
    expect(sanitizeSettings({ perp: { crooked: true } }).perp).toEqual({ slotWidth: 2.5, target: 'between', crooked: true });
    expect(sanitizeSettings({ perp: { slotWidth: 2.3, crooked: false } }).perp.crooked).toBe(false);
    for (const v of ['true', 1, null, {}, []]) expect(sanitizeSettings({ perp: { crooked: v } }).perp.crooked).toBe(false);
  });

  it('필드가 없는 v2 저장값(이 설정 전)은 꺼짐으로 읽고 다른 값은 그대로, 새 시나리오 종류도 읽는다', () => {
    const st = new MemStorage();
    st.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, perp: { slotWidth: 2.6, target: 'pillar' }, scenario: 'frontPerp' }));
    const s = loadSettings(st);
    expect(s.perp).toEqual({ slotWidth: 2.6, target: 'pillar', crooked: false });
    expect(s.scenario).toBe('frontPerp');
    for (const scenario of ['rearPerpOut', 'frontPerpOut', 'parallelOut', 'alley', 'uturn', 'kiosk'] as const) {
      expect(sanitizeSettings({ scenario }).scenario).toBe(scenario);
    }
  });
});

describe('optionsFor', () => {
  it('설정의 시나리오 종류와 옵션', () => {
    const s = sanitizeSettings({ perp: { slotWidth: 2.3, target: 'pillar' }, parallel: { slotLength: 7 }, ramp: { innerRadius: 5 } });
    expect(optionsFor({ ...s, scenario: 'rearPerp' })).toEqual({ kind: 'rearPerp', opts: { slotWidth: 2.3, target: 'pillar' } });
    expect(optionsFor({ ...s, scenario: 'frontPerp' })).toEqual({ kind: 'frontPerp', opts: { slotWidth: 2.3, target: 'pillar' } });
    expect(optionsFor({ ...s, scenario: 'parallel' })).toEqual({ kind: 'parallel', opts: { slotLength: 7 } });
    expect(optionsFor({ ...s, scenario: 'ramp' })).toEqual({ kind: 'ramp', opts: { innerRadius: 5 } });
    expect(optionsFor({ ...s, scenario: 'rearPerpOut' })).toEqual({ kind: 'rearPerpOut', opts: { slotWidth: 2.3, target: 'pillar' } });
    expect(optionsFor({ ...s, scenario: 'frontPerpOut' })).toEqual({ kind: 'frontPerpOut', opts: { slotWidth: 2.3, target: 'pillar' } });
    expect(optionsFor({ ...s, scenario: 'parallelOut' })).toEqual({ kind: 'parallelOut', opts: { slotLength: 7 } });
    for (const kind of ['alley', 'uturn', 'kiosk'] as const) expect(optionsFor({ ...s, scenario: kind })).toEqual({ kind, opts: {} });
  });

  it('crooked가 꺼져 있으면 직각 옵션 객체가 예전과 키 순서까지 같고, 켜면 crooked: true가 붙는다 (직각 주차·출차 4종)', () => {
    const off = sanitizeSettings({ perp: { slotWidth: 2.3, target: 'pillar' } });
    const on = sanitizeSettings({ perp: { slotWidth: 2.3, target: 'pillar', crooked: true } });
    for (const kind of ['rearPerp', 'frontPerp', 'rearPerpOut', 'frontPerpOut'] as const) {
      expect(JSON.stringify(optionsFor({ ...off, scenario: kind }).opts)).toBe('{"slotWidth":2.3,"target":"pillar"}');
      expect(JSON.stringify(optionsFor({ ...on, scenario: kind }).opts)).toBe('{"slotWidth":2.3,"target":"pillar","crooked":true}');
    }
    // 평행 출차와 옵션 없는 코스는 crooked를 보지 않는다
    expect(optionsFor({ ...on, scenario: 'parallelOut' }).opts).toEqual({ slotLength: 6 });
    expect(optionsFor({ ...on, scenario: 'alley' }).opts).toEqual({});
  });
});
