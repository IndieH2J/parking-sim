import * as THREE from 'three';
import type { Pose } from '../sim/geometry';
import { chaseEye } from '../sim/chaseEye';
import { DEFAULT_SPEC, type VehicleSpec } from '../sim/specs';
import type { WorldElement } from '../sim/world';
import { MIRROR_LAYER } from './cameras';
import { L } from './util';

// 3D 리플레이 추적 카메라 (계약서 §5.3, 2026-11-15 개정).
// 차체 중심 뒤 5.5 m·높이 2.8 m에서 차체 중심 앞 2 m·높이 0.6 m를 본다. 위치만 1 − exp(−4·dt)로 따라가고,
// 바라보는 점은 매번 정확히 맞춘다.
// setWorld로 장면 요소를 받으면 벽·기둥·주차 차량이 시선을 가릴 때 눈을 올리고, 그래도 안 되면 차 쪽으로 당긴다
// (src/sim/chaseEye.ts). 받기 전이나 가리는 것이 없으면 계약 눈 그대로다.
// 눈은 늘 2.8 m 이상이라 천장(2.7 m, 램프 2.3 m)보다 높다. 천장이 아래쪽만 그려지는 면(FrontSide)이라 위에서는 안 보이는 것을 전제로 한다.

const FOV = 55;
const FOLLOW = 4; // 1/s

export class ChaseCam {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 300);
  private spec: VehicleSpec = DEFAULT_SPEC;
  private world: readonly WorldElement[] = [];
  private placed = false;
  private readonly eye = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  constructor() {
    // 바깥에서 보는 카메라: 거울 카메라처럼 바깥 전용 형상(도어 어깨)도 그린다
    this.camera.layers.enable(MIRROR_LAYER);
  }

  /**
   * 차체 중심과 지붕 모서리(시선 확인용)를 정할 차종 (기본 모델 Y). 계약 밖 추가: 리플레이 프레임은 뒤축 기준이라 차체 중심을 알려면 제원이 필요하다.
   * 리플레이를 녹화한 차의 제원을 넘긴다 (차종을 바꾸면 restart()가 기록을 비우므로 지금 spec과 같다).
   */
  setSpec(spec: VehicleSpec): void {
    this.spec = spec;
  }

  /**
   * 시선을 가리는지 볼 장면 요소 (계약 개정 2026-11-15). sc.elements를 그대로 넘기면 되고 solid만 쓴다.
   * 시나리오를 다시 만들 때마다 (buildWorld) 다시 넘긴다. 넘기지 않으면 가리는 것이 없다고 보고 계약 눈 그대로다.
   */
  setWorld(elements: readonly WorldElement[]): void {
    this.world = elements;
  }

  /** 따라가기 없이 그 자세의 자리로 바로 옮긴다. 3D 리플레이를 시작할 때와 탐색(seek) 직후에 부른다. */
  reset(pose: Pose): void {
    this.aim(pose);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.look);
    this.placed = true;
  }

  /** dt = 실제 프레임 시간(s). reset() 전에 처음 부르면 reset처럼 바로 옮긴다. */
  update(pose: Pose, dt: number, aspect: number): void {
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    if (!this.placed) {
      this.reset(pose);
      return;
    }
    this.aim(pose);
    this.camera.position.lerp(this.eye, 1 - Math.exp(-FOLLOW * dt));
    this.camera.lookAt(this.look);
  }

  /** 목표 눈 위치와 바라볼 점 (Three 좌표) */
  private aim(pose: Pose): void {
    const { eye, look } = chaseEye(pose, this.spec, this.world);
    this.eye.copy(L(eye.x, eye.y, eye.h));
    this.look.copy(L(look.x, look.y, look.h));
  }
}
