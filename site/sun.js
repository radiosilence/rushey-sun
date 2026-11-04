// Solar position after Meeus via the suncalc formulation; good to a fraction of a degree, which is
// well inside the error of a 1m surface model.
const rad = Math.PI / 180;
const DAY_MS = 864e5;
const OBLIQUITY = rad * 23.4397;

/** Azimuth clockwise from true north and altitude, both radians. */
export function sunPosition(ms, lat, lon) {
  const d = ms / DAY_MS - 0.5 + 2440588 - 2451545;
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));
  const phi = rad * lat;
  const hourAngle = rad * (280.16 + 360.9856235 * d) + rad * lon - ra;
  return {
    azimuth: Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI,
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle)),
  };
}

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
});

function londonFields(ms) {
  const f = Object.fromEntries(londonParts.formatToParts(ms).map((p) => [p.type, +p.value]));
  return { y: f.year, m: f.month, d: f.day, minutes: f.hour * 60 + f.minute };
}

/** UTC ms for a London wall-clock time, whatever zone the viewer is in. */
export function londonToUtc(y, m, d, minutes) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const f = londonFields(guess);
  return guess - (Date.UTC(f.y, f.m - 1, f.d, 0, f.minutes) - guess);
}

export function londonNow() {
  return londonFields(Date.now());
}
