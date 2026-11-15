import * as THREE from 'three';

/** 거울 카메라에만 보이는 레이어 (예: 실내에서는 도어 안쪽 패널에 가려 안 보이는 바깥 도어 어깨) */
export const MIRROR_LAYER = 3;

/**
 * 평면/볼록 거울.
 * 눈 위치를 거울 평면에 대칭시킨 가상 카메라로, 거울 사각형에 정확히 맞춘
 * 비대칭(off-axis) 투영(Kooima, "Generalized Perspective Projection")으로 렌더링한다.
 * 그래서 렌더타깃 전체가 거울 면적에 쓰이고, 눈 위치가 바뀌면 거울 속 모습도 바뀐다.
 * 볼록 거울은 가상 눈을 유리 쪽으로 당겨 시야각을 convex배 넓히는 것으로 근사한다.
 */
export class MirrorView {
  readonly mesh: THREE.Mesh;
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly bezel: THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>;
  private enabled = true;

  constructor(
    private readonly size: [number, number],
    res: [number, number],
    private readonly convex: number,
    private readonly viewDirLocal: THREE.Vector3, // 운전자가 거울로 보고자 하는 방향(차량 로컬, Three 좌표)
  ) {
    this.rt = new THREE.WebGLRenderTarget(res[0], res[1]);
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(size[0], size[1]);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); // 좌우 반전
    this.material = new THREE.MeshBasicMaterial({ map: this.rt.texture });
    this.mesh = new THREE.Mesh(geo, this.material);
    // 유리 뒤 테두리: 유리와 함께 돌아가 하우징과의 틈을 가린다. 자기 거울을 그릴 때는 mesh와 함께 숨는다.
    const bezel = new THREE.Mesh(
      new THREE.BoxGeometry(size[0] + 0.014, size[1] + 0.014, 0.025),
      new THREE.MeshLambertMaterial({ color: 0x1b1d20 }),
    );
    bezel.position.z = -0.0135;
    this.mesh.add(bezel);
    this.bezel = bezel;
    this.cam.matrixAutoUpdate = false;
    this.cam.matrixWorldAutoUpdate = false;
    this.cam.layers.enable(MIRROR_LAYER);
  }

  /** 차량을 바꿀 때: 렌더타깃, 유리 평면과 재질, 테두리(이 거울 전용 geometry·재질)를 해제한다. 메시는 호출 전에 떼어 낸다. */
  dispose() {
    this.rt.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.bezel.geometry.dispose();
    this.bezel.material.dispose();
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.material.map = on ? this.rt.texture : null;
    this.material.color.set(on ? 0xffffff : 0x3a3d42);
    this.material.needsUpdate = true;
  }

  /**
   * 거울 면이 (눈 방향 + 보고자 하는 방향)의 이등분선을 향하도록 조정한다. 차량 로컬 좌표.
   * viewDir를 주면 기본 조준 대신 그 방향을 본다 (후진 연동 하향, main.ts).
   */
  aim(anchor: THREE.Vector3, eye: THREE.Vector3, viewDir: THREE.Vector3 = this.viewDirLocal) {
    this.mesh.position.copy(anchor);
    const toEye = eye.clone().sub(anchor).normalize();
    const n = toEye.add(viewDir.clone().normalize()).normalize();
    const m = new THREE.Matrix4().lookAt(n, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    this.mesh.quaternion.setFromRotationMatrix(m);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, eyeWorld: THREE.Vector3) {
    if (!this.enabled) return;
    const [w, h] = this.size;
    this.mesh.updateWorldMatrix(true, false);
    const mw = this.mesh.matrixWorld;
    const pa = new THREE.Vector3(-w / 2, -h / 2, 0).applyMatrix4(mw);
    const pb = new THREE.Vector3(w / 2, -h / 2, 0).applyMatrix4(mw);
    const pc = new THREE.Vector3(-w / 2, h / 2, 0).applyMatrix4(mw);
    const vr = pb.clone().sub(pa).normalize();
    const vu = pc.clone().sub(pa).normalize();
    const vn = new THREE.Vector3().crossVectors(vr, vu).normalize();
    const dist = eyeWorld.clone().sub(pa).dot(vn);
    if (dist <= 0.001) return; // 눈이 거울 뒤에 있음
    const pe = eyeWorld.clone().addScaledVector(vn, -2 * dist);
    if (this.convex !== 1) {
      // 볼록 거울 근사: 가상 눈을 유리 중심 쪽으로 convex배 당기면 같은 유리 창으로 보는 각이 convex배 넓어진다.
      // (창을 넓히는 대신 이렇게 하면 광선이 유리 안에서만 출발해 차체 속을 들여다보지 않는다.)
      const center = pb.clone().add(pc).multiplyScalar(0.5);
      pe.sub(center).divideScalar(this.convex).add(center);
    }

    // 가상 카메라는 거울 뒤에서 바라보므로 좌우가 바뀐 기저를 쓴다.
    const vr2 = vr.clone().negate();
    const vn2 = vn.clone().negate();
    const pa2 = pb;
    const pb2 = pa;
    const pc2 = pb.clone().add(pc).sub(pa);
    const va = pa2.clone().sub(pe);
    const vb = pb2.clone().sub(pe);
    const vc = pc2.clone().sub(pe);
    const d = -va.dot(vn2);
    const near = d; // 근평면 = 거울 평면 → 거울 뒤쪽 물체는 잘린다
    const l = vr2.dot(va);
    const r = vr2.dot(vb);
    const b = vu.dot(va);
    const t = vu.dot(vc);
    this.cam.projectionMatrix.makePerspective(l, r, t, b, near, 200);
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
    this.cam.matrixWorld.makeBasis(vr2, vu, vn2).setPosition(pe);
    this.cam.matrixWorldInverse.copy(this.cam.matrixWorld).invert();

    this.mesh.visible = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.cam);
    renderer.setRenderTarget(null);
    this.mesh.visible = true;
  }
}

/**
 * 후방카메라 화면. 실제 차의 후방카메라처럼 좌우를 뒤집어(거울상) 보여 준다: 화면 왼쪽 = 차의 왼쪽.
 * 렌더타깃에 그린 뒤 UV를 뒤집은 사각형으로 붙인다. (투영 행렬을 뒤집으면 면 감기가 바뀌어 컬링이 깨진다.)
 */
export class RearCamView {
  private readonly rt = new THREE.WebGLRenderTarget(1, 1);
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(readonly camera: THREE.PerspectiveCamera) {
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(2, 2);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); // 좌우 반전
    this.quadScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.rt.texture, depthTest: false })));
  }

  /** x, y: 캔버스 왼쪽 아래 기준, w, h: 크기 (모두 CSS 픽셀) */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, x: number, y: number, w: number, h: number) {
    const pr = renderer.getPixelRatio();
    const pw = Math.max(1, Math.round(w * pr));
    const ph = Math.max(1, Math.round(h * pr));
    if (this.rt.width !== pw || this.rt.height !== ph) this.rt.setSize(pw, ph);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setScissorTest(false);
  }
}

export type LookTarget = 'LM' | 'LW' | 'F' | 'RW' | 'RM' | 'BACK';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 운전석 1인칭 카메라: 고개 돌리기(yaw/pitch)와 몸 기울임 근사 */
export class DriverView {
  readonly camera: THREE.PerspectiveCamera;
  private eye = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.08;
  private targetYaw = 0;
  private targetPitch = -0.08;
  private baseFov = 60;
  private zoomFov: number | null = null;
  private anchors: Record<'LM' | 'RM', THREE.Vector3> = { LM: new THREE.Vector3(), RM: new THREE.Vector3() };

  constructor() {
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.03, 300);
    this.camera.rotation.order = 'YXZ';
  }

  setEye(eye: THREE.Vector3) {
    this.eye.copy(eye);
  }

  setMirrorAnchors(left: THREE.Vector3, right: THREE.Vector3) {
    this.anchors.LM.copy(left);
    this.anchors.RM.copy(right);
  }

  setFov(fov: number) {
    this.baseFov = fov;
  }

  /** 빠른 시선 '좌/우 미러'(확대)로 거울을 보고 있는지. 드래그하거나 다른 시선을 고르면 false. */
  get mirrorLook(): boolean {
    return this.zoomFov !== null;
  }

  drag(dx: number, dy: number) {
    const k = (this.camera.fov / 60) * 0.005;
    this.targetYaw = Math.max(-2.9, Math.min(2.9, this.targetYaw - dx * k));
    this.targetPitch = Math.max(-1.0, Math.min(0.5, this.targetPitch - dy * k));
    this.zoomFov = null;
  }

  look(target: LookTarget) {
    this.zoomFov = null;
    switch (target) {
      case 'F':
        this.targetYaw = 0;
        this.targetPitch = -0.08;
        break;
      case 'LW':
        this.targetYaw = 1.35;
        this.targetPitch = -0.3;
        break;
      case 'RW':
        this.targetYaw = -1.35;
        this.targetPitch = -0.3;
        break;
      case 'BACK':
        // 국내에서는 오른쪽 어깨 너머로 돌아보는 경우가 많다.
        this.targetYaw = -2.75;
        this.targetPitch = -0.12;
        break;
      case 'LM':
      case 'RM': {
        const d = this.anchors[target].clone().sub(this.eye);
        this.targetYaw = Math.atan2(-d.z, d.x);
        this.targetPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
        this.zoomFov = 26; // 작은 화면에서도 미러가 보이도록 확대
        break;
      }
    }
  }

  update(dt: number, aspect: number) {
    const k = 1 - Math.exp(-dt * 10);
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    const fovT = this.zoomFov ?? this.baseFov;
    this.camera.fov += (fovT - this.camera.fov) * k;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // 몸 기울임: 왼쪽 창으로는 약간 바깥, 뒤를 볼 때는 차 중앙 쪽으로
    const leanLeft = 0.06 * smooth(0.8, 1.4, this.yaw);
    const leanRight = 0.16 * smooth(1.2, 2.6, -this.yaw);
    this.camera.position.set(this.eye.x, this.eye.y + 0.03 * smooth(1.2, 2.6, -this.yaw), this.eye.z - leanLeft + leanRight);
    this.camera.rotation.set(this.pitch, -Math.PI / 2 + this.yaw, 0);
  }
}
