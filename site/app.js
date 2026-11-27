"use strict";

// Row layout from the pipeline: [id, name, address, zip, lat, lng, [[date, score, followUp], ...]]
const I = { id: 0, name: 1, addr: 2, zip: 3, lat: 4, lng: 5, insp: 6 };
const RECENT_DAYS = 90;
const AUSTIN = [-97.7431, 30.2672];
const MILE = 1609.344;
const RING_MILES = [0.25, 0.5, 0.75, 1];
const RING_LABELS = { 0.25: "¼ mi", 0.5: "½ mi", 0.75: "¾ mi", 1: "1 mi" };
const NEARBY_MILES = 0.5;
const PULSE_MS = 2600;

// Free vector maps from OpenFreeMap (no API key). Their tile source supplies the attribution.
const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
  streets: "https://tiles.openfreemap.org/styles/liberty",
};

// Map colors are fixed (not CSS variables) so they read the same on every basemap.
const DOT = { good: "#22c55e", ok: "#f59e0b", bad: "#ef4444", none: "#94a3b8" };
const MAJOR_ROADS = ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary"], true, false];
const EMPTY = { type: "FeatureCollection", features: [] };

const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const DARK_SCHEME = matchMedia("(prefers-color-scheme: dark)");

const prefs = loadPrefs();
const state = {
  all: [], byId: new Map(), meta: null, points: EMPTY,
  map: null, styleKey: null, selected: null, popup: null, pulseFrame: 0,
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
function square(center, half) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, y]) => offset(center, x * half, y * half));
}
function distanceMeters([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

// ---------- preferences (per-viewer convenience only) ----------
function loadPrefs() {
  const defaults = { mode: "2d", basemap: "auto", layers: { dots: true, heat: false, rings: true, buildings: true, roads: true } };
  try {
    const saved = JSON.parse(localStorage.getItem("afs-map") || "null");
    if (saved && typeof saved === "object") {
      return { ...defaults, ...saved, layers: { ...defaults.layers, ...(saved.layers || {}) } };
    }
  } catch { /* storage unavailable */ }
  return defaults;
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
function styleKey() {
  if (prefs.mode === "3d") return "dark";
  if (prefs.basemap === "auto") return DARK_SCHEME.matches ? "dark" : "light";
  return prefs.basemap;
}

function initMap() {
  state.styleKey = styleKey();
  const is3d = prefs.mode === "3d";
  const map = new maplibregl.Map({
    container: "map",
    style: STYLES[state.styleKey],
    center: AUSTIN,
    zoom: is3d ? 14.6 : 11,
    pitch: is3d ? 62 : 0,
    bearing: is3d ? -24 : 0,
    maxPitch: 75,
    attributionControl: false,
  });
  state.map = map;
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  map.on("style.load", onStyleLoad);
  // On small screens, start with the credits folded into their (i) button so they don't cover the legend.
  map.once("load", () => {
    if (innerWidth <= 820) document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  });
  // The dark style references pattern images its sprite doesn't include; draw nothing for them.
  map.on("styleimagemissing", (e) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: "300px" });
  for (const layer of ["app-dots", "app-dots-glow"]) {
    map.on("mouseenter", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features[0];
      const score = f.properties.score >= 0 ? f.properties.score : null;
      state.popup
        .setLngLat(f.geometry.coordinates)
        .setHTML(`<div class="pop"><strong>${esc(f.properties.name)}</strong>${badge(score)}</div>`)
        .addTo(map);
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      state.popup.remove();
    });
    map.on("click", layer, (e) => {
      location.hash = `#/r/${encodeURIComponent(e.features[0].properties.id)}`;
    });
  }
}

/** Runs after every style load: custom sources and layers don't survive setStyle(). */
function onStyleLoad() {
  const map = state.map;
  const dark = state.styleKey === "dark";
  const ink = dark ? "#e0f2fe" : "#075985";
  const halo = dark ? "rgba(7,11,20,0.85)" : "rgba(255,255,255,0.9)";
  // Insert below the labels but above every road and building layer: some styles put a water-name
  // label before their roads, so "the first symbol layer" would hide the glow under the roads.
  const styleLayers = map.getStyle().layers;
  let lastShape = -1;
  styleLayers.forEach((l, i) => { if (l.type !== "symbol") lastShape = i; });
  const labels = styleLayers.slice(lastShape + 1).find((l) => l.type === "symbol")?.id;
  const bandColor = ["match", ["get", "band"], "good", DOT.good, "ok", DOT.ok, "bad", DOT.bad, DOT.none];

  map.addSource("app-points", { type: "geojson", data: state.points });
  for (const id of ["app-rings", "app-ring-labels", "app-pulse", "app-beacon", "app-selected"]) {
    map.addSource(id, { type: "geojson", data: EMPTY });
  }

  // Under the map labels: roads, buildings, heatmap.
  map.addLayer({
    id: "app-road-glow", type: "line", source: "openmaptiles", "source-layer": "transportation", filter: MAJOR_ROADS,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#38bdf8",
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 14, 9, 17, 22],
      "line-blur": ["interpolate", ["linear"], ["zoom"], 11, 2, 17, 10],
      "line-opacity": 0.6,
    },
  }, labels);
  map.addLayer({
    id: "app-road-core", type: "line", source: "openmaptiles", "source-layer": "transportation", filter: MAJOR_ROADS,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#f0f9ff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 14, 1.4, 17, 3],
      "line-opacity": 0.9,
    },
  }, labels);
  map.addLayer({
    id: "app-buildings", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 13,
    filter: ["!", ["has", "hide_3d"]],
    paint: {
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0],
        0, "#2f4060", 15, "#3a5079", 50, "#4f6e9e", 120, "#7499cb", 250, "#b3d8f8"],
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, ["coalesce", ["get", "render_height"], 0]],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.9,
      "fill-extrusion-vertical-gradient": true,
    },
  }, labels);
  map.addLayer({
    id: "app-heat", type: "heatmap", source: "app-points",
    filter: ["all", [">", ["get", "score"], 0], ["<", ["get", "score"], 90]],
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "score"], 60, 1, 89, 0.12],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 15, 2.2],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 12, 15, 38],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0,0,0,0)", 0.2, "rgba(251,191,36,0.35)", 0.5, "rgba(249,115,22,0.6)", 0.8, "rgba(239,68,68,0.78)", 1, "rgba(190,18,60,0.9)"],
      "heatmap-opacity": 0.85,
    },
  }, labels);

  // On top of everything: rings, dots, selection.
  map.addLayer({
    id: "app-rings", type: "line", source: "app-rings",
    paint: { "line-color": ink, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 16, 2.2], "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "app-pulse", type: "line", source: "app-pulse",
    paint: { "line-color": ink, "line-width": 3, "line-blur": 1.5, "line-opacity": ["get", "fade"] },
  });
  map.addLayer({
    id: "app-ring-labels", type: "symbol", source: "app-ring-labels",
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, -0.9], "text-allow-overlap": true },
    paint: { "text-color": ink, "text-halo-color": halo, "text-halo-width": 1.6 },
  });
  map.addLayer({
    id: "app-dots-glow", type: "circle", source: "app-points",
    paint: {
      "circle-color": bandColor,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 9, 18, 16],
      "circle-blur": 1,
      "circle-opacity": 0.4,
    },
  });
  map.addLayer({
    id: "app-dots", type: "circle", source: "app-points",
    layout: { "circle-sort-key": ["match", ["get", "band"], "bad", 3, "ok", 2, 1] },
    paint: {
      "circle-color": bandColor,
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        10, ["match", ["get", "band"], "bad", 4, 2.6],
        14, ["match", ["get", "band"], "bad", 8, 5.5],
        18, ["match", ["get", "band"], "bad", 13, 10]],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 15, 1.4],
      "circle-stroke-color": dark ? "rgba(7,11,20,0.9)" : "rgba(255,255,255,0.95)",
      "circle-opacity": 0.95,
    },
  });
  map.addLayer({
    id: "app-beacon", type: "fill-extrusion", source: "app-beacon",
    paint: { "fill-extrusion-color": ["match", ["get", "band"], "good", DOT.good, "ok", DOT.ok, "bad", DOT.bad, "#38bdf8"], "fill-extrusion-height": 320, "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.85 },
  });
  map.addLayer({
    id: "app-selected", type: "circle", source: "app-selected",
    paint: { "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3, "circle-stroke-color": "#38bdf8" },
  });

  if (dark) {
    try {
      map.setSky({
        "sky-color": "#050a16", "horizon-color": "#12304f", "fog-color": "#070b14",
        "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.75,
      });
    } catch { /* sky unsupported */ }
  }
  try { map.setLight({ anchor: "viewport", color: "#dbeafe", intensity: 0.35, position: [1.4, 210, 50] }); } catch { /* ignore */ }

  applyVisibility();
  updateSelection();
}

function applyVisibility() {
  const map = state.map;
  if (!map || !map.getLayer("app-dots")) return;
  const is3d = prefs.mode === "3d";
  const L = prefs.layers;
  const show = (id, on) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("app-road-glow", is3d && L.roads);
  show("app-road-core", is3d && L.roads);
  show("app-buildings", is3d && L.buildings);
  show("app-heat", L.heat);
  show("app-rings", L.rings);
  show("app-ring-labels", L.rings);
  show("app-pulse", L.rings && !REDUCED_MOTION);
  show("app-dots-glow", is3d && L.dots);
  show("app-dots", L.dots);
  show("app-beacon", is3d);
  // Smaller dots in 3D so the buildings and roads stay readable.
  map.setPaintProperty("app-dots", "circle-radius", is3d
    ? ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "band"], "bad", 3.5, 2.2], 15, ["match", ["get", "band"], "bad", 6, 3.6], 18, ["match", ["get", "band"], "bad", 9, 6]]
    : ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "band"], "bad", 4, 2.6], 14, ["match", ["get", "band"], "bad", 8, 5.5], 18, ["match", ["get", "band"], "bad", 13, 10]]);
}

/** Switch basemap if the mode or style choice needs a different one. */
function ensureStyle() {
  const key = styleKey();
  if (key === state.styleKey) return;
  state.styleKey = key;
  state.popup?.remove();
  state.map.setStyle(STYLES[key]);
}

// ---------- map: modes and selection ----------
function setMode(mode) {
  if (mode === prefs.mode) return;
  prefs.mode = mode;
  savePrefs();
  syncControls();
  ensureStyle();
  applyVisibility();
  const map = state.map;
  const target = state.selected && hasCoords(state.selected) ? lngLat(state.selected) : null;
  const duration = REDUCED_MOTION ? 0 : 1800;
  if (mode === "3d") {
    const zoomedOut = map.getZoom() < 12.5;
    map.easeTo({
      center: target ?? (zoomedOut ? AUSTIN : map.getCenter()),
      zoom: Math.max(map.getZoom(), target ? 15.4 : 14.6),
      pitch: 62, bearing: -24, duration,
    });
  } else {
    map.easeTo({ pitch: 0, bearing: 0, duration });
  }
}

function select(r) {
  state.selected = r;
  updateSelection();
  if (!r || !hasCoords(r) || !state.map) return;
  const is3d = prefs.mode === "3d";
  state.map.flyTo({
    center: lngLat(r),
    zoom: Math.max(state.map.getZoom(), is3d ? 15.4 : 14.5),
    pitch: is3d ? 62 : 0,
    essential: false,
    duration: REDUCED_MOTION ? 0 : 1600,
  });
}

function updateSelection() {
  const map = state.map;
  if (!map || !map.getSource("app-rings")) return;
  const r = state.selected;
  if (!r || !hasCoords(r)) {
    for (const id of ["app-rings", "app-ring-labels", "app-pulse", "app-beacon", "app-selected"]) map.getSource(id).setData(EMPTY);
    stopPulse();
    return;
  }
  const c = lngLat(r);
  const b = band(latest(r)[1]);
  const fc = (features) => ({ type: "FeatureCollection", features });
  map.getSource("app-rings").setData(fc(RING_MILES.map((mi) => ({
    type: "Feature", properties: { miles: mi }, geometry: { type: "LineString", coordinates: circle(c, mi * MILE) },
  }))));
  map.getSource("app-ring-labels").setData(fc(RING_MILES.map((mi) => ({
    type: "Feature", properties: { label: RING_LABELS[mi] }, geometry: { type: "Point", coordinates: offset(c, 0, mi * MILE) },
  }))));
  map.getSource("app-beacon").setData(fc([{ type: "Feature", properties: { band: b }, geometry: { type: "Polygon", coordinates: [square(c, 9)] } }]));
  map.getSource("app-selected").setData(fc([{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }]));
  startPulse();
}

function startPulse() {
  if (REDUCED_MOTION || state.pulseFrame) return;
  const tick = (t) => {
    state.pulseFrame = requestAnimationFrame(tick);
    const source = state.map?.getSource("app-pulse");
    const r = state.selected;
    if (!source || !r || !hasCoords(r) || !prefs.layers.rings) return;
    const p = (t % PULSE_MS) / PULSE_MS;
    const eased = 1 - (1 - p) ** 2;
    source.setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { fade: 0.9 * (1 - p) }, geometry: { type: "LineString", coordinates: circle(lngLat(r), Math.max(1, eased * MILE), 96) } }],
    });
  };
  state.pulseFrame = requestAnimationFrame(tick);
}
function stopPulse() {
  if (state.pulseFrame) cancelAnimationFrame(state.pulseFrame);
  state.pulseFrame = 0;
}

// ---------- controls ----------
function syncControls() {
  for (const b of document.querySelectorAll(".segmented button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === prefs.mode));
  }
  const form = $("#layers");
  const is3d = prefs.mode === "3d";
  for (const input of form.querySelectorAll('input[name="basemap"]')) {
    input.checked = input.value === prefs.basemap;
    input.disabled = is3d;
    input.parentElement.classList.toggle("is-disabled", is3d);
  }
  $("#basemap-note").hidden = !is3d;
  for (const [name, on] of Object.entries(prefs.layers)) {
    const input = form.elements[name];
    if (input) input.checked = on;
  }
  for (const label of form.querySelectorAll(".only-3d")) {
    label.classList.toggle("is-disabled", !is3d);
    label.querySelector("input").disabled = !is3d;
  }
}

function initControls() {
  for (const b of document.querySelectorAll(".segmented button")) {
    b.addEventListener("click", () => setMode(b.dataset.mode));
  }
  const toggle = $("#layers-toggle");
  const form = $("#layers");
  toggle.addEventListener("click", () => {
    const open = form.hidden;
    form.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !form.hidden) {
      form.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    }
  });
  form.addEventListener("change", (e) => {
    const input = e.target;
    if (input.name === "basemap") {
      prefs.basemap = input.value;
      ensureStyle();
    } else if (input.name in prefs.layers) {
      prefs.layers[input.name] = input.checked;
      applyVisibility();
      if (input.name === "rings") updateSelection();
    }
    savePrefs();
  });
  DARK_SCHEME.addEventListener("change", () => {
    if (prefs.mode === "2d" && prefs.basemap === "auto") ensureStyle();
  });
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
    initMap();
  } else {
    $("#map").innerHTML = `<p class="muted" style="padding:16px">The map library didn't load. Search and lists still work.</p>`;
  }
  const q = $("#q");
  q.disabled = false;
  q.addEventListener("input", onSearch);
  window.addEventListener("hashchange", route);
  route();
})();
