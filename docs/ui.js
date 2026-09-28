/**
 * Wires up the controls, fetches trail data, and renders the itinerary
 * panel + map whenever an input changes. Trail-specific display metadata
 * (place names, mode) comes from data/<trail>/trail.json, not planner.js.
 *
 * Which trail loads is picked by ?trail=<id> (default: West Highland Way).
 * Two modes, set per trail in trail.json:
 *   - "fixed":   walk the whole trail; direction toggle (WHW).
 *   - "section": pick a start and end place, then days (UKK).
 */

const DATA_ROOT = "data";
// Trails offered in the header switcher; `id` is the data/<id>/ directory.
const TRAILS = [
  { id: "whw", name: "West Highland Way" },
  { id: "ukk", name: "UKK-reitti", tag: "experimental" },
];
const TRAIL_IDS = TRAILS.map((t) => t.id);
const DEFAULT_TRAIL_ID = "whw";

const TOWN_LABEL_TOLERANCE_KM = 6;
const MAX_VISIBLE_ACCOMMODATIONS = 10;
// Stops further than this from the line show their detour. 1.5 km is the
// normal search corridor (WHW, and UKK laavus); only UKK's wider search for
// roofed places (up to 5 km) goes beyond it. Stage km are along the trail.
const OFF_TRAIL_NOTE_M = 1500;

// Section mode: default day count is the section length at this daily
// distance (the middle of the trail's km/day range would overshoot on
// short sections of rough path).
const SECTION_DEFAULT_KM_PER_DAY = 20;

function selectedTrailId() {
  const id = new URLSearchParams(window.location.search).get("trail");
  return TRAIL_IDS.includes(id) ? id : DEFAULT_TRAIL_ID;
}

/** Header links between trails: plain links (?trail=<id>), so each trail
 * has a shareable URL and switching is a normal page load. */
function renderTrailSwitch(currentId) {
  const nav = document.getElementById("trail-switch");
  nav.innerHTML = "";
  for (const trail of TRAILS) {
    const link = document.createElement("a");
    link.href = trail.id === DEFAULT_TRAIL_ID ? window.location.pathname : `?trail=${trail.id}`;
    link.textContent = trail.name;
    if (trail.tag) {
      const tag = document.createElement("span");
      tag.className = "trail-switch-tag";
      tag.textContent = trail.tag;
      link.append(" ", tag);
    }
    if (trail.id === currentId) link.setAttribute("aria-current", "page");
    nav.appendChild(link);
  }
}

// Filled from trail.json on load. Must cover every km the engine can
// return as a stage endpoint, or labels fall back to a bare "km X".
let trailPlaces = [];
// How close a km must be to a place to take its name. WHW uses the default;
// the UKK sets 2 km, since its places are far apart and a laavu 5 km
// short of a town is not "the town".
let labelToleranceKm = TOWN_LABEL_TOLERANCE_KM;

function placeLabelForKm(km) {
  let best = null;
  let bestDist = Infinity;
  for (const town of trailPlaces) {
    // A town well off the trail (Nurmes, 6 km) never names a trail-side stop.
    if ((town.off_route_km || 0) > labelToleranceKm) continue;
    const dist = Math.abs(town.km - km);
    if (dist < bestDist) {
      bestDist = dist;
      best = town;
    }
  }
  return best && bestDist <= labelToleranceKm ? best.name : `km ${km.toFixed(1)}`;
}

/** A stage's end: the nearest named place, else (huts between towns on
 * the UKK) the overnight stop's own name - or "laavu at km X" when that
 * name is just generic ("Laavu", "Kota (unnamed)") - else a bare km. */
function stageEndLabel(stage) {
  const place = placeLabelForKm(stage.endRealKm);
  if (!place.startsWith("km ")) return place;
  const isGeneric = (a) =>
    a.name.endsWith("(unnamed)") || (a.label && a.name.toLowerCase() === a.label.toLowerCase());
  const named = stage.accommodations.find((a) => !isGeneric(a));
  if (named) return named.name;
  const first = stage.accommodations[0];
  return first && first.label ? `${first.label} at km ${stage.endRealKm.toFixed(1)}` : place;
}

function formatDateLabel(isoDate) {
  const dt = new Date(isoDate + "T00:00:00Z");
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Real tap targets, not arrow-suffixed text links - the arrow is dropped
// here (presentation only; the underlying URL/linkType logic is unchanged).
const LINK_LABELS = {
  direct: "Check availability",
  website: "Visit website",
  search: "Search area",
  info: "Hut info", // free huts: a plain text link, not a booking button
};

const ICON_DISTANCE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none"/>' +
  '<path d="M6.3 17.7 17.7 6.3"/>' +
  '<circle cx="19" cy="5" r="1.8" fill="currentColor" stroke="none"/>' +
  "</svg>";

const ICON_ASCENT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 18 9 9 13 14 21 4"/>' +
  "</svg>";

function linkForAccommodation(stage, acc, startDate, bookingUrls) {
  // Hut links (UKK free_hut / own_site) don't depend on dates.
  if (acc.tier === "free_hut" || acc.tier === "own_site") {
    return Planner.buildAccommodationLink(acc, bookingUrls, null, null);
  }
  if (!startDate) return null;
  const checkin = Planner.addDaysISO(startDate, stage.day - 1);
  const checkout = Planner.addDaysISO(startDate, stage.day);
  return Planner.buildAccommodationLink(acc, bookingUrls, checkin, checkout);
}

function renderAccommodationLi(stage, acc, startDate, bookingUrls) {
  const li = document.createElement("li");
  const link = linkForAccommodation(stage, acc, startDate, bookingUrls);
  const href = link ? safeHref(link.url) : null;
  li.innerHTML =
    `<span class="acc-name-block"><span class="acc-name">${escapeHtml(acc.name)}</span>` +
    `<span class="acc-type">${escapeHtml(accommodationTypeLabel(acc))}${offTrailSuffix(acc)}</span></span>` +
    (href
      ? `<a href="${href}" class="acc-link acc-link-${link.linkType}" target="_blank" rel="noopener">${LINK_LABELS[link.linkType]}</a>`
      : "");
  return li;
}

/** When even the closest overnight option is well off the trail, show the
 * extra walk next to the day's distance (which is measured along the trail). */
function offTrailStat(stage) {
  if (stage.accommodations.length === 0) return "";
  const nearestM = Math.min(...stage.accommodations.map((a) => a.offRouteM || 0));
  if (nearestM <= OFF_TRAIL_NOTE_M) return "";
  return `<span class="stage-stat stat-detour">+${(nearestM / 1000).toFixed(1)}<span class="stage-stat-unit">km off trail to the stop</span></span>`;
}

function renderItineraryPanel(itinerary, startDate, bookingUrls) {
  const panel = document.getElementById("itinerary-panel");
  const errorBox = document.getElementById("itinerary-error");
  panel.innerHTML = "";

  // The note banner sits outside <ol id="itinerary-panel"> (as its previous
  // sibling), so panel.innerHTML = "" above doesn't clear a stale one from
  // the last render - always remove it first (even before an error), then
  // re-add if still needed.
  const prevNote = panel.previousElementSibling;
  if (prevNote && prevNote.classList.contains("itinerary-note")) {
    prevNote.remove();
  }

  if (itinerary.error) {
    errorBox.textContent = itinerary.error;
    errorBox.hidden = false;
    return;
  }
  errorBox.hidden = true;

  if (itinerary.note) {
    const banner = document.createElement("p");
    banner.className = "itinerary-note";
    banner.textContent = itinerary.note;
    panel.before(banner);
  }

  let prevEndLabel = null;
  for (const stage of itinerary.days) {
    const li = document.createElement("li");
    li.className = "day-stage";

    const dayColor = TrailMap.DAY_COLORS[(stage.day - 1) % TrailMap.DAY_COLORS.length];

    const roundel = document.createElement("div");
    roundel.className = "day-roundel";
    roundel.style.setProperty("--day-color", dayColor);
    roundel.textContent = String(stage.day);
    roundel.setAttribute("aria-hidden", "true");
    li.appendChild(roundel);

    const card = document.createElement("div");
    card.className = "day-card";

    // Each day starts where the previous one ended, so reuse its label.
    // Section mode: the first and last labels are the places the user picked.
    const isLastDay = stage.day === itinerary.days.length;
    const fromLabel = prevEndLabel || itinerary.startLabel || placeLabelForKm(stage.fromRealKm);
    const toLabel = (isLastDay && itinerary.endLabel) || stageEndLabel(stage);
    prevEndLabel = toLabel;
    const dateLabel = startDate ? formatDateLabel(Planner.addDaysISO(startDate, stage.day - 1)) : null;

    const heading = document.createElement("h3");
    heading.textContent = `Day ${stage.day}: ${fromLabel} to ${toLabel}`;
    card.appendChild(heading);

    if (dateLabel) {
      const dateEl = document.createElement("p");
      dateEl.className = "stage-date";
      dateEl.textContent = dateLabel;
      card.appendChild(dateEl);
    }

    const stats = document.createElement("div");
    stats.className = "stage-stats";
    stats.innerHTML =
      `<span class="stage-stat stat-distance">${ICON_DISTANCE}${stage.distanceKm}<span class="stage-stat-unit">km</span></span>` +
      offTrailStat(stage) +
      (stage.ascentM != null
        ? `<span class="stage-stat stat-ascent">${ICON_ASCENT}${stage.ascentM}<span class="stage-stat-unit">m ascent</span></span>`
        : "");
    card.appendChild(stats);

    const list = document.createElement("ul");
    list.className = "accommodation-list";
    const overflowCount = Math.max(0, stage.accommodations.length - MAX_VISIBLE_ACCOMMODATIONS);
    stage.accommodations.forEach((acc, index) => {
      const accLi = renderAccommodationLi(stage, acc, startDate, bookingUrls);
      if (index >= MAX_VISIBLE_ACCOMMODATIONS) accLi.hidden = true;
      list.appendChild(accLi);
    });
    card.appendChild(list);

    // Section mode ends at the chosen place even with no bed there.
    if (stage.accommodations.length === 0) {
      const endNote = document.createElement("p");
      endNote.className = "stage-end-note";
      endNote.textContent =
        stage.day === itinerary.days.length
          ? "End of your section - no mapped overnight stop here."
          : "No mapped overnight stop here.";
      card.appendChild(endNote);
    }

    if (overflowCount > 0) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "show-more-toggle";
      toggle.textContent = `+${overflowCount} more`;
      toggle.addEventListener("click", () => {
        const hiddenItems = list.querySelectorAll("li[hidden]");
        const expanding = hiddenItems.length > 0;
        list.querySelectorAll("li").forEach((itemEl, index) => {
          itemEl.hidden = expanding ? false : index >= MAX_VISIBLE_ACCOMMODATIONS;
        });
        toggle.textContent = expanding ? "Show fewer" : `+${overflowCount} more`;
      });
      card.appendChild(toggle);
    }

    if (stage.passedAlong.length > 0) {
      const details = document.createElement("details");
      details.className = "passed-along";
      const summary = document.createElement("summary");
      summary.textContent = `Also passed ${stage.passedAlong.length} option${stage.passedAlong.length === 1 ? "" : "s"} along the way`;
      details.appendChild(summary);

      const passedList = document.createElement("ul");
      passedList.className = "accommodation-list";
      stage.passedAlong.forEach((acc) => {
        passedList.appendChild(renderAccommodationLi(stage, acc, startDate, bookingUrls));
      });
      details.appendChild(passedList);
      card.appendChild(details);
    }

    li.appendChild(card);
    panel.appendChild(li);
  }
}

/** " · 3.6 km off trail" for stops far enough off the line to matter. */
function offTrailSuffix(acc) {
  return acc.offRouteM > OFF_TRAIL_NOTE_M ? ` · ${(acc.offRouteM / 1000).toFixed(1)} km off trail` : "";
}

/** "autiotupa" / "laavu" for UKK huts, else the OSM type made readable. */
function accommodationTypeLabel(acc) {
  if (acc.label) return acc.label;
  return acc.type ? acc.type.replace(/_/g, " ") : "";
}

/** Links can come from free-text OSM website/url tags: only allow http(s),
 * and escape for the attribute. Returns null for anything else. */
function safeHref(url) {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : null;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ============================================================
   Route profile hero — an illustrative terrain silhouette of the
   whole trail (from route.json's elevation samples), with a tick
   at each stage's overnight stop, coloured to match that day's
   roundel/map segment. Decorative/supplementary: every distance and
   place name it depicts is also stated in the day cards, so the
   SVG itself is aria-hidden.
   ============================================================ */
const PROFILE_VIEWBOX_W = 1000;
const PROFILE_VIEWBOX_H = 120;
const PROFILE_PAD_TOP = 14;
const PROFILE_PAD_BOTTOM = 18;

function buildTerrainPath(route, loKm, hiKm) {
  const spanKm = hiKm - loKm;
  const points = route
    .filter((p) => typeof p.ele === "number" && p.km >= loKm - 1e-9 && p.km <= hiKm + 1e-9)
    .sort((a, b) => a.km - b.km);
  if (points.length < 2 || spanKm <= 0) return null;

  const elevations = points.map((p) => p.ele);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const eleRange = Math.max(1, maxEle - minEle);
  const usableH = PROFILE_VIEWBOX_H - PROFILE_PAD_TOP - PROFILE_PAD_BOTTOM;
  const baseline = PROFILE_VIEWBOX_H - PROFILE_PAD_BOTTOM;

  const coords = points.map((p) => [
    ((p.km - loKm) / spanKm) * PROFILE_VIEWBOX_W,
    baseline - ((p.ele - minEle) / eleRange) * usableH,
  ]);

  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath =
    `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${baseline} ` +
    `L${coords[0][0].toFixed(1)},${baseline} Z`;

  return { linePath, areaPath, baseline };
}

/** Profile of the route between loKm and hiKm (real km, canonical trail
 * direction left to right). Hidden entirely when there's no elevation data
 * for that stretch (e.g. UKK, north of SRTM coverage). */
function renderRouteProfile(containerEl, scaleEl, route, loKm, hiKm, itinerary) {
  const terrain = buildTerrainPath(route, loKm, hiKm);
  scaleEl.hidden = !terrain;
  if (!terrain) {
    containerEl.innerHTML = "";
    return;
  }
  document.getElementById("profile-start").textContent = placeLabelForKm(loKm);
  document.getElementById("profile-end").textContent = placeLabelForKm(hiKm);

  let ticks = "";
  if (itinerary && !itinerary.error && itinerary.days) {
    for (const stage of itinerary.days) {
      const x = (((stage.endRealKm - loKm) / (hiKm - loKm)) * PROFILE_VIEWBOX_W).toFixed(1);
      const color = TrailMap.DAY_COLORS[(stage.day - 1) % TrailMap.DAY_COLORS.length];
      ticks += `<line class="route-profile-tick" x1="${x}" y1="${PROFILE_PAD_TOP - 8}" x2="${x}" y2="${terrain.baseline}" stroke="${color}"></line>`;
    }
  }

  containerEl.innerHTML =
    `<svg viewBox="0 0 ${PROFILE_VIEWBOX_W} ${PROFILE_VIEWBOX_H}" preserveAspectRatio="none" focusable="false">` +
    `<path class="route-profile-area" d="${terrain.areaPath}"></path>` +
    `<path class="route-profile-line" d="${terrain.linePath}"></path>` +
    ticks +
    "</svg>";
}

/* ============================================================
   Mobile view switch: "Day-by-day" / "Route map" tabs. On desktop
   (see the min-width media query in style.css) both panels show at
   once, side by side, and the tabs are hidden - this same logic
   just becomes a no-op there.
   ============================================================ */
function setupViewTabs() {
  const tabs = Array.from(document.querySelectorAll(".view-tab"));
  const panels = {
    itinerary: document.getElementById("itinerary-view"),
    map: document.getElementById("map-view"),
  };

  function activate(view) {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.view === view;
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });
    Object.entries(panels).forEach(([key, panel]) => {
      panel.dataset.hidden = String(key !== view);
    });
    if (view === "map") {
      requestAnimationFrame(() => TrailMap.invalidateSize());
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab.dataset.view));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      next.focus();
      activate(next.dataset.view);
    });
  });

  activate("itinerary");
}

function defaultStartDate() {
  const today = new Date();
  today.setDate(today.getDate() + 14);
  return today.toISOString().slice(0, 10);
}

function fetchJson(url) {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  });
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

/** Section mode: slider bounds follow the selected span at the trail's
 * comfortable km/day range. */
function sectionDayBounds(spanKm, trail) {
  const min = Math.max(1, Math.ceil(spanKm / trail.max_km_per_day));
  const max = Math.max(min, Math.floor(spanKm / trail.min_km_per_day));
  return { min, max };
}

function placeOptionLabel(place) {
  return `${place.name} (km ${Math.round(place.km)})`;
}

/** Honest note under the pickers when a chosen place isn't on the line
 * itself - e.g. Nurmes town is ~6 km from where the trail passes it. */
function offRouteHint(places) {
  const far = places.filter((p) => p.off_route_km >= 1);
  if (far.length === 0) return null;
  return far.map((p) => `${p.name} centre is ${p.off_route_km.toFixed(1)} km from the trail.`).join(" ");
}

async function main() {
  const trailId = selectedTrailId();
  renderTrailSwitch(trailId);
  const base = `${DATA_ROOT}/${trailId}`;
  const [route, accommodations, trail, bookingUrls] = await Promise.all([
    fetchJson(`${base}/route.json`),
    fetchJson(`${base}/accommodations.json`),
    fetchJson(`${base}/trail.json`),
    fetchJson(`${base}/booking_urls.json`),
  ]);
  const sectionMode = trail.mode === "section";
  trailPlaces = trail.places || [];
  labelToleranceKm = trail.label_tolerance_km ?? TOWN_LABEL_TOLERANCE_KM;

  TrailMap.init("map", route);
  setupViewTabs();
  document.getElementById("controls").addEventListener("submit", (e) => e.preventDefault());

  const firstPlace = trailPlaces.length ? trailPlaces[0].name : "Start";
  const lastPlace = trailPlaces.length ? trailPlaces[trailPlaces.length - 1].name : "Finish";
  document.title = `Inn-to-Inn Planner — ${trail.name}`;
  document.querySelector(".app-header h1").textContent = `${trail.name} — Inn-to-Inn Planner`;
  document.querySelector(".app-header .subtitle").textContent = sectionMode
    ? `${firstPlace} to ${lastPlace}, ~${Math.round(trail.total_km)} km. Pick the section you want to walk and your days, get a stage-by-stage itinerary.`
    : `${firstPlace} to ${lastPlace}, ~${Math.round(trail.total_km)} km. Pick your days, get a stage-by-stage itinerary that always ends at real accommodation.`;

  const routeProfileEl = document.getElementById("route-profile");
  const routeProfileScaleEl = document.getElementById("route-profile-scale");

  const daysSlider = document.getElementById("days-slider");
  const directionSelect = document.getElementById("direction-select");
  const fromSelect = document.getElementById("from-select");
  const toSelect = document.getElementById("to-select");
  const sectionHint = document.getElementById("section-hint");
  const startDateInput = document.getElementById("start-date");
  const includeCampingCheckbox = document.getElementById("include-camping");
  const stopsSelect = document.getElementById("stops-select");
  const daysLabel = document.getElementById("days-label");
  const planByRadios = Array.from(document.querySelectorAll('input[name="plan-by"]'));

  document.getElementById("direction-control").hidden = sectionMode;
  document.getElementById("section-control").hidden = !sectionMode;
  // Plan-by-distance is offered on section-mode trails only (WHW unchanged).
  document.getElementById("plan-by").hidden = !sectionMode;
  // A trail that sets default_stops gets the three-way stop choice.
  const stopChoice = Boolean(trail.default_stops);
  document.getElementById("stops-control").hidden = !stopChoice;
  document.getElementById("camping-control").hidden = stopChoice;
  if (stopChoice) stopsSelect.value = trail.default_stops;

  startDateInput.value = defaultStartDate();

  // The one slider means days or max km/day; remember each separately.
  let planByDistance = false;
  let kmPerDay = SECTION_DEFAULT_KM_PER_DAY;

  function configureSlider() {
    if (planByDistance) {
      daysSlider.min = String(trail.min_km_per_day);
      daysSlider.max = String(trail.max_km_per_day);
      daysSlider.value = String(clamp(kmPerDay, trail.min_km_per_day, trail.max_km_per_day));
    }
  }

  function selectedSection() {
    return { from: trailPlaces[Number(fromSelect.value)], to: trailPlaces[Number(toSelect.value)] };
  }

  // Re-derive the days slider range for the chosen section, reset days to a
  // sensible default for its length, and zoom the map to it.
  function onSectionChange() {
    const { from, to } = selectedSection();
    const spanKm = Math.abs(to.km - from.km);
    if (!planByDistance) {
      const bounds = sectionDayBounds(spanKm, trail);
      daysSlider.min = String(bounds.min);
      daysSlider.max = String(bounds.max);
      daysSlider.value = String(clamp(Math.round(spanKm / SECTION_DEFAULT_KM_PER_DAY), bounds.min, bounds.max));
    }

    const hint = offRouteHint([from, to]);
    sectionHint.textContent = hint || "";
    sectionHint.hidden = !hint;

    TrailMap.showSection(route, from.km, to.km, true);
    update();
  }

  if (sectionMode) {
    trailPlaces.forEach((place, index) => {
      fromSelect.add(new Option(placeOptionLabel(place), String(index)));
      toSelect.add(new Option(placeOptionLabel(place), String(index)));
    });
    const defaults = trail.default_section || {};
    const indexOf = (name, fallback) => {
      const i = trailPlaces.findIndex((p) => p.name === name);
      return i >= 0 ? i : fallback;
    };
    fromSelect.value = String(indexOf(defaults.from, 0));
    toSelect.value = String(indexOf(defaults.to, trailPlaces.length - 1));
  } else {
    daysSlider.min = String(trail.min_days);
    daysSlider.max = String(trail.max_days);
    daysSlider.value = String(clamp(Number(daysSlider.value), trail.min_days, trail.max_days));
  }

  // days or maxDailyKm is null depending on the plan-by mode; stops is null
  // on trails that use the plain campsite checkbox.
  function planCurrent({ days, maxDailyKm, includeCamping, stops }) {
    if (!sectionMode) {
      return Planner.planTrip({ route, accommodations, days, direction: directionSelect.value, includeCamping });
    }
    const { from, to } = selectedSection();
    const lo = Math.min(from.km, to.km);
    const hi = Math.max(from.km, to.km);
    // Accommodation is only mapped for part of a long trail so far; say so
    // plainly instead of planning stages across unmapped country.
    const [covLo, covHi] = trail.accommodation_coverage_km || [0, trail.total_km];
    if (from !== to && (hi <= covLo || lo >= covHi)) {
      return { error: `Route shown for ${from.name} to ${to.name} - overnight stops on this section are not mapped yet.` };
    }
    // The trail's own km/day ceiling replaces the WHW-tuned walking limits.
    const limits = { maxAvgKm: trail.max_km_per_day, warnMaxKm: trail.max_km_per_day };
    const plan = Planner.planSection({
      route, accommodations, fromKm: from.km, toKm: to.km, days, maxDailyKm, includeCamping, stops, limits,
    });
    if (!plan.error) {
      plan.startLabel = from.name;
      plan.endLabel = to.name;
    }
    if (!plan.error && (lo < covLo || hi > covHi)) {
      const coverageNote =
        `Overnight stops are only mapped for km ${covLo}-${covHi} of the trail so far; ` +
        "the rest of this section has none in this plan.";
      plan.note = plan.note ? `${coverageNote} ${plan.note}` : coverageNote;
    }
    return plan;
  }

  function update() {
    const sliderValue = Number(daysSlider.value);
    const startDate = startDateInput.value || null;
    if (planByDistance) kmPerDay = sliderValue;

    const itinerary = planCurrent({
      days: planByDistance ? null : sliderValue,
      maxDailyKm: planByDistance ? sliderValue : null,
      includeCamping: includeCampingCheckbox.checked,
      stops: stopChoice ? stopsSelect.value : null,
    });

    if (planByDistance) {
      const dayCount = itinerary.days ? ` · ${itinerary.days.length} days` : "";
      daysLabel.innerHTML = `Max <strong id="days-value">${sliderValue}</strong> km/day${dayCount}`;
    } else {
      daysLabel.innerHTML = `Days <strong id="days-value">${sliderValue}</strong>`;
    }

    let loKm = 0;
    let hiKm = trail.total_km;
    if (sectionMode) {
      const { from, to } = selectedSection();
      loKm = Math.min(from.km, to.km);
      hiKm = Math.max(from.km, to.km);
    }

    renderItineraryPanel(itinerary, startDate, bookingUrls);
    renderRouteProfile(routeProfileEl, routeProfileScaleEl, route, loKm, hiKm, itinerary);
    // An error clears the day segments too, so a stale plan never lingers on the map.
    TrailMap.renderItinerary(
      itinerary.error ? null : itinerary,
      route,
      (stage, acc) => linkForAccommodation(stage, acc, startDate, bookingUrls)
    );
  }

  daysSlider.addEventListener("input", update);
  directionSelect.addEventListener("change", update);
  fromSelect.addEventListener("change", onSectionChange);
  toSelect.addEventListener("change", onSectionChange);
  startDateInput.addEventListener("change", update);
  includeCampingCheckbox.addEventListener("change", update);
  stopsSelect.addEventListener("change", update);
  planByRadios.forEach((radio) =>
    radio.addEventListener("change", () => {
      planByDistance = radio.value === "distance" && radio.checked;
      configureSlider();
      onSectionChange();
    })
  );

  if (sectionMode) {
    onSectionChange();
  } else {
    update();
  }
}
main().catch((err) => {
  console.error(err);
  const errorBox = document.getElementById("itinerary-error");
  errorBox.textContent = "Failed to load trail data. If you opened this file directly, serve it via a local web server instead (e.g. `python -m http.server`).";
  errorBox.hidden = false;
});
