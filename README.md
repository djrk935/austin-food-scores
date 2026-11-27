# Austin Food Scores

Search and map health inspection scores for Austin-area restaurants, built from the City of Austin's open data
([Food Establishment Inspection Scores](https://data.austintexas.gov/d/ecmv-9xxi), dataset `ecmv-9xxi`).

## Run it

Rebuild `site/data/*.json` from the latest city CSV with either pipeline. They produce the same data:

```bash
cd pipeline-rs && cargo run --release -- --download   # Rust (see pipeline-rs/README.md)
```

```bash
python3 pipeline/build.py --download                    # Python
```

During the migration, **Python is the reference implementation**: the Rust pipeline's tests compare its output
against `build.py`'s. See [pipeline-rs/SPEC.md](pipeline-rs/SPEC.md) for the exact rules.

Then serve the site:

```bash
python3 -m http.server 8790 --bind 127.0.0.1 --directory site
```

Open http://localhost:8790.

## How it fits together

- `pipeline/build.py`: Python standard library only. Downloads the city CSV, groups inspections by Facility ID,
  and writes `site/data/restaurants.json` (about 1.1 MB, about 300 KB gzipped) and `site/data/meta.json`.
- `site/`: plain HTML, CSS and JavaScript with no build step. Restaurant pages use shareable links like
  `#/r/<facility id>`.
- The map uses [MapLibre GL JS](https://maplibre.org) 5.24.1 with free vector tiles from
  [OpenFreeMap](https://openfreemap.org) (no API key):
  - **2D**: Light, Dark or Streets basemap (Match system by default), with score dots.
  - **3D**: a tilted dark city with OpenStreetMap buildings extruded by height, glowing major roads and a light beam
    over the selected restaurant.
  - **Layers**: score dots, a heatmap of scores under 90, radius rings (¼–1 mile around the selected restaurant),
    and in 3D, buildings and road glow. The viewer's choices are remembered in their browser.

## Data notes

- The city publishes the last three years of inspections. As of the last build: 6,448 facilities, 20,156 inspections,
  Nov 16, 2023 to Oct 23, 2026.
- 200 facilities have no map coordinates. They still show up in search.
- 45 inspections have no score and a few are recorded as 0. These are left out of rankings and flagged on the
  restaurant's page.
- The color bands (90+, 70–89, under 70) are the city's own categories from the dataset.

## Before going public

- OpenFreeMap allows production use without a key; keep its attribution visible (the map's ⓘ button).
- Schedule the pipeline (`cargo run --release -- --download`) to run nightly, for example with a GitHub Action, and
  deploy `site/` to a static host. Bump the `?v=` on `app.js` and `style.css` in `index.html` when they change.
