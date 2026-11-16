import type { Scenario, ScenarioKind } from '../scenarios/types';
import type { AttemptEvents } from './attempt';
import type { Pose } from './geometry';
import { polylinePolygonDistance, polyToWorld } from './geometry';
import type { GoalEval } from './goal';
import type { VehicleSpec } from './specs';
import type { WorldElement } from './world';

// 점수 (계약서 §5.1). 성공한 시도를 고정된 식으로 0–100점 매긴다.

export type ScoreKey =
  | 'angle'
  | 'center'
  | 'curbGap'
  | 'doorLeft'
  | 'doorRight'
  | 'moves'
  | 'time'
  | 'curb'
  // 상황 6종 (계약서 개정 2026-11-16 situations)
  | 'gap'
  | 'reach'
  | 'align';

export interface ScoreItem {
  key: ScoreKey;
  /** 0.1점 단위로 반올림 */
  points: number;
  max: number;
  /**
   * 원래 값 (°, m, 회, 초): angle = angleErrDeg, center = |offset.across|, curbGap = margin.right,
   * doorLeft·doorRight = 문 여유, moves = 실제 전·후진 전환 수 (기준 횟수를 빼지 않음), time = 소요 시간, curb = 연석 접촉 수,
   * gap = 시도 중 가장 가까이 간 거리 (minGap), reach = 창문 쪽 차체 → 발권기 앞면, align = |창문(눈) − 발권기 중심| (앞뒤).
   * 잴 수 없으면 null (slot인데 doors가 null인 문 항목, minGap·kiosk가 없는 gap·reach·align).
   */
  value: number | null;
}

/** total = 항목 points(0.1 단위)의 합을 반올림, 0..100 */
export interface ScoreResult {
  total: number;
  items: ScoreItem[];
}

export interface ScoreInput {
  kind: ScenarioKind;
  ev: GoalEval;
  /** 문 여유 (doorClearances). bay 계열(주차 3종)만 쓴다. 다른 계열은 보지 않으니 null을 넘긴다 */
  doors: { left: number; right: number } | null;
  events: AttemptEvents;
  /** sc.scorePar: 전환 기준 횟수(SCORE_PAR의 moves)와 gap 만점 거리(기본 0.20 m)를 덮어쓴다 */
  par?: Scenario['scorePar'];
  /** 시도 중 가장 가까이 간 거리 (clearance, m). alley·uturn의 gap 항목. 없으면(undefined·null) gap은 0점 */
  minGap?: number | null;
  /** 발권기 판정의 reach·along (kioskEval, m). kiosk의 reach·align 항목. 없으면 두 항목 0점 */
  kiosk?: { reach: number; along: number };
}

/** 점수 항목 계열 (계약서 개정 2026-11-16 situations). 종류마다 정해져 있어 zone 종류가 문 여유 항목에 닿지 않는다 */
export const FAMILY: Record<ScenarioKind, 'bay' | 'ramp' | 'pullOut' | 'alley' | 'uturn' | 'kiosk'> = {
  rearPerp: 'bay',
  frontPerp: 'bay',
  parallel: 'bay',
  ramp: 'ramp',
  rearPerpOut: 'pullOut',
  frontPerpOut: 'pullOut',
  parallelOut: 'pullOut',
  alley: 'alley',
  uturn: 'uturn',
  kiosk: 'kiosk',
};

/** gap 항목: 이 거리(m) 이상 떨어져 지나가면 만점 (ScoreInput.par.gapFull이 덮어쓴다), 0.02 m 이하면 0점 */
const GAP_FULL = 0.2;

/** moves = 감점 없는 전·후진 전환 수, tGood·tBad = 시간 만점·0점 (초) */
export const SCORE_PAR: Record<ScenarioKind, { moves: number; tGood: number; tBad: number }> = {
  rearPerp: { moves: 1, tGood: 35, tBad: 120 },
  // 1 = 실제 출발 자세에서 찾은 최소 전환 수 (모델 Y, 2.5 m between). 근거: 계약서 Amendments 2026-11-15 v3-prep-par
  frontPerp: { moves: 1, tGood: 30, tBad: 120 },
  // 2 = 기본 칸(6.0 m)에서 모델 Y의 전환 1회 이하 주차는 기하상 불가능 → 같은 규칙(찾은 최소, 최대 2). 근거: 계약서 Amendments 2026-11-15 v3-fix
  parallel: { moves: 2, tGood: 40, tBad: 150 },
  // 80·200 (예전 60·180) = 속도 상한(5 km/h, 계약서 개정 2026-11-16 controls)에 맞춘 값: tGood ≥ 1.5 × 상한에서 걸리는 최소 시간 (가드: tests/narrowRamp.test.ts)
  ramp: { moves: 0, tGood: 80, tBad: 200 },
  // 아래 6종 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C6): 해결 가능성 증명 주행에서 정한다.
  // tGood = ceil5(max(1.8 × T(모델 Y, 기본 옵션), 1.5 × 증명한 차·옵션의 최대 T)), tBad = tGood + 120,
  // moves = 모델 Y 기본 옵션 증명의 전환 수. T = 증명 주행을 속도 상한으로 따라 하는 최소 시간 (초, tests/helpers/pursuit.ts proofTime).
  // 증명한 차: 출차는 프리셋 8종, 골목·유턴·발권기는 극단 치수 3종까지 11대. 각 테스트 파일의 시간 가드가 tGood ≥ 1.5 × T를 지킨다.
  // rearPerpOut: T 모델 Y 9.80, 최대 10.40 (모델 Y 2.6 m 기둥 옆, 비뚤게) → max(17.64, 15.60) → 20
  rearPerpOut: { moves: 0, tGood: 20, tBad: 140 },
  // frontPerpOut: T 모델 Y 13.95, 최대 20.50 (쏘렌토 2.5 m 차 사이, 비뚤게) → max(25.11, 30.75) → 35
  frontPerpOut: { moves: 1, tGood: 35, tBad: 155 },
  // parallelOut: T 모델 Y 14.67 (6.0 m), 최대 15.30 (K3 6.0 m) → max(26.40, 22.95) → 30
  parallelOut: { moves: 3, tGood: 30, tBad: 150 },
  // alley: T 모델 Y 40.42, 최대 44.58 (WIDE_SWING) → max(72.75, 66.88) → 75
  alley: { moves: 0, tGood: 75, tBad: 195 },
  // uturn: T 모델 Y 15.30, 최대 20.08 (WIDE_SWING) → max(27.54, 30.13) → 35
  uturn: { moves: 2, tGood: 35, tBad: 155 },
  // kiosk: T 모델 Y 11.98, 최대 12.62 (WIDE_SWING) → max(21.57, 18.93) → 25
  kiosk: { moves: 0, tGood: 25, tBad: 145 },
};

/** `full`에서 1, `zero`에서 0, 그 사이는 직선이고 밖은 잘라 낸다 (full < zero, full > zero 모두 가능). */
export function lin(v: number, full: number, zero: number): number {
  // 바깥 max가 −0(= 0 / 음수)을 +0으로 바꾼다
  return Math.max(0, Math.min(1, (v - zero) / (full - zero)));
}

function item(key: ScoreKey, max: number, frac: number, value: number | null): ScoreItem {
  return { key, points: Math.round(max * frac * 10) / 10, max, value };
}

/**
 * 전제: ev.success. 성공이 아니거나 충돌한 시도(events.collisions > 0)는 { total: 0, items: [] }.
 * evaluateGoal은 미러를 보지 않으므로, 차체가 칸 안에 있는 채 미러가 부딪힌 시도도 success일 수 있다.
 * 항목은 FAMILY 계열마다 다르다 (발권기의 ev는 kioskEval 결과).
 */
export function scoreAttempt(inp: ScoreInput): ScoreResult {
  const { kind, ev, doors, events } = inp;
  if (!ev.success || events.collisions > 0) return { total: 0, items: [] };
  const par = SCORE_PAR[kind];
  const extra = Math.max(0, events.dirChanges - (inp.par?.moves ?? par.moves));
  // 잴 수 없는 거리에는 점수를 주지 않는다 (minGap이 없으면 0점)
  const gap = inp.minGap ?? null;
  const gapFull = inp.par?.gapFull ?? GAP_FULL;
  const gapItem = (max: number) => item('gap', max, gap === null ? 0 : lin(gap, gapFull, 0.02), gap);
  const family = FAMILY[kind];
  let items: ScoreItem[];
  if (family === 'ramp') {
    items = [
      item('curb', 40, lin(events.curbTouches, 0, 4), events.curbTouches),
      item('moves', 30, lin(extra, 0, 3), events.dirChanges),
      item('time', 30, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
    ];
  } else if (family === 'bay') {
    const across = Math.abs(ev.offset.across);
    items = [
      item('angle', 20, lin(ev.angleErrDeg, 1, 5), ev.angleErrDeg),
      kind === 'parallel'
        ? item('curbGap', 20, lin(ev.margin.right, 0.1, 0.4), ev.margin.right)
        : item('center', 20, lin(across, 0.05, 0.3), across),
      // doors가 없으면(잴 수 없음) 만점: 주변에 장애물이 없을 때 doorClearances가 상한을 돌려주는 것과 같게 본다
      item('doorLeft', 10, doors ? lin(doors.left, 0.6, 0.2) : 1, doors?.left ?? null),
      item('doorRight', 10, doors ? lin(doors.right, 0.6, 0.2) : 1, doors?.right ?? null),
      item('moves', 15, lin(extra, 0, 4), events.dirChanges),
      item('time', 15, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
      item('curb', 10, lin(events.curbTouches, 0, 2), events.curbTouches),
    ];
  } else if (family === 'pullOut') {
    items =
      kind === 'parallelOut'
        ? [
            item('curb', 20, lin(events.curbTouches, 0, 2), events.curbTouches),
            item('moves', 50, lin(extra, 0, 3), events.dirChanges),
            item('time', 30, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
          ]
        : [
            item('moves', 60, lin(extra, 0, 3), events.dirChanges),
            item('time', 40, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
          ];
  } else if (family === 'alley') {
    items = [
      gapItem(50),
      item('moves', 20, lin(extra, 0, 2), events.dirChanges),
      item('time', 30, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
    ];
  } else if (family === 'uturn') {
    items = [
      item('moves', 40, lin(extra, 0, 4), events.dirChanges),
      gapItem(30),
      item('time', 30, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
    ];
  } else {
    // kiosk: 창문 기준 판정값이 없으면 reach·align은 0점
    const k = inp.kiosk;
    items = [
      item('reach', 30, k ? lin(k.reach, 0.2, 0.3) : 0, k ? k.reach : null),
      item('align', 20, k ? lin(Math.abs(k.along), 0.1, 0.4) : 0, k ? Math.abs(k.along) : null),
      item('angle', 10, lin(ev.angleErrDeg, 1, 3), ev.angleErrDeg),
      item('moves', 10, lin(extra, 0, 2), events.dirChanges),
      item('time', 15, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
      item('curb', 15, lin(events.curbTouches, 0, 2), events.curbTouches),
    ];
  }
  // 0.1점 단위 정수로 더해 부동소수 오차 없이 반올림한다 (결과 카드의 항목을 더하면 총점과 맞는다)
  const tenths = items.reduce((s, it) => s + Math.round(it.points * 10), 0);
  return { total: Math.max(0, Math.min(100, Math.round(tenths / 10))), items };
}

/** 문을 여는 높이 범위 (m). 높이가 이 범위와 겹치는 solid만 문 여유를 줄인다. */
const DOOR_H_MIN = 0.3;
const DOOR_H_MAX = 1.2;
/** doorClearances의 기본 상한 (m). 이 값은 잰 거리가 아니라 '이 이상'이다 (결과 카드가 ≥로 보인다). */
export const DOOR_CAP = 1.0;

/**
 * 양쪽 문 여유 (m): 앞뒤 바퀴 사이 차체 옆면 선분(차량 좌표 x ∈ [tireDiameter/2 + 0.1, wheelbase − tireDiameter/2 − 0.1],
 * y = ±width/2)에서 가장 가까운 solid까지 거리, 최대 cap. 연석·휠스톱·선은 무시한다.
 * cap은 차폭보다 작아야 한다 (그래야 반대편 장애물이 차체 너머로 잡히지 않는다. 기본 1.0 < 직접 입력 최소 폭 1.4).
 */
export function doorClearances(
  spec: VehicleSpec,
  pose: Pose,
  elements: WorldElement[],
  cap = DOOR_CAP,
): { left: number; right: number } {
  const x0 = spec.tireDiameter / 2 + 0.1;
  const x1 = spec.wheelbase - spec.tireDiameter / 2 - 0.1;
  const solids = elements.filter((el) => el.kind === 'solid' && el.hMin < DOOR_H_MAX && el.hMax > DOOR_H_MIN);
  const side = (y: number) => {
    const seg = polyToWorld([{ x: x0, y }, { x: x1, y }], pose);
    let d = cap;
    for (const el of solids) d = Math.min(d, polylinePolygonDistance(seg, el.poly));
    return d;
  };
  return { left: side(spec.width / 2), right: side(-spec.width / 2) };
}
