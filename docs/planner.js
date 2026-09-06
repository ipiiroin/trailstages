/**
 * Stage segmentation engine for inn-to-inn trail planning.
 *
 * Pure: takes route + accommodations data in, returns an itinerary out.
 * Knows nothing about any specific trail's place names - that's display
 * metadata layered on top by ui.js.
 *
 * Algorithm: choose exactly N-1 intermediate overnight clusters (start and
 * finish are fixed) so that the N resulting stage lengths are as balanced as
 * possible - minimize the longest stage, tie-broken by minimizing variance
 * across all stages. This is a global optimization over the whole trail, not
 * a greedy day-by-day walk, so the requested day count is always honored
 * exactly. Accommodation that a stage happens to pass without stopping at is
 * still surfaced (see `passedAlong` on each stage) rather than silently
 * disappearing.
 */

const CLUSTER_GAP_KM = 1.0;
const MIN_AVG_STAGE_KM = 8;
// Above this, a plan is refused outright rather than attempted - reserved
// for requests too extreme to produce anything useful (e.g. 2 days on this
// trail averages ~76 km/day). 55 sits just above 3 days' 51 km/day average,
// so 3 days is attempted (and gets flagged via STAGE_WARN_MAX_KM below)
// rather than blocked.
const MAX_AVG_STAGE_KM = 55;

// A finished plan with a stage outside this range is still returned (the
// requested day count is never overridden), but flagged with a note
// suggesting a better-balanced day count nearby. 48 sits between 4 days'
// worst-case stage (~43 km, every direction/camping combination) and 3
// days' best-case stage (~54 km) - so 4+ days come back clean and 3 days
// always carries the note.
const STAGE_WARN_MAX_KM = 48;
const STAGE_WARN_MIN_KM = 5;

const ROOFED_TYPES = new Set(["hotel", "guest_house", "hostel", "bed_and_breakfast", "chalet", "apartment"]);

function roofedOptions(cluster) {
  return cluster.options.filter((o) => ROOFED_TYPES.has(o.type));
}

function clusterHasRoofed(cluster) {
  return cluster.options.some((o) => ROOFED_TYPES.has(o.type));
}

function displayOptions(cluster, includeCamping) {
  return includeCamping ? cluster.options : roofedOptions(cluster);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Group accommodations into clusters ("villages") - maximal runs where
 * consecutive points are within CLUSTER_GAP_KM of each other. */
function clusterAccommodations(accommodations, gapKm = CLUSTER_GAP_KM) {
  const sorted = [...accommodations].sort((a, b) => a.km - b.km);
  const groups = [];
  let currentGroup = null;
  let prevKm = null;

  for (const acc of sorted) {
    if (currentGroup && acc.km - prevKm <= gapKm) {
      currentGroup.push(acc);
    } else {
      currentGroup = [acc];
      groups.push(currentGroup);
    }
    prevKm = acc.km;
  }

  return groups.map((group) => ({
    km: group.reduce((sum, a) => sum + a.km, 0) / group.length,
    options: group,
  }));
}

/** Sum of positive elevation deltas between fromKm and toKm, walked in the
 * order routePoints is given in. Returns null if too few elevation samples
 * fall in range to say anything meaningful. */
function computeAscent(routePoints, fromKm, toKm) {
  const elePoints = routePoints.filter(
    (p) => p.km >= fromKm - 1e-9 && p.km <= toKm + 1e-9 && typeof p.ele === "number"
  );
  if (elePoints.length < 2) return null;

  let ascent = 0;
  for (let i = 1; i < elePoints.length; i++) {
    const delta = elePoints[i].ele - elePoints[i - 1].ele;
    if (delta > 0) ascent += delta;
  }
  return Math.round(ascent);
}

/** Clusters eligible as overnight stops: always roofed, plus camp_site-only
 * clusters when includeCamping is checked. A cluster with both kinds is
 * eligible either way (its camping options just won't be shown/booked
 * unless includeCamping is on - see displayOptions). */
function candidatePool(clusters, includeCamping) {
  return clusters.filter(
    (c) => clusterHasRoofed(c) || (includeCamping && c.options.some((o) => o.type === "camp_site"))
  );
}

function rangeInclusive(a, b) {
  const out = [];
  for (let x = a; x <= b; x++) out.push(x);
  return out;
}

/**
 * Choose exactly `totalStages` - 1 interior points from `points` (points[0]
 * and points[last] are fixed as the start and finish) to split the line
 * into `totalStages` segments, minimizing the longest segment and, among
 * partitions tied on that, minimizing the variance of segment lengths.
 *
 * Two-phase DP: phase 1 finds the minimum achievable "longest segment"
 * (classic minimize-the-maximum-partition DP). Phase 2 re-runs the same
 * partition DP but restricted to edges no longer than that optimum, this
 * time minimizing sum-of-squared segment lengths (equivalent to minimizing
 * variance, since the total distance covered is fixed regardless of which
 * points are chosen). Cluster counts on this trail are small (tens, not
 * thousands) so an O(stages * points^2) DP is simple and fast enough -
 * readability wins over a cleverer single-pass approach.
 */
function findBestPartition(points, totalStages) {
  const n = points.length;
  const lastIdx = n - 1;
  if (totalStages < 1 || totalStages > lastIdx) return null;

  const INF = Infinity;
  const EPS = 1e-6;

  const dp1 = Array.from({ length: totalStages + 1 }, () => new Array(n).fill(INF));
  dp1[0][0] = 0;

  for (let k = 1; k <= totalStages; k++) {
    const ends = k === totalStages ? [lastIdx] : rangeInclusive(1, lastIdx - 1);
    for (const i of ends) {
      for (let j = 0; j < i; j++) {
        if (dp1[k - 1][j] === INF) continue;
        const segLen = points[i] - points[j];
        const candidateMax = Math.max(dp1[k - 1][j], segLen);
        if (candidateMax < dp1[k][i] - 1e-9) dp1[k][i] = candidateMax;
      }
    }
  }

  const bestMax = dp1[totalStages][lastIdx];
  if (bestMax === INF) return null;

  const dp2 = Array.from({ length: totalStages + 1 }, () => new Array(n).fill(INF));
  const parent2 = Array.from({ length: totalStages + 1 }, () => new Array(n).fill(-1));
  dp2[0][0] = 0;

  for (let k = 1; k <= totalStages; k++) {
    const ends = k === totalStages ? [lastIdx] : rangeInclusive(1, lastIdx - 1);
    for (const i of ends) {
      for (let j = 0; j < i; j++) {
        if (dp2[k - 1][j] === INF) continue;
        const segLen = points[i] - points[j];
        if (segLen > bestMax + EPS) continue;
        const candidateSumSq = dp2[k - 1][j] + segLen * segLen;
        if (candidateSumSq < dp2[k][i] - 1e-9) {
          dp2[k][i] = candidateSumSq;
          parent2[k][i] = j;
        }
      }
    }
  }

  const pathIdx = [lastIdx];
  let curK = totalStages;
  let curI = lastIdx;
  while (curK > 0) {
    const j = parent2[curK][curI];
    pathIdx.push(j);
    curI = j;
    curK--;
  }
  pathIdx.reverse();

  return { pathIdx, maxStage: bestMax };
}

function buildStageObject(dayNumber, fromKm, toKm, fromRealKm, cluster, walkRoute, includeCamping, passedAlong) {
  return {
    day: dayNumber,
    fromKm: round2(fromKm),
    toKm: round2(toKm),
    distanceKm: round2(toKm - fromKm),
    ascentM: computeAscent(walkRoute, fromKm, toKm),
    fromRealKm: round2(fromRealKm),
    endRealKm: round2(cluster.realKm),
    accommodations: displayOptions(cluster, includeCamping).map((o) => ({
      name: o.name,
      type: o.type,
      offRouteM: o.off_route_m,
      lat: o.lat,
      lon: o.lon,
      km: o.km,
      website: o.website || null,
      osmId: o.osm_id || null,
    })),
    passedAlong: passedAlong.flatMap((c) =>
      displayOptions(c, includeCamping).map((o) => ({
        name: o.name,
        type: o.type,
        offRouteM: o.off_route_m,
        lat: o.lat,
        lon: o.lon,
        km: o.km,
        website: o.website || null,
        osmId: o.osm_id || null,
      }))
    ),
  };
}

/** Build a plan for an exact day count, or an error if that day count isn't
 * achievable with the current candidate pool. Returns maxStage/minStage/
 * stdDev alongside the stages so callers can judge how balanced it is. */
function buildPlanForDays(clusters, walkRoute, totalKm, days, includeCamping, reverse) {
  const pool = candidatePool(clusters, includeCamping);
  if (pool.length === 0) {
    return { error: "No accommodation available on this trail with the current settings." };
  }

  const finishCluster = pool[pool.length - 1];
  const intermediates = pool.slice(0, -1);
  const maxFeasibleDays = intermediates.length + 1;
  if (days > maxFeasibleDays) {
    return {
      error:
        `Only ${maxFeasibleDays} distinct overnight stop(s) are available with the current settings - ` +
        `${days} days isn't possible. Try ${maxFeasibleDays} or fewer` +
        (includeCamping ? "." : ", or include campsites for more options."),
    };
  }

  const points = [0, ...intermediates.map((c) => c.km), finishCluster.km];
  const partition = findBestPartition(points, days);
  if (!partition) {
    return { error: `Could not find a valid ${days}-day split of the available accommodation.` };
  }

  const stages = [];
  const distances = [];
  for (let d = 1; d <= days; d++) {
    const fromIdx = partition.pathIdx[d - 1];
    const toIdx = partition.pathIdx[d];
    const fromKm = points[fromIdx];
    const toKm = points[toIdx];
    const cluster = toIdx === points.length - 1 ? finishCluster : intermediates[toIdx - 1];
    const fromRealKm = reverse ? totalKm - fromKm : fromKm;

    const passedAlong = pool.filter((c) => c.km > fromKm + 1e-6 && c.km < toKm - 1e-6);

    stages.push(buildStageObject(d, fromKm, toKm, fromRealKm, cluster, walkRoute, includeCamping, passedAlong));
    distances.push(toKm - fromKm);
  }

  const maxStage = Math.max(...distances);
  const minStage = Math.min(...distances);
  const mean = totalKm / days;
  const variance = distances.reduce((s, d) => s + (d - mean) ** 2, 0) / days;
  const stdDev = Math.sqrt(variance);

  return { days: stages, maxStage, minStage, stdDev };
}

/** Among nearby day counts, find the one with the best-balanced result
 * (smallest longest stage, tie-broken by smallest stdDev) - used only to
 * populate a suggestion note, never to override the requested day count. */
function suggestBetterDayCount(clusters, walkRoute, totalKm, days, includeCamping, reverse, maxFeasibleDays) {
  const candidateDays = [days - 1, days + 1, days + 2].filter((d) => d >= 1 && d <= maxFeasibleDays && d !== days);
  let best = null;
  for (const d of candidateDays) {
    const result = buildPlanForDays(clusters, walkRoute, totalKm, d, includeCamping, reverse);
    if (result.error) continue;
    const better =
      !best ||
      result.maxStage < best.maxStage - 1e-9 ||
      (Math.abs(result.maxStage - best.maxStage) < 1e-9 && result.stdDev < best.stdDev);
    if (better) best = { days: d, maxStage: result.maxStage, stdDev: result.stdDev };
  }
  return best;
}

/**
 * @param {Object} input
 * @param {Array<{lat:number, lon:number, km:number, ele?:number}>} input.route
 * @param {Array<{name:string, type:string, km:number, lat:number, lon:number, off_route_m:number, website?:string}>} input.accommodations
 * @param {number} input.days
 * @param {"forward"|"reverse"} [input.direction]
 * @param {boolean} [input.includeCamping] - allow camp_site-only clusters as normal overnight stops
 * @returns {{days: Array<Object>, totalKm: number, direction: string, note?: string} | {error: string}}
 */
function planTrip({ route, accommodations, days, direction = "forward", includeCamping = false }) {
  if (!route || route.length < 2) {
    return { error: "Route data is missing or too short." };
  }
  if (!Number.isInteger(days) || days < 1) {
    return { error: "Days must be a positive whole number." };
  }

  const totalKm = route[route.length - 1].km;
  const reverse = direction === "reverse";

  const naiveAvg = totalKm / days;
  if (naiveAvg > MAX_AVG_STAGE_KM || naiveAvg < MIN_AVG_STAGE_KM) {
    const minDays = Math.ceil(totalKm / MAX_AVG_STAGE_KM);
    const maxDays = Math.floor(totalKm / MIN_AVG_STAGE_KM);
    return {
      error:
        `${days} day(s) gives an average of ${naiveAvg.toFixed(1)} km/day, ` +
        `which isn't realistic for inn-to-inn hiking. Try between ${minDays} and ${maxDays} days.`,
    };
  }

  // Re-express route and clusters in "walk order": km ascends 0 -> totalKm
  // in the direction the person is actually walking, so the same algorithm
  // and ascent math work for both directions.
  const walkRoute = reverse
    ? [...route].reverse().map((p) => ({ ...p, km: round2(totalKm - p.km) }))
    : route;

  const clusters = clusterAccommodations(accommodations)
    .map((c) => ({ realKm: c.km, km: reverse ? totalKm - c.km : c.km, options: c.options }))
    .sort((a, b) => a.km - b.km);

  const plan = buildPlanForDays(clusters, walkRoute, totalKm, days, includeCamping, reverse);
  if (plan.error) return plan;

  const outOfRange = plan.maxStage > STAGE_WARN_MAX_KM + 1e-9 || plan.minStage < STAGE_WARN_MIN_KM - 1e-9;
  let note;
  if (outOfRange) {
    const maxFeasibleDays = candidatePool(clusters, includeCamping).length;
    const suggestion = suggestBetterDayCount(clusters, walkRoute, totalKm, days, includeCamping, reverse, maxFeasibleDays);
    const stageDesc =
      plan.maxStage > STAGE_WARN_MAX_KM ? `a ${plan.maxStage.toFixed(1)} km stage` : `a ${plan.minStage.toFixed(1)} km stage`;
    note = suggestion
      ? `This plan still has ${stageDesc} given how accommodation is spaced along the trail - ${suggestion.days} days would balance it better.`
      : `This plan still has ${stageDesc} given how accommodation is spaced along the trail.`;
  }

  return { days: plan.days, totalKm: round2(totalKm), direction, ...(note ? { note } : {}) };
}

/** Add `days` (integer, may be negative) to an ISO date string, in UTC to avoid
 * local-timezone off-by-one errors. */
function addDaysISO(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// CJ (Commission Junction) click-tracking redirect for the Booking.com
// affiliate program. Every outbound Booking.com link - property-level or
// search fallback - must be wrapped in this so clicks are attributed.
// Deliberately only the clean canonical inner URL plus our own date params
// go in; no label=/sid=/aid= scraped from a live session.
const CJ_CLICK_BASE = "https://www.tkqlhce.com/click-101822414-15734870";

function wrapWithCJ(innerUrl) {
  return `${CJ_CLICK_BASE}?url=${encodeURIComponent(innerUrl)}`;
}

/** Booking.com location search URL (not a property page), wrapped for CJ
 * affiliate tracking. Kept as the one place this URL is built, so any future
 * change to the affiliate wrapping is a one-line change.
 *
 * A bare name-only search (`ss=<name>`) is unreliable for small hamlets:
 * tested live against Booking.com, `ss=Kingshouse` silently resolved to an
 * unrelated Kingshouse near Lochearnhead, ~30km from the real Kingshouse
 * Hotel on Rannoch Moor - wrong-location results, not "no results". Adding
 * `dest_type=latlong` + the accommodation's own lat/lon alongside `ss`
 * anchors the search geographically without dropping the name (which still
 * helps ranking/display) - verified against 5 real WHW accommodations,
 * including fixing that exact Kingshouse case and not regressing places
 * that already worked (Rowardennan, Tyndrum, Fort William). */
function buildBookingUrl(placeName, checkinISO, checkoutISO, lat, lon) {
  const params = new URLSearchParams({
    ss: placeName,
    checkin: checkinISO,
    checkout: checkoutISO,
    dest_type: "latlong",
    latitude: lat,
    longitude: lon,
  });
  const inner = `https://www.booking.com/searchresults.html?${params.toString()}`;
  return wrapWithCJ(inner);
}

/**
 * Resolve the best available link for one accommodation, checking (in
 * order) a manually curated osm_id -> Booking.com property URL mapping,
 * then the property's own website (from OSM contact tags), then the area
 * search fallback above. This is the one place that logic lives, so a
 * future affiliate id is a one-line addition here.
 *
 * `bookingUrls` is the parsed contents of data/whw/booking_urls.json:
 * { "<osm_id>": { booking_url: string|null } }. Two distinct "not a direct
 * link" states:
 *   - key missing entirely: property hasn't been pre-populated at all
 *     (logged - a gap).
 *   - booking_url is falsy (`null`, or `""` the pre-populated placeholder):
 *     no direct Booking.com link on file, whether because it was checked
 *     and confirmed absent or just not filled in yet - treated the same,
 *     not logged - falls back to the property's own website when known.
 *
 * @returns {{url: string, linkType: "direct"|"website"|"search"}}
 */
function buildAccommodationLink(acc, bookingUrls, checkinISO, checkoutISO) {
  const searchFallback = () => ({
    url: buildBookingUrl(acc.name, checkinISO, checkoutISO, acc.lat, acc.lon),
    linkType: "search",
  });

  const entry = acc.osmId ? (bookingUrls || {})[acc.osmId] : undefined;

  if (entry === undefined) {
    console.log(`Booking link: "${acc.name}" (${acc.osmId || "no osm id"}) not yet mapped - using area search fallback.`);
    return searchFallback();
  }

  if (entry.booking_url) {
    try {
      const url = new URL(entry.booking_url);
      url.searchParams.set("checkin", checkinISO);
      url.searchParams.set("checkout", checkoutISO);
      url.searchParams.set("group_adults", "2");
      return { url: wrapWithCJ(url.toString()), linkType: "direct" };
    } catch {
      console.log(`Booking link: malformed booking_url for "${acc.name}" (${acc.osmId}) - using area search fallback.`);
      return searchFallback();
    }
  }

  if (acc.website) {
    return { url: acc.website, linkType: "website" };
  }
  return searchFallback();
}

/** Tiny synthetic-data check, runnable from the browser console as
 * `Planner.selfTest()`. Not a substitute for testing against real trail
 * data, just a fast sanity check on the core segmentation logic. */
function selfTest() {
  const route = [];
  for (let km = 0; km <= 30; km += 1) {
    route.push({ lat: 56 + km * 0.001, lon: -5 + km * 0.001, km, ele: 50 + 10 * Math.sin(km / 3) });
  }
  const accommodations = [
    { name: "Alpha Inn", type: "hotel", km: 9.8, lat: 56.01, lon: -4.99, off_route_m: 100 },
    { name: "Alpha B&B", type: "guest_house", km: 10.1, lat: 56.011, lon: -4.989, off_route_m: 150 },
    { name: "Beta Hostel", type: "hostel", km: 20.2, lat: 56.02, lon: -4.98, off_route_m: 50 },
    { name: "Gamma Lodge", type: "hotel", km: 30, lat: 56.03, lon: -4.97, off_route_m: 0 },
  ];

  const results = [];
  const check = (label, cond) => results.push({ label, pass: !!cond });

  const clusters = clusterAccommodations(accommodations);
  check("clusters 3 groups from 4 points (two within 1km merge)", clusters.length === 3);

  const plan = planTrip({ route, accommodations, days: 3, direction: "forward" });
  check("3-day plan succeeds", !plan.error);
  check("3-day plan has exactly 3 days", plan.days && plan.days.length === 3);
  check("last day ends at total km", plan.days && plan.days[2].toKm === plan.totalKm);
  check("first day starts at 0", plan.days && plan.days[0].fromKm === 0);

  const tooMany = planTrip({ route, accommodations, days: 10, direction: "forward" });
  check("10-day plan on a 30km route (3km/day avg) fails gracefully", !!tooMany.error);

  // Long stretch with a stranded roofed cluster in the middle. The new
  // design must NEVER inflate the day count to rescue it - the requested
  // day count is always honored exactly. With too few days to justify a
  // stop there, it's still visible via passedAlong; with enough days, the
  // optimizer picks it because doing so balances the stages better.
  const longRoute = [];
  for (let km = 0; km <= 65; km += 1) {
    longRoute.push({ lat: 56 + km * 0.001, lon: -5 + km * 0.001, km });
  }
  const strandedAccommodations = [
    { name: "Stranded Hotel", type: "hotel", km: 15, lat: 56.015, lon: -4.985, off_route_m: 0 },
    { name: "Village A", type: "hotel", km: 35, lat: 56.035, lon: -4.965, off_route_m: 0 },
    { name: "Final B", type: "hotel", km: 64, lat: 56.064, lon: -4.936, off_route_m: 0 },
  ];

  const twoDayPlan = planTrip({ route: longRoute, accommodations: strandedAccommodations, days: 2, direction: "forward" });
  check("2-day request returns exactly 2 days, not inflated", twoDayPlan.days && twoDayPlan.days.length === 2);
  check(
    "with only 2 days, Stranded Hotel is not forced into a stop",
    twoDayPlan.days && !twoDayPlan.days.some((d) => d.accommodations.some((a) => a.name === "Stranded Hotel"))
  );
  check(
    "but it's still visible as passed-along accommodation",
    twoDayPlan.days && twoDayPlan.days.some((d) => d.passedAlong.some((a) => a.name === "Stranded Hotel"))
  );

  const threeDayPlan = planTrip({ route: longRoute, accommodations: strandedAccommodations, days: 3, direction: "forward" });
  check("3-day request returns exactly 3 days", threeDayPlan.days && threeDayPlan.days.length === 3);
  check(
    "with 3 days available, Stranded Hotel becomes a real stop",
    threeDayPlan.days && threeDayPlan.days.some((d) => d.accommodations.some((a) => a.name === "Stranded Hotel"))
  );

  // Camping toggle: a camp_site-only cluster should only ever become a
  // candidate stop (or appear in accommodations/passedAlong at all) when
  // includeCamping is checked.
  const campingAccommodations = [
    { name: "Alpha Inn", type: "hotel", km: 9.8, lat: 56.01, lon: -4.99, off_route_m: 100 },
    { name: "Midway Camp", type: "camp_site", km: 20.0, lat: 56.02, lon: -4.98, off_route_m: 50 },
    { name: "Gamma Lodge", type: "hotel", km: 30, lat: 56.03, lon: -4.97, off_route_m: 0 },
  ];
  // Only 2 days is feasible without camping (Alpha Inn + Gamma Lodge are the
  // only roofed clusters); 3 would need the camp_site to fill a slot.
  const noCamping = planTrip({ route, accommodations: campingAccommodations, days: 2, direction: "forward" });
  check(
    "includeCamping=false never surfaces the camp_site anywhere",
    noCamping.days && !noCamping.days.some((d) => [...d.accommodations, ...d.passedAlong].some((a) => a.name === "Midway Camp"))
  );
  const withCamping = planTrip({
    route, accommodations: campingAccommodations, days: 3, direction: "forward", includeCamping: true,
  });
  check(
    "includeCamping=true can select the camp_site as a real stop",
    withCamping.days && withCamping.days.some((d) => d.accommodations.some((a) => a.name === "Midway Camp"))
  );

  // Requesting more days than distinct candidate clusters exist is
  // infeasible and must fail gracefully, not crash or silently repeat a stop.
  const tooManyDaysForClusters = planTrip({
    route: longRoute, accommodations: strandedAccommodations, days: 4, direction: "forward",
  });
  check("more days than candidate clusters fails gracefully", !!tooManyDaysForClusters.error);

  const decodeCJ = (url) => {
    const prefix = `${CJ_CLICK_BASE}?url=`;
    if (!url.startsWith(prefix)) return null;
    return decodeURIComponent(url.slice(prefix.length));
  };

  const url = buildBookingUrl("Test Place", "2026-08-01", "2026-08-02", 56.65, -4.84);
  check("booking url is wrapped in the CJ click tracker", url.startsWith(`${CJ_CLICK_BASE}?url=`));
  check("no label=/sid=/aid= leaked into the wrapper", !url.includes("label=") && !url.includes("sid=") && !url.includes("aid="));
  const innerSearch = decodeCJ(url);
  check("inner url is a booking.com search url", innerSearch && innerSearch.startsWith("https://www.booking.com/searchresults.html?"));
  check("inner url anchors on coordinates via dest_type=latlong", innerSearch && innerSearch.includes("dest_type=latlong") && innerSearch.includes("latitude=56.65"));

  // Accommodation link tiering: direct mapped URL > confirmed-null's OSM
  // website > confirmed-null-with-no-website / entirely-unmapped search.
  const mappedAcc = { name: "Mapped Hotel", osmId: "node/1", lat: 56.1, lon: -4.9, website: null };
  const bookingUrls = {
    "node/1": { booking_url: "https://www.booking.com/hotel/gb/mapped-hotel.html", verified: "2026-07" },
    "node/2": { booking_url: null },
    "node/3": { booking_url: "not a valid url" },
    "node/4": { booking_url: "" },
  };
  const direct = buildAccommodationLink(mappedAcc, bookingUrls, "2026-08-01", "2026-08-02");
  check("mapped property gets a direct link", direct.linkType === "direct");
  check("direct link is wrapped in the CJ click tracker", direct.url.startsWith(`${CJ_CLICK_BASE}?url=`));
  const innerDirect = decodeCJ(direct.url);
  check("direct link carries checkin/checkout/group_adults", innerDirect && innerDirect.includes("checkin=2026-08-01") && innerDirect.includes("group_adults=2"));
  check("direct link is still the booking.com property page", innerDirect && innerDirect.startsWith("https://www.booking.com/hotel/gb/mapped-hotel.html"));

  const confirmedNullWithWebsite = buildAccommodationLink(
    { name: "No Booking Listing", osmId: "node/2", lat: 56.1, lon: -4.9, website: "https://example-inn.co.uk" },
    bookingUrls, "2026-08-01", "2026-08-02"
  );
  check("confirmed-not-on-booking falls back to the property's own website", confirmedNullWithWebsite.linkType === "website");
  check("website link is the property's own url", confirmedNullWithWebsite.url === "https://example-inn.co.uk");
  check("website link is NOT routed through the Booking.com CJ tracker", !confirmedNullWithWebsite.url.startsWith(CJ_CLICK_BASE));

  const confirmedNullNoWebsite = buildAccommodationLink(
    { name: "No Booking No Website", osmId: "node/2", lat: 56.1, lon: -4.9, website: null },
    bookingUrls, "2026-08-01", "2026-08-02"
  );
  check("confirmed-not-on-booking with no website falls back to area search", confirmedNullNoWebsite.linkType === "search");
  check("area search fallback is also wrapped in the CJ click tracker", confirmedNullNoWebsite.url.startsWith(`${CJ_CLICK_BASE}?url=`));

  const unmapped = buildAccommodationLink(
    { name: "Never Curated", osmId: "node/999", lat: 56.1, lon: -4.9, website: null },
    bookingUrls, "2026-08-01", "2026-08-02"
  );
  check("entirely unmapped property falls back to area search", unmapped.linkType === "search");

  const placeholderUnfilledWithWebsite = buildAccommodationLink(
    { name: "Not Yet Filled In", osmId: "node/4", lat: 56.1, lon: -4.9, website: "https://example.com" },
    bookingUrls, "2026-08-01", "2026-08-02"
  );
  check(
    "pre-populated but unfilled booking_url (\"\") is treated the same as confirmed-absent - falls back to the website when known",
    placeholderUnfilledWithWebsite.linkType === "website" && placeholderUnfilledWithWebsite.url === "https://example.com"
  );

  const placeholderUnfilledNoWebsite = buildAccommodationLink(
    { name: "Not Yet Filled In, No Website", osmId: "node/4", lat: 56.1, lon: -4.9, website: null },
    bookingUrls, "2026-08-01", "2026-08-02"
  );
  check(
    "unfilled booking_url (\"\") with no website falls back to area search",
    placeholderUnfilledNoWebsite.linkType === "search"
  );

  const malformed = buildAccommodationLink(
    { name: "Bad URL", osmId: "node/3", lat: 56.1, lon: -4.9, website: null },
    bookingUrls, "2026-08-01", "2026-08-02"
  );
  check("malformed mapped url falls back to area search rather than throwing", malformed.linkType === "search");

  const passed = results.filter((r) => r.pass).length;
  console.log(`Planner.selfTest: ${passed}/${results.length} passed`);
  for (const r of results) {
    console.log(`  ${r.pass ? "ok" : "FAIL"}: ${r.label}`);
  }
  return passed === results.length;
}

const Planner = { planTrip, buildBookingUrl, buildAccommodationLink, addDaysISO, clusterAccommodations, computeAscent, selfTest, CJ_CLICK_BASE };

if (typeof module !== "undefined" && module.exports) {
  module.exports = Planner;
}
if (typeof window !== "undefined") {
  window.Planner = Planner;
}
