/**
 * Leaflet rendering for the trail map: base route line, plus per-day
 * colored segments and accommodation markers once an itinerary is planned.
 */

// Named for what each hue actually is on the Highland landscape, in the
// order a stage is likely to encounter them - not an arbitrary rainbow.
const DAY_COLORS = [
  "#c1006b", // explorer pink
  "#35647d", // loch blue
  "#a85a24", // contour rust
  "#55694a", // moss
  "#6b4f7a", // heather
  "#9c7a1e", // gorse gold
  "#4a5a63", // slate
  "#5c4a3a", // peat
  "#4e7fa0", // sky
  "#8b5e3c", // bracken
  "#7d5a82", // thistle
];

const TrailMap = (() => {
  let map = null;
  let itineraryLayer = null;

  function init(containerId, route) {
    map = L.map(containerId);

    L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution:
        'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | ' +
        'Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }).addTo(map);

    const latlngs = route.map((p) => [p.lat, p.lon]);
    // Dashed, like a right-of-way footpath on an OS map, rather than a
    // solid generic "route line."
    const baseLine = L.polyline(latlngs, { color: "#24272b", weight: 3, opacity: 0.55, dashArray: "1,7" }).addTo(map);
    map.fitBounds(baseLine.getBounds(), { padding: [20, 20] });

    itineraryLayer = L.layerGroup().addTo(map);
    return map;
  }

  function sliceRouteByRealKm(route, kmA, kmB) {
    const lo = Math.min(kmA, kmB);
    const hi = Math.max(kmA, kmB);
    return route.filter((p) => p.km >= lo - 1e-6 && p.km <= hi + 1e-6);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const LINK_LABELS = {
    direct: "Check availability on Booking.com",
    website: "Visit property website",
    search: "Search area on Booking.com",
  };

  function buildPopupHtml(stage, acc, link) {
    const typeLabel = acc.type ? acc.type.replace(/_/g, " ") : "accommodation";
    const offRoute = acc.offRouteM > 0 ? `<br>${acc.offRouteM} m off route` : "";
    const linkHtml = link
      ? `<br><a href="${link.url}" target="_blank" rel="noopener">${LINK_LABELS[link.linkType]}</a>`
      : "";
    return (
      `<strong>${escapeHtml(acc.name)}</strong><br>` +
      `Day ${stage.day} &middot; ${escapeHtml(typeLabel)}${offRoute}${linkHtml}`
    );
  }

  /**
   * @param {Object} itinerary - result of Planner.planTrip
   * @param {Array} route - the full route.json data
   * @param {(stage: Object, acc: Object) => {url: string, linkType: string}} getLink
   */
  function renderItinerary(itinerary, route, getLink) {
    itineraryLayer.clearLayers();
    if (!itinerary || !itinerary.days) return;

    for (const stage of itinerary.days) {
      const color = DAY_COLORS[(stage.day - 1) % DAY_COLORS.length];
      const segment = sliceRouteByRealKm(route, stage.fromRealKm, stage.endRealKm);

      L.polyline(segment.map((p) => [p.lat, p.lon]), { color, weight: 5, opacity: 0.9 }).addTo(itineraryLayer);

      for (const acc of stage.accommodations) {
        const marker = L.circleMarker([acc.lat, acc.lon], {
          radius: 6,
          color,
          fillColor: color,
          fillOpacity: 0.85,
          weight: 2,
          className: "accommodation-marker",
        }).addTo(itineraryLayer);
        marker.bindPopup(buildPopupHtml(stage, acc, getLink(stage, acc)));
      }
    }
  }

  // Leaflet sizes itself from its container's on-screen dimensions at init
  // time; if the map starts out inside a display:none tab panel (mobile's
  // "Route map" tab, unselected on load) it measures as 0x0 and tiles never
  // fill in correctly even after the panel becomes visible. Call this right
  // after the panel is shown so Leaflet re-measures.
  function invalidateSize() {
    if (map) map.invalidateSize();
  }

  return { init, renderItinerary, invalidateSize, DAY_COLORS };
})();

if (typeof window !== "undefined") {
  window.TrailMap = TrailMap;
}
