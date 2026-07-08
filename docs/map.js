/**
 * Leaflet rendering for the trail map: base route line, plus per-day
 * colored segments and accommodation markers once an itinerary is planned.
 */

const DAY_COLORS = [
  "#8a4b2f", "#2f6b8a", "#4b8a2f", "#8a2f6b",
  "#2f8a7a", "#8a7a2f", "#5b2f8a", "#8a2f2f", "#2f5b8a",
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
    const baseLine = L.polyline(latlngs, { color: "#999999", weight: 3, opacity: 0.6 }).addTo(map);
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

  return { init, renderItinerary, DAY_COLORS };
})();

if (typeof window !== "undefined") {
  window.TrailMap = TrailMap;
}
