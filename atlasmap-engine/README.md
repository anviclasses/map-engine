# AtlasMap Engine

An interactive, drill-down **study atlas** for Indian competitive-exam
preparation. Host it once on GitHub → serve anywhere via the jsDelivr CDN →
embed in Blogger (or any site) exactly like the AI MCQs quiz engine.

Students click through **World → Country → State → District**, see clear
boundaries at every level, read curated exam facts in a side panel, and
explore **popular locations** (monuments, capitals, exam-relevant sites) as
pin-blocks on the map.

The engine is a single self-contained SVG cartographic renderer — **no Leaflet,
no Google Maps, no d3, no API key**. Every boundary is drawn from the data JSON
you host, so it loads fast and runs anywhere a `<script>` tag is allowed.

```
atlasmap-engine/
├── atlasmap.css         ← all styles (scoped to .atlasmap — multiple maps/page OK)
├── atlasmap.js          ← engine: initAtlasMap + loadAtlasMapFromUrl
├── embed-snippet.html   ← ready-to-paste code for Blogger / any site
├── demo.html            ← open locally to see World → India → UP drill-down
├── README.md
└── data/
    ├── world.json          ← 176 countries (choropleth: population)
    ├── india.json          ← 36 states/UTs (choropleth: Lok Sabha seats)
    └── uttar-pradesh.json   ← 75 districts (headquarters · division)
```

---

## How it mirrors the AI MCQs engine

| AI MCQs engine | AtlasMap engine |
|----------------|-----------------|
| `aimcq.css` + `aimcq.js` on GitHub → jsDelivr | `atlasmap.css` + `atlasmap.js` on GitHub → jsDelivr |
| Question JSONs hosted on GitHub, fetched at runtime | Map JSONs hosted on GitHub, fetched at runtime |
| `window.initAimcqQuiz(id, json, settings)` | `window.initAtlasMap(id, json, settings)` |
| `window.loadAimcqFromDrive(id, {jsonUrl, …})` | `window.loadAtlasMapFromUrl(id, {jsonUrl, settings})` |
| Paste HEAD BLOCK once + QUIZ BLOCK per post | Paste HEAD BLOCK once + MAP BLOCK per post |

If you already publish quizzes the aimcq way, you already know how to publish
maps here.

---

## 1 — Push to GitHub & create a release tag

```bash
git init
git add atlasmap.css atlasmap.js embed-snippet.html README.md data
git commit -m "v1.0.0 — initial CDN release"
git remote add origin https://github.com/YOUR-USER/atlasmap-engine.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

## 2 — CDN URLs (live ~10 min after tagging)

```
https://cdn.jsdelivr.net/gh/YOUR-USER/atlasmap-engine@1.0.0/atlasmap.css
https://cdn.jsdelivr.net/gh/YOUR-USER/atlasmap-engine@1.0.0/atlasmap.js
https://cdn.jsdelivr.net/gh/YOUR-USER/atlasmap-engine@1.0.0/data/world.json
https://cdn.jsdelivr.net/gh/YOUR-USER/atlasmap-engine@1.0.0/data/india.json
https://cdn.jsdelivr.net/gh/YOUR-USER/atlasmap-engine@1.0.0/data/uttar-pradesh.json
```

Use `@1.0.0` (a tag) for stable embeds. `@latest` always tracks your newest
release; `@main` tracks the branch (handy while developing).

## 3 — Embed in Blogger

1. **Once per blog:** Theme → Edit HTML → paste the **HEAD BLOCK** from
   `embed-snippet.html` just before `</head>` (or before `</body>`).
2. **Per post:** switch the post editor to **HTML view** and paste a
   **MAP BLOCK**. Done.

Full ready-to-paste code (three methods) is in `embed-snippet.html`.

---

## Public API

```js
// Inline JSON — you already have the level data in the page
window.initAtlasMap(containerId, mapDataJSON, settings);

// Remote JSON — fetch a level file, drill-down fetches children automatically
window.loadAtlasMapFromUrl(containerId, { jsonUrl: "…/world.json", settings: {…} });
```

### `settings`

| key | default | meaning |
|-----|---------|---------|
| `title` | from JSON | heading shown above the map |
| `subtitle` | from JSON | sub-heading |
| `height` | `null` (auto) | map height in px |
| `show_search` | `true` | region search box |
| `show_legend` | `true` | choropleth colour legend |
| `show_locations` | `true` | popular-location pins + blocks |
| `enable_zoom` | `true` | wheel-zoom + drag-pan |
| `attribution` | Natural Earth · india-maps-data | footer credit line |
| `onSelect` | `null` | `function({level, region|location})` callback |
| `resolve` | `null` | `function(ref)` → JSON / Promise / null. Override how child & parent files are obtained (e.g. serve from a bundled object instead of fetching). |
| `urlTransform` | `null` | `function(url)` → url. Rewrite child/parent URLs before fetch (the demo uses this to load local files). |

---

## Drill-down: how levels link together

Navigation is **driven entirely by the data**, not hard-coded:

- **Down:** a region that has children carries a `child` pointer:
  ```json
  "child": { "level": "country", "url": ".../india.json", "label": "Explore India →" }
  ```
  Click it → the engine fetches that file and pushes a new level.
- **Up:** each file names its `parent`:
  ```json
  "parent": { "id": "world", "name": "World", "url": ".../world.json" }
  ```
  The breadcrumb uses it to step back up.

So adding a new drill-down is just: **host a JSON, then point a `child.url`
at it.** No code changes.

---

## Data JSON schema

One file = one map level.

```jsonc
{
  "version": 1,
  "type": "atlasmap",
  "level": "country",                 // world | country | state | district …
  "id": "india",
  "name": "India",
  "subtitle": "States & Union Territories",
  "parent": { "id": "world", "name": "World", "url": ".../world.json" },

  // Which facts appear in the side panel + drive the choropleth.
  "data_fields": [
    { "key": "capital",         "label": "Capital" },
    { "key": "lok_sabha_seats", "label": "Lok Sabha seats", "type": "number",
      "choropleth": true },
    { "key": "official_language","label": "Official language", "wide": true }
  ],
  "default_metric": "lok_sabha_seats", // which numeric field colours the map

  "regions": [
    {
      "id": "up",
      "name": "Uttar Pradesh",
      "facts": {
        "capital": "Lucknow",
        "formation_year": 1950,
        "official_language": "Hindi",
        "lok_sabha_seats": 80
      },
      "child": { "level": "state", "url": ".../uttar-pradesh.json",
                 "label": "Explore districts →" },
      "geometry": { "type": "Polygon", "coordinates": [ … ] }, // GeoJSON lon,lat
      "centroid": [80.9, 26.8],
      "bbox": [77.0, 23.8, 84.6, 30.4],
      "highlight": false
    }
  ],

  "locations": [
    {
      "id": "taj-mahal",
      "name": "Taj Mahal",
      "category": "UNESCO World Heritage",
      "coordinates": [78.0421, 27.1751],   // lon, lat
      "facts": { "city": "Agra", "built_by": "Shah Jahan", "year": "1632–1653" },
      "note": "Mughal mausoleum; a frequent art-&-culture GK topic."
    }
  ]
}
```

**Field notes**

- `geometry` is standard GeoJSON (`Polygon` or `MultiPolygon`), coordinates in
  `[longitude, latitude]`. The engine projects with Web-Mercator and auto-fits
  the view — you don't supply pixel coordinates.
- `data_fields[*].type: "number"` + `choropleth: true` makes a field eligible
  to colour the map; `default_metric` picks the active one. A metric dropdown
  appears automatically when more than one numeric field is choropleth-able.
- `data_fields[*].wide: true` gives a long value its own full-width row in the
  fact panel.
- `locations` are point features shown as pins on the map and as tappable
  blocks beside it. Set `show_locations:false` to hide them.
- Omit `child` for a leaf region (e.g. a district with no deeper level).

---

## Adding more of the atlas

The starter ships World + India + Uttar Pradesh as a complete vertical slice.
To extend it:

1. **Add a state's districts** — create `data/maharashtra.json` (`level:"state"`,
   `parent` → india.json), then in `india.json` give Maharashtra a
   `child.url` pointing at it. That's it.
2. **Add another country's states** — same pattern under `world.json`.
3. **Add popular locations** — append to a file's `locations` array.

A tiny build helper (`build_geo.py` + `build_data.py`, included in the project
history) shows how the shipped boundaries were dissolved from open district
data and merged with curated exam facts — useful if you want to script new
levels rather than hand-author geometry.

---

## Accuracy & attribution

- Exam facts (capitals, formation years, official languages, Lok Sabha seats,
  district headquarters) are curated from standard GK references and meant as
  an **accurate, extendable starter** — verify against the latest official
  sources before an exam, as administrative details change.
- Boundaries:
  - World — **Natural Earth** (public domain).
  - India states & Uttar Pradesh districts — dissolved/derived from
    **india-maps-data** (ODbL). Keep the attribution line if you reuse them.

Boundaries are simplified for fast web rendering and are **for study, not for
legal or survey use**.
