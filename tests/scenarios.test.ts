import { describe, expect, it } from 'vitest';
import { MODEL_Y_2025 } from '../src/sim/specs';
import { buildScenario } from '../src/scenarios/index';
import { buildRearPerpendicular } from '../src/scenarios/rearPerpendicular';
import { buildFrontPerpendicular } from '../src/scenarios/frontPerpendicular';
import { buildParallel } from '../src/scenarios/parallel';
import { buildNarrowRamp } from '../src/scenarios/narrowRamp';
import { SCENARIO_KINDS, type Scenario, type ScenarioKind } from '../src/scenarios/types';
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
