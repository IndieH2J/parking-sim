import * as THREE from 'three';
import type { VehicleSpec } from '../sim/specs';
import { bodyExtents } from '../sim/footprint';
import { box, L } from './util';

export const CALIB_LAYER = 2;

function label(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.5, 0.25, 1);
  return s;
}

/**
 * 보정 눈금: 앞범퍼부터 0.5 m 간격 가로선과, 차체 폭을 앞으로 연장한 두 선.
 * 실제 차에서 "보닛 너머로 처음 보이는 바닥 지점"과 비교해 눈 위치를 맞추는 시각 기준.
 * 운전석 카메라에만 보인다.
 */
export function buildCalibMarks(spec: VehicleSpec): THREE.Group {
  const g = new THREE.Group();
  const { xf, hw } = bodyExtents(spec);
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const orange = new THREE.MeshBasicMaterial({ color: 0xff9f0a });
  const add = (o: THREE.Object3D) => {
    o.layers.set(CALIB_LAYER);
    g.add(o);
  };
  for (let i = 1; i <= 10; i++) {
    const d = i * 0.5;
    const x = xf + d;
    const whole = i % 2 === 0;
    add(box(x - 0.015, x + 0.015, -hw, hw, 0.006, 0.009, whole ? orange : white));
    if (whole) {
      const s = label(`${d} m`);
      s.position.copy(L(x, hw + 0.35, 0.1));
      add(s);
    }
  }
  for (const y of [hw, -hw]) add(box(xf, xf + 5, y - 0.015, y + 0.015, 0.006, 0.009, orange));
  return g;
}
