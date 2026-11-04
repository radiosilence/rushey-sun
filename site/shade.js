import { sunPosition } from "./sun.js";

export const SUN = 0, TREE_SHADE = 1, SOLID_SHADE = 2, NIGHT = 3;
// A ray may pass beneath crowns for this many metres before trunks and understorey are assumed to stop it.
export const UNDER_CANOPY_LIMIT = 30;
export const SEAT_HEIGHT = 1.0;

async function gunzip(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

function unpackU16(bytes, w, h) {
  const n = w * h, out = new Uint16Array(n);
  for (let r = 0; r < h; r++) {
    let acc = 0;
    for (let i = r * w, end = i + w; i < end; i++) {
      acc = (acc + (bytes[i] | (bytes[n + i] << 8))) & 0xffff;
      out[i] = acc;
    }
  }
  return out;
}

/** Surface layers in centimetres, raster order (row 0 = north edge). */
export async function loadWorld() {
  const [scene, top, ground, under] = await Promise.all([
    fetch("data/scene.json").then((r) => r.json()),
    gunzip("data/top.u16.gz"), gunzip("data/ground.u16.gz"), gunzip("data/under.u8.gz"),
  ]);
  const { w, h } = scene;
  return { ...scene, top: unpackU16(top, w, h), ground: unpackU16(ground, w, h), under };
}

export function groundAt(world, x, y) {
  const c = Math.min(world.w - 1, Math.max(0, Math.floor(x)));
  const r = Math.min(world.h - 1, Math.max(0, world.h - 1 - Math.floor(y)));
  return world.ground[r * world.w + c] / 100;
}

/** Unit vector to the sun in grid space (east, north, up). */
export function sunVector(world, ms) {
  const { azimuth, altitude } = sunPosition(ms, world.lat, world.lon);
  const az = azimuth + (world.convergence * Math.PI) / 180;
  return { e: Math.sin(az) * Math.cos(altitude), n: Math.cos(az) * Math.cos(altitude), u: Math.sin(altitude), azimuth, altitude };
}

/** Marches from (x, y, z) toward the sun across the surface model. Mirrors the GLSL in scene.js. */
export function shadeAt(world, x, y, z, sun) {
  if (sun.u <= 0) return NIGHT;
  const { w, h, top, ground, under } = world;
  const horiz = Math.hypot(sun.e, sun.n), dx = sun.e / horiz, dy = sun.n / horiz, rise = sun.u / horiz;
  let t = 0.5, beneath = 0;
  for (let i = 0; i < 320; i++) {
    const step = t < 40 ? 1 : t < 120 ? 2 : 4;
    t += step;
    const px = x + dx * t, py = y + dy * t;
    if (px < 0 || py < 0 || px >= w || py >= h) break;
    const rz = z + t * rise;
    if (rz > world.maxH) break;
    const idx = (h - 1 - Math.floor(py)) * w + Math.floor(px);
    if (rz * 100 >= top[idx]) continue;
    const g = ground[idx] / 100, u = under[idx];
    if (u === 0 || rz < g) return SOLID_SHADE;
    if (rz >= g + u * 0.25) return TREE_SHADE;
    beneath += step;
    if (beneath > UNDER_CANOPY_LIMIT) return TREE_SHADE;
  }
  return SUN;
}
