"use strict";
// Deep links to Yelp, Google Maps and Apple Maps for one restaurant record
// ([id, name, addr, zip, lat, lng, inspections]). Builds URLs only: nothing is
// fetched from these services. A link that can't be built safely is null.

function buildMapLinks(r) {
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const name = text(r && r[1]);
  if (!name) return { yelp: null, google: null, apple: null };
  const addr = text(r[2]);
  const lat = r[4];
  const lng = r[5];
  const coords = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : null;
  const nameAddr = addr ? `${name}, ${addr}` : name;

  // Every value must be a non-empty string that isn't a stringified missing
  // value. (Names like "NaN Noodles" are real, so only whole values are checked.)
  const bad = (v) => typeof v !== "string" || !v || /^(undefined|null|NaN)$/.test(v) || /(^|,)(undefined|null|NaN)(,|$)/.test(v);
  const url = (base, params) =>
    Object.values(params).some(bad) ? null : `${base}?${new URLSearchParams(params)}`;

  return {
    google: url("https://www.google.com/maps/search/", { api: "1", query: coords || nameAddr }),
    apple: url("https://maps.apple.com/", coords ? { q: name, ll: coords } : { q: nameAddr }),
    yelp: url("https://www.yelp.com/search", { find_desc: name, find_loc: addr || "Austin, TX" }),
  };
}

if (typeof module !== "undefined") module.exports = { buildMapLinks };
