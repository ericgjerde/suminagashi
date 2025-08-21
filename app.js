/* Compat build v2 hotfix: add precision to advect FS. */
'use strict';

(function(){
const errbox = document.getElementById('errbox');
const statusEl = document.getElementById('status');
function info(msg){ try{ statusEl.textContent = msg; }catch(e){} }
function showErr(msg){
  console.error(msg);
  if(!errbox) return;
  errbox.classList.remove('hidden');
  errbox.textContent += (errbox.textContent ? '\n' : '') + msg;
}

const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true });
if(!gl){
  showErr('WebGL2 not available. Try Chrome/Firefox. In Safari, enable WebGL 2 in Develop → Experimental Features.');
  return;
}

const dbg = gl.getExtension('WEBGL_debug_renderer_info');
if(dbg){
  const ren = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  const ven = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
  info('GPU: ' + ven + ' / ' + ren);
}

const EXT_COLOR_BUFFER_FLOAT = gl.getExtension('EXT_color_buffer_float');
const useFloat = !!EXT_COLOR_BUFFER_FLOAT;
const ENCODE_VEL = !useFloat;
const VEL_SCALE = 2.0;

info((statusEl.textContent ? statusEl.textContent + ' · ' : '') + (useFloat ? 'Float path' : 'Compat path'));

let DPR = Math.min(2, (window.devicePixelRatio || 1));

// ---------- UI ----------
const ui = {
  tool: document.getElementById('tool'),
  inkColor: document.getElementById('inkColor'),
  inkRadius: document.getElementById('inkRadius'),
  forceRadius: document.getElementById('forceRadius'),
  force: document.getElementById('force'),
  viscosity: document.getElementById('viscosity'),
  dyeDiss: document.getElementById('dyeDiss'),
  pressureIters: document.getElementById('pressureIters'),
  tilt: document.getElementById('tilt'),
  spin: document.getElementById('spin'),
  heightScale: document.getElementById('heightScale'),
  gloss: document.getElementById('gloss'),
  resetBtn: document.getElementById('resetBtn'),
};

// ---------- GL helpers ----------
function compileShader(gl, type, source, label){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(sh);
    showErr('Shader compile error (' + label + '):\n' + log);
    throw new Error('Shader compile error: ' + label);
  }
  return sh;
}
function createProgram(gl, vsSrc, fsSrc, label='prog'){
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, label+' VS');
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, label+' FS');
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'aPosition');
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(prog);
    showErr('Program link error ('+label+'):\n' + log);
    throw new Error('Program link error: ' + label);
  }
  return prog;
}
function createTexture(gl, w, h, internalFormat, format, type, filter){
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
function createFBO(gl, tex){
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if(status !== gl.FRAMEBUFFER_COMPLETE){
    showErr('FBO incomplete: 0x' + status.toString(16));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}
function createDoubleFBO(gl, w, h, internalFormat, format, type, filter){
  const tex0 = createTexture(gl, w, h, internalFormat, format, type, filter);
  const tex1 = createTexture(gl, w, h, internalFormat, format, type, filter);
  const fbo0 = createFBO(gl, tex0);
  const fbo1 = createFBO(gl, tex1);
  return {
    w, h,
    read: { tex: tex0, fbo: fbo0 },
    write: { tex: tex1, fbo: fbo1 },
    swap(){ const t = this.read; this.read = this.write; this.write = t; }
  };
}
const quadVAO = (function(){
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ -1,-1, 1,-1, -1,1, 1,-1, 1,1, -1,1 ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
})();

// ---------- Shaders ----------
const VS_SCREEN = `#version 300 es
layout(location=0) in vec2 aPosition;
out vec2 vUV;
void main(){ vUV = aPosition*0.5+0.5; gl_Position = vec4(aPosition,0.0,1.0); }`;

const FS_CLEAR = `#version 300 es
precision highp float;
out vec4 fragColor; uniform vec4 uColor;
void main(){ fragColor = uColor; }`;

// Shared helpers
const GLSL_COMMON = `
precision highp float;
uniform bool uEncodeVel;
uniform float uVelScale;
vec2 decodeVel(vec2 c){
  return uEncodeVel ? (c*2.0 - 1.0) * uVelScale : c;
}
vec2 encodeVel(vec2 v){
  return uEncodeVel ? (v / uVelScale * 0.5 + 0.5) : v;
}`;

// HOTFIX: add precision at the top of advect FS
const FS_ADVECT = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uSource;
uniform sampler2D uVelocity;
uniform float uDt;
uniform float uDissipation;
uniform vec2 uTexel;
uniform int uFieldType; // 0=dye(rgba), 1=velocity(rg)
` + GLSL_COMMON + String.raw`
vec2 backtrace(vec2 uv){
  vec2 v = decodeVel(texture(uVelocity, uv).xy);
  return uv - uDt * v;
}
void main(){
  vec2 uv = backtrace(vUV);
  uv = clamp(uv, vec2(0.001), vec2(0.999));
  if(uFieldType==0){
    vec4 src = texture(uSource, uv);
    fragColor = src * uDissipation;
  }else{
    vec2 src = decodeVel(texture(uSource, uv).xy);
    vec2 outV = src * uDissipation;
    fragColor = vec4(encodeVel(outV), 0.0, 1.0);
  }
}`;

const FS_DIVERGENCE = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
` + GLSL_COMMON + String.raw`
void main(){
  vec2 L = decodeVel(texture(uVelocity, vUV - vec2(uTexel.x,0.0)).xy);
  vec2 R = decodeVel(texture(uVelocity, vUV + vec2(uTexel.x,0.0)).xy);
  vec2 B = decodeVel(texture(uVelocity, vUV - vec2(0.0,uTexel.y)).xy);
  vec2 T = decodeVel(texture(uVelocity, vUV + vec2(0.0,uTexel.y)).xy);
  float div = 0.5 * ((R.x - L.x) + (T.y - B.y));
  fragColor = vec4(div,0.0,0.0,1.0);
}`;

const FS_PRESSURE = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
void main(){
  float L = texture(uPressure, vUV - vec2(uTexel.x,0.0)).r;
  float R = texture(uPressure, vUV + vec2(uTexel.x,0.0)).r;
  float B = texture(uPressure, vUV - vec2(0.0,uTexel.y)).r;
  float T = texture(uPressure, vUV + vec2(0.0,uTexel.y)).r;
  float div = texture(uDivergence, vUV).r;
  float p = (L + R + B + T - div) * 0.25;
  fragColor = vec4(p,0.0,0.0,1.0);
}`;

const FS_GRADIENT_SUB = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform vec2 uTexel;
` + GLSL_COMMON + String.raw`
void main(){
  float L = texture(uPressure, vUV - vec2(uTexel.x,0.0)).r;
  float R = texture(uPressure, vUV + vec2(uTexel.x,0.0)).r;
  float B = texture(uPressure, vUV - vec2(0.0,uTexel.y)).r;
  float T = texture(uPressure, vUV + vec2(0.0,uTexel.y)).r;
  vec2 vel = decodeVel(texture(uVelocity, vUV).xy);
  vel -= 0.5 * vec2(R - L, T - B);
  vec2 border = smoothstep(0.0, 0.01, vUV) * smoothstep(0.0, 0.01, 1.0 - vUV);
  float keep = border.x * border.y;
  vel *= keep;
  fragColor = vec4(encodeVel(vel),0.0,1.0);
}`;

const FS_SPLAT_VEL = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uVelocity;
uniform vec2 uPoint;
uniform vec2 uForce;
uniform float uRadius;
uniform vec2 uTexel;
` + GLSL_COMMON + String.raw`
void main(){
  vec2 vel = decodeVel(texture(uVelocity, vUV).xy);
  vec2 d = vUV - uPoint;
  float r = uRadius * min(uTexel.x, uTexel.y);
  float m = exp(-dot(d,d)/(r*r + 1e-6));
  vel += uForce * m;
  fragColor = vec4(encodeVel(vel), 0.0, 1.0);
}`;

const FS_SPLAT_DYE = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uDye;
uniform vec2 uPoint;
uniform vec3 uColor;
uniform float uRadius;
uniform vec2 uTexel;
void main(){
  vec4 dye = texture(uDye, vUV);
  vec2 d = vUV - uPoint;
  float r = uRadius * min(uTexel.x, uTexel.y);
  float m = exp(-dot(d,d)/(r*r + 1e-6));
  dye.rgb += uColor * m;
  dye.a = clamp(dye.a + 0.5 * m, 0.0, 1.0);
  fragColor = dye;
}`;

// 3D render
const VS_GRID = `#version 300 es
precision highp float;
in vec2 aXY;
in vec2 aUV;
out vec2 vUV;
out vec3 vPos;
uniform sampler2D uHeight;
uniform float uHeightScale;
uniform mat4 uViewProj;
uniform float uScale;
uniform vec2 uHeightTexel;
void main(){
  vUV = aUV;
  float h = texture(uHeight, aUV).r * uHeightScale;
  vec3 pos = vec3((aXY - 0.5) * uScale, h);
  vPos = pos;
  gl_Position = uViewProj * vec4(pos, 1.0);
}`;

const FS_RENDER = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vPos;
out vec4 fragColor;
uniform sampler2D uDye;
uniform sampler2D uHeight;
uniform vec2 uHeightTexel;
uniform float uHeightScale;
uniform float uGloss;
uniform vec3 uCamPos;
vec3 sky(vec3 dir){
  float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = vec3(0.50,0.60,0.70);
  vec3 zenith  = vec3(0.05,0.10,0.20);
  return mix(horizon, zenith, t);
}
void main(){
  float hl = texture(uHeight, vUV - vec2(uHeightTexel.x,0.0)).r * uHeightScale;
  float hr = texture(uHeight, vUV + vec2(uHeightTexel.x,0.0)).r * uHeightScale;
  float hb = texture(uHeight, vUV - vec2(0.0,uHeightTexel.y)).r * uHeightScale;
  float ht = texture(uHeight, vUV + vec2(0.0,uHeightTexel.y)).r * uHeightScale;
  vec3 dx = vec3(2.0 * uHeightTexel.x, 0.0, hr - hl);
  vec3 dy = vec3(0.0, 2.0 * uHeightTexel.y, ht - hb);
  vec3 n = normalize(cross(dy, dx));
  vec3 V = normalize(uCamPos - vPos);
  float F0 = 0.02;
  float fres = F0 + (1.0 - F0) * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 R = reflect(-V, n);
  vec3 env = sky(R);
  vec3 waterTint = vec3(0.02, 0.07, 0.12);
  vec4 dye = texture(uDye, vUV);
  vec3 body = mix(waterTint, waterTint + dye.rgb, clamp(dye.a, 0.0, 1.0));
  vec3 L = normalize(vec3(0.3, 0.8, 0.4));
  float spec = pow(max(dot(reflect(-L, n), V), 0.0), mix(50.0, 200.0, uGloss));
  vec3 color = mix(body, env, fres) + spec * 0.35;
  float vign = smoothstep(1.0, 0.8, length(vUV - 0.5) * 1.3);
  color *= vign;
  color = pow(color, vec3(1.0/2.2));
  fragColor = vec4(color, 1.0);
}`;

// Simple test shader for debugging
const FS_SIMPLE_GRID = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vPos;
out vec4 fragColor;
uniform sampler2D uDye;
void main(){
  vec4 dye = texture(uDye, vUV);
  // Simple visualization: blue water + dye
  vec3 waterColor = vec3(0.1, 0.2, 0.4);
  vec3 color = mix(waterColor, dye.rgb, dye.a);
  // Add grid lines for debugging
  float grid = step(0.98, fract(vUV.x * 20.0)) + step(0.98, fract(vUV.y * 20.0));
  color = mix(color, vec3(0.5), grid * 0.3);
  fragColor = vec4(color, 1.0);
}`;

// Programs
const progClear = createProgram(gl, VS_SCREEN, FS_CLEAR, 'clear');
const progAdvect = createProgram(gl, VS_SCREEN, FS_ADVECT, 'advect');
const progDivergence = createProgram(gl, VS_SCREEN, FS_DIVERGENCE, 'divergence');
const progPressure = createProgram(gl, VS_SCREEN, FS_PRESSURE, 'pressure');
const progGradSub = createProgram(gl, VS_SCREEN, FS_GRADIENT_SUB, 'gradsub');
const progSplatVel = createProgram(gl, VS_SCREEN, FS_SPLAT_VEL, 'splat-vel');
const progSplatDye = createProgram(gl, VS_SCREEN, FS_SPLAT_DYE, 'splat-dye');
// Create render programs with proper attribute bindings
const progRender = (function() {
  const prog = gl.createProgram();
  const vs = compileShader(gl, gl.VERTEX_SHADER, VS_GRID, 'render VS');
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS_RENDER, 'render FS');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  // Bind attributes before linking
  gl.bindAttribLocation(prog, 0, 'aXY');
  gl.bindAttribLocation(prog, 1, 'aUV');
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(prog);
    showErr('Program link error (render):\n' + log);
    throw new Error('Program link error: render');
  }
  return prog;
})();

const progSimpleGrid = (function() {
  const prog = gl.createProgram();
  const vs = compileShader(gl, gl.VERTEX_SHADER, VS_GRID, 'simple VS');
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS_SIMPLE_GRID, 'simple FS');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  // Bind attributes before linking
  gl.bindAttribLocation(prog, 0, 'aXY');
  gl.bindAttribLocation(prog, 1, 'aUV');
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(prog);
    showErr('Program link error (simple):\n' + log);
    throw new Error('Program link error: simple');
  }
  return prog;
})();

// Grid mesh (uint16 indices)
let grid = null;
function createGrid(res){
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const countX = res, countY = res;
  const verts = [];
  const uvs = [];
  for(let y=0; y<=countY; y++){
    for(let x=0; x<=countX; x++){
      const u = x / countX;
      const v = y / countY;
      verts.push(u, v);
      uvs.push(u, v);
    }
  }
  const idx = [];
  const stride = countX + 1;
  for(let y=0; y<countY; y++){
    for(let x=0; x<countX; x++){
      const i0 = y*stride + x;
      const i1 = i0 + 1;
      const i2 = i0 + stride;
      const i3 = i2 + 1;
      idx.push(i0, i2, i1,  i1, i2, i3);
    }
  }
  const vbuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const tbuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tbuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  const ibuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, num: idx.length };
}

// Targets
let sim = {};
let current = { w: 0, h: 0 };

// Helper function to clear framebuffer
function clearTarget(fbo, r, g, b, a){
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.clearColor(r, g, b, a);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function allocateTargets(){
  const w = Math.max(256, Math.floor(canvas.width / 1.3));
  const h = Math.max(256, Math.floor(canvas.height / 1.3));
  const filter = gl.LINEAR;
  const velIF = useFloat ? gl.RG16F : gl.RG8;
  const velFmt = gl.RG;
  const velType= useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  sim.velocity = createDoubleFBO(gl, w, h, velIF, velFmt, velType, filter);
  const dyeIF = useFloat ? gl.RGBA16F : gl.RGBA8;
  sim.dye = createDoubleFBO(gl, w, h, dyeIF, gl.RGBA, useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, filter);
  const pIF = useFloat ? gl.R16F : gl.R8;
  sim.pressure = createDoubleFBO(gl, w, h, pIF, gl.RED, useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, gl.NEAREST);
  sim.divergence = { tex: createTexture(gl, w, h, pIF, gl.RED, useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, gl.NEAREST) };
  sim.divFBO = createFBO(gl, sim.divergence.tex);
  current.w = w; current.h = h;
  clearTarget(sim.velocity.read.fbo, 0,0,0,1);
  clearTarget(sim.velocity.write.fbo, 0,0,0,1);
  clearTarget(sim.dye.read.fbo, 0,0,0,0);
  clearTarget(sim.dye.write.fbo, 0,0,0,0);
  clearTarget(sim.pressure.read.fbo, 0,0,0,1);
  clearTarget(sim.pressure.write.fbo, 0,0,0,1);
}

// Camera
const camera = {
  pos: [0, 0, 3.2],
  tiltDeg: parseFloat(ui.tilt.value || 28),
  spinDeg: parseFloat(ui.spin.value || -20),
  update(){
    const tilt = this.tiltDeg * Math.PI/180;
    const spin = this.spinDeg * Math.PI/180;
    const radius = 3.2;
    const x = radius * Math.sin(spin) * Math.cos(tilt);
    const y = radius * Math.sin(tilt);
    const z = radius * Math.cos(spin) * Math.cos(tilt);
    this.pos = [x, y, z];
  },
  viewProj(aspect){
    const eye = this.pos, center=[0,0,0], up=[0,1,0];
    const V = mat4LookAt(eye, center, up);
    const P = mat4Perspective(45*Math.PI/180, aspect, 0.1, 50.0);
    return mat4Mul(P, V);
  }
};
camera.update();
function mat4Mul(A, B){
  const out = new Float32Array(16);
  for(let i=0;i<4;i++) for(let j=0;j<4;j++)
    out[i*4+j] = A[i*4+0]*B[0*4+j] + A[i*4+1]*B[1*4+j] + A[i*4+2]*B[2*4+j] + A[i*4+3]*B[3*4+j];
  return out;
}
function mat4Perspective(fovy, aspect, near, far){
  const f = 1.0/Math.tan(fovy/2), nf = 1/(near - far);
  const m = new Float32Array(16);
  m[0]=f/aspect; m[5]=f; m[10]=(far+near)*nf; m[11]=-1; m[14]=(2*far*near)*nf;
  return m;
}
function mat4LookAt(e, c, u){
  const ex=e[0],ey=e[1],ez=e[2], cx=c[0],cy=c[1],cz=c[2];
  let zx = ex-cx, zy=ey-cy, zz=ez-cz; let zl=Math.hypot(zx,zy,zz); zx/=zl; zy/=zl; zz/=zl;
  let xx = u[1]*zz - u[2]*zy, xy = u[2]*zx - u[0]*zz, xz = u[0]*zy - u[1]*zx; let xl=Math.hypot(xx,xy,xz); xx/=xl; xy/=xl; xz/=xl;
  let yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;
  const m = new Float32Array(16);
  m[0]=xx; m[1]=yx; m[2]=zx; m[3]=0;
  m[4]=xy; m[5]=yy; m[6]=zy; m[7]=0;
  m[8]=xz; m[9]=yz; m[10]=zz; m[11]=0;
  m[12]=-(xx*ex + xy*ey + xz*ez);
  m[13]=-(yx*ex + yy*ey + yz*ez);
  m[14]=-(zx*ex + zy*ey + zz*ez);
  m[15]=1;
  return m;
}

// Resize
function resize(){
  const w = Math.max(2, Math.floor(window.innerWidth * DPR));
  const h = Math.max(2, Math.floor(window.innerHeight * DPR));
  if(canvas.width === w && canvas.height === h) return;
  canvas.width = w; canvas.height = h;
  gl.viewport(0,0,w,h);
  allocateTargets();
  if(grid) { gl.deleteVertexArray(grid.vao); grid = null; }
  grid = createGrid(96);
}
window.addEventListener('resize', resize);
resize();

// Interaction
let pointers = new Map();
let lastTime = performance.now();

canvas.addEventListener('pointerdown', (e)=>{
  canvas.setPointerCapture(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * DPR / canvas.width;
  const y = 1.0 - (e.clientY - rect.top) * DPR / canvas.height;
  pointers.set(e.pointerId, {x, y, px:x, py:y, down:true, shift: e.shiftKey});
  if(ui.tool.value === 'ink'){ dropInk(x,y); }
});
canvas.addEventListener('pointermove', (e)=>{
  if(!pointers.has(e.pointerId)) return;
  const P = pointers.get(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * DPR / canvas.width;
  const y = 1.0 - (e.clientY - rect.top) * DPR / canvas.height;
  P.px = P.x; P.py = P.y; P.x = x; P.y = y; P.shift = e.shiftKey;
  
  const dx = (P.x - P.px);
  const dy = (P.y - P.py);
  
  // Tool behavior
  if(ui.tool.value === 'ink'){
    // Continuous ink painting while dragging
    if(P.down) {
      // Drop ink
      const col = hexToRgb(ui.inkColor.value);
      const radius = parseFloat(ui.inkRadius.value);
      splatDye(x, y, col, radius);
      
      // Add velocity from movement to create natural swirls
      const forceMag = 0.8; // Moderate force when painting
      splatVelocity(x, y, dx * forceMag, dy * forceMag, radius * 0.8);
      
      // Add small outward push to help ink spread
      if(Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
        // If not moving much, add gentle radial spread
        ringPulse(x, y, radius * 0.8, 0.5);
      }
    }
  } else if(ui.tool.value === 'stylus' || ui.tool.value === 'comb'){
    // Disturb the fluid (and optionally add ink with shift)
    disturb(P.x, P.y, dx, dy, P.shift);
  }
});
const up = (e)=>{ if(pointers.has(e.pointerId)) pointers.delete(e.pointerId); };
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
window.addEventListener('keydown', (e)=>{ if(e.key==='r'||e.key==='R') reset(); });
ui.resetBtn.addEventListener('click', reset);
function reset(){ allocateTargets(); }

function hexToRgb(hex){ const n = parseInt(hex.slice(1),16); return [(n>>16 & 255)/255, (n>>8 & 255)/255, (n & 255)/255]; }

function dropInk(x,y){
  const col = hexToRgb(ui.inkColor.value);
  const radius = parseFloat(ui.inkRadius.value);
  splatDye(x,y, col, radius);
  
  // Add stronger outward velocity to make ink spread naturally like on water
  ringPulse(x,y, radius*1.2, 2.0); // Much stronger pulse
  
  // Add a small random disturbance for natural movement
  const angle = Math.random() * Math.PI * 2;
  const force = 0.001;
  splatVelocity(x, y, Math.cos(angle) * force, Math.sin(angle) * force, radius * 0.8);
}
function ringPulse(x,y, radius, strength){
  const steps = 16;
  for(let i=0;i<steps;i++){
    const a = i * (Math.PI*2/steps);
    const fx = Math.cos(a) * strength * 0.0015;
    const fy = Math.sin(a) * strength * 0.0015;
    splatVelocity(x, y, fx, fy, radius);
  }
}
function disturb(x,y, dx, dy, alsoInk){
  // Increase force magnitude for more visible effect
  const forceMag = parseFloat(ui.force.value) / 1000.0; // Was /100000.0, now 100x stronger
  const r = parseFloat(ui.forceRadius.value);
  const tool = ui.tool.value;
  if(tool === 'stylus'){
    splatVelocity(x,y, dx*forceMag, dy*forceMag, r);
    if(alsoInk) splatDye(x,y, hexToRgb(ui.inkColor.value), parseFloat(ui.inkRadius.value)*0.6);
  }else if(tool === 'comb'){
    const lanes = 7;
    for(let i=0;i<lanes;i++){
      const off = (i - (lanes-1)/2) / lanes * 0.08;
      const nx = -dy, ny = dx;
      const ox = nx * off, oy = ny * off;
      splatVelocity(x+ox, y+oy, dx*forceMag, dy*forceMag, r*0.75);
      if(alsoInk && (i%2===0)) splatDye(x+ox, y+oy, hexToRgb(ui.inkColor.value), parseFloat(ui.inkRadius.value)*0.5);
    }
  }
}

function splatVelocity(x,y, fx, fy, radius){
  gl.useProgram(progSplatVel);
  gl.uniform1i(gl.getUniformLocation(progSplatVel,'uVelocity'), 0);
  gl.uniform2f(gl.getUniformLocation(progSplatVel,'uPoint'), x, y);
  gl.uniform2f(gl.getUniformLocation(progSplatVel,'uForce'), fx, fy);
  gl.uniform1f(gl.getUniformLocation(progSplatVel,'uRadius'), radius);
  gl.uniform2f(gl.getUniformLocation(progSplatVel,'uTexel'), 1.0/current.w, 1.0/current.h);
  gl.uniform1i(gl.getUniformLocation(progSplatVel,'uEncodeVel'), ENCODE_VEL?1:0);
  gl.uniform1f(gl.getUniformLocation(progSplatVel,'uVelScale'), VEL_SCALE);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sim.velocity.read.tex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sim.velocity.write.fbo);
  gl.viewport(0,0,current.w,current.h);
  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  sim.velocity.swap();
}

function splatDye(x,y, color, radius){
  gl.useProgram(progSplatDye);
  gl.uniform1i(gl.getUniformLocation(progSplatDye,'uDye'), 0);
  gl.uniform2f(gl.getUniformLocation(progSplatDye,'uPoint'), x, y);
  gl.uniform3f(gl.getUniformLocation(progSplatDye,'uColor'), color[0], color[1], color[2]);
  gl.uniform1f(gl.getUniformLocation(progSplatDye,'uRadius'), radius);
  gl.uniform2f(gl.getUniformLocation(progSplatDye,'uTexel'), 1.0/current.w, 1.0/current.h);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sim.dye.read.tex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sim.dye.write.fbo);
  gl.viewport(0,0,current.w,current.h);
  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  sim.dye.swap();
}

// Step
let stepCount = 0;
function step(dt){
  stepCount++;
  const visc = Math.max(0, parseFloat(ui.viscosity.value || 0));
  // Fix: For true suminagashi, dye should NOT dissipate at all - it floats on water
  const dyeDissValue = parseFloat(ui.dyeDiss.value || 0);
  const dyeDiss = dyeDissValue === 0 ? 1.0 : (1.0 - dyeDissValue/10000.0); // No dissipation when slider is 0
  const velDiss = 1.0 - visc/1000.0;
  
  // Add subtle ambient turbulence every few frames for natural movement
  if(stepCount % 60 === 0) {
    const x = Math.random();
    const y = Math.random();
    const angle = Math.random() * Math.PI * 2;
    const force = 0.0002;
    splatVelocity(x, y, Math.cos(angle) * force, Math.sin(angle) * force, 0.1);
  }

  // Advect velocity
  gl.useProgram(progAdvect);
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uSource'), 0);
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uVelocity'), 1);
  gl.uniform1f(gl.getUniformLocation(progAdvect,'uDt'), dt * 0.85);
  gl.uniform1f(gl.getUniformLocation(progAdvect,'uDissipation'), velDiss);
  gl.uniform2f(gl.getUniformLocation(progAdvect,'uTexel'), 1.0/current.w, 1.0/current.h);
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uFieldType'), 1); // velocity
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uEncodeVel'), ENCODE_VEL?1:0);
  gl.uniform1f(gl.getUniformLocation(progAdvect,'uVelScale'), VEL_SCALE);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.velocity.read.tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sim.velocity.read.tex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sim.velocity.write.fbo);
  gl.viewport(0,0,current.w,current.h);
  gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  sim.velocity.swap();

  // Divergence
  gl.useProgram(progDivergence);
  gl.uniform1i(gl.getUniformLocation(progDivergence,'uVelocity'), 0);
  gl.uniform2f(gl.getUniformLocation(progDivergence,'uTexel'), 1.0/current.w, 1.0/current.h);
  gl.uniform1i(gl.getUniformLocation(progDivergence,'uEncodeVel'), ENCODE_VEL?1:0);
  gl.uniform1f(gl.getUniformLocation(progDivergence,'uVelScale'), VEL_SCALE);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.velocity.read.tex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sim.divFBO);
  gl.viewport(0,0,current.w,current.h);
  gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Pressure solve
  gl.useProgram(progPressure);
  gl.uniform1i(gl.getUniformLocation(progPressure,'uPressure'), 0);
  gl.uniform1i(gl.getUniformLocation(progPressure,'uDivergence'), 1);
  gl.uniform2f(gl.getUniformLocation(progPressure,'uTexel'), 1.0/current.w, 1.0/current.h);
  const iters = parseInt(ui.pressureIters.value || 55);
  for(let i=0;i<iters;i++){
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.pressure.read.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sim.divergence.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sim.pressure.write.fbo);
    gl.viewport(0,0,current.w,current.h);
    gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    sim.pressure.swap();
  }

  // Gradient subtraction
  gl.useProgram(progGradSub);
  gl.uniform1i(gl.getUniformLocation(progGradSub,'uVelocity'), 0);
  gl.uniform1i(gl.getUniformLocation(progGradSub,'uPressure'), 1);
  gl.uniform2f(gl.getUniformLocation(progGradSub,'uTexel'), 1.0/current.w, 1.0/current.h);
  gl.uniform1i(gl.getUniformLocation(progGradSub,'uEncodeVel'), ENCODE_VEL?1:0);
  gl.uniform1f(gl.getUniformLocation(progGradSub,'uVelScale'), VEL_SCALE);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.velocity.read.tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sim.pressure.read.tex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sim.velocity.write.fbo);
  gl.viewport(0,0,current.w,current.h);
  gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  sim.velocity.swap();

  // Advect dye
  gl.useProgram(progAdvect);
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uSource'), 0);
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uVelocity'), 1);
  gl.uniform1f(gl.getUniformLocation(progAdvect,'uDt'), dt);
  gl.uniform1f(gl.getUniformLocation(progAdvect,'uDissipation'), dyeDiss);
  gl.uniform2f(gl.getUniformLocation(progAdvect,'uTexel'), 1.0/current.w, 1.0/current.h);
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uFieldType'), 0); // dye
  gl.uniform1i(gl.getUniformLocation(progAdvect,'uEncodeVel'), ENCODE_VEL?1:0);
  gl.uniform1f(gl.getUniformLocation(progAdvect,'uVelScale'), VEL_SCALE);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.dye.read.tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sim.velocity.read.tex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sim.dye.write.fbo);
  gl.viewport(0,0,current.w,current.h);
  gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  sim.dye.swap();
}

// Test: draw a simple triangle first WITHOUT matrix transforms
function testTriangle() {
  // Create a simple triangle program
  if (!window.testTriProg) {
    const vsTest = `#version 300 es
      in vec2 aPos;
      void main() {
        gl_Position = vec4(aPos, 0.0, 1.0);
      }`;
    const fsTest = `#version 300 es
      precision highp float;
      out vec4 fragColor;
      void main() {
        fragColor = vec4(1.0, 0.0, 0.0, 1.0);
      }`;
    const prog = gl.createProgram();
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsTest, 'test VS');
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsTest, 'test FS');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    window.testTriProg = prog;
    
    // Create triangle VAO - simple 2D triangle
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0.0, 0.5,
      -0.5, -0.5,
      0.5, -0.5
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    window.testTriVAO = vao;
  }
  
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST); // Disable depth test for simple 2D
  gl.clearColor(0.1, 0.2, 0.3, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  gl.useProgram(window.testTriProg);
  gl.bindVertexArray(window.testTriVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  
  // Check for errors
  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    console.error('GL Error in testTriangle:', err);
  }
}

// Direct 2D water view (top-down)
function render2DWater() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0.02, 0.05, 0.08, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // Create 2D water shader if needed
  if (!window.water2DProg) {
    const vs2D = `#version 300 es
      layout(location=0) in vec2 aPosition;
      out vec2 vUV;
      void main() {
        vUV = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }`;
    
    const fs2D = `#version 300 es
      precision highp float;
      in vec2 vUV;
      out vec4 fragColor;
      uniform sampler2D uDye;
      uniform sampler2D uHeight;
      void main() {
        vec4 dye = texture(uDye, vUV);
        float h = texture(uHeight, vUV).r;
        
        // Water base color with slight height variation
        vec3 waterDeep = vec3(0.02, 0.08, 0.15);
        vec3 waterShallow = vec3(0.05, 0.15, 0.25);
        vec3 waterColor = mix(waterDeep, waterShallow, h * 2.0);
        
        // Mix in the dye
        vec3 finalColor = mix(waterColor, dye.rgb, clamp(dye.a, 0.0, 1.0));
        
        // Add some surface shine based on height
        finalColor += vec3(h * 0.1);
        
        fragColor = vec4(finalColor, 1.0);
      }`;
    
    window.water2DProg = createProgram(gl, vs2D, fs2D, 'water2D');
  }
  
  gl.useProgram(window.water2DProg);
  
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sim.dye.read.tex);
  gl.uniform1i(gl.getUniformLocation(window.water2DProg, 'uDye'), 0);
  
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, sim.pressure.read.tex);
  gl.uniform1i(gl.getUniformLocation(window.water2DProg, 'uHeight'), 1);
  
  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
}

// Simple test render
function simpleRender(){
  // Use 2D water view instead of triangle test
  render2DWater();
  return;
  
  const aspect = canvas.width / canvas.height;
  camera.tiltDeg = parseFloat(ui.tilt.value || 28);
  camera.spinDeg = parseFloat(ui.spin.value || -20);
  camera.update();
  const VP = camera.viewProj(aspect);
  
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.0, 0.1, 0.15, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  
  if (!grid || !sim.dye) return;
  
  gl.useProgram(progSimpleGrid);
  gl.bindVertexArray(grid.vao);
  
  // Set uniforms
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sim.dye.read.tex);
  gl.uniform1i(gl.getUniformLocation(progSimpleGrid, 'uDye'), 0);
  
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, sim.pressure.read.tex);
  gl.uniform1i(gl.getUniformLocation(progSimpleGrid, 'uHeight'), 1);
  
  gl.uniformMatrix4fv(gl.getUniformLocation(progSimpleGrid, 'uViewProj'), false, VP);
  gl.uniform1f(gl.getUniformLocation(progSimpleGrid, 'uScale'), 2.4);
  gl.uniform1f(gl.getUniformLocation(progSimpleGrid, 'uHeightScale'), 0.1);
  gl.uniform2f(gl.getUniformLocation(progSimpleGrid, 'uHeightTexel'), 1.0/current.w, 1.0/current.h);
  
  gl.drawElements(gl.TRIANGLES, grid.num, gl.UNSIGNED_SHORT, 0);
  gl.bindVertexArray(null);
}

// Render
let renderCallCount = 0;
function render(){
  // For now, use 2D water view since 3D has issues
  render2DWater();
  return;
  
  renderCallCount++;
  if (renderCallCount === 1) {
    console.log('First render call - checking state...');
    console.log('Canvas size:', canvas.width, 'x', canvas.height);
    console.log('Grid:', grid ? `${grid.num} indices` : 'NULL');
    console.log('Sim textures:', sim.dye ? 'OK' : 'MISSING');
  }
  
  const aspect = canvas.width / canvas.height;
  camera.tiltDeg = parseFloat(ui.tilt.value || 28);
  camera.spinDeg = parseFloat(ui.spin.value || -20);
  camera.update();
  const VP = camera.viewProj(aspect);
  const uHeightScale = parseFloat(ui.heightScale.value || 18) / 100.0;
  const uGloss = parseFloat(ui.gloss.value || 60)/100.0;

  // Test: Clear to a visible color first
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.06, 0.08, 0.10, 1.0);  // Back to original dark background
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(progRender);
  gl.bindVertexArray(grid.vao);

  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.dye.read.tex);
  gl.uniform1i(gl.getUniformLocation(progRender,'uDye'), 0);

  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sim.pressure.read.tex);
  gl.uniform1i(gl.getUniformLocation(progRender,'uHeight'), 1);

  gl.uniform2f(gl.getUniformLocation(progRender,'uHeightTexel'), 1.0/current.w, 1.0/current.h);
  gl.uniform1f(gl.getUniformLocation(progRender,'uHeightScale'), uHeightScale);
  gl.uniform1f(gl.getUniformLocation(progRender,'uGloss'), uGloss);
  gl.uniformMatrix4fv(gl.getUniformLocation(progRender,'uViewProj'), false, VP);
  gl.uniform1f(gl.getUniformLocation(progRender,'uScale'), 2.4);
  gl.uniform3f(gl.getUniformLocation(progRender,'uCamPos'), camera.pos[0], camera.pos[1], camera.pos[2]);

  // Check for GL errors before drawing
  const glError = gl.getError();
  if (glError !== gl.NO_ERROR) {
    console.error('GL Error before draw:', glError);
  }
  
  gl.drawElements(gl.TRIANGLES, grid.num, gl.UNSIGNED_SHORT, 0);
  
  const glError2 = gl.getError();
  if (glError2 !== gl.NO_ERROR) {
    console.error('GL Error after draw:', glError2);
  }
  
  gl.bindVertexArray(null);
  
  // Debug: Check if anything was drawn
  if (renderCallCount <= 2) {
    const pixels = new Uint8Array(4);
    gl.readPixels(canvas.width/2, canvas.height/2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    console.log(`Center pixel after render: RGBA(${pixels[0]}, ${pixels[1]}, ${pixels[2]}, ${pixels[3]})`);
    console.log('Grid VAO:', grid.vao, 'Num indices:', grid.num);
  }
}

// Add debug render mode
function debugRenderDyeTexture() {
  // Create simple shader if not exists
  if (!window.debugQuadProg) {
    const vsDbg = `#version 300 es
      layout(location=0) in vec2 aPosition;
      out vec2 vUV;
      void main() {
        vUV = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }`;
    
    const fsDbg = `#version 300 es
      precision highp float;
      in vec2 vUV;
      out vec4 fragColor;
      uniform sampler2D uTexture;
      void main() {
        vec4 dye = texture(uTexture, vUV);
        // Show actual dye colors on dark blue water background
        vec3 waterColor = vec3(0.02, 0.05, 0.15);
        vec3 finalColor = mix(waterColor, dye.rgb, clamp(dye.a * 2.0, 0.0, 1.0));
        fragColor = vec4(finalColor, 1.0);
      }`;
    
    window.debugQuadProg = createProgram(gl, vsDbg, fsDbg, 'debug-quad');
  }
  
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  gl.useProgram(window.debugQuadProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sim.dye.read.tex);
  gl.uniform1i(gl.getUniformLocation(window.debugQuadProg, 'uTexture'), 0);
  
  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
}

// Main loop
let debugMode = false;
let simpleMode = false;
function frame(now){
  let dt = Math.min(0.033, (now - lastTime) / 1000);
  lastTime = now;
  step(dt);
  
  if (debugMode) {
    debugRenderDyeTexture();
  } else if (simpleMode) {
    simpleRender();
  } else {
    render();
  }
  
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Add debug key handler
window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    debugMode = !debugMode;
    simpleMode = false;
    console.log('Debug mode:', debugMode ? 'ON (showing dye texture)' : 'OFF (normal 3D view)');
  } else if (e.key === 's' || e.key === 'S') {
    simpleMode = !simpleMode;
    debugMode = false;
    console.log('Simple mode:', simpleMode ? 'ON (simple 3D grid)' : 'OFF (normal render)');
  }
});

// Expose for debugging
window.DEBUG = {
  sim: sim,
  gl: gl,
  quadVAO: quadVAO,
  splatDye: splatDye,
  splatVelocity: splatVelocity,
  render: render,
  dropInk: dropInk,
  current: current,
  debugRenderDyeTexture: debugRenderDyeTexture,
  toggleDebug: () => { debugMode = !debugMode; console.log('Debug mode:', debugMode); }
};

})(); // IIFE
