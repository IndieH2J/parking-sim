import { describe, expect, it } from 'vitest';
import type { AttemptSummary, RecordsFile } from '../src/sim/records';
import {
  addAttempt,
  clearEntry,
  emptyRecords,
  loadRecords,
  MAX_RECENT,
  parseRecords,
  recordKey,
  RECORDS_KEY,
  saveRecords,
} from '../src/sim/records';

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

const KEY = 'rearPerp|w2.50|between|model-y-2025';
const OTHER = 'ramp|r6|model-y-2025';

function success(score: number, at = 1): AttemptSummary {
  return { at, outcome: 'success', score, time: 42.5, moves: 1, curb: 0, angleErrDeg: 1.5 };
}

function crash(at = 1, score = 0): AttemptSummary {
  return { at, outcome: 'crash', score, time: 12, moves: 0, curb: 1, angleErrDeg: null };
}

/** 시도 여러 개를 차례로 넣는다 */
function addAll(file: RecordsFile, key: string, list: AttemptSummary[]): RecordsFile {
  return list.reduce((f, a) => addAttempt(f, key, a).file, file);
}

/** 고치려 하면 TypeError가 나도록 깊이 얼린다 (ES 모듈은 strict mode) */
function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

describe('상수와 빈 파일', () => {
  it('계약서 §5.2 값', () => {
    expect(RECORDS_KEY).toBe('parking-sim.records.v1');
    expect(MAX_RECENT).toBe(10);
    expect(emptyRecords()).toEqual({ v: 1, entries: {} });
  });

  it('emptyRecords는 매번 새 객체', () => {
    const a = emptyRecords();
    a.entries[KEY] = { best: null, recent: [] };
    expect(emptyRecords().entries).toEqual({});
  });
});

describe('recordKey', () => {
  it('계약서 §5.2 형식', () => {
    expect(recordKey('rearPerp', { slotWidth: 2.5, target: 'between' }, 'model-y-2025')).toBe(KEY);
    expect(recordKey('frontPerp', { slotWidth: 2.3, target: 'pillar' }, 'sonata')).toBe('frontPerp|w2.30|pillar|sonata');
    expect(recordKey('parallel', { slotLength: 6 }, 'k5')).toBe('parallel|L6.00|k5');
    expect(recordKey('ramp', { innerRadius: 6 }, 'model-y-2025')).toBe(OTHER);
    expect(recordKey('ramp', { innerRadius: 5 }, 'avante')).toBe('ramp|r5|avante');
    const custom = 'custom:4790x1920x2129x1624x2890x889x1636x1213';
    expect(recordKey('parallel', { slotLength: 6.5 }, custom)).toBe(`parallel|L6.50|${custom}`);
  });

  it('직접 입력 값은 소수 둘째 자리로 맞추고 seed는 키에 넣지 않는다', () => {
    expect(recordKey('rearPerp', { slotWidth: 2.35, target: 'between' }, 'm')).toBe('rearPerp|w2.35|between|m');
    expect(recordKey('rearPerp', { slotWidth: 2.5 - 1e-12, target: 'between', seed: 3 }, 'model-y-2025')).toBe(KEY);
    expect(recordKey('parallel', { slotLength: 5.8 + 0.1 * 3 }, 'm')).toBe('parallel|L6.10|m');
  });
});

describe('addAttempt', () => {
  it('12번 넣으면 최근 기록은 10개, 최신 순', () => {
    const list = Array.from({ length: 12 }, (_, i) => success(50 + i, i + 1));
    const recent = addAll(emptyRecords(), KEY, list).entries[KEY].recent;
    expect(recent).toHaveLength(MAX_RECENT);
    expect(recent.map((a) => a.at)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it('첫 성공은 새 최고 기록', () => {
    const { file, newBest } = addAttempt(emptyRecords(), KEY, success(70));
    expect(newBest).toBe(true);
    expect(file.entries[KEY]).toEqual({ best: success(70), recent: [success(70)] });
  });

  it('더 낮은 점수와 같은 점수는 기존 최고 기록을 유지하고, 더 높은 점수만 바꾼다', () => {
    const first = addAttempt(emptyRecords(), KEY, success(80, 1)).file;
    const lower = addAttempt(first, KEY, success(60, 2));
    expect(lower.newBest).toBe(false);
    expect(lower.file.entries[KEY].best).toEqual(success(80, 1));
    const equal = addAttempt(lower.file, KEY, success(80, 3));
    expect(equal.newBest).toBe(false);
    expect(equal.file.entries[KEY].best?.at).toBe(1);
    const higher = addAttempt(equal.file, KEY, success(81, 4));
    expect(higher.newBest).toBe(true);
    expect(higher.file.entries[KEY].best).toEqual(success(81, 4));
    expect(higher.file.entries[KEY].recent.map((a) => a.at)).toEqual([4, 3, 2, 1]);
  });

  it('충돌은 최고 기록이 되지 않고 0점으로 최근 기록에만 들어간다', () => {
    const first = addAttempt(emptyRecords(), KEY, crash(1, 55));
    expect(first.newBest).toBe(false);
    expect(first.file.entries[KEY]).toEqual({ best: null, recent: [crash(1, 0)] });
    const after = addAttempt(addAttempt(emptyRecords(), KEY, success(40, 1)).file, KEY, crash(2));
    expect(after.newBest).toBe(false);
    expect(after.file.entries[KEY].best).toEqual(success(40, 1));
    expect(after.file.entries[KEY].recent.map((a) => a.outcome)).toEqual(['crash', 'success']);
  });

  it('최고 기록은 최근 목록에서 밀려나도 남는다', () => {
    const later = Array.from({ length: MAX_RECENT }, (_, i) => success(10, i + 2));
    const entry = addAll(emptyRecords(), KEY, [success(95, 1), ...later]).entries[KEY];
    expect(entry.best).toEqual(success(95, 1));
    expect(entry.recent.some((a) => a.at === 1)).toBe(false);
  });

  it('입력 파일과 요약을 바꾸지 않고, 다른 조건은 그대로 둔다', () => {
    const base = deepFreeze(addAttempt(emptyRecords(), OTHER, success(90, 1)).file);
    const before = JSON.stringify(base);
    const a = deepFreeze(success(70, 2));
    const { file } = addAttempt(base, KEY, a);
    addAttempt(base, OTHER, success(99, 3));
    addAttempt(base, OTHER, crash(4));
    expect(JSON.stringify(base)).toBe(before);
    expect(file).not.toBe(base);
    expect(file.entries[OTHER]).toEqual(base.entries[OTHER]);
    expect(file.entries[KEY].recent[0]).toEqual(a);
    expect(file.entries[KEY].recent[0]).not.toBe(a);
  });
});

describe('clearEntry', () => {
  it('그 조건만 지우고 입력은 그대로 둔다', () => {
    const f = deepFreeze(addAttempt(addAttempt(emptyRecords(), KEY, success(50)).file, OTHER, crash()).file);
    const cleared = clearEntry(f, KEY);
    expect(Object.keys(cleared.entries)).toEqual([OTHER]);
    expect(Object.keys(f.entries).sort()).toEqual([KEY, OTHER].sort());
    expect(clearEntry(cleared, 'parallel|L6.00|k5')).toEqual(cleared);
  });
});

describe('parseRecords', () => {
  it('null, 손상된 JSON, 최상위 모양이 틀린 데이터 → 빈 파일', () => {
    const bad = [
      null,
      '',
      '{',
      '{"v":1,"entries":{"a":',
      'null',
      '42',
      '"x"',
      '[]',
      '{}',
      '{"v":1}',
      '{"v":1,"entries":[]}',
      '{"v":1,"entries":null}',
      '{"v":"1","entries":{}}',
    ];
    for (const raw of bad) expect(parseRecords(raw)).toEqual(emptyRecords());
  });

  it('다른 버전 → 빈 파일', () => {
    const f = addAttempt(emptyRecords(), KEY, success(70)).file;
    expect(parseRecords(JSON.stringify({ ...f, v: 2 }))).toEqual(emptyRecords());
  });

  it('저장 → 읽기 왕복', () => {
    const f = addAttempt(addAll(emptyRecords(), KEY, [success(70, 1), crash(2), success(85, 3)]), OTHER, success(60, 4)).file;
    expect(parseRecords(JSON.stringify(f))).toEqual(f);
  });

  it('잘못된 요약과 항목만 버린다', () => {
    const good = success(70, 1);
    const raw = JSON.stringify({
      v: 1,
      entries: {
        // best의 NaN은 JSON에서 null이 된다 → best만 버림
        [KEY]: {
          best: { ...good, score: NaN },
          recent: [good, { ...good, outcome: 'win' }, { ...good, at: '2026' }, null, 5, crash(2), { ...good, angleErrDeg: undefined }],
        },
        [OTHER]: 'garbage',
        // 충돌은 최고 기록이 될 수 없고 recent도 없다 → 남는 것이 없어 항목을 버림
        'frontPerp|w2.50|between|k5': { best: crash(3), recent: 'x' },
        // 최고 기록만 남음
        'parallel|L6.00|k5': { best: success(88, 4), recent: null },
      },
    });
    const f = parseRecords(raw);
    expect(Object.keys(f.entries).sort()).toEqual([KEY, 'parallel|L6.00|k5'].sort());
    expect(f.entries[KEY]).toEqual({ best: null, recent: [good, crash(2)] });
    expect(f.entries['parallel|L6.00|k5']).toEqual({ best: success(88, 4), recent: [] });
  });

  it('최근 기록이 10개보다 많으면 자르고, 모르는 필드는 버린다', () => {
    const recent = Array.from({ length: 13 }, (_, i) => ({ ...success(50, i), extra: 'x' }));
    const f = parseRecords(JSON.stringify({ v: 1, entries: { [KEY]: { best: null, recent } } }));
    expect(f.entries[KEY].recent).toHaveLength(MAX_RECENT);
    expect(f.entries[KEY].recent[0]).toEqual(success(50, 0));
  });
});

describe('loadRecords · saveRecords', () => {
  it('Map 저장소로 왕복, 키는 RECORDS_KEY 하나', () => {
    const s = new MemStorage();
    const f = addAttempt(emptyRecords(), KEY, success(77)).file;
    expect(saveRecords(s, f)).toBe(true);
    expect([...s.m.keys()]).toEqual([RECORDS_KEY]);
    expect(loadRecords(s)).toEqual(f);
  });

  it('비어 있거나 손상된 저장소 → 빈 파일', () => {
    const s = new MemStorage();
    expect(loadRecords(s)).toEqual(emptyRecords());
    s.setItem(RECORDS_KEY, '{"v":1,"entries":{"a":');
    expect(loadRecords(s)).toEqual(emptyRecords());
  });

  it('저장소 없음(null) → 빈 파일, 저장 false', () => {
    expect(loadRecords(null)).toEqual(emptyRecords());
    expect(saveRecords(null, emptyRecords())).toBe(false);
  });

  it('예외를 던지는 저장소에서도 멈추지 않는다', () => {
    expect(() => loadRecords(throwing)).not.toThrow();
    expect(loadRecords(throwing)).toEqual(emptyRecords());
    expect(saveRecords(throwing, emptyRecords())).toBe(false);
  });
});
