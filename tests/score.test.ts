import { describe, expect, it } from 'vitest';
import type { ScenarioKind } from '../src/scenarios/types';
import { SCENARIO_KINDS } from '../src/scenarios/types';
import type { AttemptEvents } from '../src/sim/attempt';
import type { Pose, Vec2 } from '../src/sim/geometry';
import { aabbRect } from '../src/sim/geometry';
import type { GoalEval } from '../src/sim/goal';
import type { ScoreItem, ScoreKey, ScoreResult } from '../src/sim/score';
import { doorClearances, lin, SCORE_PAR, scoreAttempt } from '../src/sim/score';
import { MODEL_Y_2025 } from '../src/sim/specs';
import type { ElementKind, WorldElement } from '../src/sim/world';

/** 성공한 판정: 칸 정중앙, 각도 0. 필요한 값만 덮어쓴다. */
function goodEval(o: Partial<GoalEval> = {}): GoalEval {
  return {
    inside: true,
    angleErrDeg: 0,
    headingOk: true,
    success: true,
    margin: { front: 0.1, back: 0.1, left: 0.2, right: 0.05 },
    mirrorMargin: { left: 0.1, right: 0.1 },
    offset: { along: 0, across: 0 },
    ...o,
  };
}

/** 깔끔한 시도: 전환 0회, 10초, 연석 접촉 0회, 충돌 없음 */
function cleanEvents(o: Partial<AttemptEvents> = {}): AttemptEvents {
  return { dirChanges: 0, elapsed: 10, curbTouches: 0, collisions: 0, ...o };
}

interface Case {
  ev?: Partial<GoalEval>;
  events?: Partial<AttemptEvents>;
  /** 생략하면 slot은 양쪽 1 m, ramp는 null (main.ts와 같은 방식) */
  doors?: { left: number; right: number } | null;
}

function score(kind: ScenarioKind, c: Case = {}): ScoreResult {
  const doors = c.doors === undefined ? (kind === 'ramp' ? null : { left: 1, right: 1 }) : c.doors;
  return scoreAttempt({ kind, ev: goodEval(c.ev), doors, events: cleanEvents(c.events) });
}

function get(r: ScoreResult, key: ScoreKey): ScoreItem {
  const it = r.items.find((i) => i.key === key);
  if (!it) throw new Error(`항목 없음: ${key}`);
  return it;
}

const pts = (r: ScoreResult, key: ScoreKey) => get(r, key).points;

describe('lin', () => {
  it('full < zero (작을수록 좋음): 양 끝, 중간, 범위 밖은 잘라 냄', () => {
    expect(lin(1, 1, 5)).toBe(1);
    expect(lin(3, 1, 5)).toBe(0.5);
    expect(lin(5, 1, 5)).toBe(0); // −0이 아니라 0
    expect(lin(0, 1, 5)).toBe(1);
    expect(lin(9, 1, 5)).toBe(0);
  });

  it('full > zero (클수록 좋음)', () => {
    expect(lin(0.6, 0.6, 0.2)).toBe(1);
    expect(lin(0.4, 0.6, 0.2)).toBeCloseTo(0.5, 12);
    expect(lin(0.2, 0.6, 0.2)).toBe(0);
    expect(lin(2, 0.6, 0.2)).toBe(1);
    expect(lin(0, 0.6, 0.2)).toBe(0);
  });
});

describe('SCORE_PAR', () => {
  it('계약서 §5.1 표 (frontPerp moves 1·parallel moves 2는 2026-11-15 개정)', () => {
    expect(SCORE_PAR).toEqual({
      rearPerp: { moves: 1, tGood: 35, tBad: 120 },
      frontPerp: { moves: 1, tGood: 30, tBad: 120 },
      parallel: { moves: 2, tGood: 40, tBad: 150 },
      ramp: { moves: 0, tGood: 60, tBad: 180 },
    });
  });

  it.each(SCENARIO_KINDS)('%s: 항목 max 합 = 100', (kind) => {
    expect(score(kind).items.reduce((s, i) => s + i.max, 0)).toBe(100);
  });
});

describe('scoreAttempt: 직각 주차 (slot)', () => {
  it.each(['rearPerp', 'frontPerp'] as const)('%s: 완벽한 주차는 100점, 7개 항목이 표 순서대로', (kind) => {
    const r = score(kind);
    expect(r.total).toBe(100);
    expect(r.items.map((i) => i.key)).toEqual(['angle', 'center', 'doorLeft', 'doorRight', 'moves', 'time', 'curb']);
    expect(r.items.map((i) => i.max)).toEqual([20, 20, 10, 10, 15, 15, 10]);
    for (const i of r.items) expect(i.points).toBe(i.max);
  });

  it('각도 3° → 10점. 1° 이하 만점, 5° 이상 0점', () => {
    const a = (angleErrDeg: number) => score('rearPerp', { ev: { angleErrDeg } });
    expect(pts(a(3), 'angle')).toBe(10);
    expect(a(3).total).toBe(90);
    expect(pts(a(1), 'angle')).toBe(20);
    expect(pts(a(0.4), 'angle')).toBe(20);
    expect(pts(a(5), 'angle')).toBe(0);
    expect(pts(a(12), 'angle')).toBe(0);
    expect(get(a(3), 'angle').value).toBe(3);
  });

  it('좌우 중앙: |offset.across| 0.05 m 이하 만점, 0.30 m 이상 0점, 좌우 대칭, along은 보지 않음', () => {
    const c = (across: number) => score('frontPerp', { ev: { offset: { along: 0.4, across } } });
    expect(pts(c(0.05), 'center')).toBe(20);
    expect(pts(c(-0.05), 'center')).toBe(20);
    expect(pts(c(0.175), 'center')).toBe(10);
    expect(pts(c(-0.175), 'center')).toBe(10);
    expect(pts(c(0.3), 'center')).toBe(0);
    expect(pts(c(-0.45), 'center')).toBe(0);
    expect(get(c(-0.175), 'center').value).toBe(0.175);
    expect(c(0).total).toBe(100);
  });

  it('문 여유: 0.60 m 이상 만점, 0.20 m 이하 0점, 좌우 따로', () => {
    const d = (left: number, right: number) => score('rearPerp', { doors: { left, right } });
    expect(pts(d(0.6, 1), 'doorLeft')).toBe(10);
    expect(pts(d(0.4, 1), 'doorLeft')).toBe(5);
    expect(pts(d(0.2, 1), 'doorLeft')).toBe(0);
    expect(pts(d(0.05, 1), 'doorLeft')).toBe(0);
    const r = d(1, 0.4);
    expect(pts(r, 'doorLeft')).toBe(10);
    expect(pts(r, 'doorRight')).toBe(5);
    expect(get(r, 'doorLeft').value).toBe(1);
    expect(get(r, 'doorRight').value).toBe(0.4);
    expect(r.total).toBe(95);
  });

  it('slot인데 doors가 null이면 문 항목은 value null, 만점', () => {
    const r = score('frontPerp', { doors: null });
    expect(get(r, 'doorLeft')).toEqual({ key: 'doorLeft', points: 10, max: 10, value: null });
    expect(get(r, 'doorRight')).toEqual({ key: 'doorRight', points: 10, max: 10, value: null });
    expect(r.total).toBe(100);
  });

  it('전·후진 전환: 기준(rearPerp·frontPerp 1회, parallel 2회)을 넘은 횟수로 감점, 2회 초과 → 7.5점', () => {
    const m = (kind: ScenarioKind, dirChanges: number) => pts(score(kind, { events: { dirChanges } }), 'moves');
    expect(m('rearPerp', 0)).toBe(15);
    expect(m('rearPerp', 1)).toBe(15);
    expect(m('rearPerp', 3)).toBe(7.5);
    expect(m('rearPerp', 5)).toBe(0);
    expect(m('rearPerp', 9)).toBe(0);
    // frontPerp: 기준 1회 = 만점, 기준 + 2회 = 7.5점
    expect(m('frontPerp', 0)).toBe(15);
    expect(m('frontPerp', 1)).toBe(15);
    expect(m('frontPerp', 2)).toBe(11.3); // 15 × 0.75 = 11.25 → 0.1점 단위 반올림
    expect(m('frontPerp', 3)).toBe(7.5);
    expect(m('frontPerp', 5)).toBe(0);
    // parallel: 기준 2회 (기본 6.0 m 칸에서 모델 Y의 1회 이하는 기하상 불가능, 2026-11-15 개정)
    expect(m('parallel', 1)).toBe(15);
    expect(m('parallel', 2)).toBe(15);
    expect(m('parallel', 3)).toBe(11.3);
    expect(m('parallel', 4)).toBe(7.5);
    // value는 실제 전환 수 (기준을 빼지 않음)
    expect(get(score('rearPerp', { events: { dirChanges: 3 } }), 'moves').value).toBe(3);
  });

  it('소요 시간: tGood 이하 만점, tBad 이상 0점, 사이는 직선', () => {
    const t = (kind: ScenarioKind, elapsed: number) => pts(score(kind, { events: { elapsed } }), 'time');
    expect(t('rearPerp', 35)).toBe(15);
    expect(t('rearPerp', 77.5)).toBe(7.5);
    expect(t('rearPerp', 120)).toBe(0);
    expect(t('rearPerp', 300)).toBe(0);
    expect(t('frontPerp', 30)).toBe(15);
    expect(t('frontPerp', 75)).toBe(7.5);
    expect(t('parallel', 40)).toBe(15);
    expect(t('parallel', 95)).toBe(7.5);
    expect(t('parallel', 150)).toBe(0);
    expect(get(score('rearPerp', { events: { elapsed: 77.5 } }), 'time').value).toBe(77.5);
  });

  it('연석 접촉: 0회 만점, 1회 5점, 2회 이상 0점', () => {
    const c = (curbTouches: number) => score('rearPerp', { events: { curbTouches } });
    expect(pts(c(0), 'curb')).toBe(10);
    expect(pts(c(1), 'curb')).toBe(5);
    expect(pts(c(2), 'curb')).toBe(0);
    expect(pts(c(5), 'curb')).toBe(0);
    expect(get(c(1), 'curb').value).toBe(1);
  });

  it('항목은 0.1점 단위, 총점은 반올림한 항목 점수의 합을 반올림', () => {
    // angle 18.46 → 18.5, center 19.96 → 20.0. 원래 값의 합 98.42는 98이지만 항목 합 98.5 → 99
    const r = score('rearPerp', { ev: { angleErrDeg: 1.308, offset: { along: 0, across: 0.0505 } } });
    expect(pts(r, 'angle')).toBe(18.5);
    expect(pts(r, 'center')).toBe(20);
    expect(r.total).toBe(99);
  });
});

describe('scoreAttempt: 평행 주차 (slot)', () => {
  const gap = (right: number, across = 0) =>
    score('parallel', { ev: { margin: { front: 0.3, back: 0.3, left: 0.1, right }, offset: { along: 0, across } } });

  it('center 대신 curbGap, 완벽하면 100점', () => {
    const r = gap(0.05);
    expect(r.items.map((i) => i.key)).toEqual(['angle', 'curbGap', 'doorLeft', 'doorRight', 'moves', 'time', 'curb']);
    expect(r.total).toBe(100);
  });

  it('margin.right 0.25 → curbGap 10점', () => {
    expect(pts(gap(0.25), 'curbGap')).toBe(10);
    expect(gap(0.25).total).toBe(90);
    expect(get(gap(0.25), 'curbGap').value).toBe(0.25);
  });

  it('경계: 연석까지 0.10 m 이하 만점, 0.40 m 이상 0점', () => {
    expect(pts(gap(0.1), 'curbGap')).toBe(20);
    expect(pts(gap(0), 'curbGap')).toBe(20);
    expect(pts(gap(0.4), 'curbGap')).toBe(0);
    expect(pts(gap(0.7), 'curbGap')).toBe(0);
    // 모델 Y가 칸 안에서 가질 수 있는 최대 간격 (§1.8.3 좌우 여유 15.5 cm)
    expect(pts(gap(0.155), 'curbGap')).toBe(16.3);
  });

  it('좌우 중앙 편차는 보지 않는다', () => {
    expect(gap(0.05, 0.5).total).toBe(100);
  });
});

describe('scoreAttempt: 램프 (zone)', () => {
  it('연석 1회, 전환 0회, 50초 → 30 + 30 + 30 = 90', () => {
    const r = score('ramp', { events: { curbTouches: 1, dirChanges: 0, elapsed: 50 } });
    expect(r.items.map((i) => [i.key, i.points, i.max])).toEqual([
      ['curb', 30, 40],
      ['moves', 30, 30],
      ['time', 30, 30],
    ]);
    expect(r.total).toBe(90);
  });

  it('완벽하면 100점. 각도·중앙·문 여유는 보지 않는다', () => {
    const r = score('ramp', { ev: { angleErrDeg: 25, offset: { along: 1, across: 0.8 } }, doors: { left: 0, right: 0 } });
    expect(r.items.map((i) => i.key)).toEqual(['curb', 'moves', 'time']);
    expect(r.total).toBe(100);
  });

  it('경계: 연석 4회, 기준 초과 전환 3회, 180초에서 0점', () => {
    const e = (o: Partial<AttemptEvents>) => score('ramp', { events: o });
    expect(pts(e({ curbTouches: 2 }), 'curb')).toBe(20);
    expect(pts(e({ curbTouches: 4 }), 'curb')).toBe(0);
    expect(pts(e({ curbTouches: 7 }), 'curb')).toBe(0);
    expect(pts(e({ dirChanges: 1 }), 'moves')).toBe(20);
    expect(pts(e({ dirChanges: 3 }), 'moves')).toBe(0);
    expect(pts(e({ elapsed: 60 }), 'time')).toBe(30);
    expect(pts(e({ elapsed: 120 }), 'time')).toBe(15);
    expect(pts(e({ elapsed: 180 }), 'time')).toBe(0);
    expect(e({ curbTouches: 4, dirChanges: 3, elapsed: 180 }).total).toBe(0);
  });
});

describe('scoreAttempt: 점수를 매기지 않는 시도', () => {
  it.each(SCENARIO_KINDS)('%s: !ev.success → 0점, 항목 없음', (kind) => {
    expect(score(kind, { ev: { inside: false, success: false } })).toEqual({ total: 0, items: [] });
    expect(score(kind, { ev: { angleErrDeg: 180, headingOk: false, success: false } })).toEqual({ total: 0, items: [] });
  });

  it.each(SCENARIO_KINDS)('%s: 충돌한 시도는 판정이 성공이어도 0점 (미러만 부딪히고 차체는 칸 안)', (kind) => {
    expect(score(kind, { events: { collisions: 1 } })).toEqual({ total: 0, items: [] });
  });
});

describe('doorClearances', () => {
  const spec = MODEL_Y_2025;
  const hw = spec.width / 2;
  /** 문 선분의 앞 끝 x */
  const x1 = spec.wheelbase - spec.tireDiameter / 2 - 0.1;
  const origin: Pose = { x: 0, y: 0, heading: 0 };
  const el = (poly: Vec2[], kind: ElementKind = 'solid', hMin = 0, hMax = 2.7): WorldElement => ({ id: 't', kind, poly, hMin, hMax });
  /** 차 왼쪽 0.4 m에 선 주차 차량 (앞뒤로 문 선분보다 길다) */
  const leftCar = el(aabbRect(-1.5, hw + 0.4, 3.5, hw + 2.2), 'solid', 0, 1.5);

  it('왼쪽 0.4 m에 차 → left 0.4, right = 상한 1.0', () => {
    const d = doorClearances(spec, origin, [leftCar]);
    expect(d.left).toBeCloseTo(0.4, 9);
    expect(d.right).toBe(1);
  });

  it('cap 인자', () => {
    expect(doorClearances(spec, origin, [leftCar], 0.3)).toEqual({ left: 0.3, right: 0.3 });
    expect(doorClearances(spec, origin, [], 0.8)).toEqual({ left: 0.8, right: 0.8 });
  });

  it('오른쪽 벽 0.25 m → right 0.25', () => {
    const d = doorClearances(spec, origin, [el(aabbRect(-3, -hw - 0.55, 6, -hw - 0.25))]);
    expect(d.right).toBeCloseTo(0.25, 9);
    expect(d.left).toBe(1);
  });

  it('높이가 [0.3, 1.2]와 겹치는 solid만 센다 (경계에 닿기만 하면 제외)', () => {
    const box = (hMin: number, hMax: number) => el(aabbRect(-1, hw + 0.1, 4, hw + 0.5), 'solid', hMin, hMax);
    expect(doorClearances(spec, origin, [box(0, 0.3)]).left).toBe(1);
    expect(doorClearances(spec, origin, [box(1.2, 2.7)]).left).toBe(1);
    expect(doorClearances(spec, origin, [box(0, 0.31)]).left).toBeCloseTo(0.1, 9);
    expect(doorClearances(spec, origin, [box(1.19, 2.7)]).left).toBeCloseTo(0.1, 9);
  });

  it('연석·휠스톱·선은 높이가 겹쳐도 무시한다', () => {
    const poly = aabbRect(-1, hw + 0.05, 4, hw + 0.2);
    const kinds: ElementKind[] = ['curb', 'wheelStop', 'line'];
    expect(doorClearances(spec, origin, kinds.map((k) => el(poly, k)))).toEqual({ left: 1, right: 1 });
  });

  it('문 선분은 앞뒤 바퀴 사이: 앞 오버행 옆 기둥은 선분 앞 끝에서 잰다', () => {
    const pillar = el(aabbRect(x1 + 0.3, hw + 0.1, x1 + 1.1, hw + 0.9));
    expect(doorClearances(spec, origin, [pillar]).left).toBeCloseTo(Math.hypot(0.3, 0.1), 9);
  });

  it('자세를 따른다: (10, 5)에서 +y를 보면 왼쪽은 −x', () => {
    const wall = el(aabbRect(10 - hw - 0.65, 0, 10 - hw - 0.35, 12));
    const d = doorClearances(spec, { x: 10, y: 5, heading: Math.PI / 2 }, [wall]);
    expect(d.left).toBeCloseTo(0.35, 9);
    expect(d.right).toBe(1);
  });

  it('차체 옆면이 장애물과 겹치면 0', () => {
    expect(doorClearances(spec, origin, [el(aabbRect(0, hw - 0.1, 3, hw + 0.3))]).left).toBe(0);
  });
});
