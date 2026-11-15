import type { ScenarioKind } from '../scenarios/types';
import type { AttemptEvents } from './attempt';
import type { Pose } from './geometry';
import { polylinePolygonDistance, polyToWorld } from './geometry';
import type { GoalEval } from './goal';
import type { VehicleSpec } from './specs';
import type { WorldElement } from './world';

// 점수 (계약서 §5.1). 성공한 시도를 고정된 식으로 0–100점 매긴다.

export type ScoreKey = 'angle' | 'center' | 'curbGap' | 'doorLeft' | 'doorRight' | 'moves' | 'time' | 'curb';

export interface ScoreItem {
  key: ScoreKey;
  /** 0.1점 단위로 반올림 */
  points: number;
  max: number;
  /**
   * 원래 값 (°, m, 회, 초): angle = angleErrDeg, center = |offset.across|, curbGap = margin.right,
   * doorLeft·doorRight = 문 여유, moves = 실제 전·후진 전환 수 (기준 횟수를 빼지 않음), time = 소요 시간, curb = 연석 접촉 수.
   * 잴 수 없으면 null (slot인데 doors가 null인 문 항목).
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
  /** slot 목표의 문 여유 (doorClearances). zone(램프)은 null */
  doors: { left: number; right: number } | null;
  events: AttemptEvents;
}

/** moves = 감점 없는 전·후진 전환 수, tGood·tBad = 시간 만점·0점 (초) */
export const SCORE_PAR: Record<ScenarioKind, { moves: number; tGood: number; tBad: number }> = {
  rearPerp: { moves: 1, tGood: 35, tBad: 120 },
  // 1 = 실제 출발 자세에서 찾은 최소 전환 수 (모델 Y, 2.5 m between). 근거: 계약서 Amendments 2026-11-15 v3-prep-par
  frontPerp: { moves: 1, tGood: 30, tBad: 120 },
  // 2 = 기본 칸(6.0 m)에서 모델 Y의 전환 1회 이하 주차는 기하상 불가능 → 같은 규칙(찾은 최소, 최대 2). 근거: 계약서 Amendments 2026-11-15 v3-fix
  parallel: { moves: 2, tGood: 40, tBad: 150 },
  ramp: { moves: 0, tGood: 60, tBad: 180 },
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
 */
export function scoreAttempt(inp: ScoreInput): ScoreResult {
  const { kind, ev, doors, events } = inp;
  if (!ev.success || events.collisions > 0) return { total: 0, items: [] };
  const par = SCORE_PAR[kind];
  const extra = Math.max(0, events.dirChanges - par.moves);
  let items: ScoreItem[];
  if (kind === 'ramp') {
    items = [
      item('curb', 40, lin(events.curbTouches, 0, 4), events.curbTouches),
      item('moves', 30, lin(extra, 0, 3), events.dirChanges),
      item('time', 30, lin(events.elapsed, par.tGood, par.tBad), events.elapsed),
    ];
  } else {
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
