import type { VehicleSpec } from './specs';

/**
 * 운전자 눈 위치(차량 로컬: 뒤축 원점, +x 전방, +y 왼쪽, h 높이).
 * 추정값: 키 175 cm 기준 spec.eye에서 출발해, 키가 1 cm 커질 때
 * 앉은 눈높이 +0.47 cm, 시트 뒤로 +0.35 cm 정도 이동한다고 근사한다.
 */
export function eyeLocal(
  spec: VehicleSpec,
  driverHeightCm: number,
  seatHeightCm: number,
  seatForeCm: number,
): { x: number; y: number; h: number } {
  const dH = (driverHeightCm - 175) / 100;
  const h = spec.eye.height + dH * 0.47 + seatHeightCm / 100;
  const fromFront = spec.eye.fromFront + dH * 0.35 - seatForeCm / 100;
  return {
    x: spec.wheelbase + spec.frontOverhang - fromFront,
    y: spec.eye.lateral,
    h: Math.min(h, spec.height - 0.1), // 머리가 지붕을 뚫지 않게
  };
}
