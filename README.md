# Inn-to-Inn Planner — West Highland Way

A browser-only trip planner for inn-to-inn hiking. Pick how many days you
have and which direction you're walking, and get a stage-by-stage itinerary
for the West Highland Way (Milngavie → Fort William, ~153 km) where every
night ends at real accommodation — on a map, with distance/ascent per day
and a Booking.com link for each option (a direct property page with your
dates prefilled where one's been mapped, an area search otherwise).

Live demo: open `web/index.html` via a local static server (see below).

## How it works

**No backend, no accounts, no build step.** Two halves:

1. **Build pipeline** (`data/build/`, Python, run locally, one-off) — fetches
   OpenStreetMap data via the Overpass API, stitches it into a route with a
   distance axis, projects accommodation onto that axis, and writes static
   JSON to `data/whw/`.
2. **Runtime** (`web/`, plain HTML/CSS/JS) — loads the pre-baked JSON, runs
   the stage-segmentation algorithm in the browser, and renders a Leaflet
   map + itinerary panel. The only network calls at runtime are map tiles
   and outbound Booking.com links.

The segmentation engine (`web/planner.js`) is a pure function — trail data
in, itinerary out — with no knowledge of place names, so it isn't tied to
this one trail. Adding a second trail means re-running the pipeline against
a different route relation, not touching the engine.

## Running the data pipeline

Only needed if you want to regenerate `data/whw/*.json` (already committed
and ready to use as-is).

```bash
pip install -r data/build/requirements.txt

python data/build/fetch_osm.py        # Overpass -> data/raw/ (raw, gitignored)
python data/build/build_route.py      # stitch route -> data/whw/route.json
python data/build/fetch_water.py      # named loch polygons near the route -> data/raw/water_bodies.json
python data/build/build_accommodations.py  # project accommodations -> data/whw/accommodations.json
python data/build/export.py           # simplify + validate + minify, writes data/whw/trail.json too
```

Run in that order. `fetch_water.py` needs `route.json` to already exist (it
filters lochs by proximity to the route) and `build_accommodations.py` needs
`water_bodies.json` to exist (for same-shore filtering — see "Known
limitations"). `build_accommodations.py` projects onto whatever's currently
in `data/whw/route.json`, and `export.py` simplifies that same file in place
— so if you only want to refresh accommodations, don't run `export.py`
again without also re-running `build_route.py` first, or you'll project
onto an already-simplified line.

Each stage prints a sanity check: `build_route.py` verifies the stitched
route is ~150–155 km (OSM route relations aren't ordered or consistently
directed — this is stitched by chaining shared endpoint node ids), and
`build_accommodations.py` checks that known clusters (Drymen, Rowardennan,
Tyndrum, Kingshouse, Kinlochleven) landed near their expected km.

## Running the web app

Serve `web/` (and the sibling `data/`) over HTTP — opening `index.html`
directly via `file://` will fail because browsers block `fetch()` of local
JSON under the file protocol.

```bash
python -m http.server 8000
# then open http://localhost:8000/web/index.html
```

## Segmentation details worth knowing

- **Global optimization, not a greedy day-by-day walk.** The planner picks
  all `N - 1` intermediate overnight stops at once, choosing whichever
  combination of real accommodation clusters minimizes the longest stage
  (tie-broken by minimizing variance across all stages). The requested day
  count is always honored exactly — it never inflates or shrinks to fit
  accommodation gaps.
- **Roofed vs. camping.** By default only "roofed" accommodation clusters
  (hotel/guest_house/hostel/bed_and_breakfast/chalet/apartment) are
  candidate stops — check "Include campsites" to let camp_site-only
  clusters compete as normal stops too. With it unchecked, camp_site
  accommodation never appears anywhere in the itinerary, including the
  "passed along the way" list.
- **"Passed along the way."** A stage's card can list nearby accommodation
  clusters it walks past without stopping at — display-only, doesn't
  change the day structure. This is how the itinerary stays honest about
  real options (e.g. Inversnaid Hotel) that the chosen split doesn't happen
  to use for a given day count.
- **Balance warning.** If the best possible split for the requested day
  count still leaves a stage under 5 km or over 35 km (accommodation is
  just spaced unevenly there), the plan is still returned as requested,
  with a note suggesting a nearby day count that balances better.
- **Same-shore filtering.** `build_accommodations.py` won't match an
  accommodation to a route point if the straight line between them crosses
  a lake — otherwise a west-shore Loch Lomond guesthouse could get matched
  to an east-shore trail point across the water.
- **Per-trail config, not hardcoded UI values.** `data/whw/trail.json`
  (written by `export.py`) holds the trail's name, total distance, and the
  days slider's min/max — the frontend reads this instead of hardcoding a
  range, so a second trail is a new `data/<trail>/` directory plus this
  config, not a code change.

## Booking links

Each accommodation resolves to one of three link types, in this priority
order (`web/planner.js`'s `buildAccommodationLink`):

1. **Direct property page** ("Check availability →") — if
   `data/whw/booking_urls.json` has a curated `booking_url` for that
   accommodation's OSM id, link straight there with `checkin`/`checkout`/
   `group_adults=2` appended.
2. **Property website** ("Visit website →") — if the mapping confirms the
   property isn't on Booking.com (`booking_url: null`) but OSM has a
   `website`/`contact:website` tag, link there instead.
3. **Area search** ("Search area →") — the same coordinate-anchored
   Booking.com search used everywhere else, as the final fallback.

`booking_urls.json` is hand-curated, not scraped. `python
data/build/init_booking_urls.py` pre-populates a row for every roofed
accommodation, keyed by `osm_id` (stable; names aren't), each with a
`_comment` carrying everything needed to curate it right there — name,
type, approximate place, and a search link to click through — so there's
no separate worklist file to cross-reference. Click the search link, find
the matching property on Booking.com, and paste its URL into that row's
`booking_url`. `_comment` is regenerated context, not something to
hand-edit — re-running the script refreshes it but leaves any `booking_url`
you've already filled in untouched (merges into the existing file rather
than overwriting it, so re-running after new accommodation data lands
never clobbers curation already done).

`booking_url` has three meaningful states, all logged as a gap except the
middle one: an entirely missing key or `""` (pre-populated, not yet
filled in) both mean "not curated yet"; `null` means checked and confirmed
the property has no Booking.com listing (a deliberate answer, not a gap —
triggers the website fallback instead).

## Known limitations

- **One trail.** This is a West Highland Way MVP, not a multi-trail product.
- **OpenStreetMap is the only accommodation source.** Coverage is
  community-sourced and incomplete — see the in-app footer for a link to
  add missing places on osm.org. A few OSM `name` tags are informal (e.g.
  campsite notes), which occasionally surfaces odd-looking entries.
- **Same-shore filtering only covers named lochs the pipeline actually
  fetched** (`fetch_water.py` — currently Loch Lomond and Loch Tulla, the
  only two large enough and close enough to the WHW to plausibly cause a
  cross-shore false match). Straight-line distance to a route point can
  still cross a smaller or unnamed body of water this pipeline didn't fetch.
- **No live availability, even for direct links.** Direct property links
  and the area-search fallback both take you to Booking.com to check real
  availability — this app has no idea what's actually bookable. The area
  search fallback is coordinate-anchored
  (`?ss=<name>&dest_type=latlong&latitude=...&longitude=...`), not a
  property page — bare name-only searches were tested and found unreliable
  for small hamlets (`ss=Kingshouse` silently resolved to an unrelated
  place near Lochearnhead, ~30 km from the real Kingshouse Hotel).
- **The direct-link mapping is only as complete as the manual curation.**
  `booking_urls.json` starts empty; until it's filled in via the worklist
  (see "Booking links" above), every accommodation falls back to its OSM
  website or an area search.
- **No accounts, no GPX export, no server.**
- **Elevation is best-effort.** Sampled from the Open-Elevation API at
  roughly one point per 200 m of trail; ascent is a reasonable estimate,
  not a survey-grade figure.
- **The days slider allows 4, which this trail can't satisfy realistically**
  (153 km / 4 days averages ~38 km/day, over the 35 km/day sanity
  threshold) — the app shows a graceful error suggesting a valid day range
  instead of a bad itinerary. This is intentional (see "Graceful failures"
  in the segmentation design), not a bug.
- **The requested day count is always honored exactly.** If accommodation
  is spaced unevenly enough that even the best split has an awkward stage,
  the plan still comes back at the requested length, with a note
  suggesting a better-balanced day count instead — see "Balance warning"
  above.

## Attribution

Route and accommodation data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
ODbL. Map tiles by [OpenTopoMap](https://opentopomap.org), CC-BY-SA.
Elevation via [Open-Elevation](https://www.open-elevation.com/).
