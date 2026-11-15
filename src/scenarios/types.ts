import type { Pose, Vec2 } from '../sim/geometry';
import type { WorldElement } from '../sim/world';
import type { Goal } from '../sim/goal';

// 시나리오 공통 타입과 옵션 메타데이터 (계약서 §1.1).

export type ScenarioKind = 'rearPerp' | 'frontPerp' | 'parallel' | 'ramp';
export const SCENARIO_KINDS: readonly ScenarioKind[] = ['rearPerp', 'frontPerp', 'parallel', 'ramp'];
export type TargetKind = 'between' | 'pillar';

/** rearPerp, frontPerp */
export interface PerpOptions {
  slotWidth: number;
  target: TargetKind;
  seed?: number;
}
export interface ParallelOptions {
  slotLength: number;
  seed?: number;
}
/** innerRadius는 RAMP_RADIUS_OPTIONS 중 하나 */
export interface RampOptions {
  innerRadius: number;
}
export interface ScenarioOptionsMap {
  rearPerp: PerpOptions;
  frontPerp: PerpOptions;
  parallel: ParallelOptions;
  ramp: RampOptions;
}
export type AnyScenarioOptions = ScenarioOptionsMap[ScenarioKind];

// UI·설정 정리·테스트용 옵션 메타데이터.
// 시나리오 에이전트는 바꿀 필요를 보고만 하고, 수정은 게이트만 한다.
/** 직각 두 종류가 함께 쓴다 (settings.perp). 계획서 옵션이라 지우지 않는다. */
export const PERP_SLOT_PRESETS: readonly number[] = [2.3, 2.5, 2.6];
export const PERP_SLOT_RANGE = { min: 2.1, max: 3.2, step: 0.05 };
export const PARALLEL_LENGTH_PRESETS: readonly number[] = [6.0, 6.5, 7.0];
export const PARALLEL_LENGTH_RANGE = { min: 5.8, max: 8.0, step: 0.1 };
export const RAMP_RADIUS_OPTIONS: readonly number[] = [6, 5];

/** 시각 표현 전용, 볼록. h = 윗면 높이 (기본 0.001). */
export interface FloorPatch {
  poly: Vec2[];
  tone: 'aisle' | 'walkway';
  h?: number;
}

export interface Scenario {
  kind: ScenarioKind;
  /** 모두 prepare()를 거친 요소. id는 서로 다르고 poly는 모두 볼록 */
  elements: WorldElement[];
  /** poseClear(start, 조향 0)이 'ok' */
  start: Pose;
  goal: Goal;
  /** 바닥·천장 평면 범위 */
  bounds: { x0: number; x1: number; y0: number; y1: number };
  ceilingHeight: number;
  /** scene.ts·minimap.ts에 박혀 있던 통로 바닥을 대신한다 */
  floor: FloorPatch[];
  /** 천장 조명 중심. 긴 축이 heading 방향 */
  lamps: Pose[];
}
