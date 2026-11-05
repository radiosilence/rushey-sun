# rushey-sun

3D sun and shadow simulation of Catford, Ladywell, Brockley, Honor Oak and Lewisham, for finding the bench or the pub garden that is actually in the sun. A sibling of [bpp-sun](https://github.com/radiosilence/bpp-sun), which does the same for Beckenham Place Park.

https://radiosilence.github.io/rushey-sun/

Drag the map, scrub the date and time, and the shadows move. Seats in direct sun glow; the list ranks them by share of daylight spent in sun, and can be narrowed to one park or to pubs. Selecting a bench shows its whole year, and *Sit here* drops the camera to eye height facing the way the bench faces, so you can scrub time and see whether the sun is in your eyes. At a picnic table you can swap sides. With location allowed, it finds the nearest bench that is sunny now and will stay so for half an hour.

## Why it is built this way

**Shadows come from LIDAR, not from modelled trees.** The Environment Agency's 1m first-return surface model contains every real crown and roof, so a ray marched across it gives shadows for the trees that exist rather than for cones placed at guessed positions. Everything you see standing up in the 3D view is decoration and casts nothing: tree meshes are seeded from canopy peaks with crown spread from a watershed of the canopy, and buildings are a Delaunay mesh of each OSM footprint lifted to the LIDAR surface, which is where the roof pitches come from.

**One march, two implementations.** The ground shadows are a GLSL pass over the surface model, rerun when the sun moves. Seat statistics use the same march in JS (`shadeAt`), because ~140 seats × 288 five-minute steps is trivial on the CPU and avoids GPU readback. The two must stay in step; both live next to a comment saying so.

**No precomputed results.** Any date is computed in the browser on demand, so the shipped data is just three height layers (~12MB gzipped for 2.95 × 3.2 km) and a scene JSON.

**Heights are packed for size.** Ground is stored in 5cm steps with a plane predictor (left + up − upper-left), and the surface as centimetres above ground, which is zero over open ground and so compresses to almost nothing there. That is a third smaller than raw centimetres, and ±2.5cm is lost inside a 1m cell.

**Crowns have an underside.** A plain 2.5D surface treats a tree as a solid column to the ground, which wrongly shades every bench beside a trunk at low sun. Each canopy cell carries an estimated crown-base height (40% of the local canopy height), and rays may travel beneath it.

**Every bench in the extent, not just park benches.** Rushey Green is a high street, so benches are grouped by the named park they sit in, else the street within 60m. Seats within 60m of the edge are dropped, because shade cast from beyond the LIDAR tile is unknown.

**Pubs are seats.** Every pub gets a seat 1.5m out from the wall nearest a road, facing the street. A pub with a garden gets a second seat, because front and back catch the sun at different times: its mapped `leisure=outdoor_seating` within 30m if there is one, otherwise, for pubs in `GARDENS` (sides taken from CAMRA's listings), the middle of the open ground found by marching away from the road through the back of the building. The march may step over up to 8m of building, because canopies and outbuildings behind pubs are mapped as buildings.

**No build step.** ES modules and an import map; three.js and delaunator come from a CDN. `site/` is deployed as-is.

## Known lies

- LIDAR is flown leaf-off. Crowns are morphologically closed to approximate summer leaf, so **winter tree shade is overstated** — most of this canopy is bare from November to March. Tree shade is reported separately from building/terrain shade for that reason.
- A ray may pass under canopy for 30m before it is assumed blocked by trunks and understorey. That number is a judgement, not a measurement.
- Drawn roofs are LIDAR clamped between an estimated eave and the footprint's 90th-percentile height, because overhanging trees otherwise spike them. Wall and roof colours are arbitrary. This affects the picture only; shadows use the raw surface. The Catford Cat is drawn from primitives and casts nothing.
- In the seated view the sun can appear through a gap in the decorative trees while the bench reads as tree-shaded, or the reverse. The readout is the computed answer; the picture is not.
- Movable furniture and pub tables are wherever someone last mapped them, or guessed as above. An estimated garden seat is a point in the right yard, not the table you would pick; a covered garden reads as building shade because the canopy is in the LIDAR. Rather than chase that, **Pin** analyses any tapped spot exactly like a bench; pins live in `localStorage`, not in the data.
- Bench positions and orientation come from OSM. Unmapped benches don't exist here, and benches without a `direction` tag are drawn facing the nearest path.
- Direct-beam geometry only: no cloud, no diffuse light.
- Solar position is the low-precision Meeus series, good to a fraction of a degree.

## Data

```
mise run data    # fetch LIDAR + OSM into pipeline/raw, write site/data
mise run serve   # http://localhost:8765
```

`pipeline/build.py` is a PEP 723 script; `uv` resolves its dependencies. Raw downloads are cached in `pipeline/raw/` and not committed. To cover a different area, change the extent and the Overpass bbox at the top of the script; every named `leisure=park` inside is picked up.

Coordinates are local metres on the British National Grid from the extent's south-west corner. Solar azimuths are rotated by the grid convergence (−1.54° here) before use. GPS fixes are placed with an affine fit emitted by the pipeline (≤20cm error over the extent), which saves shipping a projection library.

## Attribution

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) — LIDAR Composite DSM/DTM © Environment Agency. Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
