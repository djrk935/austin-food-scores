"use strict";

// Row layout from the pipeline: [id, name, address, zip, lat, lng, [[date, score, followUp], ...]]
const I = { id: 0, name: 1, addr: 2, zip: 3, lat: 4, lng: 5, insp: 6 };
const RECENT_DAYS = 90;
const AUSTIN = [-97.7431, 30.2672];
const MILE = 1609.344;
const RING_MILES = [0.25, 0.5, 0.75, 1];
const RING_LABELS = { 0.25: "¼ mi", 0.5: "½ mi", 0.75: "¾ mi", 1: "1 mi" };
const NEARBY_MILES = 0.5;

// One muted map: OpenFreeMap's positron style (no API key) patched by map-style.json.
const MAP_STYLE = "map-style.json";
const PITCH_3D = 50;
const CLUSTER_MAX_ZOOM = 13; // individual markers from zoom 14 up
const EMPTY = { type: "FeatureCollection", features: [] };

const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

const prefs = loadPrefs();
const state = {
  all: [], byId: new Map(), meta: null, points: EMPTY,
  map: null, selected: null, popup: null,
};
const $ = (sel) => document.querySelector(sel);

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’`]/g, "").replace(/[^a-z0-9 ]+/g, " ");
const parseDate = (iso) => new Date(iso + "T12:00:00");
const fmtDate = (iso) => parseDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtNum = (n) => n.toLocaleString("en-US");
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function band(score) {
  if (score == null || score === 0) return "none";
  if (score >= 90) return "good";
  if (score >= 70) return "ok";
  return "bad";
}
const BAND_TEXT = {
  good: "90 or higher, the city's top band",
  ok: "70 to 89, the city's middle band",
  bad: "under 70, the city's lowest band",
  none: "no usable score recorded",
};
const COLOR_VAR = { good: "--good", ok: "--ok", bad: "--bad", none: "--none" };

function badge(score, big = false) {
  const label = score == null ? "–" : score;
  return `<span class="badge ${band(score)}${big ? " big" : ""}" aria-label="Score ${label}">${label}</span>`;
}

function ago(iso) {
  const days = Math.round((Date.now() - parseDate(iso)) / 86400000);
  if (days < 1) return "today";
  if (days < 45) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30.4);
  if (months < 18) return `${months} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
}

const latest = (r) => r[I.insp][0];
// Rankings skip blanks and zeros: a 0 is far more likely a data-entry gap than a real result.
const rankable = (insp) => insp[1] != null && insp[1] > 0;
const hasCoords = (r) => r[I.lat] != null && r[I.lng] != null;
const lngLat = (r) => [r[I.lng], r[I.lat]];

// ---------- geometry ----------
function offset([lng, lat], dxMeters, dyMeters) {
  return [lng + dxMeters / (111320 * Math.cos((lat * Math.PI) / 180)), lat + dyMeters / 110540];
}
function circle(center, meters, steps = 128) {
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    coords.push(offset(center, meters * Math.cos(t), meters * Math.sin(t)));
  }
  return coords;
}
function distanceMeters([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

// ---------- preferences (per-viewer convenience only) ----------
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem("afs-map") || "null");
    if (saved && (saved.mode === "2d" || saved.mode === "3d")) return { mode: saved.mode };
  } catch { /* storage unavailable */ }
  return { mode: "3d" };
}
function savePrefs() {
  try { localStorage.setItem("afs-map", JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

// ---------- data ----------
async function load() {
  const [rows, meta] = await Promise.all([
    fetch("data/restaurants.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()),
  ]);
  state.all = rows;
  state.meta = meta;
  for (const r of rows) {
    r.search = norm(`${r[I.name]} ${r[I.addr]} ${r[I.zip]}`);
    r.nameKey = norm(r[I.name]);
    state.byId.set(r[I.id], r);
  }
  state.points = {
    type: "FeatureCollection",
    features: rows.filter(hasCoords).map((r) => {
      const score = latest(r)[1];
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: lngLat(r) },
        properties: { id: r[I.id], name: r[I.name], score: score ?? -1, band: band(score) },
      };
    }),
  };
  $("#tagline").textContent =
    `Health inspection scores for ${fmtNum(meta.facilities)} Austin-area food businesses, ` +
    `from official city data through ${fmtDate(meta.newestInspection)}.`;
  $("#source").innerHTML =
    `Data: <a href="${esc(meta.source)}" rel="noopener">City of Austin open data, Austin Public Health</a>. ` +
    `${fmtNum(meta.inspections)} inspections from ${fmtDate(meta.oldestInspection)} to ${fmtDate(meta.newestInspection)}.`;
}

function search(q) {
  const tokens = norm(q).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const hits = [];
  for (const r of state.all) {
    if (!tokens.every((t) => r.search.includes(t))) continue;
    const first = tokens[0];
    const rank = r.nameKey.startsWith(first) ? 0 : r.nameKey.includes(first) ? 1 : 2;
    hits.push([rank, r]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1][I.name].localeCompare(b[1][I.name]));
  return hits.slice(0, 40).map((h) => h[1]);
}

function recent() {
  const cutoff = new Date(parseDate(state.meta.newestInspection) - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  return state.all.filter((r) => rankable(latest(r)) && latest(r)[0] >= cutoff);
}

function nearby(r, miles = NEARBY_MILES) {
  if (!hasCoords(r)) return null;
  const center = lngLat(r);
  const scores = [];
  let count = 0;
  for (const other of state.all) {
    if (other === r || !hasCoords(other) || distanceMeters(center, lngLat(other)) > miles * MILE) continue;
    count++;
    const l = latest(other);
    if (rankable(l)) scores.push(l[1]);
  }
  scores.sort((a, b) => a - b);
  const median = scores.length ? scores[Math.floor(scores.length / 2)] : null;
  return { count, median, under70: scores.filter((s) => s < 70).length };
}

// ---------- views ----------
function rowHtml(r) {
  const l = latest(r);
  return `<li><a class="row" href="#/r/${encodeURIComponent(r[I.id])}">
    ${badge(l[1])}
    <span class="who"><span class="name">${esc(r[I.name])}</span><span class="addr">${esc(r[I.addr])}</span></span>
    <span class="when">${fmtDate(l[0])}</span>
  </a></li>`;
}

function renderHome() {
  const rec = recent();
  const lowest = [...rec].sort((a, b) => latest(a)[1] - latest(b)[1]).slice(0, 15);
  const perfect = rec.filter((r) => latest(r)[1] === 100).sort((a, b) => (latest(b)[0] > latest(a)[0] ? 1 : -1));
  const latestScores = state.all.map(latest).filter(rankable).map((i) => i[1]);
  const share = (pred) => {
    const n = latestScores.filter(pred).length;
    const pct = (100 * n) / latestScores.length;
    return n > 0 && pct < 1 ? `${fmtNum(n)}` : `${Math.round(pct)}%`;
  };
  const under70 = share((s) => s < 70);

  $("#view").innerHTML = `
    <div class="stats">
      <div class="stat"><b>${share((s) => s >= 90)}</b><span>scored 90+ last time</span></div>
      <div class="stat"><b>${share((s) => s >= 70 && s < 90)}</b><span>scored 70–89</span></div>
      <div class="stat"><b>${under70}</b><span>${under70.endsWith("%") ? "scored" : "places scored"} under 70</span></div>
    </div>
    <h2>Lowest scores in the last ${RECENT_DAYS} days</h2>
    <ul class="list">${lowest.map(rowHtml).join("") || '<li class="row muted">None in this period.</li>'}</ul>
    <h2>Perfect 100s in the last ${RECENT_DAYS} days <span class="muted">(${perfect.length})</span></h2>
    <ul class="list">${perfect.slice(0, 15).map(rowHtml).join("") || '<li class="row muted">None in this period.</li>'}</ul>
    <p class="note">"Last ${RECENT_DAYS} days" counts back from the newest inspection in the data (${fmtDate(state.meta.newestInspection)}). Scores of 0 or blank are left out of rankings, since they are usually missing data.</p>`;
}

function renderResults(q) {
  const hits = search(q);
  $("#view").innerHTML = hits.length
    ? `<h2>${hits.length === 40 ? "Top 40 matches" : `${hits.length} match${hits.length === 1 ? "" : "es"}`}</h2><ul class="list">${hits.map(rowHtml).join("")}</ul>`
    : `<p class="muted" style="margin-top:16px">No restaurants match “${esc(q)}”. Try part of the name, a street, or a ZIP code.</p>`;
}

function chartSvg(insp) {
  const pts = [...insp].reverse().filter((i) => i[1] != null);
  if (pts.length < 2) return "";
  const W = 560, H = 170, padL = 30, padR = 26, padT = 18, padB = 26;
  const lo = Math.min(60, ...pts.map((p) => p[1])) - 5;
  const x = (i) => padL + (i * (W - padL - padR)) / (pts.length - 1);
  const y = (s) => padT + ((100 - s) * (H - padT - padB)) / (100 - lo);
  const bandRect = (top, bottom, v) =>
    `<rect x="${padL}" y="${y(top)}" width="${W - padL - padR}" height="${Math.max(0, y(bottom) - y(top))}" fill="${cssVar(v)}" opacity="0.1"/>`;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const showDates = pts.length <= 8;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score history chart">
    ${bandRect(100, 90, "--good")}${bandRect(90, 70, "--ok")}${bandRect(70, lo, "--bad")}
    ${[100, 90, 70].map((t) => `<text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}
    <path d="${line}" fill="none" stroke="${cssVar("--muted")}" stroke-width="1.5"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p[1])}" r="5" fill="${cssVar(COLOR_VAR[band(p[1])])}"/>
      <text class="val" x="${x(i)}" y="${y(p[1]) - 9}" text-anchor="middle">${p[1]}</text>
      ${showDates ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${parseDate(p[0]).toLocaleDateString("en-US", { month: "short", year: "2-digit" })}</text>` : ""}`).join("")}
  </svg>`;
}

function nearbyHtml(r) {
  const n = nearby(r);
  if (!n) return "";
  const parts = [`<strong>${fmtNum(n.count)}</strong> other place${n.count === 1 ? "" : "s"} within ½ mile`];
  if (n.median != null) parts.push(`median latest score <strong>${n.median}</strong>`);
  if (n.under70) parts.push(`<strong>${n.under70}</strong> under 70`);
  return `<div class="nearby">
    <svg class="rings" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="3"/><circle cx="13" cy="13" r="7"/><circle cx="13" cy="13" r="11.5"/></svg>
    <p>${parts.join(" · ")}. The rings on the map mark ¼ to 1 mile.</p>
  </div>`;
}

function linksHtml(r) {
  const urls = buildMapLinks(r);
  const name = esc(r[I.name].trim());
  const items = [
    ["yelp", "View on Yelp", "on Yelp"],
    ["google", "View on Google Maps", "on Google Maps"],
    ["apple", "View in Apple Maps", "in Apple Maps"],
  ].filter(([key]) => urls[key]);
  if (!items.length) return "";
  return `<section class="outlinks" aria-label="Find this place elsewhere">
    <ul>${items.map(([key, label, where]) => `<li><a class="outlink" href="${esc(urls[key])}" target="_blank" rel="noopener noreferrer" aria-label="View ${name} ${where} (opens in a new tab)">${label}<span aria-hidden="true"> ↗</span></a></li>`).join("")}</ul>
    <p class="note">Links open third-party sites. This project is not affiliated with Yelp, Google, or Apple.</p>
  </section>`;
}

function renderDetail(id) {
  const r = state.byId.get(id);
  if (!r) {
    $("#view").innerHTML = `<p class="muted" style="margin-top:16px">That restaurant isn't in the current data. <a href="#/">Back to all restaurants</a></p>`;
    select(null);
    return;
  }
  const insp = r[I.insp];
  const l = latest(r);
  const scored = insp.filter(rankable).map((i) => i[1]);
  const avg = scored.length ? Math.round(scored.reduce((a, s) => a + s, 0) / scored.length) : null;
  const zeroNote = insp.some((i) => i[1] === 0 || i[1] == null)
    ? `<p class="note">Some inspections show a score of 0 or no score. These are usually gaps in the city's records rather than real results.</p>`
    : "";

  $("#view").innerHTML = `
    <article class="detail">
      <h1>${esc(r[I.name])}</h1>
      <p class="addr">${esc(r[I.addr])}</p>
      <div class="headline">
        ${badge(l[1], true)}
        <div>
          <p><strong>Latest score</strong>, ${BAND_TEXT[band(l[1])]}.</p>
          <p class="muted">Inspected ${fmtDate(l[0])} (${ago(l[0])})${avg != null && scored.length > 1 ? `. Average across ${scored.length} inspections: ${avg}.` : "."}</p>
        </div>
      </div>
      ${linksHtml(r)}
      ${nearbyHtml(r)}
      ${chartSvg(insp)}
      <table>
        <thead><tr><th>Date</th><th>Score</th><th>Type</th></tr></thead>
        <tbody>${insp.map((i) => `<tr><td>${fmtDate(i[0])}</td><td>${badge(i[1])}</td><td>${i[2] ? "Follow-up" : "Routine"}</td></tr>`).join("")}</tbody>
      </table>
      ${zeroNote}
      ${hasCoords(r) ? "" : `<p class="note">The city's data has no map location for this business.</p>`}
    </article>
    <a class="back" href="#/">← All restaurants</a>`;

  document.title = `${r[I.name]} – Austin Food Scores`;
  select(r);
}

// ---------- map: setup ----------
const BAND_RANGE = { good: "90–100", ok: "70–89", bad: "Under 70" };

/** Loads positron from OpenFreeMap and applies the paint/hide/add patch in map-style.json. */
async function loadMapStyle() {
  const patch = await fetch(MAP_STYLE).then((r) => r.json());
  const style = await fetch(patch.base).then((r) => r.json());
  const byId = new Map(style.layers.map((l) => [l.id, l]));
  for (const [id, paint] of Object.entries(patch.paint || {})) {
    const layer = byId.get(id);
    if (layer) layer.paint = { ...layer.paint, ...paint };
  }
  for (const id of patch.hide || []) {
    const layer = byId.get(id);
    if (layer) layer.layout = { ...layer.layout, visibility: "none" };
  }
  for (const { before, layer } of patch.add || []) {
    const i = style.layers.findIndex((l) => l.id === before);
    style.layers.splice(i < 0 ? style.layers.length : i, 0, layer);
  }
  if (patch.light) style.light = patch.light;
  return style;
}

function popupHtml(p) {
  const score = p.score >= 0 ? p.score : null;
  const b = band(score);
  const text = b === "none" ? "No score · no usable score recorded" : `${score} · ${BAND_RANGE[b]}`;
  return `<div class="pop"><strong>${esc(p.name)}</strong><span class="pop-score"><span class="swatch ${b}" aria-hidden="true"></span>${text}</span></div>`;
}

async function initMap() {
  const style = await loadMapStyle();
  const is3d = prefs.mode === "3d";
  const map = new maplibregl.Map({
    container: "map",
    style,
    center: AUSTIN,
    zoom: is3d ? 13.6 : 11,
    pitch: is3d ? PITCH_3D : 0,
    bearing: 0,
    maxPitch: 70,
    attributionControl: false,
  });
  state.map = map;
  map.addControl(new maplibregl.AttributionControl({ compact: innerWidth <= 820 }), "bottom-right");
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  map.on("style.load", onStyleLoad);
  // On small screens, start with the credits folded into their (i) button so they don't cover the legend.
  map.once("load", () => {
    if (innerWidth <= 820) document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  });
  map.on("styleimagemissing", (e) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: "300px" });
  map.on("mouseenter", "app-dots", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const f = e.features[0];
    state.popup.setLngLat(f.geometry.coordinates).setHTML(popupHtml(f.properties)).addTo(map);
  });
  map.on("mouseleave", "app-dots", () => {
    map.getCanvas().style.cursor = "";
    state.popup.remove();
  });
  map.on("click", "app-dots", (e) => {
    location.hash = `#/r/${encodeURIComponent(e.features[0].properties.id)}`;
  });
  // Clusters: clicking zooms in until the cluster splits.
  map.on("mouseenter", "app-clusters", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "app-clusters", () => { map.getCanvas().style.cursor = ""; });
  map.on("click", "app-clusters", async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource("app-points").getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom, duration: REDUCED_MOTION ? 0 : 500 });
  });

  // A restaurant link opened before the map existed: move there now, without animating.
  if (state.selected && hasCoords(state.selected)) {
    map.jumpTo({ center: lngLat(state.selected), zoom: 15 });
  }
}

/** Adds the app's sources and layers on top of the muted basemap. */
function onStyleLoad() {
  const map = state.map;
  const color = { good: cssVar("--band-good"), ok: cssVar("--band-ok"), bad: cssVar("--band-bad"), none: cssVar("--band-none") };
  const ink = cssVar("--map-ink");
  const ink2 = cssVar("--map-ink-2");
  const accent = cssVar("--map-accent");

  map.addSource("app-points", {
    type: "geojson", data: state.points,
    cluster: true, clusterRadius: 40, clusterMaxZoom: CLUSTER_MAX_ZOOM,
  });
  for (const id of ["app-rings", "app-ring-labels", "app-selected"]) {
    map.addSource(id, { type: "geojson", data: EMPTY });
  }

  map.addLayer({
    id: "app-rings", type: "line", source: "app-rings",
    paint: { "line-color": ink2, "line-width": 1 },
  });
  map.addLayer({
    id: "app-ring-labels", type: "symbol", source: "app-ring-labels",
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, -0.9], "text-allow-overlap": true },
    paint: { "text-color": ink2, "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
  });
  // Clusters are neutral (they mix bands); size steps with the count, never with a band.
  map.addLayer({
    id: "app-clusters", type: "circle", source: "app-points", filter: ["has", "point_count"],
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": ["step", ["get", "point_count"], 12, 100, 15, 500, 18],
      "circle-stroke-width": 1,
      "circle-stroke-color": ink2,
    },
  });
  map.addLayer({
    id: "app-cluster-count", type: "symbol", source: "app-points", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-allow-overlap": true },
    paint: { "text-color": ink },
  });
  // Individual facilities: band color, one size for every band, 1px outline, no glow.
  map.addLayer({
    id: "app-dots", type: "circle", source: "app-points", filter: ["!", ["has", "point_count"]],
    layout: { "circle-sort-key": ["match", ["get", "band"], "bad", 3, "ok", 2, 1] },
    paint: {
      "circle-color": ["match", ["get", "band"], "good", color.good, "ok", color.ok, "bad", color.bad, color.none],
      "circle-radius": 5,
      "circle-stroke-width": 1,
      "circle-stroke-color": ink,
    },
  });
  map.addLayer({
    id: "app-selected", type: "circle", source: "app-selected",
    paint: { "circle-radius": 10, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2, "circle-stroke-color": accent },
  });

  updateSelection();
}

// ---------- map: modes and selection ----------
function setMode(mode) {
  if (mode === prefs.mode) return;
  prefs.mode = mode;
  savePrefs();
  syncControls();
  state.map?.easeTo({ pitch: mode === "3d" ? PITCH_3D : 0, bearing: 0, duration: REDUCED_MOTION ? 0 : 800 });
}

function select(r) {
  state.selected = r;
  updateSelection();
  if (!r || !hasCoords(r) || !state.map) return;
  state.map.flyTo({
    center: lngLat(r),
    zoom: Math.max(state.map.getZoom(), 15),
    essential: false,
    duration: REDUCED_MOTION ? 0 : 1200,
  });
}

function updateSelection() {
  const map = state.map;
  if (!map || !map.getSource("app-rings")) return;
  const r = state.selected;
  if (!r || !hasCoords(r)) {
    for (const id of ["app-rings", "app-ring-labels", "app-selected"]) map.getSource(id).setData(EMPTY);
    return;
  }
  const c = lngLat(r);
  const fc = (features) => ({ type: "FeatureCollection", features });
  map.getSource("app-rings").setData(fc(RING_MILES.map((mi) => ({
    type: "Feature", properties: { miles: mi }, geometry: { type: "LineString", coordinates: circle(c, mi * MILE) },
  }))));
  map.getSource("app-ring-labels").setData(fc(RING_MILES.map((mi) => ({
    type: "Feature", properties: { label: RING_LABELS[mi] }, geometry: { type: "Point", coordinates: offset(c, 0, mi * MILE) },
  }))));
  map.getSource("app-selected").setData(fc([{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }]));
}

// ---------- controls ----------
function syncControls() {
  for (const b of document.querySelectorAll(".segmented button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === prefs.mode));
  }
}

function initControls() {
  for (const b of document.querySelectorAll(".segmented button")) {
    b.addEventListener("click", () => setMode(b.dataset.mode));
  }
  syncControls();
}

// ---------- routing ----------
function route() {
  const m = location.hash.match(/^#\/r\/(.+)$/);
  if (m) {
    renderDetail(decodeURIComponent(m[1]));
    return;
  }
  document.title = "Austin Food Scores";
  select(null);
  const q = $("#q").value.trim();
  q ? renderResults(q) : renderHome();
}

let typing;
function onSearch() {
  clearTimeout(typing);
  typing = setTimeout(() => {
    if (location.hash.startsWith("#/r/")) history.replaceState(null, "", "#/");
    route();
  }, 120);
}

(async function main() {
  try {
    await load();
  } catch (err) {
    $("#view").innerHTML = `<p class="muted">Couldn't load the inspection data. Please refresh the page.</p>`;
    console.error(err);
    return;
  }
  initControls();
  if (window.maplibregl) {
    initMap().catch((err) => {
      $("#map").innerHTML = `<p class="muted" style="padding:16px">The map didn't load. Search and lists still work.</p>`;
      console.error(err);
    });
  } else {
    $("#map").innerHTML = `<p class="muted" style="padding:16px">The map library didn't load. Search and lists still work.</p>`;
  }
  const q = $("#q");
  q.disabled = false;
  q.addEventListener("input", onSearch);
  window.addEventListener("hashchange", route);
  route();
})();
