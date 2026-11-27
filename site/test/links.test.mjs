// Run with: node --test "site/test/*.test.mjs"   (no packages needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildMapLinks } = require("../links.js");

const rec = (name, addr, lat = null, lng = null) => ["1", name, addr, "", lat, lng, []];
const params = (u) => Object.fromEntries(new URL(u).searchParams);
const noBadTokens = (links) => {
  for (const u of Object.values(links)) {
    if (u) assert.doesNotMatch(u, /=(undefined|null|NaN)(&|$)|%2C(undefined|null|NaN)/);
  }
};

test("coords + address", () => {
  const l = buildMapLinks(rec("04 Lounge, The", "3808 S Congress Ave Austin, TX 78704-7218", 30.22565, -97.76274));
  assert.equal(l.google, "https://www.google.com/maps/search/?api=1&query=30.22565%2C-97.76274");
  assert.equal(l.apple, "https://maps.apple.com/?q=04+Lounge%2C+The&ll=30.22565%2C-97.76274");
  assert.equal(l.yelp, "https://www.yelp.com/search?find_desc=04+Lounge%2C+The&find_loc=3808+S+Congress+Ave+Austin%2C+TX+78704-7218");
});

test("coords, no address", () => {
  const l = buildMapLinks(rec("Cafe", "  ", 30.1, -97.2));
  assert.deepEqual(params(l.google), { api: "1", query: "30.1,-97.2" });
  assert.deepEqual(params(l.apple), { q: "Cafe", ll: "30.1,-97.2" });
  assert.deepEqual(params(l.yelp), { find_desc: "Cafe", find_loc: "Austin, TX" });
});

test("address, no coords", () => {
  const l = buildMapLinks(rec("290 Express", "9520 Highway 290 W Unit A Austin, TX 78736-7826"));
  const q = "290 Express, 9520 Highway 290 W Unit A Austin, TX 78736-7826";
  assert.deepEqual(params(l.google), { api: "1", query: q });
  assert.deepEqual(params(l.apple), { q });
  assert.deepEqual(params(l.yelp), { find_desc: "290 Express", find_loc: "9520 Highway 290 W Unit A Austin, TX 78736-7826" });
});

test("name only", () => {
  const l = buildMapLinks(rec("Cafe", null));
  assert.deepEqual(params(l.google), { api: "1", query: "Cafe" });
  assert.deepEqual(params(l.apple), { q: "Cafe" });
  assert.deepEqual(params(l.yelp), { find_desc: "Cafe", find_loc: "Austin, TX" });
  noBadTokens(l);
});

test("empty or whitespace name hides all links", () => {
  for (const n of ["", "   ", null, undefined]) {
    assert.deepEqual(buildMapLinks(rec(n, "1 Main St", 30, -97)), { yelp: null, google: null, apple: null });
  }
});

test("NaN / partial coordinates fall back to the address", () => {
  const l = buildMapLinks(rec("Cafe", "1 Main St", NaN, -97));
  assert.deepEqual(params(l.apple), { q: "Cafe, 1 Main St" });
  noBadTokens(l);
});

test("special characters round-trip", () => {
  for (const name of ["Tom & Jerry's", "Bar #2", 'The "Best" Tacos', "Café Ñandú 東京", "NaN Noodles"]) {
    const l = buildMapLinks(rec(name, "1 Main St Austin, TX", 30.2, -97.7));
    assert.equal(params(l.yelp).find_desc, name);
    assert.equal(params(l.apple).q, name);
    for (const u of Object.values(l)) assert.doesNotMatch(u, /[ "#']/); // all encoded
  }
});
