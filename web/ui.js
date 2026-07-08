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

const LINK_LABELS = {
  direct: "Check availability →",
  website: "Visit website →",
  search: "Search area →",
};

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
    `<span>${escapeHtml(acc.name)} <span class="acc-type">${escapeHtml(typeLabel)}</span></span>` +
    (link ? `<a href="${link.url}" class="acc-link acc-link-${link.linkType}" target="_blank" rel="noopener">${LINK_LABELS[link.linkType]}</a>` : "");
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

  if (itinerary.note) {
    const banner = document.createElement("p");
    banner.className = "itinerary-note";
    banner.textContent = itinerary.note;
    panel.appendChild(banner);
  }

  for (const stage of itinerary.days) {
    const card = document.createElement("div");
    card.className = "day-card";
    card.style.setProperty("--day-color", TrailMap.DAY_COLORS[(stage.day - 1) % TrailMap.DAY_COLORS.length]);

    const fromLabel = placeLabelForKm(stage.fromRealKm);
    const toLabel = placeLabelForKm(stage.endRealKm);
    const dateLabel = startDate ? formatDateLabel(Planner.addDaysISO(startDate, stage.day - 1)) : null;

    const heading = document.createElement("h3");
    heading.textContent = `Day ${stage.day}: ${fromLabel} → ${toLabel}`;
    card.appendChild(heading);

    const meta = document.createElement("div");
    meta.className = "stage-meta";
    const ascentText = stage.ascentM != null ? `, ${stage.ascentM} m ascent` : "";
    meta.textContent = `${stage.distanceKm} km${ascentText}${dateLabel ? " · " + dateLabel : ""}`;
    card.appendChild(meta);

    const list = document.createElement("ul");
    list.className = "accommodation-list";
    const overflowCount = Math.max(0, stage.accommodations.length - MAX_VISIBLE_ACCOMMODATIONS);
    stage.accommodations.forEach((acc, index) => {
      const li = renderAccommodationLi(stage, acc, startDate, bookingUrls);
      if (index >= MAX_VISIBLE_ACCOMMODATIONS) li.hidden = true;
      list.appendChild(li);
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
        list.querySelectorAll("li").forEach((li, index) => {
          li.hidden = expanding ? false : index >= MAX_VISIBLE_ACCOMMODATIONS;
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

    panel.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function defaultStartDate() {
  const today = new Date();
  today.setDate(today.getDate() + 14);
  return today.toISOString().slice(0, 10);
}

async function main() {
  const [route, accommodations, trail, bookingUrls] = await Promise.all([
    fetch("../data/whw/route.json").then((r) => r.json()),
    fetch("../data/whw/accommodations.json").then((r) => r.json()),
    fetch("../data/whw/trail.json").then((r) => r.json()),
    fetch("../data/whw/booking_urls.json").then((r) => r.json()),
  ]);

  TrailMap.init("map", route);

  document.querySelector(".app-header h1").textContent = `${trail.name} — Inn-to-Inn Planner`;
  document.querySelector(".app-header .subtitle").textContent =
    `Milngavie to Fort William, ~${Math.round(trail.total_km)} km. Pick your days, get a stage-by-stage itinerary that always ends at real accommodation.`;

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
