import { loadWorld, shadeAt, sunVector, groundAt, SUN, TREE_SHADE, SOLID_SHADE, NIGHT, SEAT_HEIGHT } from "./shade.js";
import { londonToUtc, londonNow } from "./sun.js";
import { createScene } from "./scene.js";

const STEP = 5, STEPS = 1440 / STEP;
const STRIP_FROM = 4 * 60, STRIP_TO = 22 * 60;
const YEAR_DAYS = 5, YEAR_STEP = 15;
const STATE_COLOR = { [SUN]: "#f2ac3a", [TREE_SHADE]: "#4d7a5c", [SOLID_SHADE]: "#5c5e72" };
const STATE_LABEL = { [SUN]: "in direct sun", [TREE_SHADE]: "in tree shade", [SOLID_SHADE]: "shaded by a building or a hill", [NIGHT]: "after dark" };
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** One hue, dark to bright: the day's share of sun. */
function ramp(f) {
  const stops = [[74, 58, 28], [176, 124, 34], [255, 214, 92]];
  const t = Math.min(0.999, Math.max(0, f)) * 2, i = Math.floor(t), k = t - i;
  return `rgb(${stops[i].map((c, j) => Math.round(c + (stops[i + 1][j] - c) * k)).join(",")})`;
}

let world, view;
try {
  world = await loadWorld();
  view = createScene($("view"), world);
  $("loading").remove();
} catch (err) {
  $("loading").textContent = `Couldn't start: ${err.message}. This needs WebGL2 and a browser from 2023 or later.`;
  throw err;
}

const numbered = new Map();
world.benches.forEach((b) => {
  if (b.kind !== "pub") {
    const what = b.where === "outdoor seating" ? "outdoor seating" : b.kind === "table" ? "picnic table" : "bench";
    const key = `${b.g}|${what}`, n = (numbered.get(key) ?? 0) + 1;
    numbered.set(key, n);
    b.name = b.g ? `${b.g} ${what} ${n}` : `${what[0].toUpperCase()}${what.slice(1)} ${n}`;
  }
  b.z = groundAt(world, b.x, b.y) + SEAT_HEIGHT;
});
const parkNames = new Set(world.parks.map((p) => p.name));
const groups = [...new Set(world.benches.map((b) => b.g).filter((g) => parkNames.has(g)))]
  .sort((a, b) => world.benches.filter((x) => x.g === b).length - world.benches.filter((x) => x.g === a).length);
$("where").append(...groups.map((g) => new Option(g, g)));
/** Whether a place belongs in the list under the chosen filter; dropped pins always do. */
const shown = (b) => b.kind === "spot" || state.where === "all" || (state.where === "pubs" ? b.kind === "pub" : b.g === state.where);

// Furniture gets moved and OSM lags, so any spot on the ground can be pinned and analysed like a bench.
const SPOTS_KEY = "rushey-sun:spots";
function loadSpots() {
  try {
    return JSON.parse(localStorage.getItem(SPOTS_KEY) ?? "[]").filter((p) => p.x >= 0 && p.y >= 0 && p.x < world.w && p.y < world.h);
  } catch {
    return [];
  }
}
function saveSpots() {
  try {
    localStorage.setItem(SPOTS_KEY, JSON.stringify(places.filter((b) => b.kind === "spot").map(({ id, x, y, n }) => ({ id, x, y, n }))));
  } catch {
    // Private browsing: pins just won't outlive the tab.
  }
}
function makeSpot({ id, x, y, n }) {
  // Invert the pipeline's lon/lat -> metres affine so a pin can still hand off to walking directions.
  const [[a, b, c], [d, e, f]] = world.geo, det = a * e - b * d;
  const lon = world.lon + (e * (x - c) - b * (y - f)) / det, lat = world.lat + (a * (y - f) - d * (x - c)) / det;
  return { id, kind: "spot", n, name: `My spot ${n}`, x, y, z: groundAt(world, x, y) + SEAT_HEIGHT, f: 180, lat, lon };
}
const places = [...world.benches, ...loadSpots().map(makeSpot)];
places.filter((b) => b.kind === "spot").forEach(view.addMarker);
const benchById = new Map(places.map((b) => [b.id, b]));

const params = new URLSearchParams(location.search);
const now = londonNow();
const [py, pm, pd] = (params.get("d") ?? "").split("-").map(Number);
const state = {
  y: py || now.y, m: pm || now.m, d: pd || now.d,
  minutes: params.has("t") ? +params.get("t") : Math.round(now.minutes / STEP) * STEP,
  selected: benchById.has(+params.get("b")) ? +params.get("b") : null,
  sort: "day", where: groups.includes(params.get("w")) || params.get("w") === "pubs" ? params.get("w") : "all", me: null, seated: false, flipped: false, placing: false,
};

let urlTimer = null;
let day = null; // { suns, rise, set, rows: Map<id, { states, sunMin, dayMin, li, cursor, pct, dot }> }

const noonUtc = (y, m, d) => londonToUtc(y, m, d, 720);
const sunsFor = (y, m, d, step) => {
  const noon = noonUtc(y, m, d);
  return Array.from({ length: 1440 / step }, (_, i) => sunVector(world, noon + (i * step - 720) * 60000));
};

function dayRow(b, suns) {
  const states = Uint8Array.from(suns, (s) => shadeAt(world, b.x, b.y, b.z, s));
  return { states, sunMin: states.filter((s) => s === SUN).length * STEP, dayMin: suns.filter((s) => s.u > 0).length * STEP };
}

function computeDay() {
  const suns = sunsFor(state.y, state.m, state.d, STEP);
  const up = suns.map((s) => s.u > 0);
  day = { suns, rows: new Map(places.map((b) => [b.id, dayRow(b, suns)])), rise: up.indexOf(true) * STEP, set: up.lastIndexOf(true) * STEP };
  buildList();
}

function buildList() {
  const list = $("list");
  list.replaceChildren();
  for (const b of places) {
    const row = day.rows.get(b.id);
    const li = document.createElement("li");
    li.innerHTML = `<span class="rank"></span><span class="pct"></span><span class="strip"><canvas width="216" height="1"></canvas><b></b></span>`;
    li.title = b.name;
    li.addEventListener("click", () => select(b.id, true));
    const ctx = li.querySelector("canvas").getContext("2d");
    for (let min = STRIP_FROM; min < STRIP_TO; min += STEP) {
      const s = row.states[min / STEP];
      if (s === NIGHT) continue;
      ctx.fillStyle = STATE_COLOR[s];
      ctx.fillRect((min - STRIP_FROM) / STEP, 0, 1, 1);
    }
    const strip = li.querySelector(".strip");
    strip.addEventListener("pointermove", (ev) => {
      const r = strip.getBoundingClientRect();
      const min = STRIP_FROM + Math.floor(((ev.clientX - r.left) / r.width) * (STRIP_TO - STRIP_FROM) / STEP) * STEP;
      showTip(`${b.name} · ${hhmm(min)} · ${STATE_LABEL[row.states[min / STEP]]}`, ev);
    });
    strip.addEventListener("pointerleave", () => showTip(null));
    Object.assign(row, { li, rank: li.querySelector(".rank"), pct: li.querySelector(".pct"), cursor: li.querySelector("b") });
  }
}

const sunFrom = (row, from) => row.states.subarray(from / STEP).filter((s) => s === SUN).length * STEP;
const distance = (b) => (state.me ? Math.hypot(b.x - state.me.x, b.y - state.me.y) : Infinity);

function refresh() {
  const step = state.minutes / STEP, sun = day.suns[step];
  view.setSun(sun);

  const score = { day: (b) => day.rows.get(b.id).sunMin, rest: (b) => sunFrom(day.rows.get(b.id), state.minutes), near: (b) => -distance(b) }[state.sort];
  const ordered = places.filter(shown).sort((a, b) => score(b) - score(a));
  const cursor = `${((state.minutes - STRIP_FROM) / (STRIP_TO - STRIP_FROM)) * 100}%`;
  let sunlitCount = 0;
  $("list").replaceChildren();
  for (const b of places) if (!shown(b)) view.paintMarker(b.id, null, false, b.id === state.selected);
  ordered.forEach((b, i) => {
    const row = day.rows.get(b.id), sunlit = row.states[step] === SUN, share = row.dayMin ? row.sunMin / row.dayMin : 0;
    sunlitCount += sunlit && b.kind !== "spot";
    row.rank.textContent = i + 1;
    const sub = state.sort === "near" ? `${Math.round(distance(b))} m` : `${((state.sort === "rest" ? sunFrom(row, state.minutes) : row.sunMin) / 60).toFixed(1)} h`;
    row.pct.innerHTML = `${Math.round(share * 100)}%<i class="now${sunlit ? " on" : ""}"></i><small>${sub}${state.sort === "rest" ? " left" : ""}</small>`;
    row.cursor.style.left = cursor;
    row.cursor.hidden = state.minutes < STRIP_FROM || state.minutes >= STRIP_TO;
    row.li.classList.toggle("selected", b.id === state.selected);
    $("list").appendChild(row.li);
    view.paintMarker(b.id, ramp(share), sunlit, b.id === state.selected);
  });

  const date = new Date(Date.UTC(state.y, state.m - 1, state.d));
  $("date").value = `${state.y}-${pad(state.m)}-${pad(state.d)}`;
  $("day").value = Math.min(364, Math.round((date - Date.UTC(state.y, 0, 1)) / 864e5));
  $("time").value = state.minutes;
  $("clock").textContent = hhmm(state.minutes);
  const alt = Math.round((sun.altitude * 180) / Math.PI), az = ((sun.azimuth * 180) / Math.PI + 360) % 360;
  const chosen = benchById.get(state.selected);
  $("readout").textContent = (alt > 0 ? `${hhmm(state.minutes)} · sun ${alt}° up in the ${COMPASS[Math.round(az / 22.5) % 16]}` : `${hhmm(state.minutes)} · sun is down`)
    + (chosen ? `\n${chosen.name} · ${STATE_LABEL[day.rows.get(chosen.id).states[step]]}` : "");
  $("sunfacts").textContent = `Sunrise ≈ ${hhmm(day.rise)} · sunset ≈ ${hhmm(day.set)} · ${sunlitCount} of ${ordered.filter((b) => b.kind !== "spot").length} in sun now`;
  $("where").value = state.where;

  renderDetail();
  view.setGuide(state.me, benchById.get(state.selected));
  // Safari throws if replaceState is called more than 100 times in 30s, which Play would hit.
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const q = new URLSearchParams({ d: $("date").value, t: state.minutes });
    if (state.selected) q.set("b", state.selected);
    if (state.where !== "all") q.set("w", state.where);
    history.replaceState(null, "", `?${q}`);
  }, 400);
}

// --- selected bench: today's numbers plus the whole year at a glance
let yearFor = null;

function renderDetail() {
  const el = $("detail"), b = benchById.get(state.selected);
  el.hidden = !b;
  if (!b) return void (yearFor = null);
  const row = day.rows.get(b.id), step = state.minutes / STEP, current = row.states[step];
  let change = step;
  while (change < STEPS && row.states[change] === current) change++;
  const until = current === NIGHT ? "" : change < STEPS ? ` until ${hhmm(change * STEP)}` : "";
  const tags = [b.backrest === "yes" && "backrest", b.backrest === "no" && "no backrest", b.material, b.seats && `${b.seats} seats`].filter(Boolean).join(" · ");
  const share = row.dayMin ? Math.round((row.sunMin / row.dayMin) * 100) : 0;

  if (yearFor !== b.id) {
    el.innerHTML = `
      <h3></h3><p class="muted" id="d-tags"></p>
      <div class="big" id="d-big"></div><p id="d-now"></p>
      <p class="row"><button id="d-sit" type="button"></button><button id="d-flip" type="button">⇄ Other side</button><button id="d-remove" type="button">Remove pin</button></p>
      <p><a id="d-walk" target="_blank" rel="noopener">Walking directions</a><span id="d-osm-wrap"> · <a id="d-osm" target="_blank" rel="noopener">OpenStreetMap</a></span> <span class="muted" id="d-dist"></span></p>
      <div id="year"><div class="hours">${[6, 9, 12, 15, 18, 21].map((h) => `<span style="top:${((h * 60 - STRIP_FROM) / (STRIP_TO - STRIP_FROM)) * 100}%">${h}</span>`).join("")}</div><canvas width="73" height="72"></canvas><b></b></div>
      <div class="months">${"JFMAMJJASOND".split("").map((c) => `<span>${c}</span>`).join("")}</div>
      <p class="muted">Every fifth day of the year against time of day. Click to jump there.</p>`;
    drawYear(b, el.querySelector("canvas"));
    $("d-sit").addEventListener("click", () => {
      state.seated = !state.seated;
      if (state.seated) view.sit(benchById.get(state.selected), state.flipped);
      else view.stand();
      renderDetail();
    });
    $("d-flip").addEventListener("click", () => {
      state.flipped = !state.flipped;
      view.sit(benchById.get(state.selected), state.flipped);
    });
    $("d-remove").addEventListener("click", () => removeSpot(state.selected));
    yearFor = b.id;
  }
  el.querySelector("h3").textContent = b.name;
  $("d-tags").textContent = b.kind === "spot" ? "Dropped pin · saved on this device"
    : b.kind === "pub" ? (b.where === "beer garden" ? "Pub · the mapped outdoor seating" : "Pub · on the pavement out front; any garden isn't mapped")
    : [tags, b.inscription && `“${b.inscription}”`].filter(Boolean).join(" — ");
  $("d-flip").hidden = !(state.seated && (b.kind === "table" || b.kind === "pub"));
  $("d-osm-wrap").hidden = b.kind === "spot";
  $("d-remove").hidden = b.kind !== "spot";
  $("d-big").textContent = `${share}% · ${(row.sunMin / 60).toFixed(1)} h of sun`;
  $("d-now").textContent = `At ${hhmm(state.minutes)}: ${STATE_LABEL[current]}${until}.`;
  $("d-sit").textContent = state.seated ? "↑ Stand up" : "Sit here — see the sun from this seat";
  $("d-walk").href = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lon}&travelmode=walking`;
  $("d-osm").href = `https://www.openstreetmap.org/${b.osm}`;
  $("d-dist").textContent = state.me ? `· ${Math.round(distance(b))} m from you` : "";
  el.querySelector("#year b").style.left = `${($("day").value / 365) * 100}%`;
}

function drawYear(b, canvas) {
  const ctx = canvas.getContext("2d"), cells = [];
  for (let col = 0; col < 73; col++) {
    const date = new Date(Date.UTC(state.y, 0, 1 + col * YEAR_DAYS));
    const suns = sunsFor(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), YEAR_STEP);
    for (let r = 0; r < 72; r++) {
      const s = shadeAt(world, b.x, b.y, b.z, suns[STRIP_FROM / YEAR_STEP + r]);
      cells[col * 72 + r] = s;
      if (s === NIGHT) continue;
      ctx.fillStyle = STATE_COLOR[s];
      ctx.fillRect(col, r, 1, 1);
    }
  }
  const at = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const col = Math.min(72, Math.max(0, Math.floor(((ev.clientX - rect.left) / rect.width) * 73)));
    const r = Math.min(71, Math.max(0, Math.floor(((ev.clientY - rect.top) / rect.height) * 72)));
    return { date: new Date(Date.UTC(state.y, 0, 1 + col * YEAR_DAYS)), minutes: STRIP_FROM + r * YEAR_STEP, s: cells[col * 72 + r] };
  };
  canvas.addEventListener("pointermove", (ev) => {
    const c = at(ev);
    showTip(`${c.date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} · ${hhmm(c.minutes)} · ${STATE_LABEL[c.s]}`, ev);
  });
  canvas.addEventListener("pointerleave", () => showTip(null));
  canvas.addEventListener("click", (ev) => {
    const c = at(ev);
    state.minutes = c.minutes;
    setDate(c.date.getUTCFullYear(), c.date.getUTCMonth() + 1, c.date.getUTCDate());
  });
}

function showTip(text, ev) {
  const tip = $("tip");
  tip.hidden = !text;
  if (!text) return;
  tip.textContent = text;
  tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, ev.clientX + 14)}px`;
  tip.style.top = `${Math.max(8, ev.clientY - 34)}px`;
}

function select(id, fly) {
  if (id !== state.selected) state.flipped = false;
  state.selected = id;
  if (state.seated && !id) {
    state.seated = false;
    view.stand();
  }
  refresh();
  if (id && state.seated) view.sit(benchById.get(id), state.flipped);
  else if (id && fly) view.flyTo(benchById.get(id));
  if (id) $("detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setPlacing(on) {
  state.placing = on;
  view.setPlacing(on);
  $("pin").setAttribute("aria-pressed", on);
  notice(on ? "Tap the ground where you want to sit." : "");
}

function addSpot(point) {
  if (!point) return notice("That's off the edge of the map — tap inside it.");
  const n = Math.max(0, ...places.filter((b) => b.kind === "spot").map((b) => b.n)) + 1;
  const spot = makeSpot({ id: -Date.now(), n, ...point });
  places.push(spot);
  benchById.set(spot.id, spot);
  view.addMarker(spot);
  day.rows.set(spot.id, dayRow(spot, day.suns));
  saveSpots();
  buildList();
  setPlacing(false);
  select(spot.id, false);
}

function removeSpot(id) {
  places.splice(places.findIndex((b) => b.id === id), 1);
  benchById.delete(id);
  day.rows.delete(id);
  saveSpots();
  buildList();
  select(null);
  view.removeMarker(id);
}

function setDate(y, m, d) {
  Object.assign(state, { y, m, d });
  computeDay();
  refresh();
}

// --- geolocation
let watching = null;

function locate() {
  if (!navigator.geolocation) return Promise.reject(new Error("This browser has no geolocation."));
  if (state.me) return Promise.resolve(state.me);
  return new Promise((resolve, reject) => {
    watching ??= navigator.geolocation.watchPosition(({ coords }) => {
      const [gx, gy] = world.geo, dl = coords.longitude - world.lon, dt = coords.latitude - world.lat;
      state.me = { x: gx[0] * dl + gx[1] * dt + gx[2], y: gy[0] * dl + gy[1] * dt + gy[2], accuracy: coords.accuracy };
      view.setUser(state.me);
      refresh();
      resolve(state.me);
    }, (err) => {
      navigator.geolocation.clearWatch(watching);
      watching = null;
      reject(new Error(err.code === err.PERMISSION_DENIED ? "Location permission was refused." : "Couldn't get a location fix."));
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  });
}

function notice(text) {
  $("findnote").textContent = text;
}

/** Nearest seat in the current filter that is in sun at the selected time, preferring ones that stay sunny for half an hour. */
async function findSunny() {
  notice("Finding you…");
  try {
    await locate();
  } catch (err) {
    return notice(err.message);
  }
  const step = state.minutes / STEP;
  const sunny = world.benches.filter((b) => shown(b) && day.rows.get(b.id).states[step] === SUN);
  if (!sunny.length) return notice(`Nothing ${state.where === "pubs" ? "outside a pub " : ""}is in sun at ${hhmm(state.minutes)}.`);
  const lasting = sunny.filter((b) => day.rows.get(b.id).states.subarray(step, step + 30 / STEP).every((s) => s === SUN));
  const best = (lasting.length ? lasting : sunny).reduce((a, b) => (distance(b) < distance(a) ? b : a));
  notice(`${best.name} is ${Math.round(distance(best))} m away${lasting.length ? "" : ", but the sun is about to leave it"}.`);
  select(best.id, true);
}

// --- wiring
view.onPick = (id) => select(id, false);
view.onGround = addSpot;
$("pin").addEventListener("click", () => setPlacing(!state.placing));
view.onHover = (id, ev) => {
  $("view").style.cursor = id ? "pointer" : "";
  if (!id) return showTip(null);
  const b = benchById.get(id), row = day.rows.get(id);
  showTip(`${b.name} · ${Math.round((row.sunMin / (row.dayMin || 1)) * 100)}% today · ${STATE_LABEL[row.states[state.minutes / STEP]]}`, ev);
};
view.onCompass = (theta) => ($("compass").firstElementChild.style.transform = `rotate(${theta}rad)`);
$("compass").addEventListener("click", () => view.faceNorth());

$("date").addEventListener("change", (ev) => {
  const [y, m, d] = ev.target.value.split("-").map(Number);
  if (y) setDate(y, m, d);
});
$("day").addEventListener("input", (ev) => {
  const date = new Date(Date.UTC(state.y, 0, 1 + +ev.target.value));
  setDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
});
$("time").addEventListener("input", (ev) => {
  state.minutes = +ev.target.value;
  refresh();
});
$("today").addEventListener("click", () => {
  const t = londonNow();
  state.minutes = Math.round(t.minutes / STEP) * STEP % 1440;
  setDate(t.y, t.m, t.d);
});
$("sort").addEventListener("change", async (ev) => {
  state.sort = ev.target.value;
  if (state.sort === "near") await locate().catch((err) => notice(err.message));
  refresh();
});
$("find").addEventListener("click", findSunny);
$("where").addEventListener("change", (ev) => {
  state.where = ev.target.value;
  $("find").textContent = state.where === "pubs" ? "☀ Nearest sunny pint" : "☀ Nearest sunny seat";
  refresh();
});
$("locate").addEventListener("click", () => locate().then(() => notice(""), (err) => notice(err.message)));

let playing = null;
$("play").addEventListener("click", (ev) => {
  const on = !playing;
  ev.currentTarget.setAttribute("aria-pressed", on);
  ev.currentTarget.textContent = on ? "❚❚ Pause" : "▶ Play";
  clearInterval(playing);
  playing = on && setInterval(() => {
    state.minutes += STEP;
    if (state.minutes > day.set + 30 || state.minutes < day.rise - 30) state.minutes = Math.max(0, day.rise - 30);
    refresh();
  }, 70);
});

$("axis").innerHTML = [6, 9, 12, 15, 18, 21].map((h) => `<span style="left:${((h * 60 - STRIP_FROM) / (STRIP_TO - STRIP_FROM)) * 100}%">${pad(h)}</span>`).join("");
state.minutes = Math.min(1435, state.minutes);
$("find").textContent = state.where === "pubs" ? "☀ Nearest sunny pint" : "☀ Nearest sunny seat";
computeDay();
refresh();
if (state.selected) view.flyTo(benchById.get(state.selected));
