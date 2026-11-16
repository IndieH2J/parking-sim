import { describe, expect, it } from 'vitest';
import { clearance } from '../src/sim/clearance';
import { buildFootprint } from '../src/sim/footprint';
import { aabbRect, type Pose, type Vec2 } from '../src/sim/geometry';
import { MODEL_Y_2025 } from '../src/sim/specs';
import { prepare, type ElementKind, type WorldElement } from '../src/sim/world';
import { OVERSIZED } from './helpers/specs';

// 장애물까지 여유 clearance (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C0).

const spec = MODEL_Y_2025;
const fp = buildFootprint(spec);
const hw = spec.width / 2;
/** 미러가 차체 옆면에서 튀어나온 길이 (모델 Y 0.1045 m) */
const mo = (spec.widthMirrors - spec.width) / 2;
/** 앞범퍼 x (뒤축 기준) */
const xf = spec.wheelbase + spec.frontOverhang;
const origin: Pose = { x: 0, y: 0, heading: 0 };

let n = 0;
/** prepare()를 거친 요소 (near()가 쓰는 외접원 캐시) */
const el = (poly: Vec2[], kind: ElementKind = 'solid', hMin = 0, hMax = 2.7): WorldElement =>
  prepare({ id: `t${n++}`, kind, tag: kind === 'solid' ? 'wall' : undefined, poly, hMin, hMax });

/** 차 왼쪽 옆면에서 gap만큼 떨어진 벽 (차보다 앞뒤로 길다) */
const leftWall = (gap: number, hMin = 0, hMax = 2.7) => el(aabbRect(-3, hw + gap, 6, hw + gap + 0.3), 'solid', hMin, hMax);

describe('clearance', () => {
  it('주변에 아무것도 없으면 cap (기본 1)', () => {
    expect(clearance(fp, origin, [])).toBe(1);
    expect(clearance(fp, origin, [], 0.4)).toBe(0.4);
  });

  it('잰 거리: 앞범퍼 0.4 m 앞 벽 → 0.4', () => {
    expect(clearance(fp, origin, [el(aabbRect(xf + 0.4, -3, xf + 0.7, 3))])).toBeCloseTo(0.4, 9);
  });

  it('미러도 잰다: 옆면에서 0.30 m 벽은 미러에서 0.30 − 미러 돌출', () => {
    expect(clearance(fp, origin, [leftWall(0.3)])).toBeCloseTo(0.3 - mo, 9);
  });

  it('높이 범위가 겹치는 부품만 잰다: 미러보다 낮은 벽(0~0.5 m)은 차체 옆면에서 0.30', () => {
    expect(clearance(fp, origin, [leftWall(0.3, 0, 0.5)])).toBeCloseTo(0.3, 9);
  });

  it('높이가 차와 겹치지 않는 solid는 무시한다 (지붕 위 차단기 팔, 지상고 아래 턱, 경계에 닿기만 한 것)', () => {
    const over = aabbRect(0, -3, 1, 3); // 차 위를 가로지른다
    expect(clearance(fp, origin, [el(over, 'solid', spec.height + 0.05, spec.height + 0.15)])).toBe(1);
    expect(clearance(fp, origin, [el(over, 'solid', 0, spec.groundClearance - 0.05)])).toBe(1);
    expect(clearance(fp, origin, [el(over, 'solid', 0, spec.groundClearance)])).toBe(1);
    expect(clearance(fp, origin, [el(over, 'solid', spec.height, spec.height + 1)])).toBe(1);
  });

  it('연석·휠스톱·선은 차체와 겹쳐도 무시한다', () => {
    const poly = aabbRect(0, -0.2, 1, 0.2);
    const kinds: ElementKind[] = ['curb', 'wheelStop', 'line'];
    expect(clearance(fp, origin, kinds.map((k) => el(poly, k)))).toBe(1);
  });

  it('겹치면 0: 차체 안 기둥, 미러에 걸친 벽', () => {
    expect(clearance(fp, origin, [el(aabbRect(1, -0.2, 1.3, 0.1))])).toBe(0);
    expect(clearance(fp, origin, [leftWall(mo / 2)])).toBe(0);
  });

  it('cap을 넘지 않는다', () => {
    expect(clearance(fp, origin, [el(aabbRect(xf + 0.7, -3, xf + 1, 3))], 0.5)).toBe(0.5);
    expect(clearance(fp, origin, [el(aabbRect(xf + 1.5, -3, xf + 2, 3))])).toBe(1);
    expect(clearance(fp, origin, [leftWall(0.3)], 0.1)).toBe(0.1);
  });

  it('여러 요소 중 가장 가까운 것', () => {
    const els = [leftWall(0.5), el(aabbRect(xf + 0.25, -3, xf + 0.5, 3)), el(aabbRect(-3, -hw - 0.9, 6, -hw - 0.6))];
    expect(clearance(fp, origin, els)).toBeCloseTo(0.25, 9);
  });

  it('자세를 따른다: (10, 5)에서 +y를 보면 앞벽은 y = 5 + 앞범퍼 + 0.25', () => {
    const wall = el(aabbRect(5, 5 + xf + 0.25, 15, 5 + xf + 0.5));
    expect(clearance(fp, { x: 10, y: 5, heading: Math.PI / 2 }, [wall])).toBeCloseTo(0.25, 9);
  });

  it('긴 차의 앞범퍼 0.95 m 앞 작은 기둥도 잰다 (뒤축에서 6 m 넘게 떨어진 요소를 거르지 않음)', () => {
    const ofp = buildFootprint(OVERSIZED);
    const nose = OVERSIZED.wheelbase + OVERSIZED.frontOverhang;
    const post = el(aabbRect(nose + 0.95, -0.05, nose + 1.05, 0.05));
    expect(clearance(ofp, origin, [post])).toBeCloseTo(0.95, 9);
  });
});
