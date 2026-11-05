import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import Delaunator from "delaunator";
import { groundAt, UNDER_CANOPY_LIMIT } from "./shade.js";


// Same march as shadeAt() in shade.js, run once per ground texel whenever the sun moves.
const SHADOW_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uTop, uGround, uUnder;
uniform vec3 uSun;
uniform vec2 uSize;
uniform float uMaxH;
in vec2 vUv;
out vec4 color;

ivec2 cell(vec2 p) { return ivec2(int(p.x), int(uSize.y) - 1 - int(p.y)); }

void main() {
  color = vec4(0.0, 0.0, 0.0, 1.0);
  if (uSun.z <= 0.0) return;
  vec2 p = vUv * uSize;
  float z = float(texelFetch(uGround, cell(p), 0).r) * 0.01 + 0.1;
  float horiz = length(uSun.xy);
  vec2 dir = uSun.xy / horiz;
  float rise = uSun.z / horiz, t = 0.5, beneath = 0.0;
  for (int i = 0; i < 320; i++) {
    float stride = t < 40.0 ? 1.0 : t < 120.0 ? 2.0 : 4.0;
    t += stride;
    vec2 q = p + dir * t;
    if (q.x < 0.0 || q.y < 0.0 || q.x >= uSize.x || q.y >= uSize.y) break;
    float rz = z + t * rise;
    if (rz > uMaxH) break;
    ivec2 c = cell(q);
    if (rz >= float(texelFetch(uTop, c, 0).r) * 0.01) continue;
    float g = float(texelFetch(uGround, c, 0).r) * 0.01;
    uint u = texelFetch(uUnder, c, 0).r;
    if (u == 0u || rz < g) return;
    if (rz >= g + float(u) * 0.25) { color.g = 1.0; return; }
    beneath += stride;
    if (beneath > ${UNDER_CANOPY_LIMIT.toFixed(1)}) { color.g = 1.0; return; }
  }
  color.r = 1.0;
}`;

const QUAD_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const TERRAIN_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal, vPos;
void main() { vUv = uv; vNormal = normal; vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D uBase, uShadow;
uniform vec3 uSunDir, uSunTint;
uniform float uDaylight;
uniform vec2 uTexel;
varying vec2 vUv;
varying vec3 vNormal, vPos;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec3 base = texture2D(uBase, vUv).rgb;
  // The basemap is ~0.4m a pixel; from a bench that is a blur, so break it up with grain that fades out with distance.
  float grain = 0.6 * noise(vPos.xz * 0.7) + 0.4 * noise(vPos.xz * 3.1);
  base *= 1.0 + (grain - 0.5) * 0.22 * (1.0 - smoothstep(40.0, 260.0, distance(vPos, cameraPosition)));
  // 3x3 tent over the 1m shadow texels; otherwise edges stair-step when the camera is near the ground.
  vec4 s = vec4(0.0);
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float wgt = (2.0 - abs(float(i))) * (2.0 - abs(float(j))) / 16.0;
    s += wgt * texture2D(uShadow, vUv + vec2(float(i), float(j)) * uTexel);
  }
  float facing = 0.8 + 0.2 * max(dot(normalize(vNormal), uSunDir), 0.0);
  // Tree shade reads a touch lighter than hard shade: canopy shadow is dappled, a wall's is not.
  float shade = mix(0.36, 0.46, s.g);
  vec3 lit = base * uSunTint * facing;
  vec3 col = mix(base * shade * vec3(0.78, 0.88, 1.15), lit, s.r);
  gl_FragColor = vec4(col * mix(0.12, 1.0, uDaylight), 1.0);
  #include <colorspace_fragment>
}`;

function intTexture(data, w, h, type, internalFormat) {
  const t = new THREE.DataTexture(data, w, h, THREE.RedIntegerFormat, type);
  t.internalFormat = internalFormat;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

const AREA_FILL = { garden: "#a9b98e", grass: "#93b96c", meadow: "#a9b76a", pitch: "#84b363", scrub: "#7f9f5e", sand: "#e3d3a0", play: "#cdb98f", parking: "#a5a5a0" };

function drawBasemap(world, size) {
  const { w, h } = world, k = size / w;
  const mask = document.createElement("canvas");
  mask.width = w; mask.height = h;
  const mctx = mask.getContext("2d"), img = mctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (!world.under[i]) continue;
    img.data.set([122, 150, 88, 255], i * 4);
  }
  mctx.putImageData(img, 0, 0);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const trace = (pts, close) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => ctx[i ? "lineTo" : "moveTo"](x * k, (h - y) * k));
    if (close) ctx.closePath();
  };
  ctx.fillStyle = "#b4b9a6"; ctx.fillRect(0, 0, size, size);
  const fillAreas = (kinds) => {
    for (const area of world.areas) {
      if (!kinds.includes(area.k)) continue;
      trace(area.p, true); ctx.fillStyle = AREA_FILL[area.k]; ctx.fill();
      if (area.k === "pitch") { ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 0.35 * k; ctx.stroke(); }
    }
  };
  fillAreas(["garden"]);
  ctx.fillStyle = "#93b96c";
  for (const park of world.parks) { trace(park.p, true); ctx.fill(); }
  fillAreas(["grass", "meadow", "scrub", "pitch", "play", "sand", "parking"]);
  ctx.drawImage(mask, 0, 0, size, size);
  ctx.fillStyle = "#6f9fc0";
  for (const poly of world.water) { trace(poly, true); ctx.fill(); }
  ctx.lineCap = ctx.lineJoin = "round";
  const styles = { road: ["#8e8e8a", 7], service: ["#a3a39c", 4], rail: ["#5d5a58", 5], path: ["#e4d9bd", 2.6] };
  for (const kind of ["road", "service", "rail", "path"]) {
    [ctx.strokeStyle, ctx.lineWidth] = [styles[kind][0], styles[kind][1] * k];
    for (const line of world.lines) if (line.k === kind) { trace(line.p); ctx.stroke(); }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const WALLS = [0xcdb891, 0xb98a72, 0xded6c6, 0xc9c4b8];
const ROOFS = [0x6e6f78, 0x96604c, 0x7b5e50];

function inside(x, y, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Each footprint is meshed as a Delaunay triangulation of its outline plus a 1m interior grid, lifted to the LIDAR
 * surface, so pitches, gables and hips come out as scanned and edges stay true to the OSM outline.
 * Display only: shadows never touch these meshes.
 */
function buildBuildings(world) {
  const { w, h, minH, top } = world;
  const pos = [], col = [], idx = [], color = new THREE.Color();
  const vertex = (x, y, z) => { pos.push(x - w / 2, z - minH, h / 2 - y); col.push(color.r, color.g, color.b); return pos.length / 3 - 1; };
  const surface = (x, y) => {
    const c = Math.min(w - 2, Math.max(1, Math.floor(x))), r = Math.min(h - 2, Math.max(1, h - 1 - Math.floor(y))), around = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) around.push(top[(r + dr) * w + c + dc]);
    return around.sort((p, q) => p - q)[4] / 100;
  };

  world.buildings.forEach((b, n) => {
    const signed = b.p.reduce((acc, [x, y], i) => acc + x * b.p[(i + 1) % b.p.length][1] - b.p[(i + 1) % b.p.length][0] * y, 0);
    const ring = signed > 0 ? b.p : [...b.p].reverse();

    // Outline resampled at ~1.5m, each point remembering which way is indoors.
    const edge = [];
    ring.forEach(([x0, y0], i) => {
      const [x1, y1] = ring[(i + 1) % ring.length], len = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.round(len / 1.5));
      for (let k = 0; k < steps; k++) edge.push({ x: x0 + ((x1 - x0) * k) / steps, y: y0 + ((y1 - y0) * k) / steps, nx: -(y1 - y0) / len, ny: (x1 - x0) / len });
    });
    // 1m cells of the footprint: 1 inside by scanline, 2 within 0.75m of the outline. Testing every cell against
    // every edge instead is quadratic, which a shopping centre outline makes take seconds.
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
    const bw = Math.ceil(Math.max(...xs)) - x0 + 1, bh = Math.ceil(Math.max(...ys)) - y0 + 1, cells = new Uint8Array(bw * bh);
    for (let r = 0; r < bh; r++) {
      const y = y0 + r + 0.5, cross = [];
      ring.forEach(([ax, ay], i) => {
        const [bx, by] = ring[(i + 1) % ring.length];
        if (ay > y !== by > y) cross.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      });
      cross.sort((p, q) => p - q);
      for (let k = 0; k + 1 < cross.length; k += 2)
        for (let c = Math.max(0, Math.ceil(cross[k] - x0 - 0.5)); c < bw && x0 + c + 0.5 < cross[k + 1]; c++) cells[r * bw + c] = 1;
    }
    ring.forEach(([ax, ay], i) => {
      const [bx, by] = ring[(i + 1) % ring.length], steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.25));
      for (let k = 0; k <= steps; k++) {
        const sx = ax + ((bx - ax) * k) / steps, sy = ay + ((by - ay) * k) / steps;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const c = Math.floor(sx - x0) + dc, r = Math.floor(sy - y0) + dr;
          if (c >= 0 && r >= 0 && c < bw && r < bh && Math.hypot(x0 + c + 0.5 - sx, y0 + r + 0.5 - sy) < 0.75) cells[r * bw + c] |= 2;
        }
      }
    });
    /** Point in footprint, exact near the outline and by cell lookup elsewhere (a cell's points share its centre's side). */
    const within = (x, y) => {
      const c = Math.floor(x - x0), r = Math.floor(y - y0);
      if (c < 0 || r < 0 || c >= bw || r >= bh) return false;
      const s = cells[r * bw + c];
      return s & 2 ? inside(x, y, ring) : s === 1;
    };
    const grid = [];
    for (let r = 0; r < bh; r++) for (let c = 0; c < bw; c++) {
      if (cells[r * bw + c] !== 1) continue;
      const x = x0 + c + 0.5, y = y0 + r + 0.5;
      grid.push({ x, y, z: surface(x, y) });
    }

    // Overhanging trees put 15m spikes in a house roof; the footprint's 90th percentile is the honest ceiling.
    const sorted = grid.map((g) => g.z).sort((p, q) => p - q), ceiling = b.z + b.h + 1.5;
    const eave = sorted.length ? Math.max(b.z + 2.2, Math.min(sorted[Math.floor(sorted.length / 4)], b.z + b.h)) : b.z + b.h;
    const lift = (z) => Math.min(ceiling, Math.max(eave, z));
    // LIDAR on the outline itself is half ground, so read the roof a little way indoors.
    const raw = edge.map((e) => (within(e.x + e.nx * 1.5, e.y + e.ny * 1.5) ? lift(surface(e.x + e.nx * 1.5, e.y + e.ny * 1.5)) : eave));
    edge.forEach((e, i) => (e.z = [raw.at(i - 1), raw[i], raw[(i + 1) % raw.length]].sort((p, q) => p - q)[1]));
    grid.forEach((g) => (g.z = lift(g.z)));

    const wall = WALLS[n % WALLS.length];
    const pitched = sorted.length && sorted[Math.floor(sorted.length * 0.9)] - eave > 1.2;
    color.setHex(pitched ? ROOFS[n % ROOFS.length] : 0x9a9a96);
    const points = [...edge, ...grid], first = pos.length / 3;
    points.forEach((p) => vertex(p.x, p.y, p.z));
    const { triangles } = Delaunator.from(points, (p) => p.x, (p) => p.y);
    for (let t = 0; t < triangles.length; t += 3) {
      const [p, q, r] = [points[triangles[t]], points[triangles[t + 1]], points[triangles[t + 2]]];
      if (!within((p.x + q.x + r.x) / 3, (p.y + q.y + r.y) / 3)) continue;
      const up = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) > 0;
      idx.push(first + triangles[t], first + triangles[t + (up ? 1 : 2)], first + triangles[t + (up ? 2 : 1)]);
    }

    color.setHex(wall);
    edge.forEach((e, i) => {
      const f = edge[(i + 1) % edge.length];
      const v = [vertex(e.x, e.y, b.z - 1), vertex(f.x, f.y, b.z - 1), vertex(f.x, f.y, f.z), vertex(e.x, e.y, e.z)];
      idx.push(v[0], v[1], v[2], v[0], v[2], v[3]);
    });
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

function label(text, fill = "#ffffff", scale = 0.028) {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"), font = "600 28px system-ui, sans-serif";
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 16;
  canvas.height = 40;
  ctx.font = font; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  ctx.lineWidth = 6; ctx.strokeStyle = "rgba(15, 18, 24, 0.85)"; ctx.strokeText(text, 8, 21);
  ctx.fillStyle = fill; ctx.fillText(text, 8, 21);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, sizeAttenuation: false, transparent: true }));
  sprite.scale.set((scale * canvas.width) / canvas.height, scale, 1);
  sprite.renderOrder = 8;
  return sprite;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith, uHorizon, uSunDir, uGlow;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = mix(uHorizon, uZenith, pow(clamp(dir.y, 0.0, 1.0), 0.5));
  float toward = max(dot(dir, uSunDir), 0.0);
  col += uGlow * (0.35 * pow(toward, 12.0) + 0.9 * pow(toward, 220.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export function createScene(container, world) {
  const { w, h, minH } = world;
  const toWorld = (x, y, z) => new THREE.Vector3(x - w / 2, z - minH, h / 2 - y);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 2, 12000);
  camera.position.set(-350, 650, 900);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 25;
  controls.maxDistance = 3000;
  controls.target.copy(toWorld(w / 2, h / 2, groundAt(world, w / 2, h / 2)));

  // --- shadow pass
  const coarse = matchMedia("(pointer: coarse)").matches;
  const stride = coarse ? 4 : 2;
  const shadowTarget = new THREE.WebGLRenderTarget(coarse ? 1024 : w, coarse ? 1024 : h, { depthBuffer: false });
  const shadowMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: SHADOW_FRAG, depthTest: false,
    uniforms: {
      uTop: { value: intTexture(world.top, w, h, THREE.UnsignedShortType, "R16UI") },
      uGround: { value: intTexture(world.ground, w, h, THREE.UnsignedShortType, "R16UI") },
      uUnder: { value: intTexture(world.under, w, h, THREE.UnsignedByteType, "R8UI") },
      uSun: { value: new THREE.Vector3(0, 0, 1) }, uSize: { value: new THREE.Vector2(w, h) }, uMaxH: { value: world.maxH },
    },
  });
  const shadowScene = new THREE.Scene();
  shadowScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shadowMaterial));
  const shadowCamera = new THREE.Camera();

  // --- terrain
  const terrainGeo = new THREE.PlaneGeometry(w, h, w / stride, h / stride);
  const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, groundAt(world, pos.getX(i) + w / 2, pos.getY(i) + h / 2) - minH);
  terrainGeo.rotateX(-Math.PI / 2);
  terrainGeo.computeVertexNormals();
  const terrainMaterial = new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG,
    uniforms: {
      uBase: { value: drawBasemap(world, coarse ? 2048 : 4096) }, uShadow: { value: shadowTarget.texture },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunTint: { value: new THREE.Color(1, 1, 1) }, uDaylight: { value: 1 }, uTexel: { value: new THREE.Vector2(0.8 / shadowTarget.width, 0.8 / shadowTarget.height) },
    },
  });
  scene.add(new THREE.Mesh(terrainGeo, terrainMaterial));
  // Past the LIDAR tile the ground dissolves into haze rather than ending at a cliff.
  const beyondMaterial = new THREE.ShaderMaterial({
    uniforms: { uHorizon: { value: new THREE.Color() }, uDaylight: { value: 1 } },
    vertexShader: "varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 uHorizon; uniform float uDaylight; varying vec3 vPos;
      void main() {
        gl_FragColor = vec4(mix(vec3(0.36, 0.41, 0.29) * mix(0.12, 1.0, uDaylight), uHorizon, smoothstep(900.0, 4500.0, length(vPos.xz))), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const beyond = new THREE.Mesh(new THREE.CircleGeometry(9000, 64).rotateX(-Math.PI / 2), beyondMaterial);
  beyond.position.y = -1;
  scene.add(beyond);

  // --- buildings
  scene.add(buildBuildings(world));
  const roofAt = (x, y) => world.top[(h - 1 - Math.floor(y)) * w + Math.floor(x)] / 100;
  for (const l of world.labels) {
    const sprite = label(l.t);
    sprite.position.copy(toWorld(l.x, l.y, (l.k === "park" ? groundAt(world, l.x, l.y) : roofAt(l.x, l.y)) + 25));
    scene.add(sprite);
  }
  for (const b of world.benches) {
    if (b.kind !== "pub" || b.where !== "out front") continue;
    const sprite = label(b.name.replace(/^The /, ""), "#f6cf7e", 0.022);
    sprite.position.copy(toWorld(b.x, b.y, groundAt(world, b.x, b.y) + 24));
    scene.add(sprite);
  }

  // The fibreglass cat that climbs the Catford Centre, roughly to scale. Decoration only.
  for (const l of world.labels.filter((l) => l.k === "art" && l.t.includes("Cat"))) {
    const black = new THREE.MeshLambertMaterial({ color: 0x18171a, flatShading: true });
    const ball = (sx, sy, sz, x, y, z) => new THREE.SphereGeometry(1, 10, 8).scale(sx, sy, sz).translate(x, y, z);
    const cone = (x, z) => new THREE.ConeGeometry(0.45, 0.9, 4).translate(x, 3.7, z);
    const tail = new THREE.TorusGeometry(1.6, 0.22, 6, 12, Math.PI * 1.2).rotateY(Math.PI / 2).translate(0, 2.1, -3.2);
    const cat = new THREE.Mesh(mergeGeometries([ball(1.3, 1.2, 2.6, 0, 1.6, 0), ball(1, 0.95, 0.95, 0, 2.9, 2.5), cone(-0.55, 2.6), cone(0.55, 2.6), tail]), black);
    cat.position.copy(toWorld(l.x, l.y, roofAt(l.x, l.y) - 0.3));
    cat.rotation.y = 0.6;
    scene.add(cat);
  }

  // --- trees: crowns sized from LIDAR crown-top height
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial({ flatShading: true }), world.trees.length * 2);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.7, 1, 5), new THREE.MeshLambertMaterial({ color: 0x5b4636 }), world.trees.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), tint = new THREE.Color();
  world.trees.forEach(([x, y, th, spread], i) => {
    const base = toWorld(x + 0.5, y + 0.5, groundAt(world, x, y));
    const rnd = (k) => ((x * 73 + y * 151 + k * 37) % 100) / 100;
    const r = Math.min(9, spread) * 0.9, crownH = th * 0.62;
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd(1) * Math.PI);
    m.compose(base.clone().setY(base.y + th - crownH / 2), q, new THREE.Vector3(r * (0.85 + 0.3 * rnd(2)), crownH / 2, r * (0.85 + 0.3 * rnd(3))));
    crowns.setMatrixAt(i * 2, m);
    // A second, offset lobe so crowns read as foliage masses rather than balloons.
    const lobe = new THREE.Vector3((rnd(4) - 0.5) * r, th - crownH * (0.55 + 0.3 * rnd(5)), (rnd(6) - 0.5) * r);
    m.compose(base.clone().add(lobe), q, new THREE.Vector3(r * 0.68, crownH * 0.36, r * 0.68));
    crowns.setMatrixAt(i * 2 + 1, m);
    q.identity();
    m.compose(base.clone().setY(base.y + (th - crownH) / 2), q, new THREE.Vector3(Math.max(0.5, th / 30), th - crownH, Math.max(0.5, th / 30)));
    trunks.setMatrixAt(i, m);
    const jitter = ((x * 73 + y * 151) % 100) / 100;
    crowns.setColorAt(i * 2, tint.setHSL(0.27 + jitter * 0.06, 0.42, 0.25 + jitter * 0.1));
    crowns.setColorAt(i * 2 + 1, tint.offsetHSL(0, 0, 0.035));
  });
  scene.add(crowns, trunks);

  // --- bench and picnic table furniture, turned to face the way a sitter would
  const box = (sx, sy, sz, x, y, z) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
  const furniture = {
    bench: mergeGeometries([box(1.8, 0.08, 0.5, 0, 0.45, 0), box(1.8, 0.5, 0.06, 0, 0.75, -0.25), box(0.08, 0.45, 0.45, -0.8, 0.22, 0), box(0.08, 0.45, 0.45, 0.8, 0.22, 0)]),
    table: mergeGeometries([box(1.8, 0.08, 0.8, 0, 0.75, 0), box(1.8, 0.06, 0.3, 0, 0.45, 0.75), box(1.8, 0.06, 0.3, 0, 0.45, -0.75), box(0.1, 0.75, 1.6, -0.7, 0.37, 0), box(0.1, 0.75, 1.6, 0.7, 0.37, 0)]),
  };
  for (const [kind, geo] of Object.entries(furniture)) {
    const items = world.benches.filter((b) => b.kind === kind || (kind === "table" && b.kind === "pub"));
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xb48e62 }), items.length);
    items.forEach((b, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.PI - (b.f * Math.PI) / 180);
      mesh.setMatrixAt(i, m.compose(toWorld(b.x, b.y, groundAt(world, b.x, b.y)), q, new THREE.Vector3(1, 1, 1)));
    });
    scene.add(mesh);
  }
  q.identity();

  // --- light and sky
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.5);
  const ambient = new THREE.HemisphereLight(0xcfe3ff, 0x6b7a55, 1.1);
  scene.add(sunLight, sunLight.target, ambient);
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(65, 24, 12), new THREE.MeshBasicMaterial({ color: 0xfff1b8, fog: false }));
  scene.add(sunDisc);
  const SKY = { night: new THREE.Color(0x0b1020), twilight: new THREE.Color(0x3c4a78), low: new THREE.Color(0xecc4a0), day: new THREE.Color(0x9cc7ec), zenith: new THREE.Color(0x3f7fd0) };
  const horizon = new THREE.Color(), zenith = new THREE.Color();
  scene.background = horizon;
  const skyMaterial = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
    uniforms: { uZenith: { value: zenith }, uHorizon: { value: horizon }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uGlow: { value: new THREE.Color() } },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), skyMaterial);
  sky.renderOrder = -1;
  scene.add(sky);
  let sunDir = new THREE.Vector3(0, 1, 0);

  // --- bench markers
  const markers = new Map();
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);
  const addMarker = (b) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
    sprite.position.copy(toWorld(b.x, b.y, groundAt(world, b.x, b.y) + 2.5));
    sprite.renderOrder = 10;
    sprite.userData.id = b.id;
    markerGroup.add(sprite);
    markers.set(b.id, { sprite, canvas, tex, kind: b.kind });
  };
  world.benches.forEach(addMarker);

  const dotCanvas = document.createElement("canvas");
  dotCanvas.width = dotCanvas.height = 64;
  const dctx = dotCanvas.getContext("2d");
  dctx.beginPath(); dctx.arc(32, 32, 30, 0, Math.PI * 2); dctx.fillStyle = "rgba(60, 140, 255, 0.28)"; dctx.fill();
  dctx.beginPath(); dctx.arc(32, 32, 13, 0, Math.PI * 2); dctx.fillStyle = "#2f7bff"; dctx.fill();
  dctx.lineWidth = 5; dctx.strokeStyle = "#ffffff"; dctx.stroke();
  const userDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(dotCanvas), depthTest: false, sizeAttenuation: false, transparent: true }));
  userDot.scale.setScalar(0.06);
  userDot.renderOrder = 13;
  userDot.visible = false;
  const guide = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xf3e6c4, dashSize: 6, gapSize: 4, depthTest: false, transparent: true }));
  guide.renderOrder = 9;
  guide.visible = false;
  guide.frustumCulled = false;
  scene.add(userDot, guide);

  let dirty = true, flight = null, seat = null, placing = false;
  controls.addEventListener("change", () => (dirty = true));

  const api = {
    onPick: null, onHover: null, onCompass: null,

    setSun(sun) {
      const daylight = THREE.MathUtils.smoothstep(sun.altitude, -0.1, 0.12);
      const dir = new THREE.Vector3(sun.e, sun.u, -sun.n);
      shadowMaterial.uniforms.uSun.value.set(sun.e, sun.n, sun.u);
      renderer.setRenderTarget(shadowTarget);
      renderer.render(shadowScene, shadowCamera);
      renderer.setRenderTarget(null);

      const warmth = 1 - THREE.MathUtils.smoothstep(sun.altitude, 0.05, 0.45);
      terrainMaterial.uniforms.uSunDir.value.copy(dir);
      terrainMaterial.uniforms.uSunTint.value.setRGB(1.06, 1.0 - 0.1 * warmth, 0.94 - 0.24 * warmth);
      terrainMaterial.uniforms.uDaylight.value = daylight;
      sunLight.position.copy(controls.target).addScaledVector(dir, 1000);
      sunLight.target.position.copy(controls.target);
      sunLight.intensity = 2.5 * daylight * (sun.u > 0 ? 1 : 0);
      sunLight.color.setRGB(1, 1 - 0.15 * warmth, 1 - 0.35 * warmth);
      ambient.intensity = 0.15 + 0.95 * daylight;
      sunDir = dir;
      sunDisc.visible = sun.u > -0.02;
      const { smoothstep } = THREE.MathUtils;
      horizon.copy(SKY.night)
        .lerp(SKY.twilight, smoothstep(sun.altitude, -0.22, -0.03))
        .lerp(SKY.low, smoothstep(sun.altitude, -0.05, 0.05))
        .lerp(SKY.day, smoothstep(sun.altitude, 0.03, 0.35));
      zenith.copy(SKY.night).lerp(SKY.twilight, smoothstep(sun.altitude, -0.25, -0.05)).lerp(SKY.zenith, smoothstep(sun.altitude, -0.08, 0.3));
      beyondMaterial.uniforms.uHorizon.value.copy(horizon);
      beyondMaterial.uniforms.uDaylight.value = daylight;
      skyMaterial.uniforms.uSunDir.value.copy(dir);
      skyMaterial.uniforms.uGlow.value.setRGB(1, 0.85 - 0.25 * warmth, 0.6 - 0.35 * warmth).multiplyScalar(daylight);
      dirty = true;
    },

    /** Sunlit seats glow in `fill`; shaded ones recede so the eye lands on where the sun is. A null fill hides the marker. */
    paintMarker(id, fill, sunlit, selected) {
      const { canvas, tex, sprite, kind } = markers.get(id);
      sprite.visible = fill !== null && seat?.marker !== sprite;
      if (fill === null) return void (dirty = true);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, 64, 64);
      if (sunlit) {
        const halo = ctx.createRadialGradient(32, 32, 10, 32, 32, 32);
        halo.addColorStop(0, "rgba(246, 176, 60, 0.75)");
        halo.addColorStop(1, "rgba(246, 176, 60, 0)");
        ctx.fillStyle = halo; ctx.fillRect(0, 0, 64, 64);
      }
      // Dropped pins are diamonds so they never pass for mapped furniture; pubs are beer mats.
      const r = sunlit ? 15 : 11;
      ctx.beginPath();
      if (kind === "spot") { ctx.moveTo(32, 32 - r * 1.25); ctx.lineTo(32 + r * 1.25, 32); ctx.lineTo(32, 32 + r * 1.25); ctx.lineTo(32 - r * 1.25, 32); ctx.closePath(); }
      else if (kind === "pub") ctx.roundRect(32 - r, 32 - r, r * 2, r * 2, r * 0.35);
      else ctx.arc(32, 32, r, 0, Math.PI * 2);
      ctx.fillStyle = sunlit ? fill : "#4d4b5a"; ctx.fill();
      ctx.lineWidth = selected ? 6 : 3.5;
      ctx.strokeStyle = selected ? "#f3e6c4" : sunlit ? "#ffffff" : "#17130f";
      ctx.stroke();
      tex.needsUpdate = true;
      sprite.scale.setScalar(selected ? 0.07 : 0.05);
      sprite.renderOrder = selected ? 12 : sunlit ? 11 : 10;
      dirty = true;
    },

    /** GPS fix in local metres, or null to hide. */
    setUser(me) {
      userDot.visible = !!me;
      if (me) userDot.position.copy(toWorld(me.x, me.y, groundAt(world, me.x, me.y) + 2));
      dirty = true;
    },

    /** Straight line from the user to a bench; null clears it. */
    setGuide(me, bench) {
      guide.visible = !!(me && bench);
      if (guide.visible) {
        guide.geometry.setFromPoints([me, bench].map((p) => toWorld(p.x, p.y, groundAt(world, p.x, p.y) + 2)));
        guide.computeLineDistances();
      }
      dirty = true;
    },

    faceNorth() {
      const offset = camera.position.clone().sub(controls.target);
      const flat = Math.hypot(offset.x, offset.z);
      flight = { target: controls.target.clone(), position: controls.target.clone().add(new THREE.Vector3(0, offset.y, flat)) };
    },

    addMarker,

    removeMarker(id) {
      const { sprite, tex } = markers.get(id);
      markerGroup.remove(sprite);
      tex.dispose();
      sprite.material.dispose();
      markers.delete(id);
      if (seat?.marker === sprite) seat.marker = null;
      dirty = true;
    },

    /** While placing, a tap on open ground reports the spot through onGround instead of clearing the selection. */
    setPlacing(on) {
      placing = on;
      renderer.domElement.style.cursor = on ? "crosshair" : "";
    },

    /**
     * Drops the camera to eye height on the bench, facing the way it faces; drag then looks around.
     * At a picnic table you sit on one plank looking across the top, and `flipped` takes the other plank.
     */
    sit(bench, flipped) {
      seat ??= { position: camera.position.clone(), target: controls.target.clone() };
      if (seat.marker) seat.marker.visible = true;
      seat.marker = markers.get(bench.id).sprite;
      seat.marker.visible = false;
      const f = (bench.f * Math.PI) / 180, dir = new THREE.Vector3(Math.sin(f), 0, -Math.cos(f)).multiplyScalar(flipped ? -1 : 1);
      const eye = toWorld(bench.x, bench.y, groundAt(world, bench.x, bench.y) + 1.2).addScaledVector(dir, bench.kind === "table" ? -0.75 : 0.15);
      // Orbiting a point 30cm ahead is, near enough, turning your head.
      Object.assign(controls, { minDistance: 0.01, maxPolarAngle: Math.PI * 0.97, enablePan: false, enableZoom: false });
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      Object.assign(camera, { near: 0.3, fov: 70 });
      camera.updateProjectionMatrix();
      flight = { target: eye.clone().addScaledVector(dir, 0.3), position: eye };
    },

    stand() {
      if (!seat) return;
      if (seat.marker) seat.marker.visible = true;
      Object.assign(controls, { minDistance: 25, maxPolarAngle: Math.PI * 0.47, enablePan: true, enableZoom: true });
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.PAN;
      Object.assign(camera, { near: 2, fov: 45 });
      camera.updateProjectionMatrix();
      flight = { target: seat.target, position: seat.position };
      seat = null;
    },

    flyTo(bench) {
      const target = toWorld(bench.x, bench.y, groundAt(world, bench.x, bench.y));
      const offset = camera.position.clone().sub(controls.target).setLength(160);
      offset.y = Math.max(offset.y, 90);
      flight = { target, position: target.clone().add(offset) };
    },

    resize() {
      const { clientWidth, clientHeight } = container;
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      dirty = true;
    },
  };

  // --- picking: a tap selects, a drag pans
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let downAt = null;
  const hit = (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(markerGroup.children)[0]?.object.userData.id ?? null;
  };
  // Marching the pick ray over the height grid is far cheaper than raycasting a million terrain triangles.
  const groundUnderPointer = () => {
    const { origin, direction } = raycaster.ray, p = new THREE.Vector3();
    for (let t = 1; t < 8000; t += t < 300 ? 0.5 : 2) {
      p.copy(origin).addScaledVector(direction, t);
      const x = p.x + w / 2, y = h / 2 - p.z;
      if (x >= 0 && y >= 0 && x < w && y < h && p.y + minH <= groundAt(world, x, y)) return { x, y };
    }
    return null;
  };
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    downAt = [ev.clientX, ev.clientY];
    if (!seat) flight = null;
  });
  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) < 6) {
      const id = hit(ev);
      if (id === null && placing) api.onGround?.(groundUnderPointer());
      else api.onPick?.(id);
    }
    downAt = null;
  });
  renderer.domElement.addEventListener("pointermove", (ev) => {
    if (ev.pointerType === "mouse" && !ev.buttons) api.onHover?.(hit(ev), ev);
  });
  renderer.domElement.addEventListener("pointerleave", () => api.onHover?.(null));

  new ResizeObserver(api.resize).observe(container);
  renderer.setAnimationLoop(() => {
    if (flight) {
      controls.target.lerp(flight.target, 0.12);
      camera.position.lerp(flight.position, 0.12);
      if (controls.target.distanceTo(flight.target) < 0.02 && camera.position.distanceTo(flight.position) < 0.02) {
        controls.target.copy(flight.target);
        camera.position.copy(flight.position);
        flight = null;
      }
      dirty = true;
    }
    controls.update();
    if (!dirty) return;
    dirty = false;
    sky.position.copy(camera.position);
    sunDisc.position.copy(camera.position).addScaledVector(sunDir, 7000);
    renderer.render(scene, camera);
    api.onCompass?.(controls.getAzimuthalAngle());
  });
  return api;
}
