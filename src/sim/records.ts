import type { AnyScenarioOptions, ParallelOptions, PerpOptions, RampOptions, ScenarioKind } from '../scenarios/types';

// 기록 (계약서 §5.2). 조건(시나리오 + 옵션 + 차)마다 최고 기록 하나와 최근 기록 MAX_RECENT개.
// 순수 함수 + 저장소를 인자로 받는 얇은 저장 함수. 리플레이는 저장하지 않는다.

export interface AttemptSummary {
  /** 시각 (ms, Date.now()) */
  at: number;
  outcome: 'success' | 'crash';
  /** 0..100. 충돌은 0 */
  score: number;
  /** 소요 시간 (초) */
  time: number;
  /** 전·후진 전환 수 */
  moves: number;
  /** 연석 접촉 수 */
  curb: number;
  /** 요구 방향과의 각도 차 (°). 판정이 없으면 null */
  angleErrDeg: number | null;
}

export interface RecordEntry {
  /** 가장 높은 점수의 성공. 충돌은 최고 기록이 되지 않는다. */
  best: AttemptSummary | null;
  /** 최신 순, MAX_RECENT개 이하 */
  recent: AttemptSummary[];
}

export interface RecordsFile {
  v: 1;
  entries: Record<string, RecordEntry>;
}

export const RECORDS_KEY = 'parking-sim.records.v1';
export const MAX_RECENT = 10;

/** 조건 키. vehicleKey는 src/sim/vehicles.ts의 vehicleKey() 결과. */
export function recordKey(kind: ScenarioKind, opts: AnyScenarioOptions, vehicleKey: string): string {
  switch (kind) {
    case 'rearPerp':
    case 'frontPerp': {
      const o = opts as PerpOptions;
      return `${kind}|w${o.slotWidth.toFixed(2)}|${o.target}|${vehicleKey}`;
    }
    case 'parallel':
      return `parallel|L${(opts as ParallelOptions).slotLength.toFixed(2)}|${vehicleKey}`;
    case 'ramp':
      return `ramp|r${(opts as RampOptions).innerRadius}|${vehicleKey}`;
  }
}

export function emptyRecords(): RecordsFile {
  return { v: 1, entries: {} };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 저장된 요약 하나. 모양이 틀리면 null, 모르는 필드는 버린다. */
function toSummary(v: unknown): AttemptSummary | null {
  if (!isObj(v)) return null;
  const { at, outcome, score, time, moves, curb, angleErrDeg } = v;
  if (!isNum(at) || !isNum(score) || !isNum(time) || !isNum(moves) || !isNum(curb)) return null;
  if (outcome !== 'success' && outcome !== 'crash') return null;
  if (angleErrDeg !== null && !isNum(angleErrDeg)) return null;
  return { at, outcome, score, time, moves, curb, angleErrDeg };
}

/** 저장된 항목 하나. 잘못된 요약은 버리고, 남는 것이 없으면 null. */
function toEntry(v: unknown): RecordEntry | null {
  if (!isObj(v)) return null;
  const best = toSummary(v.best);
  const recent = Array.isArray(v.recent)
    ? v.recent
        .map(toSummary)
        .filter((s): s is AttemptSummary => s !== null)
        .slice(0, MAX_RECENT)
    : [];
  const e: RecordEntry = { best: best?.outcome === 'success' ? best : null, recent };
  return e.best || e.recent.length > 0 ? e : null;
}

/**
 * 손상된 JSON, 최상위 모양이 틀린 데이터, 다른 버전 → 빈 파일.
 * 그 아래는 잘못된 항목·요약만 버린다 (NaN 같은 숫자 하나가 JSON에서 null이 되어 기록 전체가 지워지지 않게).
 */
export function parseRecords(raw: string | null): RecordsFile {
  if (raw === null) return emptyRecords();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyRecords();
  }
  if (!isObj(data) || data.v !== 1 || !isObj(data.entries)) return emptyRecords();
  const entries: [string, RecordEntry][] = [];
  for (const [k, v] of Object.entries(data.entries)) {
    const e = toEntry(v);
    if (e) entries.push([k, e]);
  }
  return { v: 1, entries: Object.fromEntries(entries) };
}

/**
 * 순수 함수: 새 파일을 돌려주고 입력은 바꾸지 않는다. 충돌은 0점으로 최근 기록에만 들어간다.
 * newBest = 성공이고 기존 최고 기록이 없거나 점수가 더 높을 때 (같은 점수면 기존 기록 유지).
 * 키 정리는 하지 않는다 (조건마다 작은 요약 11개라 저장소 한도보다 훨씬 작다).
 */
export function addAttempt(file: RecordsFile, key: string, a: AttemptSummary): { file: RecordsFile; newBest: boolean } {
  const s: AttemptSummary = a.outcome === 'crash' ? { ...a, score: 0 } : { ...a };
  const prev = file.entries[key];
  const newBest = s.outcome === 'success' && (!prev?.best || s.score > prev.best.score);
  const entry: RecordEntry = {
    best: newBest ? s : (prev?.best ?? null),
    recent: [s, ...(prev?.recent ?? [])].slice(0, MAX_RECENT),
  };
  return { file: { v: 1, entries: { ...file.entries, [key]: entry } }, newBest };
}

/** 그 조건의 기록을 지운 새 파일 */
export function clearEntry(file: RecordsFile, key: string): RecordsFile {
  const entries = { ...file.entries };
  delete entries[key];
  return { v: 1, entries };
}

/** 저장소가 없거나 읽기가 실패하면 빈 파일 */
export function loadRecords(storage: Pick<Storage, 'getItem'> | null): RecordsFile {
  try {
    return parseRecords(storage?.getItem(RECORDS_KEY) ?? null);
  } catch {
    return emptyRecords();
  }
}

/** 저장했으면 true. 저장소가 없거나 쓰기가 실패하면(사생활 보호 모드, 용량 초과) false */
export function saveRecords(storage: Pick<Storage, 'setItem'> | null, file: RecordsFile): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RECORDS_KEY, JSON.stringify(file));
    return true;
  } catch {
    return false;
  }
}
