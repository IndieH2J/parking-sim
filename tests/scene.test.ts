import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { buildStatic, CHASE_HIDDEN } from '../src/render/scene';
import { buildKiosk } from '../src/scenarios/kiosk';
import { CHASE_OFFSETS } from '../src/sim/chaseEye';
import { MODEL_Y_2025 } from '../src/sim/specs';

// 추적 카메라(3D 리플레이)로 그릴 때 숨기는 정적 메시 (scene.ts CHASE_HIDDEN). 빌더를 직접 import한다 (§A.5).

/** 메시 꼭짓점 높이(three y = 시뮬레이션 높이)의 범위 */
function heightRange(o: THREE.Object3D): { min: number; max: number } {
  const pos = (o as THREE.Mesh).geometry.attributes.position;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    min = Math.min(min, pos.getY(i));
    max = Math.max(max, pos.getY(i));
  }
  return { min, max };
}

describe('추적 카메라에서 숨기는 메시', () => {
  it('발권기: 추적 눈(2.8 m)보다 높은 천장(3.0 m)도 조명 상자와 함께 숨긴다', () => {
    const sc = buildKiosk(MODEL_Y_2025);
    // 다루는 경우: 실내이고, 눈이 천장 아래로 내려오면 아래를 향한 천장 면이 보인다
    expect(sc.outdoor).toBeFalsy();
    expect(sc.ceilingHeight).toBeGreaterThan(CHASE_OFFSETS.height);
    const g = buildStatic(sc);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;
    // 천장: 꼭짓점이 모두 천장 높이인 메시 (다른 요소와 섞여 병합되면 찾지 못한다)
    const ceilings = g.children.filter((o) => {
      const r = heightRange(o);
      return near(r.min, sc.ceilingHeight) && near(r.max, sc.ceilingHeight);
    });
    expect(ceilings).toHaveLength(1);
    expect(ceilings[0].name).toBe(CHASE_HIDDEN);
    // 조명 상자: 꼭짓점이 모두 천장 바로 아래 10 cm 안에 있는 메시
    const lamps = g.children.filter((o) => {
      const r = heightRange(o);
      return r.min > sc.ceilingHeight - 0.1 && r.max < sc.ceilingHeight - 1e-5;
    });
    expect(lamps).toHaveLength(1);
    expect(lamps[0].name).toBe(CHASE_HIDDEN);
    // 그 밖의 메시(벽·발권기·차단기·바닥·목표 등)는 숨기지 않는다
    expect(g.children.filter((o) => o.name === CHASE_HIDDEN)).toHaveLength(2);
  });
});
