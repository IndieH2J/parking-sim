import { describe, expect, it } from 'vitest';
import { MODEL_Y_2025 } from '../src/sim/specs';
import { buildScenario } from '../src/scenarios/index';
import { buildRearPerpendicular } from '../src/scenarios/rearPerpendicular';
import { buildFrontPerpendicular } from '../src/scenarios/frontPerpendicular';
import { buildParallel } from '../src/scenarios/parallel';
import { buildNarrowRamp } from '../src/scenarios/narrowRamp';
import { withCrooked } from '../src/scenarios/crooked';
import { buildFrontPerpOut, buildParallelOut, buildRearPerpOut } from '../src/scenarios/pullOut';
import { buildAlley } from '../src/scenarios/alley';
import { buildUturn } from '../src/scenarios/uturn';
import { buildKiosk } from '../src/scenarios/kiosk';
import { SCENARIO_KINDS, SITUATION_GROUPS, type PerpOptions, type Scenario, type ScenarioKind } from '../src/scenarios/types';
import { DEFAULT_SETTINGS, optionsFor } from '../src/ui/settings';

// 등록부 (계약서 §1.2, §9 v2 게이트 1). 시나리오별 테스트는 빌더를 직접 부르므로(§A.5) 여기서만 index.ts를 거친다.
// 옵션은 main.ts와 같은 길(optionsFor)로 만든다.

const spec = MODEL_Y_2025;

/** 각 종류의 빌더를 직접 부른 결과 (등록부가 맞는 빌더로 보내는지 비교용) */
function direct(kind: ScenarioKind): Scenario {
  const o = optionsFor({ ...DEFAULT_SETTINGS, scenario: kind });
  switch (o.kind) {
    case 'rearPerp':
      return buildRearPerpendicular(o.opts as Parameters<typeof buildRearPerpendicular>[0]);
    case 'frontPerp':
      return buildFrontPerpendicular(o.opts as Parameters<typeof buildFrontPerpendicular>[0]);
    case 'parallel':
      return buildParallel(o.opts as Parameters<typeof buildParallel>[0]);
    case 'ramp':
      return buildNarrowRamp(o.opts as Parameters<typeof buildNarrowRamp>[0], spec);
    case 'rearPerpOut':
      return buildRearPerpOut(o.opts as Parameters<typeof buildRearPerpOut>[0], spec);
    case 'frontPerpOut':
      return buildFrontPerpOut(o.opts as Parameters<typeof buildFrontPerpOut>[0], spec);
    case 'parallelOut':
      return buildParallelOut(o.opts as Parameters<typeof buildParallelOut>[0], spec);
    case 'alley':
      return buildAlley(spec);
    case 'uturn':
      return buildUturn(spec);
    case 'kiosk':
      return buildKiosk(spec);
  }
}

describe('buildScenario 등록부', () => {
  for (const kind of SCENARIO_KINDS) {
    it(`${kind}: 모델 Y로 만들면 같은 종류를 돌려주고, 그 종류의 빌더 결과와 같다`, () => {
      const o = optionsFor({ ...DEFAULT_SETTINGS, scenario: kind });
      expect(o.kind).toBe(kind);
      const sc = buildScenario(o.kind, o.opts, spec);
      expect(sc.kind).toBe(kind);
      expect(sc.elements.length).toBeGreaterThan(0);
      expect(sc).toEqual(direct(kind));
    });
  }
});

describe('상황 6종 (계약서 개정 2026-11-16 situations)', () => {
  it('직각 주차는 옆 차 비뚤게(crooked)를 켜면 withCrooked를 거친다', () => {
    for (const kind of ['rearPerp', 'frontPerp'] as const) {
      const o = optionsFor({ ...DEFAULT_SETTINGS, scenario: kind, perp: { ...DEFAULT_SETTINGS.perp, crooked: true } });
      expect(o.opts).toEqual({ slotWidth: 2.5, target: 'between', crooked: true });
      const opts = o.opts as PerpOptions;
      const plain = kind === 'rearPerp' ? buildRearPerpendicular(opts) : buildFrontPerpendicular(opts);
      expect(buildScenario(kind, opts, spec)).toEqual(withCrooked(plain, opts, spec));
    }
  });

  it('상황 묶음: 주차하기 3 · 출차하기 3 · 주행 연습 4, 모든 종류가 정확히 한 번', () => {
    expect(SITUATION_GROUPS).toEqual([
      { group: 'park', kinds: ['rearPerp', 'frontPerp', 'parallel'] },
      { group: 'pullOut', kinds: ['rearPerpOut', 'frontPerpOut', 'parallelOut'] },
      { group: 'drive', kinds: ['ramp', 'alley', 'uturn', 'kiosk'] },
    ]);
    expect(SITUATION_GROUPS.flatMap((g) => g.kinds).sort()).toEqual([...SCENARIO_KINDS].sort());
  });
});
