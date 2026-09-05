/**
 * Wires up the controls, fetches trail data, and renders the itinerary
 * panel + map whenever an input changes. Trail-specific display metadata
 * (place names) lives here, not in planner.js.
 */

// Approximate km of named stops along the West Highland Way, in canonical
// Milngavie(0) -> Fort William(~153) order. Used only to label stage
// endpoints for display - the engine itself only deals in km and clusters.
const TRAIL_TOWNS = [
  { name: "Milngavie", km: 0 },
  { name: "Drymen", km: 19 },
  { name: "Rowardennan", km: 43 },
  { name: "Inverarnan", km: 66 },
  { name: "Tyndrum", km: 85 },
  { name: "Inveroran", km: 98 },
  { name: "Kingshouse", km: 115 },
  { name: "Kinlochleven", km: 130 },
  { name: "Fort William", km: 153 },
];

const TOWN_LABEL_TOLERANCE_KM = 6;
const MAX_VISIBLE_ACCOMMODATIONS = 10;

function placeLabelForKm(km) {
  let best = null;
  let bestDist = Infinity;
  for (const town of TRAIL_TOWNS) {
    const dist = Math.abs(town.km - km);
    if (dist < bestDist) {
      bestDist = dist;
      best = town;
    }
  }
  return best && bestDist <= TOWN_LABEL_TOLERANCE_KM ? best.name : `km ${km.toFixed(1)}`;
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
  if (!startDate) return null;
  const checkin = Planner.addDaysISO(startDate, stage.day - 1);
  const checkout = Planner.addDaysISO(startDate, stage.day);
  return Planner.buildAccommodationLink(acc, bookingUrls, checkin, checkout);
}

function renderAccommodationLi(stage, acc, startDate, bookingUrls) {
  const li = document.createElement("li");
  const link = linkForAccommodation(stage, acc, startDate, bookingUrls);
  const typeLabel = acc.type ? acc.type.replace(/_/g, " ") : "";
  li.innerHTML =
    `<span class="acc-name-block"><span class="acc-name">${escapeHtml(acc.name)}</span>` +
    `<span class="acc-type">${escapeHtml(typeLabel)}</span></span>` +
    (link
      ? `<a href="${link.url}" class="acc-link acc-link-${link.linkType}" target="_blank" rel="noopener">${LINK_LABELS[link.linkType]}</a>`
      : "");
  return li;
}

function renderItineraryPanel(itinerary, startDate, bookingUrls) {
  const panel = document.getElementById("itinerary-panel");
  const errorBox = document.getElementById("itinerary-error");
  panel.innerHTML = "";

  if (itinerary.error) {
    errorBox.textContent = itinerary.error;
    errorBox.hidden = false;
    return;
  }
  errorBox.hidden = true;

  // The note banner sits outside <ol id="itinerary-panel"> (as its previous
  // sibling), so panel.innerHTML = "" above doesn't clear a stale one from
  // the last render - always remove it first, then re-add if still needed.
  const prevNote = panel.previousElementSibling;
  if (prevNote && prevNote.classList.contains("itinerary-note")) {
    prevNote.remove();
  }
  if (itinerary.note) {
    const banner = document.createElement("p");
    banner.className = "itinerary-note";
    banner.textContent = itinerary.note;
    panel.before(banner);
  }

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

    const fromLabel = placeLabelForKm(stage.fromRealKm);
    const toLabel = placeLabelForKm(stage.endRealKm);
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

function buildTerrainPath(route, totalKm) {
  const points = route.filter((p) => typeof p.ele === "number").slice().sort((a, b) => a.km - b.km);
  if (points.length < 2) return null;

  const elevations = points.map((p) => p.ele);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const eleRange = Math.max(1, maxEle - minEle);
  const usableH = PROFILE_VIEWBOX_H - PROFILE_PAD_TOP - PROFILE_PAD_BOTTOM;
  const baseline = PROFILE_VIEWBOX_H - PROFILE_PAD_BOTTOM;

  const coords = points.map((p) => [
    (p.km / totalKm) * PROFILE_VIEWBOX_W,
    baseline - ((p.ele - minEle) / eleRange) * usableH,
  ]);

  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath =
    `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${baseline} ` +
    `L${coords[0][0].toFixed(1)},${baseline} Z`;

  return { linePath, areaPath, baseline };
}

function renderRouteProfile(containerEl, route, totalKm, itinerary) {
  const terrain = buildTerrainPath(route, totalKm);
  if (!terrain) {
    containerEl.innerHTML = "";
    return;
  }

  let ticks = "";
  if (itinerary && !itinerary.error && itinerary.days) {
    for (const stage of itinerary.days) {
      const x = ((stage.endRealKm / totalKm) * PROFILE_VIEWBOX_W).toFixed(1);
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

async function main() {
  const [route, accommodations, trail, bookingUrls] = await Promise.all([
    fetch("data/whw/route.json").then((r) => r.json()),
    fetch("data/whw/accommodations.json").then((r) => r.json()),
    fetch("data/whw/trail.json").then((r) => r.json()),
    fetch("data/whw/booking_urls.json").then((r) => r.json()),
  ]);

  TrailMap.init("map", route);
  setupViewTabs();
  document.getElementById("controls").addEventListener("submit", (e) => e.preventDefault());

  document.querySelector(".app-header h1").textContent = `${trail.name} — Inn-to-Inn Planner`;
  document.querySelector(".app-header .subtitle").textContent =
    `Milngavie to Fort William, ~${Math.round(trail.total_km)} km. Pick your days, get a stage-by-stage itinerary that always ends at real accommodation.`;

  const routeProfileEl = document.getElementById("route-profile");

  const daysSlider = document.getElementById("days-slider");
  const daysValue = document.getElementById("days-value");
  const directionSelect = document.getElementById("direction-select");
  const startDateInput = document.getElementById("start-date");
  const includeCampingCheckbox = document.getElementById("include-camping");

  daysSlider.min = String(trail.min_days);
  daysSlider.max = String(trail.max_days);
  daysSlider.value = String(Math.min(Math.max(Number(daysSlider.value), trail.min_days), trail.max_days));

  startDateInput.value = defaultStartDate();

  function update() {
    const days = Number(daysSlider.value);
    daysValue.textContent = String(days);
    const direction = directionSelect.value;
    const startDate = startDateInput.value || null;
    const includeCamping = includeCampingCheckbox.checked;

    const itinerary = Planner.planTrip({ route, accommodations, days, direction, includeCamping });

    renderItineraryPanel(itinerary, startDate, bookingUrls);
    renderRouteProfile(routeProfileEl, route, trail.total_km, itinerary);

    if (!itinerary.error) {
      TrailMap.renderItinerary(itinerary, route, (stage, acc) => linkForAccommodation(stage, acc, startDate, bookingUrls));
    }
  }

  daysSlider.addEventListener("input", update);
  directionSelect.addEventListener("change", update);
  startDateInput.addEventListener("change", update);
  includeCampingCheckbox.addEventListener("change", update);

  update();
}

main().catch((err) => {
  console.error(err);
  const errorBox = document.getElementById("itinerary-error");
  errorBox.textContent = "Failed to load trail data. If you opened this file directly, serve it via a local web server instead (e.g. `python -m http.server`).";
  errorBox.hidden = false;
});
