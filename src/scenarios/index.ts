import type { VehicleSpec } from '../sim/specs';
import type { Scenario, ScenarioKind, ScenarioOptionsMap } from './types';
import { buildRearPerpendicular } from './rearPerpendicular';
import { buildFrontPerpendicular } from './frontPerpendicular';
import { buildParallel } from './parallel';
import { buildNarrowRamp } from './narrowRamp';
import { withCrooked } from './crooked';
import { buildFrontPerpOut, buildParallelOut, buildRearPerpOut } from './pullOut';
import { buildAlley } from './alley';
import { buildUturn } from './uturn';
import { buildKiosk } from './kiosk';

// 시나리오 등록부 (계약서 §1.2). 테스트는 이 파일 대신 각 빌더를 직접 import한다 (§A.5).

const BUILDERS: { [K in ScenarioKind]: (opts: ScenarioOptionsMap[K], spec: VehicleSpec) => Scenario } = {
  // 옆 차 비뚤게(crooked)는 빌더 결과의 후처리다: 빌더 시그니처(계약서 §1.2)와 배치·난수 순서를 그대로 둔다
  rearPerp: (o, spec) => withCrooked(buildRearPerpendicular(o), o, spec),
  frontPerp: (o, spec) => withCrooked(buildFrontPerpendicular(o), o, spec),
  parallel: (o) => buildParallel(o),
  // 램프는 차에 따라 달라진다 (차로 확장·구역 길이)
  ramp: (o, spec) => buildNarrowRamp(o, spec),
  // 상황 6종 (계약서 개정 2026-11-16 situations): 모두 차에 맞춰 크기가 정해진다. 골목·유턴·발권기는 옵션이 없다
  rearPerpOut: (o, spec) => buildRearPerpOut(o, spec),
  frontPerpOut: (o, spec) => buildFrontPerpOut(o, spec),
  parallelOut: (o, spec) => buildParallelOut(o, spec),
  alley: (_o, spec) => buildAlley(spec),
  uturn: (_o, spec) => buildUturn(spec),
  kiosk: (_o, spec) => buildKiosk(spec),
};

export function buildScenario<K extends ScenarioKind>(kind: K, opts: ScenarioOptionsMap[K], spec: VehicleSpec): Scenario {
  return BUILDERS[kind](opts, spec);
}
