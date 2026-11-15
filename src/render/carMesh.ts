import * as THREE from 'three';
import type { VehicleSpec } from '../sim/specs';
import { bodyExtents, buildFootprint } from '../sim/footprint';
import { eyeLocal } from '../sim/driver';
import { aabbRect, rect, type Vec2 } from '../sim/geometry';
import { beam, box, extrudePoly, extrudeProfile, L, mat, wallsOnly } from './util';
import { MIRROR_LAYER } from './cameras';

// 로우폴리 차체. 실제 치수(전장·전폭·축거·오버행·미러 폭)만 반영한 일반 형상이며,
// 특정 제조사의 디자인을 재현하지 않는다. 실루엣 비율은 추정값이다.

const BODY = 0xe6e7ea;
const TRIM = 0x18191b;
const DASH = 0x26282b;
const SEAT = 0x2f3134;
const TIRE = 0x121212;
const RIM = 0x80858b;
const LINING = 0x2b2d31; // 차체 외피 안쪽 면(실내에서 보이는 쪽)
const GLASS = 0x3a424a; // 밖에서 본 옆 유리
/**
 * 사이드미러 유리(mirror.xRear) → 카울(앞유리 하단) 최소 간격 (m). 추정값.
 * 175 cm 눈에서 A필러가 미러 유리를 가리는 비율(격자 광선 검사): 이 규칙 전 모닝 좌 16%·우 35%, 캐스퍼 크기 38%·66%,
 * 작은 직접 입력 최대 84%·96% → 0.25 m에서 모두 4% 이하. 모델 Y(0.32)·아반떼·K3·K5·쏘나타는 그대로.
 */
const MIRROR_TO_COWL = 0.25;

export interface CarRig {
  group: THREE.Group; // 차량 루트(뒤축 원점). position/rotation은 매 프레임 갱신
  frontWheels: THREE.Object3D[]; // 조향 피벗
  wheels: THREE.Object3D[]; // 회전(굴림)용
  steeringWheel: THREE.Object3D;
  /** 핸들·칼럼 묶음. position.y = 칼럼 높이 조절(0 이하, 눈이 기준보다 낮을 때 내림: main.ts applyDriver) */
  steeringRig: THREE.Object3D;
  mirrorAnchors: { left: THREE.Vector3; right: THREE.Vector3; rear: THREE.Vector3 }; // 미러 유리 중심 (Three 로컬)
  mirrorGlassSize: { side: [number, number]; rear: [number, number] };
  /** 보닛 윗면 높이(차량 로컬 x에서). 직선이라 카울 뒤(운전석)로 늘린 면으로도 쓴다: main.ts 눈 높이 하한 */
  hoodLine: (x: number) => number;
}

export function buildCar(spec: VehicleSpec): CarRig {
  const g = new THREE.Group();
  const { xr, xf, hw } = bodyExtents(spec);
  const H = spec.height;
  const belt = 0.62 * H; // 벨트라인(창문 아래선) 높이
  // 하부 차체 윗면 = 보닛 밑면. 모델 Y는 0.8 m. 낮은 차(전고 약 1.61 m 미만)는 벨트라인 아래 0.2 m로 내린다:
  // 보닛 앞 끝(belt - 0.15)이 이 면보다 낮으면 보닛 단면이 꼬인다 (세단·모닝 프리셋, 직접 입력 전고 1.2 m).
  const lowerTop = Math.min(0.8, belt - 0.2);
  // 앞유리 하단. 사이드미러 유리가 카울보다 MIRROR_TO_COWL 이상 뒤에 오게 한다: 짧은 차(모닝·소형 직접 입력)는
  // 추정 미러 위치(눈 + 0.59 m)가 카울에 바짝 붙어, 뒤로 누운 A필러가 운전석에서 본 미러 유리를 가렸다. 모델 Y는 그대로(간격 0.32).
  const cowlX = Math.max(spec.wheelbase - 0.45, spec.mirror.xRear + MIRROR_TO_COWL);
  const roofFrontX = cowlX - 0.72;
  const roofRearX = xr + 0.45;
  const roofHw = hw - 0.2;
  const body = mat(BODY);
  const trim = mat(TRIM);
  const fp = buildFootprint(spec);

  // ---- 외관 ----
  // 하부 차체와 벨트 밴드는 옆면만 세운다. 위 뚜껑이 있으면 운전석에서 실내(대시·바닥)를 덮어 버린다.
  // 바깥 면은 차체색, 같은 형상의 안쪽 면(BackSide)은 실내색이라 안에서 봐도 창문 아래는 막혀 있다.
  const lining = new THREE.MeshLambertMaterial({ color: LINING, side: THREE.BackSide });
  const shell = (poly: Vec2[], h0: number, h1: number) => {
    const outer = wallsOnly(poly, h0, h1, body);
    g.add(outer, new THREE.Mesh(outer.geometry, lining));
  };
  shell(fp.body.poly, 0.22, lowerTop);
  const c = 0.15;
  shell(
    [
      { x: xr + c, y: -hw + 0.02 },
      { x: cowlX, y: -hw + 0.02 },
      { x: cowlX, y: hw - 0.02 },
      { x: xr + c, y: hw - 0.02 },
      { x: xr, y: hw - c },
      { x: xr, y: -hw + c },
    ],
    lowerTop,
    belt,
  );
  // 보닛
  g.add(
    extrudeProfile(
      [
        [cowlX, lowerTop],
        [xf, lowerTop],
        [xf - 0.08, belt - 0.15],
        [cowlX, belt],
      ],
      2 * (hw - 0.09),
      body,
    ),
  );
  // 앞 펜더까지 이어진 보닛 윗면: 보닛(±(hw-0.09))을 덮고 차체 옆면까지 넓힌 한 덩어리.
  // 운전석에서 보이는 앞쪽 외곽선이 실제 차폭(±hw, 앞 모서리는 평면도의 모따기)과 같아진다.
  // 윗면이 보닛 윗면과 같은 평면이라 겹쳐도 보이지 않고, 한 덩어리라 이음매가 없다.
  // 카울 쪽 끝은 벨트 밴드 앞벽과 겹치지 않게 5 mm 띄운다.
  const hoodTop = (x: number) => belt - (0.15 * (x - cowlX)) / (xf - 0.08 - cowlX);
  const deck = extrudePoly(
    [
      { x: cowlX + 0.005, y: -hw },
      { x: xf - c, y: -hw },
      { x: xf - 0.08, y: -(hw - 0.07) },
      { x: xf - 0.08, y: hw - 0.07 },
      { x: xf - c, y: hw },
      { x: cowlX + 0.005, y: hw },
    ],
    lowerTop,
    belt,
    body,
  );
  const deckPos = deck.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < deckPos.count; i++) if (deckPos.getY(i) > lowerTop + 0.01) deckPos.setY(i, hoodTop(deckPos.getX(i)));
  deck.geometry.computeVertexNormals();
  g.add(deck);
  // 하부 검은 몰딩 (범퍼 하단 ~ 지상고). 외피와 같은 외곽이라 윗면(0.22 m)이 바닥을 막는다.
  // (안쪽으로 들이면 외피 아래 끝과의 틈으로 실내에서 바깥 바닥이 보인다.)
  g.add(extrudePoly(fp.body.poly, spec.groundClearance, 0.22, trim));

  // 기둥·지붕 (A, B, C 필러는 어두운 트림)
  for (const s of [1, -1]) {
    g.add(beam(L(cowlX - 0.03, s * (hw - 0.08), belt), L(roofFrontX, s * roofHw, H - 0.04), 0.09, trim, 0.06));
    const bX = cowlX - 1.25;
    g.add(beam(L(bX, s * (hw - 0.05), belt), L(bX, s * roofHw, H - 0.04), 0.1, trim, 0.06));
    g.add(beam(L(xr + 0.35, s * (hw - 0.05), belt), L(roofRearX + 0.05, s * roofHw, H - 0.05), 0.2, trim, 0.08));
  }
  g.add(box(roofRearX, roofFrontX, -roofHw, roofHw, H - 0.05, H, mat(0x1c1f23)));
  g.add(beam(L(roofFrontX, roofHw, H - 0.04), L(roofFrontX, -roofHw, H - 0.04), 0.07, trim));
  g.add(beam(L(roofRearX, roofHw, H - 0.04), L(roofRearX, -roofHw, H - 0.04), 0.08, trim));
  g.add(beam(L(xr + 0.12, hw - 0.1, belt + 0.06), L(xr + 0.12, -(hw - 0.1), belt + 0.06), 0.1, body));
  // 옆 유리: 바깥 면만 있다. 실내에서는 뒷면이라 보이지 않고, 사이드미러에는 차 옆면(창)으로 비친다.
  // (없으면 미러 안쪽 가장자리의 광선이 열린 창으로 실내를 들여다본다.)
  for (const s of [1, -1]) {
    const yb = s * (hw - 0.08);
    const yt = s * roofHw;
    const q = [
      L(xr + 0.35, yb, belt),
      L(cowlX - 0.03, yb, belt),
      L(roofFrontX, yt, H - 0.05),
      L(roofRearX + 0.05, yt, H - 0.05),
    ];
    if (s > 0) q.reverse(); // 바깥쪽이 앞면이 되도록
    const geo = new THREE.BufferGeometry().setFromPoints([q[0], q[1], q[2], q[0], q[2], q[3]]);
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, mat(GLASS)));
    // 도어 어깨(유리 아래 ~ 차체 옆면 사이 윗면). 실내에서는 도어 안쪽 패널에 가려 안 보이므로 거울에만 그린다.
    const [sy0, sy1] = s > 0 ? [hw - 0.08, hw - 0.02] : [-(hw - 0.02), -(hw - 0.08)];
    const shoulder = box(xr + c, cowlX, sy0, sy1, belt, belt + 0.004, body);
    shoulder.layers.set(MIRROR_LAYER);
    g.add(shoulder);
  }

  // 사이드미러 하우징 (차체색). 유리는 눈 위치에 맞춰 약 15~35° 돌아가므로(cameras.ts aim),
  // 하우징 뒷면을 유리면보다 앞으로 물려 유리 안쪽 가장자리를 가리거나 거울에 비치지 않게 한다.
  const m = spec.mirror;
  const mw = spec.widthMirrors / 2;
  for (const s of [1, -1]) {
    const y0 = s > 0 ? m.yInner : -mw;
    const y1 = s > 0 ? mw : -m.yInner;
    g.add(box(m.xRear + 0.06, m.xFront, y0, y1, m.hBottom, m.hTop, body));
  }
  const mirrorY = (m.yInner + mw) / 2 + 0.01;
  // 유리는 하우징 위쪽에 둔다: 유리 아래 끝이 벨트라인(도어 어깨)보다 위여야 거울 광선이 차체 속에서 출발하지 않는다.
  const glassH = m.hTop - m.hBottom - 0.05;
  const mirrorH = m.hTop - 0.005 - glassH / 2;

  // ---- 실내 ----
  // 높이는 키 175 cm 운전자의 눈 높이(eh)와 벨트라인 기준이다 (모델 Y 값은 그대로: eh = 1.2).
  const eye = eyeLocal(spec, 175, 0, 0);
  const eh = eye.h;
  // 대시보드: 윗면은 카울(보닛 뒤끝)과 맞추고, 뒷면은 핸들 앞에 둔다.
  // 핸들 림 윗부분이 앞으로 0.078 m 기울어 약 0.10 m 틈이 필요하다: 뒷면 x = max(카울 - 0.36, 눈 x + 0.55) (계약서 §2.6).
  // 모델 Y는 그대로(2.080), 투싼·쏘렌토·모닝은 대시 뒷면이 앞으로 물러나 핸들이 대시에 묻히지 않는다.
  const dashX = Math.max(cowlX - 0.36, eye.x + 0.55);
  g.add(box(dashX, cowlX, -(hw - 0.08), hw - 0.08, 0.55, belt + 0.005, mat(DASH)));
  // 중앙 디스플레이 (0.36 x 0.22 m, 대각 약 16.6인치). 대시 뒷면 앞에 서 있고, 윗변(약 belt-0.007)이 대시 윗면보다
  // 낮아 가장 낮은 렌더 눈(보닛 면 + 3.5 cm, main.ts)에서도 대시선 위로 올라와 앞유리를 가리지 않는다.
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.22, 0.36), mat(0x0b0c0e));
  screen.position.copy(L(dashX - 0.02, 0, belt - 0.115));
  screen.rotation.z = -0.2; // 윗부분을 앞으로 젖혀 화면이 운전자 눈 쪽을 향하도록
  g.add(screen);
  // 도어 트림·바닥
  for (const s of [1, -1]) {
    const y0 = s > 0 ? hw - 0.1 : -(hw - 0.04);
    const y1 = s > 0 ? hw - 0.04 : -(hw - 0.1);
    g.add(box(xr + 0.3, cowlX - 0.02, y0, y1, 0.4, belt, trim));
  }
  // 바닥: 눈 아래 0.88 m (모델 Y 0.32), 하부 몰딩 윗면(0.22)보다 위
  const floorTop = Math.max(eh - 0.88, 0.26);
  g.add(box(xr + 0.2, cowlX - 0.2, -(hw - 0.1), hw - 0.1, floorTop - 0.04, floorTop, mat(DASH)));
  // 뒷바퀴 휠하우스 (실내로 바퀴가 보이지 않게)
  const tr = spec.tireDiameter / 2 + 0.05;
  for (const s of [1, -1]) {
    const yIn = spec.trackRear / 2 - spec.tireWidth / 2 - 0.04;
    g.add(box(-tr, tr, s > 0 ? yIn : -(hw - 0.03), s > 0 ? hw - 0.03 : -yIn, 0.3, 2 * tr, mat(DASH)));
  }
  // 조수석 시트, 뒷좌석
  const seat = mat(SEAT);
  g.add(box(eye.x - 0.28, eye.x - 0.14, -eye.y - 0.25, -eye.y + 0.25, eh - 0.75, eh - 0.08, seat));
  g.add(box(eye.x - 0.27, eye.x - 0.15, -eye.y - 0.13, -eye.y + 0.13, eh - 0.04, eh + 0.16, seat));
  g.add(box(-0.38, -0.22, -(hw - 0.16), hw - 0.16, eh - 0.75, eh - 0.18, seat));
  for (const y of [-0.5, 0, 0.5]) g.add(box(-0.36, -0.24, y - 0.12, y + 0.12, eh - 0.16, eh, seat));

  // 핸들 (키 175 cm 운전자 위치 기준, 25° 기울임). steeringRig로 칼럼 높이를 운전자 눈 높이에 맞춰 내린다.
  const steeringRig = new THREE.Group();
  g.add(steeringRig);
  const wheelC = { x: eye.x + 0.45, h: eh - 0.27 }; // 핸들 중심 (모델 Y 높이 0.93)
  const tilt = new THREE.Group();
  tilt.position.copy(L(wheelC.x, eye.y, wheelC.h));
  tilt.rotation.z = (-25 * Math.PI) / 180;
  const face = new THREE.Group();
  face.rotation.y = -Math.PI / 2;
  tilt.add(face);
  const steeringWheel = new THREE.Group();
  face.add(steeringWheel);
  steeringWheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.02, 8, 32), trim));
  steeringWheel.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.02), trim));
  const lower = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.17, 0.02), trim);
  lower.position.y = -0.09;
  steeringWheel.add(lower);
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.025), mat(0xd04040));
  marker.position.y = 0.185;
  steeringWheel.add(marker);
  steeringRig.add(tilt);
  // 스티어링 칼럼: 핸들 중심에서 핸들 면의 법선(앞·아래, 기울기 0.084/0.18)을 따라 대시 뒷면 안쪽 0.079 m까지.
  // 대시 뒷면이 앞으로 물러나면 칼럼도 함께 길어진다 (모델 Y는 그대로: 눈 x + 0.63, 높이 0.846).
  const colX = dashX + 0.079;
  steeringRig.add(beam(L(wheelC.x, eye.y, wheelC.h), L(colX, eye.y, wheelC.h - ((colX - wheelC.x) * 0.084) / 0.18), 0.06, trim));

  // ---- 바퀴 ----
  const wheels: THREE.Object3D[] = [];
  const frontWheels: THREE.Object3D[] = [];
  const r = spec.tireDiameter / 2;
  const tireGeo = new THREE.CylinderGeometry(r, r, spec.tireWidth, 18);
  tireGeo.rotateX(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(r * 0.62, r * 0.62, spec.tireWidth + 0.01, 10);
  rimGeo.rotateX(Math.PI / 2);
  const positions: [number, number, boolean][] = [
    [spec.wheelbase, spec.trackFront / 2, true],
    [spec.wheelbase, -spec.trackFront / 2, true],
    [0, spec.trackRear / 2, false],
    [0, -spec.trackRear / 2, false],
  ];
  for (const [x, y, front] of positions) {
    const pivot = new THREE.Group();
    pivot.position.copy(L(x, y, r));
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(tireGeo, mat(TIRE)));
    spin.add(new THREE.Mesh(rimGeo, mat(RIM)));
    pivot.add(spin);
    g.add(pivot);
    wheels.push(spin);
    if (front) frontWheels.push(pivot);
  }

  return {
    group: g,
    frontWheels,
    wheels,
    steeringWheel,
    steeringRig,
    mirrorAnchors: {
      left: L(m.xRear - 0.004, mirrorY, mirrorH),
      right: L(m.xRear - 0.004, -mirrorY, mirrorH),
      rear: L(roofFrontX + 0.12, 0, H - 0.2),
    },
    mirrorGlassSize: { side: [Math.min(0.18, mw - m.yInner - 0.02), glassH], rear: [0.25, 0.065] },
    hoodLine: hoodTop,
  };
}

/** 주차된 차 (메타데이터의 중심·방향·크기 사용) */
export function buildParkedCar(meta: Record<string, number | string>): THREE.Group {
  const len = meta.length as number;
  const wid = meta.width as number;
  const hgt = meta.height as number;
  const color = meta.color as number;
  const g = new THREE.Group();
  const hl = len / 2;
  const hw = wid / 2;
  const c = 0.14;
  const poly = [
    { x: -hl + c, y: -hw },
    { x: hl - c, y: -hw },
    { x: hl, y: -hw + c },
    { x: hl, y: hw - c },
    { x: hl - c, y: hw },
    { x: -hl + c, y: hw },
    { x: -hl, y: hw - c },
    { x: -hl, y: -hw + c },
  ];
  const belt = 0.62 * hgt;
  g.add(extrudePoly(poly, 0.18, belt, mat(color)));
  g.add(extrudePoly(aabbRect(-hl + 0.55, -hw + 0.12, hl - 1.15, hw - 0.12), belt, hgt - 0.04, mat(0x22262b)));
  g.add(extrudePoly(aabbRect(-hl + 0.75, -hw + 0.16, hl - 1.5, hw - 0.16), hgt - 0.04, hgt, mat(color)));
  // 접힌 미러
  for (const s of [1, -1]) g.add(extrudePoly(rect(hl - 1.2, s * (hw + 0.02), 0.2, 0.06), belt, belt + 0.12, mat(color)));
  const r = 0.33;
  const tg = new THREE.CylinderGeometry(r, r, 0.23, 14);
  tg.rotateX(Math.PI / 2);
  const wb = len * 0.6;
  for (const [x, y] of [
    [wb / 2, hw - 0.17],
    [wb / 2, -(hw - 0.17)],
    [-wb / 2, hw - 0.17],
    [-wb / 2, -(hw - 0.17)],
  ]) {
    const t = new THREE.Mesh(tg, mat(TIRE));
    t.position.copy(L(x, y, r));
    g.add(t);
  }
  g.position.copy(L(meta.cx as number, meta.cy as number, 0));
  g.rotation.y = meta.heading as number;
  return g;
}
