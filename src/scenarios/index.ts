import type { VehicleSpec } from '../sim/specs';
import type { Scenario, ScenarioKind, ScenarioOptionsMap } from './types';
import { buildRearPerpendicular } from './rearPerpendicular';
import { buildFrontPerpendicular } from './frontPerpendicular';
import { buildParallel } from './parallel';
import { buildNarrowRamp } from './narrowRamp';

// 시나리오 등록부 (계약서 §1.2). 테스트는 이 파일 대신 각 빌더를 직접 import한다 (§A.5).

const BUILDERS: { [K in ScenarioKind]: (opts: ScenarioOptionsMap[K], spec: VehicleSpec) => Scenario } = {
  rearPerp: (o) => buildRearPerpendicular(o),
  frontPerp: (o) => buildFrontPerpendicular(o),
  parallel: (o) => buildParallel(o),
  // 램프만 차에 따라 달라진다 (차로 확장·구역 길이)
  ramp: (o, spec) => buildNarrowRamp(o, spec),
};

export function buildScenario<K extends ScenarioKind>(kind: K, opts: ScenarioOptionsMap[K], spec: VehicleSpec): Scenario {
  return BUILDERS[kind](opts, spec);
}
