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
// The two upper limits below are the defaults, tuned for walking the WHW;
// a trail can override them via planTrip's `limits` (the UKK allows up to
// 60 km/day so bike and running plans can be tried).
//
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

// Overnight stops with a roof. wilderness_hut covers both the UKK's free
// autiotupa and its bookable vuokratupa (the `tier` field tells them apart).
const ROOFED_TYPES = new Set([
  "hotel", "motel", "guest_house", "hostel", "bed_and_breakfast", "chalet", "apartment", "alpine_hut", "wilderness_hut",
]);
// Stops that need your own tent or sleeping gear: campsites, and open
// shelters (laavu / kota). Only candidates when includeCamping is on.
const CAMPING_TYPES = new Set(["camp_site", "shelter"]);

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

/** Clusters eligible as overnight stops: always roofed, plus camping-only
 * clusters (campsites, laavu/kota shelters) when includeCamping is checked.
 * A cluster with both kinds is eligible either way (its camping options
 * just won't be shown/booked unless includeCamping is on - see
 * displayOptions). */
function candidatePool(clusters, includeCamping) {
  return clusters.filter(
    (c) => clusterHasRoofed(c) || (includeCamping && c.options.some((o) => CAMPING_TYPES.has(o.type)))
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

// "Roofed where possible" in Days mode: a day may run this much longer than
// the most balanced plan's longest day if that buys a roof for the night.
const ROOF_STRETCH_FACTOR = 1.25;

/**
 * Cheapest way along `points` from the first to the last using only steps
 * no longer than maxStepKm. Each step costs [days, campNights, length^2],
 * summed and compared lexicographically - all three are additive, so plain
 * DP is exact. `stages` fixes the number of steps; null lets it float (and
 * then fewer days wins first). useCamp: count nights at camping-only stops.
 * allowGapHops: a step between two neighbouring points is always allowed,
 * however long - the only way across a gap with no stop at all.
 *
 * Runs on every slider move over up to ~200 stops x ~90 days, so costs live
 * in flat arrays with parent pointers (no per-step array copies), and only
 * steps within reach (points are sorted) are tried.
 * Returns { cost: [days, camp, sumSq], path: [point indices] } or null.
 */
function cheapestPath(points, isCampNight, maxStepKm, stages, useCamp, allowGapHops = false) {
  const n = points.length;
  const last = n - 1;
  const layers = stages == null ? 1 : stages;

  // Per layer: cost components and the parent point index (-1 = unreached).
  const makeLayer = () => ({
    days: new Float64Array(n).fill(Infinity),
    camp: new Float64Array(n),
    sq: new Float64Array(n),
    parent: new Int32Array(n).fill(-1),
  });
  const better = (d, c, q, L, j) =>
    d < L.days[j] - 1e-9 ||
    (Math.abs(d - L.days[j]) <= 1e-9 && (c < L.camp[j] - 1e-9 || (Math.abs(c - L.camp[j]) <= 1e-9 && q < L.sq[j] - 1e-9)));

  // relax(from, to, j): try every step i -> j that is within reach.
  const relax = (from, to, j) => {
    let i = j - 1;
    while (i > 0 && points[j] - points[i - 1] <= maxStepKm + 1e-6) i--;
    const firstInReach = points[j] - points[i] <= maxStepKm + 1e-6 ? i : j;
    const tryStep = (k) => {
      if (from.days[k] === Infinity) return;
      const len = points[j] - points[k];
      const d = from.days[k] + 1;
      const c = from.camp[k] + (useCamp && isCampNight[j] ? 1 : 0);
      const q = from.sq[k] + len * len;
      if (to.days[j] === Infinity || better(d, c, q, to, j)) {
        to.days[j] = d;
        to.camp[j] = c;
        to.sq[j] = q;
        to.parent[j] = k;
      }
    };
    for (let k = firstInReach; k < j; k++) tryStep(k);
    if (allowGapHops && firstInReach === j) tryStep(j - 1);
  };

  const start = makeLayer();
  start.days[0] = 0;
  const history = [start];
  if (stages == null) {
    // One layer: a point's best cost only depends on earlier points.
    for (let j = 1; j <= last; j++) relax(start, start, j);
  } else {
    for (let k = 1; k <= layers; k++) {
      const next = makeLayer();
      const prevLayer = history[k - 1];
      if (k === layers) relax(prevLayer, next, last);
      else for (let j = 1; j < last; j++) relax(prevLayer, next, j);
      history.push(next);
    }
  }

  const final = history[history.length - 1];
  if (final.days[last] === Infinity) return null;
  const path = [last];
  if (stages == null) {
    for (let j = last; j !== 0; j = start.parent[j]) path.push(start.parent[j]);
  } else {
    let j = last;
    for (let k = layers; k > 0; k--) {
      j = history[k].parent[j];
      path.push(j);
    }
  }
  path.reverse();
  return { cost: [final.days[last], final.camp[last], final.sq[last]], path };
}
/** Smallest step length (from the candidates) for which ok(step) holds;
 * ok must be monotone (false ... false true ... true). */
function smallestStep(candidates, ok) {
  let lo = 0;
  let hi = candidates.length - 1;
  if (hi < 0 || !ok(candidates[hi])) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(candidates[mid])) hi = mid;
    else lo = mid + 1;
  }
  return candidates[lo];
}

/**
 * Partition for the section-mode preferences. Priorities, in order:
 *   1. fewest days (only when `stages` is null, i.e. planning by km/day)
 *   2. fewest nights without a roof (only when preferRoofed)
 *   3. shortest longest day
 *   4. most even days (least sum of squares)
 * ...all subject to a daily cap:
 *   - planning by distance: maxDailyKm. A gap between two neighbouring stops
 *     longer than that is still crossed (it's unavoidable), but every other
 *     day keeps to the cap; capRaised flags that it happened.
 *   - planning by days with preferRoofed: ROOF_STRETCH_FACTOR x the most
 *     balanced plan's longest day.
 */
function findPreferredPartition(points, isCampNight, { stages = null, preferRoofed = false, maxDailyKm = null }) {
  const lengths = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) lengths.push(points[j] - points[i]);
  }
  const candidates = [...new Set(lengths.map((l) => Math.round(l * 1e6) / 1e6))].sort((a, b) => a - b);
  const byDistance = stages == null;
  const path = (step, useCamp) => cheapestPath(points, isCampNight, step, stages, useCamp, byDistance);

  let cap;
  if (byDistance) {
    cap = maxDailyKm ?? Infinity;
  } else {
    // Shortest possible longest day for this many days, ignoring roofs.
    const bottleneck = smallestStep(candidates, (step) => path(step, false) !== null);
    if (bottleneck === null) return null;
    cap = preferRoofed ? bottleneck * ROOF_STRETCH_FACTOR : bottleneck;
  }

  // Priorities 1-2 at the cap, then the smallest longest day that keeps them.
  const atCap = path(cap, preferRoofed);
  if (!atCap) return null;
  const keepsPriorities = (step) => {
    const r = path(step, preferRoofed);
    return r !== null && r.cost[0] === atCap.cost[0] && r.cost[1] === atCap.cost[1];
  };
  const step = smallestStep(candidates.filter((c) => c <= cap + 1e-9), keepsPriorities) ?? cap;
  const best = path(step, preferRoofed);
  const longest = Math.max(...best.path.slice(1).map((j, k) => points[j] - points[best.path[k]]));
  return { pathIdx: best.path, maxStage: longest, capRaised: byDistance && longest > cap + 1e-6 };
}
/** accommodations.json record -> the shape the UI renders. `tier` and
 * `label` are UKK-only (null on WHW): tier picks the link rule in
 * buildAccommodationLink, label is a display name like "autiotupa". */
function toStageOption(o) {
  return {
    name: o.name,
    type: o.type,
    tier: o.tier || null,
    label: o.label || null,
    offRouteM: o.off_route_m,
    lat: o.lat,
    lon: o.lon,
    km: o.km,
    website: o.website || null,
    osmId: o.osm_id || null,
  };
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
    accommodations: displayOptions(cluster, includeCamping).map(toStageOption),
    passedAlong: passedAlong.flatMap((c) => displayOptions(c, includeCamping).map(toStageOption)),
  };
}

// A section's ends are town/place nodes; their beds can sit a couple of km
// away (Vuokatti's hotels are 1-2 km short of the town node). Beds this
// close to the start are "still at the start", not a first night's stop.
const SECTION_END_RADIUS_KM = 3;

/** Section mode's finish: the walk ends where the user chose, bed or no bed
 * (a section walker may be heading home). A candidate cluster within
 * SECTION_END_RADIUS_KM of the end is used as the finish so its options
 * show; otherwise the last day ends at an empty "end of section" point. */
function sectionFinish(pool, totalKm, reverse) {
  const nearEnd = pool.filter((c) => c.km >= totalKm - SECTION_END_RADIUS_KM - 1e-9);
  if (nearEnd.length > 0) return nearEnd[nearEnd.length - 1];
  return { km: totalKm, realKm: reverse ? 0 : totalKm, options: [] };
}

/** Build a plan for an exact day count, or an error if that day count isn't
 * achievable with the current candidate pool. Returns maxStage/minStage/
 * stdDev alongside the stages so callers can judge how balanced it is.
 * finishAtEnd (section mode): the last day ends at totalKm - see
 * sectionFinish - instead of at the last accommodation cluster. */
function buildPlanForDays(clusters, walkRoute, totalKm, days, includeCamping, reverse, finishAtEnd = false, prefs = {}) {
  const { preferRoofed = false, maxDailyKm = null } = prefs;
  const pool = candidatePool(clusters, includeCamping);
  if (pool.length === 0 && !finishAtEnd) {
    return { error: "No accommodation available on this trail with the current settings." };
  }

  let finishCluster;
  let intermediates;
  if (finishAtEnd) {
    finishCluster = sectionFinish(pool, totalKm, reverse);
    // A stop at (or within a town's width of) the start would be a ~0 km day.
    intermediates = pool.filter(
      (c) => c !== finishCluster && c.km > SECTION_END_RADIUS_KM && c.km < finishCluster.km - 1e-6
    );
  } else {
    finishCluster = pool[pool.length - 1];
    intermediates = pool.slice(0, -1);
  }
  const maxFeasibleDays = intermediates.length + 1;
  if (days != null && days > maxFeasibleDays) {
    return {
      error:
        `Only ${maxFeasibleDays} distinct overnight stop(s) are available with the current settings - ` +
        `${days} days isn't possible. Try ${maxFeasibleDays} or fewer` +
        (includeCamping ? "." : ", or include campsites for more options."),
    };
  }

  const points = [0, ...intermediates.map((c) => c.km), finishCluster.km];
  // The WHW's original modes (fixed days, no roof preference) keep the
  // original optimizer untouched; the newer modes use the lexicographic one.
  let partition;
  if (days != null && !preferRoofed) {
    partition = findBestPartition(points, days);
  } else {
    const isCampNight = [false, ...intermediates.map((c) => !clusterHasRoofed(c)), false];
    partition = findPreferredPartition(points, isCampNight, { stages: days, preferRoofed, maxDailyKm });
  }
  if (!partition) {
    return { error: `Could not find a valid ${days}-day split of the available accommodation.` };
  }
  days = partition.pathIdx.length - 1;

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

  // Nights (every stop but the finish) spent without a roof.
  const campNights = stages.slice(0, -1).filter((s) => s.accommodations.every((a) => !ROOFED_TYPES.has(a.type))).length;

  return { days: stages, maxStage, minStage, stdDev, campNights, capRaised: Boolean(partition.capRaised) };
}

/** Among nearby day counts, find the one with the best-balanced result
 * (smallest longest stage, tie-broken by smallest stdDev) - used only to
 * populate a suggestion note, never to override the requested day count. */
function suggestBetterDayCount(clusters, walkRoute, totalKm, days, includeCamping, reverse, maxFeasibleDays, finishAtEnd, prefs) {
  const candidateDays = [days - 1, days + 1, days + 2].filter((d) => d >= 1 && d <= maxFeasibleDays && d !== days);
  let best = null;
  for (const d of candidateDays) {
    const result = buildPlanForDays(clusters, walkRoute, totalKm, d, includeCamping, reverse, finishAtEnd, prefs);
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
 * @param {number} [input.days] - exact day count; or leave null and give maxDailyKm
 * @param {number} [input.maxDailyKm] - plan by distance: fewest days with no day longer than this
 * @param {"forward"|"reverse"} [input.direction]
 * @param {boolean} [input.includeCamping] - allow camp_site-only clusters as normal overnight stops
 * @param {"roofed"|"prefer_roofed"|"any"} [input.stops] - overrides includeCamping: roofed only, roofed
 *   where possible (camping-only stops only where no roof is within reach), or any stop (pure balance)
 * @param {Object} [input.limits] - per-trail km/day limits; defaults are tuned for walking the WHW
 * @param {number} [input.limits.maxAvgKm] - refuse plans averaging more than this per day
 * @param {number} [input.limits.warnMaxKm] - flag (but still return) plans with a stage longer than this
 * @param {boolean} [input.finishAtEnd] - end the last day at the route end even without accommodation there (section mode)
 * @returns {{days: Array<Object>, totalKm: number, direction: string, note?: string} | {error: string}}
 */
function planTrip({
  route, accommodations, days = null, maxDailyKm = null, direction = "forward",
  includeCamping = false, stops = null, limits = {}, finishAtEnd = false,
}) {
  const maxAvgKm = limits.maxAvgKm ?? MAX_AVG_STAGE_KM;
  const warnMaxKm = limits.warnMaxKm ?? STAGE_WARN_MAX_KM;
  const stopMode = stops ?? (includeCamping ? "any" : "roofed");
  const allowCamping = stopMode !== "roofed";
  const byDistance = days == null;
  const prefs = { preferRoofed: stopMode === "prefer_roofed", maxDailyKm: byDistance ? maxDailyKm : null };
  if (!route || route.length < 2) {
    return { error: "Route data is missing or too short." };
  }
  if (byDistance && !(maxDailyKm > 0)) {
    return { error: "Give either a day count or a maximum daily distance." };
  }
  if (!byDistance && (!Number.isInteger(days) || days < 1)) {
    return { error: "Days must be a positive whole number." };
  }

  const totalKm = route[route.length - 1].km;
  const reverse = direction === "reverse";

  const naiveAvg = byDistance ? MIN_AVG_STAGE_KM : totalKm / days;
  if (totalKm < MIN_AVG_STAGE_KM) {
    return { error: `At ${totalKm.toFixed(1)} km this is shorter than a single day's walk - pick a longer section.` };
  }
  if (naiveAvg > maxAvgKm || naiveAvg < MIN_AVG_STAGE_KM) {
    const minDays = Math.ceil(totalKm / maxAvgKm);
    const maxDays = Math.floor(totalKm / MIN_AVG_STAGE_KM);
    if (maxDays < 1) {
      return { error: `At ${totalKm.toFixed(1)} km this is shorter than a single day's walk - pick a longer section.` };
    }
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

  const plan = buildPlanForDays(clusters, walkRoute, totalKm, days, allowCamping, reverse, finishAtEnd, prefs);
  if (plan.error) return plan;

  if (byDistance) {
    const note = distanceModeNote(plan, maxDailyKm, stopMode, () =>
      buildPlanForDays(clusters, walkRoute, totalKm, null, false, reverse, finishAtEnd, { maxDailyKm })
    );
    return {
      days: plan.days, totalKm: round2(totalKm), direction, campNights: plan.campNights, ...(note ? { note } : {}),
    };
  }

  const outOfRange = plan.maxStage > warnMaxKm + 1e-9 || plan.minStage < STAGE_WARN_MIN_KM - 1e-9;
  let note;
  if (outOfRange) {
    const maxFeasibleDays = candidatePool(clusters, allowCamping).length;
    const suggestion = suggestBetterDayCount(clusters, walkRoute, totalKm, days, allowCamping, reverse, maxFeasibleDays, finishAtEnd, prefs);
    const stageDesc =
      plan.maxStage > warnMaxKm ? `a ${plan.maxStage.toFixed(1)} km stage` : `a ${plan.minStage.toFixed(1)} km stage`;
    note = suggestion
      ? `This plan still has ${stageDesc} given how accommodation is spaced along the trail - ${suggestion.days} days would balance it better.`
      : `This plan still has ${stageDesc} given how accommodation is spaced along the trail.`;
  }

  if (stopMode === "prefer_roofed" && plan.campNights > 0) {
    note = [campNightsNote(plan.campNights), note].filter(Boolean).join(" ");
  }
  const extra = stops ? { campNights: plan.campNights } : {};
  return { days: plan.days, totalKm: round2(totalKm), direction, ...extra, ...(note ? { note } : {}) };
}

function campNightsNote(n) {
  return `${n} night${n === 1 ? " is" : "s are"} at a campsite or open shelter, where no roofed stop was within reach.`;
}

/** Notes for a plan made by maximum daily distance: days forced over the
 * limit by a gap with no stop, roofless nights, and - when a roof every
 * night is possible within the same limit - how many days that would take. */
function distanceModeNote(plan, maxDailyKm, stopMode, planRoofedOnly) {
  const parts = [];
  const tooLong = plan.days.filter((d) => d.distanceKm > maxDailyKm + 0.05);
  if (tooLong.length > 0) {
    const list = tooLong.map((d) => `day ${d.day} (${d.distanceKm.toFixed(1)} km)`).join(", ");
    parts.push(`There is no stop close enough to keep every day under ${maxDailyKm} km: ${list}.`);
  }
  if (stopMode !== "roofed" && plan.campNights > 0) {
    if (stopMode === "prefer_roofed") parts.push(campNightsNote(plan.campNights));
    const roofed = planRoofedOnly();
    if (!roofed.error && !roofed.capRaised && roofed.days.length !== plan.days.length) {
      parts.push(`A roof every night within ${maxDailyKm} km/day would take ${roofed.days.length} days.`);
    }
  }
  return parts.join(" ");
}

/** Route vertex at an exact km, linearly interpolated between neighbours.
 * A km that lands on an existing vertex returns that vertex as-is, so its
 * elevation sample isn't lost to a neighbour that has none. */
function pointAtKm(route, km) {
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    if (Math.abs(km - a.km) < 1e-9) return { ...a };
    if (Math.abs(km - b.km) < 1e-9) return { ...b };
    if (km < b.km) {
      const t = b.km === a.km ? 0 : (km - a.km) / (b.km - a.km);
      const p = { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), km };
      if (typeof a.ele === "number" && typeof b.ele === "number") p.ele = a.ele + t * (b.ele - a.ele);
      return p;
    }
  }
  return { ...route[route.length - 1] };
}

/** The part of the route between loKm and hiKm (real trail km), with exact
 * interpolated endpoints. */
function sliceRoute(route, loKm, hiKm) {
  const inner = route.filter((p) => p.km > loKm + 1e-9 && p.km < hiKm - 1e-9);
  return [pointAtKm(route, loKm), ...inner, pointAtKm(route, hiKm)];
}

/**
 * Section mode: plan a walk between two points on a long trail (fromKm ->
 * toKm in real trail km; fromKm > toKm means walking the trail backwards).
 *
 * The section is cut out and treated as a trail of its own - km rebased to
 * start at 0 - so planTrip's optimizer runs over only the clusters inside
 * [start, end]. Unlike a fixed trail, the last day ends at the chosen end
 * even with no bed there (finishAtEnd). Every km in the result is then
 * shifted back to real trail km so the map and place labels line up with
 * the full route.
 *
 * @returns same shape as planTrip, plus sectionFromKm / sectionToKm
 */
function planSection({
  route, accommodations, fromKm, toKm, days = null, maxDailyKm = null, includeCamping = false, stops = null, limits = {},
}) {
  if (!route || route.length < 2) {
    return { error: "Route data is missing or too short." };
  }
  if (Math.abs(fromKm - toKm) < 1e-6) {
    return { error: "Start and end are the same place - pick two different points." };
  }
  // A waypoint rounded past the end of the line (e.g. 886.0 vs 885.98) would
  // otherwise produce a phantom negative-length first or last stage.
  const routeEndKm = route[route.length - 1].km;
  fromKm = Math.min(Math.max(fromKm, route[0].km), routeEndKm);
  toKm = Math.min(Math.max(toKm, route[0].km), routeEndKm);

  const lo = Math.min(fromKm, toKm);
  const hi = Math.max(fromKm, toKm);
  const sectionRoute = sliceRoute(route, lo, hi).map((p) => ({ ...p, km: p.km - lo }));
  const sectionAccommodations = accommodations
    .filter((a) => a.km >= lo - 1e-9 && a.km <= hi + 1e-9)
    .map((a) => ({ ...a, km: a.km - lo }));

  const plan = planTrip({
    route: sectionRoute,
    accommodations: sectionAccommodations,
    days,
    maxDailyKm,
    direction: fromKm > toKm ? "reverse" : "forward",
    includeCamping,
    stops,
    limits,
    finishAtEnd: true,
  });
  if (plan.error) return plan;

  const toRealKm = (km) => round2(km + lo);
  const shiftAcc = (acc) => ({ ...acc, km: acc.km + lo });
  return {
    ...plan,
    sectionFromKm: fromKm,
    sectionToKm: toKm,
    days: plan.days.map((stage) => ({
      ...stage,
      fromRealKm: toRealKm(stage.fromRealKm),
      endRealKm: toRealKm(stage.endRealKm),
      accommodations: stage.accommodations.map(shiftAcc),
      passedAlong: stage.passedAlong.map(shiftAcc),
    })),
  };
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
 * @returns {{url: string, linkType: "direct"|"website"|"search"|"info"} | null} - null for a hut with no known page
 */
function buildAccommodationLink(acc, bookingUrls, checkinISO, checkoutISO) {
  // Huts are never on Booking.com. A free hut (autiotupa, laavu) is
  // unbookable - just an info link (e.g. its luontoon.fi page) when known.
  // A rental hut books on its own site. Neither gets a search fallback.
  if (acc.tier === "free_hut") {
    return acc.website ? { url: acc.website, linkType: "info" } : null;
  }
  if (acc.tier === "own_site") {
    return acc.website ? { url: acc.website, linkType: "website" } : null;
  }

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

  // UKK hut tiers: an autiotupa (wilderness_hut) is a roofed stop; a laavu
  // (shelter) needs your own gear, so it's a stop only with camping on.
  const hutAccommodations = (midType, midTier) => [
    { name: "Alpha Inn", type: "hotel", km: 9.8, lat: 56.01, lon: -4.99, off_route_m: 100 },
    { name: "Mid Hut", type: midType, tier: midTier, km: 20.0, lat: 56.02, lon: -4.98, off_route_m: 50 },
    { name: "Gamma Lodge", type: "hotel", km: 30, lat: 56.03, lon: -4.97, off_route_m: 0 },
  ];
  const withAutiotupa = planTrip({ route, accommodations: hutAccommodations("wilderness_hut", "free_hut"), days: 3 });
  check(
    "an autiotupa is a roofed stop without the camping toggle",
    withAutiotupa.days && withAutiotupa.days.some((d) => d.accommodations.some((a) => a.name === "Mid Hut"))
  );
  check("a laavu is not a stop without the camping toggle", !!planTrip({ route, accommodations: hutAccommodations("shelter", "free_hut"), days: 3 }).error);
  const withLaavu = planTrip({ route, accommodations: hutAccommodations("shelter", "free_hut"), days: 3, includeCamping: true });
  check(
    "a laavu is a stop with the camping toggle",
    withLaavu.days && withLaavu.days.some((d) => d.accommodations.some((a) => a.name === "Mid Hut" && a.tier === "free_hut"))
  );

  const hutInfo = buildAccommodationLink({ name: "Hut", tier: "free_hut", website: "https://www.luontoon.fi/x" }, {}, "2026-08-01", "2026-08-02");
  check("a free hut with a page gets a plain info link, not Booking.com", hutInfo && hutInfo.linkType === "info" && hutInfo.url === "https://www.luontoon.fi/x");
  check("a free hut with no page gets no link at all", buildAccommodationLink({ name: "Hut", tier: "free_hut" }, {}, "2026-08-01", "2026-08-02") === null);
  const rentalHut = buildAccommodationLink({ name: "Rental", tier: "own_site", website: "https://example.fi" }, {}, "2026-08-01", "2026-08-02");
  check("a rental hut links to its own site", rentalHut && rentalHut.linkType === "website");
  check("a rental hut with no site gets no Booking.com search", buildAccommodationLink({ name: "Rental", tier: "own_site" }, {}, "2026-08-01", "2026-08-02") === null);

  // Stop preference: "roofed where possible" takes a hotel over an equally
  // handy laavu; "any" just balances distances and takes the laavu.
  const sixty = [];
  for (let km = 0; km <= 60; km += 1) sixty.push({ lat: 64 + km * 0.001, lon: 28, km });
  const hotelOrLaavu = [
    { name: "Side Hotel", type: "hotel", km: 27, lat: 64.027, lon: 28, off_route_m: 0 },
    { name: "Mid Laavu", type: "shelter", tier: "free_hut", km: 30, lat: 64.03, lon: 28, off_route_m: 0 },
    { name: "End Hotel", type: "hotel", km: 60, lat: 64.06, lon: 28, off_route_m: 0 },
  ];
  const stopAt = (plan) => plan.days && plan.days[0].accommodations.map((a) => a.name).join();
  check("'any' balances onto the laavu", stopAt(planTrip({ route: sixty, accommodations: hotelOrLaavu, days: 2, stops: "any" })) === "Mid Laavu");
  const prefer = planTrip({ route: sixty, accommodations: hotelOrLaavu, days: 2, stops: "prefer_roofed" });
  check("'prefer_roofed' takes the hotel a little off-balance", stopAt(prefer) === "Side Hotel" && prefer.campNights === 0);

  // Plan by distance: the fewest days that keep every day under the limit.
  const everyTwenty = [20, 40, 60].map((km) => ({ name: `Hotel ${km}`, type: "hotel", km, lat: 64 + km * 0.001, lon: 28, off_route_m: 0 }));
  const by25 = planTrip({ route: sixty, accommodations: everyTwenty, maxDailyKm: 25, stops: "roofed" });
  check("max 25 km/day over 60 km with hotels every 20 km -> 3 days", by25.days && by25.days.length === 3 && !by25.note);
  const by45 = planTrip({ route: sixty, accommodations: everyTwenty, maxDailyKm: 45, stops: "roofed" });
  check("max 45 km/day -> 2 days", by45.days && by45.days.length === 2);
  const gappy = [10, 50, 60].map((km) => ({ name: `Hotel ${km}`, type: "hotel", km, lat: 64 + km * 0.001, lon: 28, off_route_m: 0 }));
  const byGap = planTrip({ route: sixty, accommodations: gappy, maxDailyKm: 20, stops: "roofed" });
  check(
    "a gap longer than the limit is crossed in one day, other days keep to it, and the note says so",
    byGap.days && byGap.days.map((d) => d.distanceKm).join() === "10,40,10" && byGap.note.includes("day 2 (40.0 km)")
  );

  // Section mode: only clusters inside [from, to] are used, and every km in
  // the result is real trail km (not rebased to the section start).
  const section = planSection({ route: longRoute, accommodations: strandedAccommodations, fromKm: 10, toKm: 40, days: 2 });
  check("section plan succeeds", !section.error);
  check("section day 1 starts at the section start in real km", section.days && section.days[0].fromRealKm === 10);
  check("section ends at the chosen end, even with no bed there", section.days && section.days[1].endRealKm === 40);
  check("a section ending with no bed shows no accommodation for the last day", section.days && section.days[1].accommodations.length === 0);
  check(
    "section never uses accommodation outside [from, to]",
    section.days && !section.days.some((d) => [...d.accommodations, ...d.passedAlong].some((a) => a.name === "Final B"))
  );
  check("section distances are measured within the section", section.days && section.days[0].distanceKm === 5);
  check("accommodation km stays real trail km", section.days && section.days[0].accommodations[0].km === 15);

  const backwards = planSection({ route: longRoute, accommodations: strandedAccommodations, fromKm: 64, toKm: 10, days: 2 });
  check("to < from walks the section backwards", !backwards.error && backwards.direction === "reverse");
  check("backwards section starts at from", backwards.days && backwards.days[0].fromRealKm === 64);
  check("backwards section ends at to", backwards.days && backwards.days[1].endRealKm === 10);
  const nearStart = planSection({ route: longRoute, accommodations: strandedAccommodations, fromKm: 13, toKm: 40, days: 2 });
  check(
    "a bed within 3 km of the section start is never a night's stop",
    nearStart.days && nearStart.days[0].endRealKm === 35 && !nearStart.days.some((d) => d.accommodations.some((a) => a.name === "Stranded Hotel"))
  );
  const endsAtBed = planSection({ route: longRoute, accommodations: strandedAccommodations, fromKm: 0, toKm: 35.5, days: 2 });
  check("a stop within 3 km of the end is used as the finish", endsAtBed.days && endsAtBed.days[1].endRealKm === 35 && endsAtBed.days[1].accommodations.length === 1);

  const samePlace = planSection({ route: longRoute, accommodations: strandedAccommodations, fromKm: 35, toKm: 35, days: 1 });
  check("same start and end fails gracefully", !!samePlace.error);
  const tooShort = planSection({ route: longRoute, accommodations: strandedAccommodations, fromKm: 30, toKm: 35, days: 1 });
  check("section shorter than a day's walk fails with a clear message", tooShort.error && tooShort.error.includes("shorter"));
  // Per-trail limits: the WHW defaults refuse a 60 km/day average, a trail
  // configured for up to 60 km/day plans it without an over-long note.
  const fastRoute = [];
  for (let km = 0; km <= 120; km += 1) fastRoute.push({ lat: 64 + km * 0.001, lon: 28, km });
  const fastAcc = [
    { name: "Half Way", type: "hotel", km: 60, lat: 64.06, lon: 28, off_route_m: 0 },
    { name: "Finish", type: "hotel", km: 120, lat: 64.12, lon: 28, off_route_m: 0 },
  ];
  check("default limits refuse 60 km/day", !!planTrip({ route: fastRoute, accommodations: fastAcc, days: 2 }).error);
  const fast = planTrip({ route: fastRoute, accommodations: fastAcc, days: 2, limits: { maxAvgKm: 60, warnMaxKm: 60 } });
  check("raised limits allow 60 km/day, unflagged", !fast.error && fast.days.length === 2 && !fast.note);

  const pastEnd = planSection({ route: longRoute, accommodations: strandedAccommodations, fromKm: 65.04, toKm: 10, days: 2 });
  check(
    "a from/to rounded past the route end is clamped, never a negative stage",
    pastEnd.days && pastEnd.days.every((d) => d.distanceKm > 0) && pastEnd.days[0].fromRealKm === 65
  );

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

const Planner = { planTrip, planSection, sliceRoute, buildBookingUrl, buildAccommodationLink, addDaysISO, clusterAccommodations, computeAscent, selfTest, CJ_CLICK_BASE };

if (typeof module !== "undefined" && module.exports) {
  module.exports = Planner;
}
if (typeof window !== "undefined") {
  window.Planner = Planner;
}
