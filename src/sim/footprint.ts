import type { Vec2 } from './geometry';
import { rect } from './geometry';
import type { VehicleSpec } from './specs';

// 차량 로컬 좌표(원점 = 뒤축 중심, +x 전방, +y 왼쪽)에서의 외곽 형상.

export interface Part {
  poly: Vec2[];
  hMin: number;
  hMax: number;
}

export interface Footprint {
  body: Part;
  mirrorLeft: Part;
  mirrorRight: Part;
  /** 차체 외곽을 구역별 꺾은선으로 나눈 것 (거리 센서용) */
  zones: Record<BodyZone, Vec2[]>;
  /** B필러 중심 x. 추정값. 3D 차 모델의 B필러와 탑뷰 표시가 이 값을 같이 쓴다. 충돌 판정에는 쓰지 않는다 */
  bPillarX: number;
}

export type BodyZone =
  | 'frontLeft'
  | 'frontCenter'
  | 'frontRight'
  | 'rearLeft'
  | 'rearCenter'
  | 'rearRight'
  | 'left'
  | 'right';

/** 모서리를 깎은 정도(평면도에서 범퍼 모서리의 둥근 정도 근사) */
const CORNER_CHAMFER = 0.15;

/**
 * 사이드미러 유리(mirror.xRear) → 카울(앞유리 하단) 최소 간격 (m). 추정값.
 * 175 cm 눈에서 A필러가 미러 유리를 가리는 비율(격자 광선 검사): 이 규칙 전 모닝 좌 16%·우 35%, 캐스퍼 크기 38%·66%,
 * 작은 직접 입력 최대 84%·96% → 0.25 m에서 모두 4% 이하. 모델 Y(0.32)·아반떼·K3·K5·쏘나타는 그대로.
 */
const MIRROR_TO_COWL = 0.25;

/**
 * 앞유리 하단(카울) x. 추정값. 3D 차 모델(render/carMesh.ts)의 보닛·앞유리·필러가 여기에 맞춰진다.
 * 사이드미러 유리가 카울보다 MIRROR_TO_COWL 이상 뒤에 오게 한다: 짧은 차(모닝·소형 직접 입력)는
 * 추정 미러 위치(눈 + 0.59 m)가 카울에 바짝 붙어, 뒤로 누운 A필러가 운전석에서 본 미러 유리를 가렸다. 모델 Y는 그대로(간격 0.32).
 */
export function cowlXOf(spec: VehicleSpec): number {
  return Math.max(spec.wheelbase - 0.45, spec.mirror.xRear + MIRROR_TO_COWL);
}

export function bodyExtents(spec: VehicleSpec) {
  return {
    xr: -spec.rearOverhang,
    xf: spec.wheelbase + spec.frontOverhang,
    hw: spec.width / 2,
  };
}

export function buildFootprint(spec: VehicleSpec): Footprint {
  const { xr, xf, hw } = bodyExtents(spec);
  const c = CORNER_CHAMFER;
  const body: Vec2[] = [
    { x: xr + c, y: -hw },
    { x: xf - c, y: -hw },
    { x: xf, y: -hw + c },
    { x: xf, y: hw - c },
    { x: xf - c, y: hw },
    { x: xr + c, y: hw },
    { x: xr, y: hw - c },
    { x: xr, y: -hw + c },
  ];
  const m = spec.mirror;
  const mw = spec.widthMirrors / 2;
  const mirrorLeft = [
    { x: m.xRear, y: m.yInner },
    { x: m.xFront, y: m.yInner },
    { x: m.xFront, y: mw },
    { x: m.xRear, y: mw },
  ];
  const mirrorRight = mirrorLeft.map((p) => ({ x: p.x, y: -p.y })).reverse();
  const t = hw / 3;
  const zones: Record<BodyZone, Vec2[]> = {
    frontCenter: [
      { x: xf, y: -t },
      { x: xf, y: t },
    ],
    frontLeft: [
      { x: xf, y: t },
      { x: xf, y: hw - c },
      { x: xf - c, y: hw },
    ],
    frontRight: [
      { x: xf, y: -t },
      { x: xf, y: -hw + c },
      { x: xf - c, y: -hw },
    ],
    rearCenter: [
      { x: xr, y: -t },
      { x: xr, y: t },
    ],
    rearLeft: [
      { x: xr, y: t },
      { x: xr, y: hw - c },
      { x: xr + c, y: hw },
    ],
    rearRight: [
      { x: xr, y: -t },
      { x: xr, y: -hw + c },
      { x: xr + c, y: -hw },
    ],
    left: [
      { x: xf - c, y: hw },
      { x: xr + c, y: hw },
    ],
    right: [
      { x: xf - c, y: -hw },
      { x: xr + c, y: -hw },
    ],
  };
  return {
    body: { poly: body, hMin: spec.groundClearance, hMax: spec.height },
    mirrorLeft: { poly: mirrorLeft, hMin: m.hBottom, hMax: m.hTop },
    mirrorRight: { poly: mirrorRight, hMin: m.hBottom, hMax: m.hTop },
    zones,
    // 추정값: 카울 1.25 m 뒤. 모든 프리셋·직접 입력 범위에서 175 cm 운전자 눈보다 0.1~0.41 m 뒤(어깨 옆)다
    bPillarX: cowlXOf(spec) - 1.25,
  };
}

export type WheelId = 'FL' | 'FR' | 'RL' | 'RR';

/** 타이어 접지 영역(평면도). 앞바퀴는 조향각만큼 회전한다. */
export function wheelPolys(spec: VehicleSpec, steer: number): Record<WheelId, Vec2[]> {
  const L = spec.wheelbase;
  const d = spec.tireDiameter;
  const w = spec.tireWidth;
  return {
    FL: rect(L, spec.trackFront / 2, d, w, steer),
    FR: rect(L, -spec.trackFront / 2, d, w, steer),
    RL: rect(0, spec.trackRear / 2, d, w),
    RR: rect(0, -spec.trackRear / 2, d, w),
  };
}
