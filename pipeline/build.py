# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "scikit-image", "rasterio", "shapely", "pyproj"]
# ///
"""Builds site/data from EA LIDAR (DSM/DTM 1m) and OSM. Run: uv run pipeline/build.py"""

import gzip
import json
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio import features
from scipy import ndimage as ndi
from skimage.segmentation import watershed
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, unary_union

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT.parent / "site" / "data"

# British National Grid extent: Honor Oak Park to Lewisham, Ladywell Fields down to Rushey Green, plus ~250m so
# low-sun shadows from outside still land.
E0, N0, E1, N1 = 535650, 173000, 538600, 176200
W, H = E1 - E0, N1 - N0
# Shade from beyond the extent is unknown, so seats nearer the edge than this are left out.
EDGE = 60
# Pub gardens OSM doesn't map, by a substring of the pub's OSM name: which side of the building, relative to the
# nearest road, the garden is on. The seat goes in the open ground found on that side.
# Sides are from CAMRA's pub listings (camra.org.uk/pubs).
GARDENS = {name: "rear" for name in ("Harrow", "Fox & Firkin", "Blythe Hill Tavern", "Catford Bridge Tavern", "Brockley Jack", "Crofton Park Tavern",
                                     "Lawrence Arms", "Jolly Farmer", "Chandos", "Catford House")}
UA = {"User-Agent": "rushey-sun/0.1 (github.com/radiosilence/rushey-sun)"}

WCS = "https://environment.data.gov.uk/spatialdata/{slug}/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId={cov}&format=image/tiff&subset=E({e0},{e1})&subset=N({n0},{n1})"
LIDAR = {
    "dsm": ("lidar-composite-digital-surface-model-first-return-dsm-1m", "df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m"),
    "dtm": ("lidar-composite-digital-terrain-model-dtm-1m", "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m"),
}
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
OSM_QUERY = """[out:json][timeout:120][bbox:51.4385,-0.0510,51.4690,-0.0045];
(nwr["amenity"="bench"];nwr["leisure"="picnic_table"];nwr["natural"="water"];nwr["leisure"="park"];
nwr["amenity"~"^(pub|bar|biergarten)$"];nwr["leisure"="outdoor_seating"];node["tourism"="artwork"]["name"];nwr["landuse"="cemetery"];
way["building"];relation["building"];way["highway"];way["railway"="rail"];
nwr["leisure"~"^(pitch|playground|garden)$"];nwr["amenity"="parking"];nwr["natural"~"^(scrub|sand|beach|grassland|heath)$"];nwr["landuse"~"^(meadow|grass)$"];);out body geom;"""
AREA_KINDS = {"pitch": "pitch", "playground": "play", "garden": "garden", "parking": "parking", "scrub": "scrub", "heath": "scrub",
              "sand": "sand", "beach": "sand", "grassland": "meadow", "meadow": "meadow", "grass": "grass", "cemetery": "meadow"}

to_bng = Transformer.from_crs(4326, 27700, always_xy=True)


def fetch(url, dest, data=None):
    if dest.exists():
        return
    print("fetching", dest.name)
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        dest.write_bytes(r.read())


def local(geom):
    """OSM lat/lon geometry -> local metres (x east, y north from the SW corner)."""
    lon = [p["lon"] for p in geom]
    lat = [p["lat"] for p in geom]
    e, n = to_bng.transform(lon, lat)
    return np.column_stack([np.asarray(e) - E0, np.asarray(n) - N0])


def polygons(el):
    """Outer rings of a way or multipolygon relation as shapely polygons."""
    rings = []
    if el["type"] == "way" and "geometry" in el:
        rings = [el["geometry"]]
    elif el["type"] == "relation":
        rings = [m["geometry"] for m in el["members"] if m.get("role") == "outer" and "geometry" in m]
    out = []
    for ring in rings:
        if len(ring) >= 4 and ring[0] == ring[-1]:
            p = Polygon(local(ring))
            if not p.is_valid:
                p = p.buffer(0)
            if not p.is_empty:
                out.extend(p.geoms if p.geom_type == "MultiPolygon" else [p])
    return out


def rc(poly):
    """Rasterise a local-metre polygon onto the grid (row 0 = north edge)."""
    return features.rasterize([poly], out_shape=(H, W), transform=rasterio.transform.from_origin(0, H, 1, 1), all_touched=True).astype(bool)


def planes(d):
    """Byte-plane split, so gzip sees the mostly-zero high bytes as one long run."""
    d = d.astype(np.uint16)
    return gzip.compress(np.concatenate([(d & 0xFF).astype(np.uint8).ravel(), (d >> 8).astype(np.uint8).ravel()]).tobytes(), 9)


def pack_rows(a):
    """Row-wise delta, as PNG's Sub filter: suits the surface, which jumps at every wall."""
    return planes(np.diff(a.astype(np.int64), axis=1, prepend=0))


def pack_plane(a):
    """Predicts each cell as left + up - upper-left, which leaves near-zero residuals on smooth terrain."""
    a = a.astype(np.int64)
    pred = np.zeros_like(a)
    pred[1:, 1:] = a[1:, :-1] + a[:-1, 1:] - a[:-1, :-1]
    pred[0, 1:] = a[0, :-1]
    pred[1:, 0] = a[:-1, 0]
    return planes(a - pred)


def coords(xy, nd=1):
    return [[round(float(x), nd), round(float(y), nd)] for x, y in xy]


def main():
    RAW.mkdir(exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (slug, cov) in LIDAR.items():
        fetch(WCS.format(slug=slug, cov=cov, e0=E0, e1=E1, n0=N0, n1=N1), RAW / f"{name}.tif")
    for i, endpoint in enumerate(OVERPASS):
        try:
            fetch(endpoint, RAW / "osm.json", data=urllib.parse.urlencode({"data": OSM_QUERY}).encode())
            break
        except OSError as err:
            print(f"  {endpoint}: {err}")
            if i == len(OVERPASS) - 1:
                raise

    dsm = rasterio.open(RAW / "dsm.tif").read(1).astype(np.float32)
    dtm = rasterio.open(RAW / "dtm.tif").read(1).astype(np.float32)
    assert dsm.shape == (H, W) and dsm.min() > -100 and dtm.min() > -100
    osm = json.loads((RAW / "osm.json").read_text())["elements"]
    domain = box(0, 0, W, H)

    parks = [(el["tags"]["name"], p) for el in osm if el.get("tags", {}).get("leisure") == "park" and "name" in el["tags"]
             for p in polygons(el) if p.intersects(domain)]
    seatable = domain.buffer(-EDGE)

    # --- buildings: OSM footprints, LIDAR heights
    chm = np.maximum(dsm - dtm, 0)
    buildings, bmask = [], np.zeros((H, W), bool)
    for el in osm:
        if "building" not in el.get("tags", {}):
            continue
        for p in polygons(el):
            if not p.within(domain):
                continue
            m = rc(p)
            bmask |= m
            h = float(np.percentile(chm[m], 90))
            buildings.append({"p": coords(p.exterior.coords[:-1]), "h": round(max(h, 2.5), 1), "z": round(float(dtm[m].min()), 1), "poly": p})
    bmask = ndi.binary_dilation(bmask, iterations=1)

    # --- canopy: LIDAR is flown leaf-off, so crowns are porous; close the holes for a leaf-on surface.
    veg = np.where(bmask, 0, chm)
    tall = ndi.maximum_filter(veg, size=7)
    tree = (tall >= 6) & (veg >= 2) & ~bmask
    closed = ndi.grey_closing(veg, size=5)
    tree |= (closed >= 2) & (tall >= 6) & ~bmask
    # Sub-60cm returns outside trees are grass and sensor noise; at low sun they'd speckle the ground with shadow.
    top = np.where(tree, dtm + closed, np.where(bmask | (chm >= 0.6), dsm, dtm))
    # Crown underside: sun gets in under open-grown trees at low angles, which a plain 2.5D surface can't show.
    under = np.where(tree, np.minimum(0.4 * tall, np.maximum(closed - 1, 0)), 0)
    under_q = np.clip(np.round(under * 4), 0, 255).astype(np.uint8)
    under_q[tree & (under_q == 0)] = 1

    # --- trees for display: crown tops from the smoothed canopy
    sm = ndi.gaussian_filter(np.where(tree, closed, 0), 1.5)
    peaks = (sm == ndi.maximum_filter(sm, size=9)) & (sm >= 5)
    rows, cols = np.nonzero(peaks)
    # Crown spread from a watershed of the canopy around each peak, so an oak and a birch don't draw alike.
    markers = np.zeros((H, W), np.int32)
    markers[rows, cols] = np.arange(1, len(rows) + 1)
    crowns = watershed(-sm, markers, mask=tree & (sm >= 2))
    area = np.bincount(crowns.ravel(), minlength=len(rows) + 1)[1:]
    radius = np.clip(np.sqrt(area / np.pi), 1.5, 11)
    trees = [[int(c), int(H - 1 - r), round(float(sm[r, c]), 1), round(float(rad), 1)] for r, c, rad in zip(rows, cols, radius)]

    # --- benches, pubs, basemap vectors
    walkable = [LineString(local(el["geometry"])) for el in osm if el["type"] == "way" and "highway" in el.get("tags", {}) and "geometry" in el]
    ROAD_KINDS = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "pedestrian"}
    named_roads = [(el["tags"]["name"], LineString(local(el["geometry"]))) for el in osm if el["type"] == "way" and "geometry" in el
                   and el.get("tags", {}).get("highway") in ROAD_KINDS and "name" in el["tags"]]
    roads = [line for name, line in named_roads] + [LineString(local(el["geometry"])) for el in osm if el["type"] == "way" and "geometry" in el
                                                    and el.get("tags", {}).get("highway") in ROAD_KINDS and "name" not in el["tags"]]

    def place_name(pt):
        """The park a seat is in, else the street it is on."""
        for name, poly in parks:
            if poly.buffer(10).contains(pt):
                return name
        name, line = min(named_roads, key=lambda r: r[1].distance(pt))
        return name if line.distance(pt) < 60 else None
    CARDINALS = {c: i * 22.5 for i, c in enumerate("N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())}

    def facing(x, y, tag):
        """Degrees clockwise from north that a sitter faces: the OSM tag, else toward the nearest path."""
        if tag:
            try:
                return float(CARDINALS.get(tag.upper(), tag))
            except ValueError:
                pass
        pt = Point(x, y)
        line = min(walkable, key=pt.distance)
        if line.distance(pt) > 20 or line.distance(pt) < 0.05:
            return 180.0
        near = line.interpolate(line.project(pt))
        return float(np.degrees(np.arctan2(near.x - x, near.y - y)) % 360)

    from_bng = Transformer.from_crs(27700, 4326, always_xy=True)
    benches = []
    for el in osm:
        t = el.get("tags", {})
        kind = "bench" if t.get("amenity") == "bench" else "table" if t.get("leisure") == "picnic_table" else None
        if not kind or el["type"] != "node" or t.get("access") == "private":
            continue
        x, y = local([el])[0]
        if not seatable.contains(Point(x, y)):
            continue
        benches.append({"id": el["id"], "osm": f"node/{el['id']}", "kind": kind, "g": place_name(Point(x, y)), "x": round(float(x), 1), "y": round(float(y), 1),
                        "lat": el["lat"], "lon": el["lon"], "f": round(facing(x, y, t.get("direction")), 1),
                        **{k: t[k] for k in ("backrest", "material", "seats", "inscription") if k in t}})

    # Pubs: the mapped beer garden or outdoor seating if there is one, else the pavement out front.
    def centre(el):
        return Point(local([el])[0]) if el["type"] == "node" else unary_union(polygons(el)).representative_point()

    seating = [(el, centre(el)) for el in osm if el.get("tags", {}).get("leisure") == "outdoor_seating"]

    def open_ground(home, side):
        """A seat in the open ground on one side of a building: (point, facing), or None if it is built up."""
        wall, kerb = nearest_points(home.exterior, min(roads, key=home.distance))
        ax, ay = kerb.x - wall.x, kerb.y - wall.y
        base = np.arctan2(ax, ay) + {"front": 0, "rear": np.pi, "left": np.pi / 2, "right": -np.pi / 2}[side]
        c = home.centroid
        for turn in (0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3):
            a = base + turn
            dx, dy = np.sin(a), np.cos(a)
            t0 = next((t for t in np.arange(0, 80, 0.5) if not home.contains(Point(c.x + dx * t, c.y + dy * t))), None)
            if t0 is None:
                continue
            # Canopies and outbuildings behind a pub are mapped as buildings, so up to 8m of them can be stepped over.
            start = run = None
            for t in np.arange(t0 + 1.5, t0 + 40, 0.5):
                x, y = c.x + dx * t, c.y + dy * t
                if not (0 <= x < W and 0 <= y < H):
                    break
                if bmask[H - 1 - int(y), int(x)]:
                    if start is not None or t - t0 > 8:
                        break
                    continue
                start = t if start is None else start
                run = t - start
            if run is not None and run >= 3:
                d = start + min(run / 2, 8)
                # Back to the pub wall.
                return Point(c.x + dx * d, c.y + dy * d), float(np.degrees(a) % 360)
        return None
    used = set()
    for el in osm:
        t = el.get("tags", {})
        if t.get("amenity") not in ("pub", "bar", "biergarten") or "name" not in t:
            continue
        at = centre(el)
        home = next((b["poly"] for b in buildings if b["poly"].buffer(2).contains(at)), None)
        near = at if home is None else home
        mapped = min(((s, p) for s, p in seating if p.distance(near) < 30), key=lambda sp: sp[1].distance(at), default=None)
        side = next((v for k, v in GARDENS.items() if k in t["name"]), None)
        seats = []
        if home is None:
            seats.append((at, "out front", facing(at.x, at.y, None)))
        else:
            wall, kerb = nearest_points(home.exterior, min(roads, key=home.distance))
            d = max(wall.distance(kerb), 1e-6)
            step = min(1.5, d / 2) / d
            spot = Point(wall.x + (kerb.x - wall.x) * step, wall.y + (kerb.y - wall.y) * step)
            seats.append((spot, "out front", float(np.degrees(np.arctan2(kerb.x - wall.x, kerb.y - wall.y)) % 360)))
        # A garden is a second seat: front and back catch the sun at different times of day.
        if mapped:
            used.add(mapped[0]["id"])
            spot = mapped[1]
            # Back to the pub wall.
            f = float(np.degrees(np.arctan2(spot.x - home.centroid.x, spot.y - home.centroid.y)) % 360) if home else 180.0
            seats.append((spot, "beer garden", f))
        elif home is not None and side and (yard := open_ground(home, side)):
            seats.append((yard[0], "garden", yard[1]))
        base = el["id"] if el["type"] == "node" else 10**12 + el["id"]
        for n, (spot, where, f) in enumerate(seats):
            if not seatable.contains(spot):
                continue
            lon_, lat_ = from_bng.transform(spot.x + E0, spot.y + N0)
            benches.append({"id": base + n * 3 * 10**12, "osm": f"{el['type']}/{el['id']}", "kind": "pub", "name": t["name"] + (" garden" if where != "out front" else ""),
                            "where": where, "x": round(spot.x, 1), "y": round(spot.y, 1), "lat": round(lat_, 7), "lon": round(lon_, 7), "f": round(float(f), 1)})
    for el, spot in seating:
        if el["id"] in used or not seatable.contains(spot):
            continue
        lon_, lat_ = from_bng.transform(spot.x + E0, spot.y + N0)
        benches.append({"id": 2 * 10**12 + el["id"], "osm": f"{el['type']}/{el['id']}", "kind": "table", "g": place_name(spot), "where": "outdoor seating",
                        "x": round(spot.x, 1), "y": round(spot.y, 1), "lat": round(lat_, 7), "lon": round(lon_, 7), "f": 180.0})

    labels = []
    for name in dict.fromkeys(n for n, _ in parks):
        biggest = max((p for n, p in parks if n == name), key=lambda p: p.intersection(domain).area)
        at = biggest.intersection(domain).representative_point()
        labels.append({"t": name, "k": "park", "x": round(at.x, 1), "y": round(at.y, 1)})
    for el in osm:
        t = el.get("tags", {})
        if t.get("tourism") == "artwork" and "Cat" in t.get("name", "") and el["type"] == "node":
            x, y = local([el])[0]
            labels.append({"t": t["name"], "k": "art", "x": round(float(x), 1), "y": round(float(y), 1)})
    for b in buildings:
        del b["poly"]

    water = [coords(p.exterior.coords[:-1]) for el in osm if el.get("tags", {}).get("natural") == "water" for p in polygons(el) if p.intersects(domain)]
    areas = []
    for el in osm:
        t = el.get("tags", {})
        kind = AREA_KINDS.get(t.get("leisure") or t.get("amenity") or t.get("natural") or t.get("landuse"))
        if kind and "building" not in t:
            areas += [{"k": kind, "p": coords(p.exterior.coords[:-1])} for p in polygons(el) if p.intersects(domain)]
    PATHS = {"footway", "path", "cycleway", "track", "steps", "pedestrian", "bridleway"}
    lines = []
    for el in osm:
        t = el.get("tags", {})
        if el["type"] != "way" or "geometry" not in el or not ("highway" in t or "railway" in t):
            continue
        xy = local(el["geometry"])
        if not LineString(xy).intersects(domain):
            continue
        kind = "rail" if "railway" in t else "path" if t["highway"] in PATHS else "service" if t["highway"] == "service" else "road"
        lines.append({"k": kind, "p": coords(xy)})

    # Grid north vs true north, so solar azimuths can be rotated onto the grid.
    ce, cn = E0 + W / 2, N0 + H / 2
    lon, lat = Transformer.from_crs(27700, 4326, always_xy=True).transform(ce, cn)
    e2, n2 = to_bng.transform(lon, lat + 0.01)
    convergence = float(np.degrees(np.arctan2(e2 - ce, n2 - cn)))

    # Affine lon/lat -> local metres, so the browser can place a GPS fix without a projection library.
    # Over this extent the fit is good to ~20cm, far inside GPS error.
    gl, gt = np.meshgrid(np.linspace(lon - 0.015, lon + 0.015, 9), np.linspace(lat - 0.009, lat + 0.009, 9))
    ge, gn = to_bng.transform(gl.ravel(), gt.ravel())
    A = np.column_stack([gl.ravel() - lon, gt.ravel() - lat, np.ones(gl.size)])
    geo = [np.linalg.lstsq(A, v, rcond=None)[0].tolist() for v in (np.asarray(ge) - E0, np.asarray(gn) - N0)]
    resid = max(float(np.abs(A @ np.array(g) - v).max()) for g, v in zip(geo, (np.asarray(ge) - E0, np.asarray(gn) - N0)))
    print(f"geo affine max residual {resid * 1000:.1f} mm")

    # Ground in 5cm steps and the surface as cm above ground, which is zero over open ground: a third smaller than
    # raw cm, for ±2.5cm that is lost in 1m cells.
    (OUT / "ground.u16.gz").write_bytes(pack_plane(np.round(dtm * 20)))
    (OUT / "above.u16.gz").write_bytes(pack_rows(np.maximum(np.round(top * 100) - np.round(dtm * 100), 0)))
    (OUT / "under.u8.gz").write_bytes(gzip.compress(under_q.tobytes(), 9))
    scene = {"w": W, "h": H, "origin": [E0, N0], "lat": lat, "lon": lon, "convergence": convergence, "geo": geo,
             "minH": float(dtm.min()), "maxH": float(top.max()),
             "parks": [{"name": n, "p": coords(p.exterior.coords[:-1])} for n, p in parks], "labels": labels, "benches": benches, "buildings": buildings,
             "trees": trees, "water": water, "areas": areas, "lines": lines}
    (OUT / "scene.json").write_text(json.dumps(scene, separators=(",", ":")))
    print(f"{sum(b['kind'] == 'pub' for b in benches)} pubs, {len(benches)} seats, {len(buildings)} buildings, {len(trees)} trees, convergence {convergence:.2f}°")
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name}: {f.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
