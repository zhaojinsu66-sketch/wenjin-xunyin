/*
 * 问金寻银 · 3D 场景（three.js）。
 * 每个亮点是一只真实股票，尘埃归属于离它最近的股票、颜色跟着这只股票的真实涨跌走。
 * 股票状态存在一张浮点纹理里（涨跌幅、闪光时间、大小、点亮时间），行情更新只改纹理，不动几何。
 *
 * Wenjin Xunyin · 3D scene (three.js).
 * Each bright point is a real stock; dust belongs to the nearest stock and follows its real price change.
 * Stock state lives in a float texture (change, flare time, size, reveal time); quote updates only touch the texture, never the geometry.
 */
import * as THREE from './three.module.min.js';

const Core = window.NebulaCore;
const W = 256;
const K = 3.7;

const RAMP = /* glsl */`
vec3 ramp(float p){
  if(p<-90.) return vec3(.16,.19,.25);
  float a=clamp(abs(p)/7.,0.,1.);
  if(abs(p)<.05) return vec3(.62,.66,.72);
  if(p>0.) return a<.35?mix(vec3(.98,.78,.36),vec3(1.,.56,.20),a/.35):mix(vec3(1.,.56,.20),vec3(1.,.16,.20),(a-.35)/.65);
  return a<.35?mix(vec3(.40,.72,.95),vec3(.16,.82,.72),a/.35):mix(vec3(.16,.82,.72),vec3(.08,.86,.40),(a-.35)/.65);
}`;

const MORPH = /* glsl */`
uniform vec3 uPhase;
vec3 morph(vec3 p){
  vec3 q=p*${K.toFixed(2)}+uPhase;
  vec3 s=sin(q),c=cos(q);
  float f=s.x*c.y+s.y*c.z+s.z*c.x;
  vec3 g=vec3(c.x*c.y-s.z*s.x,c.y*c.z-s.x*s.y,c.z*c.x-s.y*s.z);
  return p-g*f/((dot(g,g)+.35)*${K.toFixed(2)});
}`;

const STATE = /* glsl */`
uniform highp sampler2D uState;
vec4 stateOf(float i){int id=int(i+.5);return texelFetch(uState,ivec2(id%${W},id/${W}),0);}`;

const NOISE = /* glsl */`
float hash(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*noise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}`;

const POINT_FRAGMENT = /* glsl */`
varying vec3 vColor;
void main(){
  float d=length(gl_PointCoord-.5)*2.;
  if(d>1.) discard;
  float a=pow(1.-d,1.5)+.5*pow(max(0.,1.-d*2.4),2.);
  gl_FragColor=vec4(vColor*a,1.);
}`;

const additive = extra => Object.assign({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }, extra);

// 外盘的尺寸（世界单位，星云球壳半径约 1.06）。星云是主角，外盘只是贴在外面的一圈薄环，最外面就是股票信息，不再有刻度和白边：
// 由内到外是涨跌环、次级涨跌榜标签（第 7–12 名）、涨跌榜标签（前 6 名）
/**
 * 接口线和彗星在核心上的位置：碎壳表面的半径。
 * Where cables and comets attach to the core: the radius of the broken shell surface.
 */
export const CORE_SOCKET = 0.31;
const DIAL = { slots: 12, breadth: [1.066, 1.074], inner: [1.08, 1.184], label: [1.19, 1.32] };
// 平时从正面展示。留一点点几乎看不出的倾角：同一圈要按远近分两遍画，完全正对时远近分不开
const FACE_ON = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.02, 0.012, 0));

function annulus(r1, r2, segments = 256) {
  const pos = [], index = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    pos.push(c * r1, s * r1, 0, c * r2, s * r2, 0);
  }
  for (let i = 0; i < segments; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

/**
 * 一段弧形标签：中心在 +x 轴。u 沿顺时针增加（文字阅读方向），v 从内到外。
 * An arc-shaped label centered on the +x axis. u increases clockwise (reading direction), v runs from inner to outer.
 */
function arcStrip(r1, r2, half, segments = 24) {
  const pos = [], uv = [], index = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments, t = half - u * 2 * half, c = Math.cos(t), s = Math.sin(t);
    pos.push(c * r1, s * r1, 0, c * r2, s * r2, 0);
    uv.push(u, 0, u, 1);
  }
  for (let i = 0; i < segments; i++) { const a = i * 2; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

const DIAL_VERTEX = 'varying vec2 vP;varying float vZ;void main(){vP=position.xy;vec4 mv=modelViewMatrix*vec4(position,1.);vZ=mv.z;gl_Position=projectionMatrix*mv;}';

function fullscreen(material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}
const QUAD_VERTEX = 'varying vec2 vUv;void main(){vUv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}';

/**
 * 辉光：先逐级缩小（13 点采样，小亮点不闪烁），再逐级放大叠加。
 * Bloom: downsample step by step (13-tap sampling so small points do not flicker), then upsample and add.
 */
class Bloom {
  constructor(renderer, type) {
    this.renderer = renderer;
    this.type = type;
    this.levels = 5;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.down = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKnee: { value: 0 } },
      vertexShader: QUAD_VERTEX, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc;uniform vec2 uTexel;uniform float uKnee;varying vec2 vUv;
        vec3 s(float x,float y){return texture2D(tSrc,vUv+vec2(x,y)*uTexel).rgb;}
        void main(){
          vec3 c=s(0.,0.)*.125+(s(-2.,2.)+s(2.,2.)+s(-2.,-2.)+s(2.,-2.))*.03125+(s(0.,2.)+s(-2.,0.)+s(2.,0.)+s(0.,-2.))*.0625+(s(-1.,1.)+s(1.,1.)+s(-1.,-1.)+s(1.,-1.))*.125;
          if(uKnee>0.){float b=max(c.r,max(c.g,c.b));c*=smoothstep(uKnee*.45,uKnee*1.2,b);}
          gl_FragColor=vec4(min(c,vec3(24.)),1.);
        }`,
    });
    this.up = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1 } },
      vertexShader: QUAD_VERTEX, depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc;uniform vec2 uTexel;uniform float uGain;varying vec2 vUv;
        vec3 s(float x,float y){return texture2D(tSrc,vUv+vec2(x,y)*uTexel).rgb;}
        void main(){
          vec3 c=s(0.,0.)*4.+(s(-1.,0.)+s(1.,0.)+s(0.,-1.)+s(0.,1.))*2.+s(-1.,-1.)+s(1.,-1.)+s(-1.,1.)+s(1.,1.);
          gl_FragColor=vec4(c/16.*uGain,1.);
        }`,
    });
    this.tri = fullscreen(this.down);
    this.scene.add(this.tri);
    this.targets = [];
  }

  resize(w, h) {
    this.targets.forEach(t => t.dispose());
    this.targets = [];
    let x = Math.max(2, w >> 1), y = Math.max(2, h >> 1);
    for (let i = 0; i < this.levels; i++) {
      this.targets.push(new THREE.WebGLRenderTarget(x, y, { type: this.type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false }));
      x = Math.max(2, x >> 1); y = Math.max(2, y >> 1);
    }
  }

  run(source) {
    const r = this.renderer;
    let src = source;
    this.tri.material = this.down;
    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i];
      this.down.uniforms.tSrc.value = src;
      this.down.uniforms.uTexel.value.set(1 / (i === 0 ? target.width * 2 : this.targets[i - 1].width), 1 / (i === 0 ? target.height * 2 : this.targets[i - 1].height));
      this.down.uniforms.uKnee.value = i === 0 ? 0.8 : 0;
      r.setRenderTarget(target);
      r.render(this.scene, this.camera);
      src = target.texture;
    }
    this.tri.material = this.up;
    const prevAuto = r.autoClear;
    r.autoClear = false;
    for (let i = this.targets.length - 1; i > 0; i--) {
      this.up.uniforms.tSrc.value = this.targets[i].texture;
      this.up.uniforms.uTexel.value.set(1 / this.targets[i].width, 1 / this.targets[i].height);
      this.up.uniforms.uGain.value = 0.92;
      r.setRenderTarget(this.targets[i - 1]);
      r.render(this.scene, this.camera);
    }
    r.autoClear = prevAuto;
    return this.targets[0].texture;
  }
}

export class NebulaScene {
  constructor(canvas, { capture = false } = {}) {
    this.canvas = canvas;
    this.capture = capture;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: capture });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    const gl = this.renderer.getContext();
    this.floatTarget = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const type = this.floatTarget ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type, depthBuffer: true, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.bloom = new Bloom(this.renderer, type);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40);
    this.camDist = 4.6;
    this.camera.position.set(0, 0, this.camDist);
    this.shell = new THREE.Group();
    this.scene.add(this.shell);
    this.shell.rotation.set(0.32, 0.5, 0);

    this.time = 0;
    this.flow = 0;
    this.flowSpeed = 0.05;
    this.heat = 0.6;
    this.tilt = 0;
    this.uniforms = {
      uTime: { value: 0 }, uPx: { value: 1 }, uDim: { value: 0 }, uView: { value: 0 }, uCamDist: { value: this.camDist },
      uPhase: { value: new THREE.Vector3() }, uFlow: { value: 0 }, uState: { value: null }, uHeat: { value: 0.6 }, uTilt: { value: 0 },
    };
    this.dimTarget = 0;
    this.viewTarget = 0;
    this.frameCur = null;
    this.frameTarget = { cx: 0, cy: 0, radius: 100 };
    this.size = { w: 1, h: 1, dpr: 1 };
    this.drag = { active: false, vx: 0.0, vy: 0.0 };
    this.auto = 0.05;
    this.level = 0;
    this.slow = 0;
    this.frameMs = 16;
    this.lastNow = 0;

    this.compositeScene = new THREE.Scene();
    this.composite = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0.55 }, uAspect: { value: 1 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) } },
      vertexShader: QUAD_VERTEX, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */`
        uniform sampler2D tScene,tBloom;uniform float uBloom,uAspect;uniform vec2 uCenter;varying vec2 vUv;
        void main(){
          vec3 c=texture2D(tScene,vUv).rgb+texture2D(tBloom,vUv).rgb*uBloom;
          vec2 q=(vUv-uCenter)*vec2(uAspect,1.);
          c*=mix(.55,1.,smoothstep(1.05,.18,length(q)));
          // 按亮度压缩，保持色相：粒子叠得再密，红还是红、绿还是绿，只有最亮的地方才偏白
          float l=max(c.r,max(c.g,c.b));
          c*=(1.-exp(-l*1.3))/max(l,1e-4);
          c=mix(c,vec3(1.),smoothstep(1.6,7.,l)*.55);
          c=pow(c,vec3(1./2.2));
          c+=(fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5)/255.;
          gl_FragColor=vec4(c,1.);
        }`,
    });
    this.compositeScene.add(fullscreen(this.composite));
    this.compositeCam = new THREE.Camera();

    this.buildCore();
    this.buildComets();
    this.buildRings();
    this.buildDial();
  }

  // ---------------------------------------------------------------- 尺寸和取景 / Size and framing

  resize(w, h, dpr) {
    const ratio = Math.min(dpr, [2, 1.7, 1.35, 1.1][this.level]);
    this.size = { w, h, dpr: ratio };
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    const pw = Math.round(w * ratio), ph = Math.round(h * ratio);
    this.rt.setSize(pw, ph);
    this.bloom.resize(pw, ph);
    this.uniforms.uPx.value = ratio;
    this.composite.uniforms.uAspect.value = w / h;
    this.applyFrame(true);
  }

  /**
   * 让星云球心落在屏幕 (cx, cy)，半径 radius（CSS 像素）。
   * Put the nebula center at screen (cx, cy) with the given radius (CSS pixels).
   */
  setFrame(cx, cy, radius, instant = false) {
    this.frameTarget = { cx, cy, radius };
    if (instant || !this.frameCur) { this.frameCur = { cx, cy, radius }; this.applyFrame(true); }
  }

  applyFrame() {
    const f = this.frameCur;
    if (!f) return;
    const { w, h } = this.size;
    const focal = f.radius * Math.sqrt(this.camDist * this.camDist - 1);
    this.camera.fov = 2 * Math.atan((h / 2) / focal) * 180 / Math.PI;
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, h, w / 2 - f.cx, h / 2 - f.cy, w, h);
    this.camera.updateProjectionMatrix();
    this.composite.uniforms.uCenter.value.set(f.cx / w, 1 - f.cy / h);
    this.scaleBase = f.radius / 165;
  }

  // ---------------------------------------------------------------- 股票 / Stocks

  /**
   * positions: Float32Array(n*3)。sizes: 0–1。
   * positions: Float32Array(n*3). sizes: 0–1.
   */
  setStocks(positions, sizes, dustCount) {
    this.positions = positions;
    this.n = positions.length / 3;
    const height = Math.ceil(this.n / W);
    this.state = new Float32Array(W * height * 4);
    for (let i = 0; i < this.n; i++) {
      this.state[i * 4] = -99;
      this.state[i * 4 + 1] = -100;
      this.state[i * 4 + 2] = Math.min(0.999, sizes[i]);
      this.state[i * 4 + 3] = 1e7;
    }
    this.stateTex = new THREE.DataTexture(this.state, W, height, THREE.RGBAFormat, THREE.FloatType);
    this.stateTex.minFilter = this.stateTex.magFilter = THREE.NearestFilter;
    this.stateTex.needsUpdate = true;
    this.uniforms.uState.value = this.stateTex;
    this.buildStocks();
    this.buildDust(dustCount);
  }

  setChange(i, pct) { this.state[i * 4] = pct === null || Number.isNaN(pct) ? -99 : pct; this.dirty = true; }
  flare(i, delay = 0) { this.state[i * 4 + 1] = this.time + delay; this.dirty = true; }
  reveal(i, delay = 0) { if (this.state[i * 4 + 3] > 1e6) { this.state[i * 4 + 3] = this.time + delay; this.dirty = true; } }
  setSize(i, size) { this.state[i * 4 + 2] = Math.floor(this.state[i * 4 + 2]) + Math.min(0.999, size); this.dirty = true; }
  /**
   * 高亮一批股票（选中规则、选中个股时其余变暗）。传 null 取消。
   * Highlight a set of stocks (the rest dim when a rule or a stock is selected). Pass null to clear.
   */
  setMask(list) {
    for (let i = 0; i < this.n; i++) this.state[i * 4 + 2] = this.state[i * 4 + 2] % 1 + (this.viewOff && this.viewOff[i] ? 2 : 0);
    if (list && list.length) for (const i of list) this.state[i * 4 + 2] = this.state[i * 4 + 2] % 1 + 1;
    this.highlighted = list && list.length ? list : null;
    this.dimTarget = this.highlighted ? 1 : 0;
    this.dirty = true;
  }
  /**
   * 切换市场：off[i] 为真的股票变暗，其余照常。和高亮是两回事，可以同时存在。传 null 取消。
   * Market filter: stocks with off[i] true are dimmed, the rest unchanged. Independent of highlighting; both can apply. Pass null to clear.
   */
  setViewOff(off) {
    this.viewOff = off;
    this.viewTarget = off ? 1 : 0;
    this.setMask(this.highlighted);
  }

  buildStocks() {
    const g = new THREE.BufferGeometry();
    const index = new Float32Array(this.n), seed = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) { index[i] = i; seed[i] = (i * 0.61803398875) % 1; }
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const material = new THREE.ShaderMaterial(additive({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aIndex,aSeed;
        uniform float uTime,uPx,uDim,uView,uCamDist;
        varying vec3 vColor;
        ${RAMP}${MORPH}${STATE}
        void main(){
          vec4 s=stateOf(aIndex);
          float mask=floor(s.b),size=fract(s.b);
          float hit=step(.5,mask)*step(mask,1.5),off=step(1.5,mask)*uView;
          float born=clamp((uTime-s.a)/1.1,0.,1.);
          float e=1.-pow(1.-born,3.);
          vec3 p=morph(position)*mix(.16,1.,e);
          vec4 mv=modelViewMatrix*vec4(p,1.);
          float age=uTime-s.g;
          float hot=age>=0.?exp(-age*2.1):0.;
          float depth=clamp((-mv.z-(uCamDist-1.1))/2.2,0.,1.);
          float fade=mix(1.,.2,depth*depth);
          float tw=.84+.16*sin(uTime*(1.1+aSeed*2.2)+aSeed*40.);
          float dim=mix(1.,hit>.5?1.5:.14,uDim)*mix(1.,.13,off);
          vColor=ramp(s.r)*(.92+hot*4.2*(1.-off)+hit*1.2*uDim)*fade*tw*dim*step(.001,born);
          float px=mix(1.7,5.4,size)*mix(1.,.62,off)+hot*8.*(1.-off)+hit*3.5*uDim;
          gl_PointSize=max(1.,px*uPx*uCamDist/-mv.z)*min(1.,born*1.4);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: POINT_FRAGMENT,
    }));
    this.stockPoints = new THREE.Points(g, material);
    this.stockPoints.frustumCulled = false;
    this.stockPoints.renderOrder = 3;
    this.shell.add(this.stockPoints);
  }

  /**
   * 尘埃撒在多孔面上，再归属到最近的股票（颜色、点亮时间都跟这只股票）。
   * Scatter dust on the porous surface and assign each grain to its nearest stock (color and reveal time follow that stock).
   */
  buildDust(count) {
    const random = Core.rng(20261103);
    const cell = 0.14;
    const grid = new Map();
    const key = (x, y, z) => (x + 64) * 16641 + (y + 64) * 129 + (z + 64);
    for (let i = 0; i < this.n; i++) {
      const k = key(Math.floor(this.positions[i * 3] / cell), Math.floor(this.positions[i * 3 + 1] / cell), Math.floor(this.positions[i * 3 + 2] / cell));
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, bucket = []);
      bucket.push(i);
    }
    const nearest = p => {
      const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
      let best = -1, bestD = 1e9;
      for (let reach = 1; reach <= 3 && best < 0; reach++) {
        for (let x = cx - reach; x <= cx + reach; x++) for (let y = cy - reach; y <= cy + reach; y++) for (let z = cz - reach; z <= cz + reach; z++) {
          const bucket = grid.get(key(x, y, z));
          if (!bucket) continue;
          for (const i of bucket) {
            const dx = this.positions[i * 3] - p[0], dy = this.positions[i * 3 + 1] - p[1], dz = this.positions[i * 3 + 2] - p[2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      return best >= 0 ? best : Math.floor(random() * this.n);
    };
    const pos = new Float32Array(count * 3), stock = new Float32Array(count), flow = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      let p;
      for (let tries = 0; tries < 12; tries++) {
        const y = random() * 2 - 1, t = random() * Math.PI * 2, r0 = Math.sqrt(1 - y * y), radius = 0.66 + 0.38 * Math.pow(random(), 0.55);
        p = Core.toSurface([Math.cos(t) * r0 * radius, y * radius, Math.sin(t) * r0 * radius]);
        const r = Math.hypot(p[0], p[1], p[2]);
        if (r > 0.6 && r < 1.065) break;
      }
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      stock[i] = nearest(p);
      // 切向流场：在空间上连续，相邻的尘埃朝同一个方向走，看起来是一股股数据流
      const sx = Math.sin(K * p[0]), cx = Math.cos(K * p[0]), sy = Math.sin(K * p[1]), cy = Math.cos(K * p[1]), sz = Math.sin(K * p[2]), cz = Math.cos(K * p[2]);
      const n = [cx * cy - sz * sx, cy * cz - sx * sy, cz * cx - sy * sz];
      const a = [Math.sin(p[1] * 2.3 + 1), Math.cos(p[2] * 2.3 + 2), Math.sin(p[0] * 2.3 + 3)];
      const f = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      flow[i * 4] = f[0] / fl; flow[i * 4 + 1] = f[1] / fl; flow[i * 4 + 2] = f[2] / fl; flow[i * 4 + 3] = random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aStock', new THREE.BufferAttribute(stock, 1));
    g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 4));
    const material = new THREE.ShaderMaterial(additive({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aStock;attribute vec4 aFlow;
        uniform float uTime,uPx,uDim,uView,uCamDist,uFlow;
        varying vec3 vColor;
        ${RAMP}${MORPH}${STATE}
        void main(){
          vec4 s=stateOf(aStock);
          float seed=aFlow.w;
          float ph=fract(uFlow*(.4+seed*.6)+seed*7.3);
          vec3 p=morph(position+aFlow.xyz*(ph-.5)*(.05+seed*.11));
          float born=clamp((uTime-s.a)/1.6,0.,1.);
          float age=uTime-s.g;
          float hot=age>=0.?exp(-age*1.7):0.;
          vec4 mv=modelViewMatrix*vec4(p,1.);
          float depth=clamp((-mv.z-(uCamDist-1.1))/2.2,0.,1.);
          float fade=mix(1.,.13,depth);
          float mask=floor(s.b);
          float dim=mix(1.,(mask>.5&&mask<1.5)?1.3:.12,uDim)*mix(1.,.16,step(1.5,mask)*uView);
          vec3 lit=mix(ramp(s.r),vec3(.80,.82,.88),.14)*(.36+hot*1.5);
          vec3 dark=vec3(.040,.058,.085);
          // 侧面看过去的曲面，粒子在屏幕上挤得最密：调暗一些，轮廓还在，不会糊成一条白边
          vec3 q=p*${K.toFixed(2)}+uPhase;
          vec3 sq=sin(q),cq=cos(q);
          vec3 nv=normalMatrix*vec3(cq.x*cq.y-sq.z*sq.x,cq.y*cq.z-sq.x*sq.y,cq.z*cq.x-sq.y*sq.z);
          float facing=abs(nv.z)/max(length(nv),.001);
          vColor=mix(dark,lit,born)*fade*(.3+.7*sin(ph*3.14159))*dim*mix(.42,1.,smoothstep(.04,.5,facing));
          gl_PointSize=max(1.,(1.05+seed*1.15+hot*2.2)*uPx*uCamDist/-mv.z);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: POINT_FRAGMENT,
    }));
    this.dust = new THREE.Points(g, material);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 2;
    this.dustCount = count;
    this.shell.add(this.dust);
  }

  // ---------------------------------------------------------------- 燃烧的核心 / Burning core

  buildCore() {
    this.core = new THREE.Group();
    this.scene.add(this.core);
    // 内部火焰
    const fire = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 4), new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec3 vP,vN,vV;void main(){vP=position;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
      fragmentShader: /* glsl */`
        uniform float uTime,uHeat,uTilt;varying vec3 vP,vN,vV;${NOISE}
        void main(){
          float t=uTime*.32;
          float n=fbm(vP*9.+vec3(0.,-t*2.2,t));
          float m=fbm(vP*22.+vec3(t*1.3,n*3.,-t));
          float h=smoothstep(.30,.80,n*.8+m*.35);
          vec3 warm=mix(vec3(.85,.16,.02),vec3(1.,.56,.10),h);
          vec3 cool=mix(vec3(.01,.26,.30),vec3(.10,.72,.62),h);
          vec3 c=mix(warm,cool,smoothstep(-.35,-.9,uTilt)*.85);
          c=mix(c,vec3(1.,.86,.55),smoothstep(.82,1.,h));
          float f=pow(max(dot(vN,vV),0.),1.4);
          gl_FragColor=vec4(c*(.34+1.5*h*h)*(.34+f)*(.5+uHeat*.6),1.);
        }`,
    }));
    fire.renderOrder = 0;
    this.core.add(fire);
    // 焦黑的多面体碎壳：缺几片，露出里面的火
    const shard = new THREE.IcosahedronGeometry(0.29, 2);
    const p = shard.attributes.position;
    const faces = p.count / 3;
    const random = Core.rng(4242);
    const displaced = new Map();
    for (let i = 0; i < p.count; i++) {
      const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      let s = displaced.get(k);
      if (!s) displaced.set(k, s = 0.86 + random() * 0.26);
      p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
    }
    const faceRandom = new Float32Array(p.count);
    for (let f = 0; f < faces; f++) { const v = random(); faceRandom[f * 3] = faceRandom[f * 3 + 1] = faceRandom[f * 3 + 2] = v; }
    shard.setAttribute('aFace', new THREE.BufferAttribute(faceRandom, 1));
    shard.computeVertexNormals();
    const shell = new THREE.Mesh(shard, new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.DoubleSide,
      vertexShader: 'attribute float aFace;varying vec3 vP,vN,vV;varying float vF;void main(){vP=position;vF=aFace;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
      fragmentShader: /* glsl */`
        uniform float uTime,uHeat,uTilt;varying vec3 vP,vN,vV;varying float vF;${NOISE}
        void main(){
          if(vF<.20) discard;
          float t=uTime*.18;
          // 裂缝：两层噪声的等值线，越靠近等值线越亮
          float a=fbm(vP*11.+vec3(t,0.,-t));
          float b=fbm(vP*26.+vec3(0.,t*1.5,t));
          float crack=smoothstep(.055,.0,abs(a-.5))*smoothstep(.2,.65,b+.2);
          float pulse=.55+.45*sin(uTime*1.6+vF*40.);
          vec3 warm=mix(vec3(1.,.24,.03),vec3(1.,.68,.18),b);
          vec3 cool=mix(vec3(.02,.42,.42),vec3(.22,.92,.72),b);
          vec3 glow=mix(warm,cool,smoothstep(-.35,-.9,uTilt)*.85);
          float fres=pow(1.-abs(dot(vN,vV)),2.5);
          vec3 base=vec3(.008,.007,.008)+vec3(.15,.13,.12)*fres*.42+vec3(.028,.024,.022)*max(dot(vN,normalize(vec3(.4,.7,.6))),0.);
          float edgeBand=vF>.86?1.:0.;
          vec3 c=base+glow*crack*(1.15+2.1*uHeat)*pulse+glow*edgeBand*.20*pulse*(.3+uHeat);
          gl_FragColor=vec4(c,1.);
        }`,
    }));
    shell.renderOrder = 1;
    this.core.add(shell);
    this.coreShell = shell;
    // 线框：碎壳的边 + 外面一层细丝笼
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shard, 1), new THREE.ShaderMaterial(additive({
      uniforms: this.uniforms,
      vertexShader: 'varying float vD;void main(){vec4 mv=modelViewMatrix*vec4(position*1.002,1.);vD=length(position);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'uniform float uHeat;varying float vD;void main(){gl_FragColor=vec4(vec3(.72,.62,.50)*(.16+.20*uHeat),1.);}',
    })));
    edges.renderOrder = 4;
    this.core.add(edges);
    this.cage = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.43, 1)), new THREE.LineBasicMaterial({ color: new THREE.Color(0.075, 0.07, 0.065), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.cage.renderOrder = 4;
    this.scene.add(this.cage);
    // 火星
    const sparks = 260, sp = new Float32Array(sparks * 3), sd = new Float32Array(sparks);
    for (let i = 0; i < sparks; i++) {
      const y = random() * 2 - 1, t = random() * Math.PI * 2, r0 = Math.sqrt(1 - y * y), r = 0.14 + random() * 0.30;
      sp[i * 3] = Math.cos(t) * r0 * r; sp[i * 3 + 1] = y * r; sp[i * 3 + 2] = Math.sin(t) * r0 * r; sd[i] = random();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    const sparkPoints = new THREE.Points(sg, new THREE.ShaderMaterial(additive({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aSeed;uniform float uTime,uPx,uCamDist,uHeat;varying vec3 vColor;
        void main(){
          float t=fract(uTime*(.05+aSeed*.13)+aSeed*9.);
          vec3 p=position*(.75+t*.75);
          p+=vec3(sin(uTime*.8+aSeed*30.),cos(uTime*.7+aSeed*50.),sin(uTime*.6+aSeed*20.))*.012;
          vec4 mv=modelViewMatrix*vec4(p,1.);
          float a=sin(t*3.14159);
          vColor=mix(vec3(1.,.36,.10),vec3(1.,.85,.5),aSeed)*a*(.8+uHeat*2.);
          gl_PointSize=(1.2+aSeed*2.2)*uPx*uCamDist/-mv.z;
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: POINT_FRAGMENT,
    })));
    sparkPoints.renderOrder = 5;
    sparkPoints.frustumCulled = false;
    this.core.add(sparkPoints);
    // 白色光晕
    const aura = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial(additive({
      uniforms: this.uniforms, depthTest: false,
      vertexShader: /* glsl */`
        varying vec2 vQ;uniform float uHeat;
        void main(){
          vQ=position.xy;
          vec4 c=modelViewMatrix*vec4(0.,0.,0.,1.);
          c.xy+=position.xy*(.95+uHeat*.2);
          gl_Position=projectionMatrix*c;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vQ;uniform float uHeat,uTilt,uTime;
        void main(){
          float d=length(vQ);
          float a=exp(-d*d*14.)*.085+exp(-d*5.5)*.03;
          a*=smoothstep(1.,.6,d);
          vec3 tint=mix(vec3(1.,.72,.46),vec3(.46,1.,.86),smoothstep(-.35,-.9,uTilt)*.85);
          gl_FragColor=vec4(tint*a*(.5+uHeat*.6),1.);
        }`,
    })));
    aura.renderOrder = 1;
    aura.frustumCulled = false;
    this.scene.add(aura);
  }

  /**
   * 放射线：每根是一个行业，朝向它在星云上的位置，长度是它的成交额占比，颜色是它的平均涨跌。
   * Rays: one per industry, pointing at its place on the nebula; length is its share of turnover, color its average change.
   */
  setRays(list) {
    if (this.rays) { this.shell.remove(this.rays); this.rays.geometry.dispose(); this.rays.material.dispose(); }
    const n = list.length;
    const pos = new Float32Array(n * 6), color = new Float32Array(n * 6), along = new Float32Array(n * 2), seed = new Float32Array(n * 2);
    list.forEach((ray, i) => {
      const from = 0.31, to = from + ray.len;
      for (let c = 0; c < 3; c++) { pos[i * 6 + c] = ray.dir[c] * from; pos[i * 6 + 3 + c] = ray.dir[c] * to; }
      const rgb = Core.changeColor(ray.pct);
      const pale = 0.55;
      for (let c = 0; c < 3; c++) { color[i * 6 + c] = 1; color[i * 6 + 3 + c] = rgb[c] * (1 - pale) + pale; }
      along[i * 2] = 0; along[i * 2 + 1] = 1;
      seed[i * 2] = seed[i * 2 + 1] = (i * 0.618) % 1;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(along, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.rays = new THREE.LineSegments(g, new THREE.ShaderMaterial(additive({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute vec3 aColor;attribute float aT,aSeed;uniform float uTime,uHeat,uDim;varying vec3 vC;
        void main(){
          float s=.45+.55*sin(uTime*(.5+aSeed)+aSeed*30.);
          vC=aColor*pow(1.-aT,1.3)*.34*(.4+uHeat*.6)*(.45+.55*s)*mix(1.,.2,uDim);
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
        }`,
      fragmentShader: 'varying vec3 vC;void main(){gl_FragColor=vec4(vC,1.);}',
    })));
    this.rays.renderOrder = 2;
    this.rays.frustumCulled = false;
    this.shell.add(this.rays);
  }

  buildRings() {
    const ring = (radius, tiltX, tiltZ, alpha) => {
      const pts = [];
      for (let i = 0; i < 128; i++) { const t = i / 128 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * radius, 0, Math.sin(t) * radius)); }
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: new THREE.Color(alpha, alpha, alpha * 1.15), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      line.rotation.set(tiltX, 0, tiltZ);
      line.renderOrder = 1;
      this.shell.add(line);
    };
    ring(1.05, Math.PI / 2.6, 0.3, 0.06);
    ring(1.05, -Math.PI / 3.2, -0.5, 0.06);
  }

  // ---------------------------------------------------------------- 星盘 / Dial

  buildDial() {
    this.dial = new THREE.Group();
    this.dialSpin = new THREE.Group();      // 顺时针慢转：两圈涨跌榜标签
    this.dial.add(this.dialSpin);
    this.scene.add(this.dial);
    this.dial.quaternion.copy(FACE_ON);
    this.dialIdle = 0;
    this.dialFlat = false;
    this.dialUniforms = { uDim: this.uniforms.uDim, uCenterZ: { value: -this.camDist } };

    // 涨跌环：弧长 = 上涨、下跌家数占比；启动时是点亮进度。这层不转
    this.breadthUniforms = { uUp: { value: 0 }, uDown: { value: 0 }, uBoot: { value: 0 } };
    const breadth = new THREE.Mesh(annulus(DIAL.breadth[0] - 0.008, DIAL.breadth[1] + 0.008, 360), new THREE.ShaderMaterial({
      uniforms: Object.assign({}, this.dialUniforms, this.breadthUniforms), vertexShader: DIAL_VERTEX,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      fragmentShader: /* glsl */`
        uniform float uUp,uDown,uBoot,uDim;varying vec2 vP;
        void main(){
          float r=length(vP),aa=fwidth(r);
          float band=smoothstep(${DIAL.breadth[0].toFixed(3)}-aa,${DIAL.breadth[0].toFixed(3)}+aa,r)*smoothstep(${DIAL.breadth[1].toFixed(3)}+aa,${DIAL.breadth[1].toFixed(3)}-aa,r);
          float c=fract(.25-atan(vP.y,vP.x)/6.2831853);
          vec3 color=vec3(.3,.32,.36);float a=band*.22;
          if(uBoot>0.&&uBoot<1.){if(c<uBoot){color=vec3(1.,.72,.3)*.8;a=band;}}
          else if(c<uUp){color=vec3(1.,.2,.22)*.72;a=band;}
          else if(c>1.-uDown){color=vec3(.1,.86,.44)*.72;a=band;}
          gl_FragColor=vec4(color*mix(1.,.5,uDim),a);
        }`,
    }));
    breadth.renderOrder = 5;
    breadth.frustumCulled = false;
    this.dial.add(breadth);

    // 涨跌榜标签两圈：外圈是涨跌幅最大的前 6 名，里圈是第 7–12 名。每个标签自己一张贴图，只在内容变了才重画。
    // 里圈错开半格，标签之间的缝正对外圈标签的中线，外圈标签连到粒子的相位线从缝里穿过去
    const step = Math.PI * 2 / DIAL.slots;
    const half = step / 2 - 0.016;
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.slots = this.labelRing(DIAL.label, 164, 0, false, step, half, anisotropy);
    this.innerSlots = this.labelRing(DIAL.inner, 144, step / 2, true, step, half, anisotropy);
    this.allSlots = [...this.slots, ...this.innerSlots];
    this.slotQueue = [];
  }

  /**
   * 一圈标签。贴图宽 768，高按这一圈的弧长和环宽的比例定，字才不会被拉扁；secondary 的里圈暗一点。
   * One ring of labels. Texture width 768, height from the ring's arc length to width ratio so text is not stretched; the secondary inner ring is a little dimmer.
   */
  labelRing([r1, r2], height, offset, secondary, step, half, anisotropy) {
    const geometry = arcStrip(r1, r2, half);
    const ring = [];
    for (let k = 0; k < DIAL.slots; k++) {
      const canvas = document.createElement('canvas');
      canvas.width = 768; canvas.height = height;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = anisotropy;
      const material = new THREE.ShaderMaterial({
        uniforms: { uDim: this.uniforms.uDim, tText: { value: texture }, uColor: { value: new THREE.Color(0.5, 0.5, 0.55) }, uReveal: { value: 0 }, uFlash: { value: 0 } },
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        vertexShader: /* glsl */`
          varying vec2 vUv;varying float vFlip,vFade;
          void main(){
            // 标签的外向方向：右上半圈字头朝外，左下半圈字头朝内，这样无论转到哪里字都不会倒过来；交界处淡出再翻转
            vec3 rv=normalMatrix*vec3(1.,0.,0.);
            float side=dot(normalize(rv.xy+1e-5),vec2(.7071));
            vFlip=side<0.?1.:0.;
            vFade=smoothstep(.02,.1,abs(side));
            vUv=uv;
            gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
          }`,
        fragmentShader: /* glsl */`
          uniform sampler2D tText;uniform vec3 uColor;uniform float uReveal,uDim,uFlash;
          varying vec2 vUv;varying float vFlip,vFade;
          void main(){
            vec2 t=vFlip>.5?vec2(1.-vUv.x,1.-vUv.y):vUv;
            if(!gl_FrontFacing) t.x=1.-t.x;   // 手势把星盘转到背面时，字不要变成镜像
            vec4 c=texture2D(tText,t);
            float dim=mix(1.,.55,uDim);
            // 外缘的彩色弧和起始短线（画在盘的坐标里，不随文字翻转）
            float ay=fwidth(vUv.y),ax=fwidth(vUv.x);
            float arc=smoothstep(.925-ay,.925+ay,vUv.y)*smoothstep(1.+ay,.98,vUv.y);
            float start=smoothstep(.009+ax,.009-ax,vUv.x)*smoothstep(.2,.4,vUv.y);
            float line=max(arc,start);
            float back=.5;
            vec3 col=c.rgb*(.9+uFlash*.9)*dim;
            float a=c.a;
            vec4 text=vec4(col,a);
            vec4 under=vec4(uColor*(.82+uFlash*1.4)*dim,line);
            float outA=max(a,line);
            vec3 outC=mix(under.rgb,text.rgb,a);
            float full=outA+back*(1.-outA);
            gl_FragColor=vec4(outC*outA/max(full,.001),full*vFade*uReveal);
          }`,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.z = k * step + offset;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      this.dialSpin.add(mesh);
      ring.push({ mesh, canvas, ctx: canvas.getContext('2d'), texture, entry: null, signature: '', pending: null, secondary });
    }
    return ring;
  }

  /**
   * 外圈涨跌榜标签（前 6 名）。entries：最多 12 个 {name, pct, index}，空位传 null。内容变了才排队重画，一帧画一个。
   * Outer ring of mover labels (top 6). entries: up to 12 {name, pct, index}, null for empty slots. Redrawn only when content changes, one label per frame.
   */
  setDialSlots(entries) { this.fillRing(this.slots, entries); }

  /**
   * 里圈涨跌榜标签（第 7–12 名），格式同外圈。
   * Inner ring of mover labels (ranks 7–12), same format as the outer ring.
   */
  setDialInner(entries) { this.fillRing(this.innerSlots, entries); }

  fillRing(ring, entries) {
    ring.forEach((slot, k) => {
      const e = entries[k] || null;
      const signature = e ? `${e.name}|${e.pct.toFixed(2)}` : '';
      slot.entry = e;
      if (signature === slot.signature) return;
      slot.signature = signature;
      slot.pending = e;
      slot.dirty = true;
      if (!this.slotQueue.includes(slot)) this.slotQueue.push(slot);
    });
  }

  drawSlot(slot) {
    const g = slot.ctx, W = slot.canvas.width, H = slot.canvas.height, e = slot.pending;
    g.clearRect(0, 0, W, H);
    slot.mesh.material.uniforms.uReveal.value = e ? (slot.secondary ? 0.86 : 1) : 0;
    if (e) {
      const up = e.pct >= 0;
      const main = up ? '#ff5a52' : '#27e38c';
      slot.mesh.material.uniforms.uColor.value.set(up ? 0xff3b3f : 0x18d67c);
      const family = 'system-ui,"PingFang SC","MiSans","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
      const margin = 16;
      // 一行放下名称和涨跌幅：涨跌幅右对齐、大小固定，名称占剩下的宽度，太长就缩小。字号跟着贴图高度走，里圈的贴图矮，字也小
      g.textBaseline = 'middle';
      g.fillStyle = main;
      // 外盘很薄：涨跌幅留一位小数，省下的宽度给字号，精确到两位的数字在个股卡片里
      g.font = `700 ${Math.round(H * 0.585)}px ui-monospace,"Roboto Mono","Cascadia Mono",Consolas,monospace`;
      const pct = (up ? '+' : '') + e.pct.toFixed(Math.abs(e.pct) >= 100 ? 0 : 1) + '%';
      const pctWidth = g.measureText(pct).width;
      g.textAlign = 'right';
      g.fillText(pct, W - margin, H * 0.46);
      g.textAlign = 'left';
      const room = W - margin * 2 - pctWidth - 12;
      let size = Math.round(H * 0.646);
      g.font = `700 ${size}px ${family}`;
      const measured = g.measureText(e.name).width;
      if (measured > room) { size = Math.max(Math.round(H * 0.29), Math.floor(size * room / measured)); g.font = `700 ${size}px ${family}`; }
      g.fillText(e.name, margin, H * 0.46, room);
    }
    slot.texture.needsUpdate = true;
  }

  /**
   * 标签上的股票收到一次真实更新时闪一下。
   * Flash a label when its stock receives a real update.
   */
  flashDialStock(index) {
    for (const slot of this.allSlots) if (slot.entry && slot.entry.index === index) slot.mesh.material.uniforms.uFlash.value = 1;
  }

  /**
   * 外圈第 k 个标签内缘中点的屏幕位置，以及这个标签的内容（相位线用）。
   * Screen position of the inner-edge midpoint of the k-th outer label, plus its content (for the link lines).
   */
  dialSlotAnchor(k) {
    const slot = this.slots[k];
    if (!slot.entry) return null;
    const v = this._d || (this._d = new THREE.Vector3());
    const a = slot.mesh.rotation.z;
    v.set(Math.cos(a) * DIAL.label[0], Math.sin(a) * DIAL.label[0], 0).applyMatrix4(this.dialSpin.matrixWorld);
    const front = v.z;
    v.project(this.camera);
    return { x: (v.x + 1) / 2 * this.size.w, y: (1 - v.y) / 2 * this.size.h, front, entry: slot.entry };
  }

  setDialBreadth(up, down, boot = 0) {
    this.breadthUniforms.uUp.value = up;
    this.breadthUniforms.uDown.value = down;
    this.breadthUniforms.uBoot.value = boot;
  }

  /**
   * 点到了哪个标签：把点击的射线打到星盘平面上，换算成极坐标。
   * Which label was hit: cast the click ray onto the dial plane and convert to polar coordinates.
   */
  pickDial(x, y) {
    if (!this.slots) return null;
    const ndc = new THREE.Vector2(x / this.size.w * 2 - 1, 1 - y / this.size.h * 2);
    const ray = this._ray || (this._ray = new THREE.Raycaster());
    ray.setFromCamera(ndc, this.camera);
    this.dialSpin.updateWorldMatrix(true, false);
    const inverse = new THREE.Matrix4().copy(this.dialSpin.matrixWorld).invert();
    const o = ray.ray.origin.clone().applyMatrix4(inverse), d = ray.ray.direction.clone().transformDirection(inverse);
    if (Math.abs(d.z) < 1e-4) return null;
    const t = -o.z / d.z;
    if (t <= 0) return null;
    const px = o.x + d.x * t, py = o.y + d.y * t, r = Math.hypot(px, py);
    // 两圈的分界取在外圈内缘：外圈的字大，往里多留一点点也不会点错
    const outer = r >= DIAL.label[0] - 0.004;
    if (r < DIAL.inner[0] - 0.012 || r > DIAL.label[1] + 0.03) return null;
    const step = Math.PI * 2 / DIAL.slots;
    let a = Math.atan2(py, px) - (outer ? 0 : step / 2);
    while (a < 0) a += Math.PI * 2;
    const k = Math.round(a / step) % DIAL.slots;
    return (outer ? this.slots : this.innerSlots)[k].entry;
  }

  updateDial(dt) {
    const t = this.time;
    // 手势可以把整个星系转到任何角度。停手 4 秒后星盘慢慢回到正面（星云留在转到的位置）；抽屉打开时马上回正
    const spinning = Math.abs(this.drag.vx) + Math.abs(this.drag.vy) > 0.0005;
    this.dialIdle = this.drag.active || spinning ? 0 : this.dialIdle + dt;
    if (this.dialFlat || this.dialIdle > 4) this.dial.quaternion.slerp(FACE_ON, Math.min(1, dt * (this.dialFlat ? 5 : 1.1)));
    this.dialSpin.rotation.z = -t * 0.05;
    // 重画标签：一帧一个，省得一次全画造成卡顿；每个标签换内容时也像翻牌一样依次走过去
    const next = this.slotQueue.shift();
    if (next) this.drawSlot(next);
    this.scene.updateMatrixWorld();
    const v = this._w || (this._w = new THREE.Vector3());
    const flashDecay = Math.exp(-dt * 3);
    for (const slot of this.allSlots) {
      v.set(Math.cos(slot.mesh.rotation.z), Math.sin(slot.mesh.rotation.z), 0).transformDirection(this.dialSpin.matrixWorld);
      slot.mesh.renderOrder = v.z >= 0 ? 5 : 1.5;
      slot.mesh.material.uniforms.uFlash.value *= flashDecay;
    }
  }

  // ---------------------------------------------------------------- 数据彗星：真实更新从左边飞进来，落到对应的股票上 / Data comets: real updates fly in from the left and land on their stocks

  buildComets() {
    this.cometCount = 260;
    const trail = 8;
    this.cometTrail = trail;
    const total = this.cometCount * trail;
    const start = new Float32Array(total * 3), end = new Float32Array(total * 3), timing = new Float32Array(total * 2), color = new Float32Array(total * 3), along = new Float32Array(total);
    for (let i = 0; i < this.cometCount; i++) for (let k = 0; k < trail; k++) { along[i * trail + k] = k / (trail - 1); timing[(i * trail + k) * 2] = -1000; timing[(i * trail + k) * 2 + 1] = 1; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(start, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTiming', new THREE.BufferAttribute(timing, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    this.cometUniforms = Object.assign({}, this.uniforms, { uShell: { value: new THREE.Matrix4() } });
    this.comets = new THREE.Points(g, new THREE.ShaderMaterial(additive({
      uniforms: this.cometUniforms, depthTest: false,
      vertexShader: /* glsl */`
        attribute vec3 aEnd,aColor;attribute vec2 aTiming;attribute float aAlong;
        uniform float uTime,uPx,uCamDist;uniform mat4 uShell;varying vec3 vColor;
        void main(){
          float t=(uTime-aTiming.x-aAlong*.11)/aTiming.y;
          if(t<0.||t>1.){gl_Position=vec4(2.,2.,2.,1.);gl_PointSize=0.;vColor=vec3(0.);return;}
          float e=t*t*(3.-2.*t);
          vec3 end=(uShell*vec4(aEnd,1.)).xyz;
          vec3 mid=(position+end)*.5+vec3(0.,(end.y-position.y)*.15+.12,.35);
          vec3 p=mix(mix(position,mid,e),mix(mid,end,e),e);
          vec4 mv=modelViewMatrix*vec4(p,1.);
          float tail=1.-aAlong;
          vColor=aColor*tail*tail*(1.5+3.*tail)*smoothstep(0.,.08,t);
          gl_PointSize=(1.3+tail*4.4)*uPx*uCamDist/-mv.z;
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: POINT_FRAGMENT,
    })));
    this.comets.frustumCulled = false;
    this.comets.renderOrder = 6;
    this.scene.add(this.comets);
    this.cometNext = 0;
    this.cometDirty = false;
  }

  /**
   * 数据送进核心时亮一下，越密越亮。
   * Brighten the core when data arrives; the denser the data, the brighter.
   */
  kick(amount) { this.kickLevel = Math.min(1, (this.kickLevel || 0) + amount); }

  /**
   * 发一颗彗星：从核心表面朝第 i 只股票的方向飞出去。delay 秒后出发，duration 秒到达。
   * Launch a comet from the core surface toward stock i. Departs after delay seconds, arrives after duration seconds.
   */
  coreComet(i, rgb, delay = 0, duration = 0.7) {
    if (!this.comets || i < 0 || i >= this.n) return;
    const from = this._from || (this._from = new THREE.Vector3());
    from.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]).applyMatrix4(this.shell.matrixWorld).normalize().multiplyScalar(CORE_SOCKET);
    const g = this.comets.geometry;
    const slot = this.cometNext;
    this.cometNext = (this.cometNext + 1) % this.cometCount;
    for (let k = 0; k < this.cometTrail; k++) {
      const v = slot * this.cometTrail + k;
      g.attributes.position.setXYZ(v, from.x, from.y, from.z);
      g.attributes.aEnd.setXYZ(v, this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      g.attributes.aTiming.setXY(v, this.time + delay, duration);
      g.attributes.aColor.setXYZ(v, rgb[0], rgb[1], rgb[2]);
    }
    this.cometDirty = true;
  }

  // ---------------------------------------------------------------- 交互 / Interaction

  /**
   * 绕屏幕的横轴、竖轴转：用四元数累加，任何方向都能转满 360 度，不会卡在两极。
   * Rotate about the screen's horizontal and vertical axes with accumulated quaternions: a full 360° in any direction, no lock at the poles.
   */
  turn(object, dx, dy) {
    const e = this._euler || (this._euler = new THREE.Euler());
    const q = this._quat || (this._quat = new THREE.Quaternion());
    q.setFromEuler(e.set(dy, dx, 0));
    object.quaternion.premultiply(q);
  }

  rotateBy(dx, dy) {
    this.turn(this.shell, dx, dy);
    this.turn(this.dial, dx, dy);
    this.drag.vx = dx; this.drag.vy = dy;
  }

  /**
   * 第 i 只股票在屏幕上的位置；front 大于 0 表示在球的前半边。
   * Screen position of stock i; front > 0 means it is on the near half of the sphere.
   */
  project(i) {
    const v = this._v || (this._v = new THREE.Vector3());
    v.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]).applyMatrix4(this.shell.matrixWorld);
    const front = v.z;
    v.project(this.camera);
    return { x: (v.x + 1) / 2 * this.size.w, y: (1 - v.y) / 2 * this.size.h, front };
  }

  projectDir(dir, radius) {
    const v = this._v || (this._v = new THREE.Vector3());
    v.set(dir[0] * radius, dir[1] * radius, dir[2] * radius).applyMatrix4(this.shell.matrixWorld);
    const front = v.z;
    v.project(this.camera);
    return { x: (v.x + 1) / 2 * this.size.w, y: (1 - v.y) / 2 * this.size.h, front };
  }

  pick(x, y, reach = 22) {
    let best = -1, bestD = reach * reach;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i * 4 + 3] > 1e6 || (this.viewOff && this.viewOff[i])) continue;
      const p = this.project(i);
      if (p.front < -0.15) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2 - p.front * 40;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---------------------------------------------------------------- 每帧 / Per frame

  frame(now, active) {
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 1 / 60;
    this.lastNow = now;
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    this.flow += dt * this.flowSpeed;
    u.uFlow.value = this.flow;
    const t = this.time;
    u.uPhase.value.set(0.30 * Math.sin(t * 0.083), 0.30 * Math.sin(t * 0.061 + 1), 0.30 * Math.sin(t * 0.072 + 2));
    this.heatNow = (this.heatNow === undefined ? this.heat : this.heatNow) + (this.heat - (this.heatNow === undefined ? this.heat : this.heatNow)) * Math.min(1, dt * 2);
    this.kickLevel = (this.kickLevel || 0) * Math.exp(-dt * 2.4);
    u.uHeat.value = this.heatNow + this.kickLevel * 0.4;
    u.uTilt.value += (this.tilt - u.uTilt.value) * Math.min(1, dt * 1.5);
    u.uDim.value += (this.dimTarget - u.uDim.value) * Math.min(1, dt * 5);
    u.uView.value += (this.viewTarget - u.uView.value) * Math.min(1, dt * 5);
    if (this.frameCur) {
      const f = this.frameCur, g = this.frameTarget;
      const k = Math.min(1, dt * 5);
      if (Math.abs(f.cx - g.cx) + Math.abs(f.cy - g.cy) + Math.abs(f.radius - g.radius) > 0.05) {
        f.cx += (g.cx - f.cx) * k; f.cy += (g.cy - f.cy) * k; f.radius += (g.radius - f.radius) * k;
        this.applyFrame();
      }
    }
    if (!this.drag.active) {
      const decay = Math.exp(-dt * 2.6);
      this.drag.vx *= decay; this.drag.vy *= decay;
      this.turn(this.shell, this.drag.vx + this.auto * dt, this.drag.vy);
      this.turn(this.dial, this.drag.vx, this.drag.vy);
    }
    this.core.rotation.y = t * 0.09;
    this.core.rotation.x = Math.sin(t * 0.07) * 0.35;
    this.cage.rotation.y = -t * 0.05;
    this.cage.rotation.z = t * 0.03;
    this.updateDial(dt);
    this.shell.updateMatrixWorld();
    this.cometUniforms.uShell.value.copy(this.shell.matrixWorld);
    if (this.dirty && this.stateTex) { this.stateTex.needsUpdate = true; this.dirty = false; }
    if (this.cometDirty) {
      const a = this.comets.geometry.attributes;
      a.position.needsUpdate = a.aEnd.needsUpdate = a.aTiming.needsUpdate = a.aColor.needsUpdate = true;
      this.cometDirty = false;
    }
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(this.scene, this.camera);
    const bloomTex = this.bloom.run(this.rt.texture);
    this.composite.uniforms.tScene.value = this.rt.texture;
    this.composite.uniforms.tBloom.value = bloomTex;
    r.setRenderTarget(null);
    r.render(this.compositeScene, this.compositeCam);
    if (!this.capture && active) this.adapt(dt);
  }

  /**
   * 设备发热、掉帧时自动降一档：先减尘埃，再降分辨率。
   * Step quality down when the device heats up or drops frames: first less dust, then lower resolution.
   */
  adapt(dt) {
    this.frameMs += (dt * 1000 - this.frameMs) * 0.03;
    if (this.frameMs > 30) this.slow++; else this.slow = Math.max(0, this.slow - 1);
    if (this.slow > 150 && this.level < 3) {
      this.level++;
      this.slow = 0;
      if (this.dust) this.dust.geometry.setDrawRange(0, Math.round(this.dustCount * [1, 0.75, 0.55, 0.4][this.level]));
      this.resize(this.size.w, this.size.h, window.devicePixelRatio || 1);
    }
  }
}
