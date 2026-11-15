import * as THREE from 'three';
import type { Pose, Vec2 } from '../sim/geometry';
import type { VehicleSpec } from '../sim/specs';
import { buildFootprint } from '../sim/footprint';
import { L } from './util';

// 고스트 비교의 3D 표시 (계약서 §4): 이전 차의 바닥 윤곽(차체 + 양쪽 미러)과 네 모서리 기둥.
// 기본 레이어라 운전석·미러·후방카메라에 모두 보인다. 충돌은 없다.

const COLOR = 0xff9f0a;
const RIBBON_W = 0.04;
/**
 * 바닥 띠 높이. 계약은 0.012인데 후방카메라 가이드 리본(guideLines.ts)이 정확히 0.012라
 * 겹치는 곳에서 깊이 싸움(z-fighting)이 난다. 1 mm 아래에 두어 가이드가 위에 보이게 한다.
 * 목표 칸(0.005)과 주차선(0.003)보다는 위.
 */
const RIBBON_H = 0.011;
const POST = 0.05;

/**
 * 평면도 윤곽: 차체 팔각형의 두 옆변에 미러 상자의 바깥 부분을 끼운 닫힌 다각형 하나.
 * 미러 상자를 따로 그리면 차체 안으로 들어간 변과, 반투명 띠가 겹쳐 진해지는 곳이 생긴다.
 */
function planOutline(body: Vec2[], spec: VehicleSpec): Vec2[] {
  const mw = spec.widthMirrors / 2;
  const { xFront, xRear } = spec.mirror;
  const out: Vec2[] = [];
  body.forEach((p, i) => {
    const q = body[(i + 1) % body.length];
    out.push(p);
    if (p.y === q.y) {
      // 옆변 (x축과 나란한 변): 진행 방향 순서로 미러 돌출부를 끼운다
      const s = Math.sign(p.y);
      const [x0, x1] = q.x > p.x ? [xRear, xFront] : [xFront, xRear];
      out.push({ x: x0, y: p.y }, { x: x0, y: s * mw }, { x: x1, y: s * mw }, { x: x1, y: p.y });
    }
  });
  return out;
}

/** 차체 모서리 = 모따기(대각선) 변의 중점 4개 */
function cornerPoints(body: Vec2[]): Vec2[] {
  return body.flatMap((p, i) => {
    const q = body[(i + 1) % body.length];
    return p.x !== q.x && p.y !== q.y ? [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }] : [];
  });
}

/** 닫힌 다각형 둘레를 중심선으로 하는 폭 w 띠 (모서리는 마이터 이음). 로컬 좌표, 높이 h. */
function ringRibbon(poly: Vec2[], w: number, h: number): THREE.BufferGeometry {
  const n = poly.length;
  const normal = (a: Vec2, b: Vec2): Vec2 => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
  };
  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  poly.forEach((p, i) => {
    const n1 = normal(poly[(i + n - 1) % n], p);
    const n2 = normal(p, poly[(i + 1) % n]);
    // 마이터: 앞뒤 두 변에서 모두 w/2 떨어진 점
    const k = w / 2 / (1 + n1.x * n2.x + n1.y * n2.y);
    const mx = (n1.x + n2.x) * k;
    const my = (n1.y + n2.y) * k;
    outer.push({ x: p.x + mx, y: p.y + my });
    inner.push({ x: p.x - mx, y: p.y - my });
  });
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (const q of [outer[i], outer[j], inner[j], outer[i], inner[j], inner[i]]) {
      const v = L(q.x, q.y, h);
      pos.push(v.x, v.y, v.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export class GhostView {
  /** main.ts가 씬에 한 번 추가한다. 차종(setSpec)이 있고 setVisible(false)가 아닐 때만 보인다. */
  readonly group = new THREE.Group();
  private readonly lineMat = new THREE.MeshBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly postMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.5, depthWrite: false });
  private geoms: THREE.BufferGeometry[] = [];
  private on = true;

  constructor() {
    this.group.visible = false;
  }

  /** 기하를 새로 만들고 이전 것은 해제한다. null → 비우고 숨긴다. 보임 여부(setVisible)는 바꾸지 않는다. */
  setSpec(spec: VehicleSpec | null): void {
    this.clear();
    if (spec) {
      const body = buildFootprint(spec).body.poly;
      const ribbon = ringRibbon(planOutline(body, spec), RIBBON_W, RIBBON_H);
      const post = new THREE.BoxGeometry(POST, spec.height, POST);
      this.geoms = [ribbon, post];
      // renderOrder 1: 반투명 목표 칸(scene.ts)보다 나중에 그려, 겹쳐도 초록으로 물들지 않는다
      const outline = new THREE.Mesh(ribbon, this.lineMat);
      outline.renderOrder = 1;
      this.group.add(outline);
      for (const c of cornerPoints(body)) {
        const m = new THREE.Mesh(post, this.postMat);
        m.position.copy(L(c.x, c.y, spec.height / 2));
        m.renderOrder = 1;
        this.group.add(m);
      }
    }
    this.syncVisible();
  }

  /** pose = 고스트 자세 (ghostPose 결과) */
  update(pose: Pose): void {
    this.group.position.copy(L(pose.x, pose.y, 0));
    this.group.rotation.y = pose.heading;
  }

  setVisible(on: boolean): void {
    this.on = on;
    this.syncVisible();
  }

  dispose(): void {
    this.clear();
    this.lineMat.dispose();
    this.postMat.dispose();
  }

  private syncVisible(): void {
    this.group.visible = this.on && this.geoms.length > 0;
  }

  private clear(): void {
    this.group.clear();
    for (const g of this.geoms) g.dispose();
    this.geoms = [];
  }
}
