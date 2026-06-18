# Interactive Map Portal Engine

A drill-down geography atlas for students. **Host once on GitHub → serve anywhere via jsDelivr CDN**, with map **data JSONs hosted on GitHub and fetched at runtime** — the same hosting model as the AI-MCQ Quiz Engine.

Levels drill down cleanly:

```
World ▸ Countries  →  Country ▸ States  →  State ▸ Districts  →  District ▸ Popular locations
```

At every level a side **gazetteer panel** shows the region's data: human demography (population, sex ratio, literacy, density…), popular places, popular institutions, agriculture & lands, and forests & wildlife, plus exam notes. Built on **MapLibre GL JS** (no API key, no tile bill — the default look is a clean vector atlas).

## Repository structure

```
mapportal-engine/
├── mapportal.css        ← all styles (scoped to #mapportal-root-scope)
├── mapportal.js         ← engine (initMapPortal + loadMapPortal)
├── embed-snippet.html   ← ready-to-paste code for Blogger / WordPress / HTML
└── README.md
india-exam-map.json      ← example rich data file (Indian competitive exams)
```

## 1 — Push to GitHub & tag a release

```bash
git init
git add mapportal.css mapportal.js india-exam-map.json README.md
git commit -m "v1.0.0 — initial release"
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

## 2 — CDN URLs (live ~10 min after tagging)

```
https://cdn.jsdelivr.net/gh/YOUR-USER/YOUR-REPO@v1.0.0/mapportal.css
https://cdn.jsdelivr.net/gh/YOUR-USER/YOUR-REPO@v1.0.0/mapportal.js
https://cdn.jsdelivr.net/gh/YOUR-USER/YOUR-REPO@v1.0.0/india-exam-map.json
```

> Always pin a version tag. Never use `@latest` in production.

## 3 — Embed on any site

See `embed-snippet.html` for the full copy-paste block.

**Head tags (once per site):**
```html
<link  rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<link  rel="stylesheet" href="https://cdn.jsdelivr.net/gh/YOUR-USER/YOUR-REPO@v1.0.0/mapportal.css">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/gh/YOUR-USER/YOUR-REPO@v1.0.0/mapportal.js"></script>
```

**Map block — remote JSON (recommended):**
```html
<div id="map-portal-1" style="height:620px"></div>
<script>
document.addEventListener('DOMContentLoaded', function () {
  window.loadMapPortal('map-portal-1', {
    jsonUrl: 'https://cdn.jsdelivr.net/gh/YOUR-USER/YOUR-REPO@v1.0.0/india-exam-map.json',
    settings: { basemap: 'none', start: 'world', show_labels: true }
  });
});
</script>
```

> The wrapper `div` **must** have a height, or the map renders at zero pixels.

## Public API

| Function | Use |
|----------|-----|
| `initMapPortal(containerId, dataJSON, settings)` | Render from data already in the page (inline JSON). |
| `loadMapPortal(containerId, { jsonUrl, settings })` | Fetch a JSON file from a URL, then render. |
| `loadMapPortal(containerId, { jsonUrls:[...], settings })` | Fetch several files; `meta` from the first, all `nodes` merged. |

Both return `{ map, goTo(nodeId) }` so you can script the MapLibre instance or jump to a node.

### Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `basemap` | `'none'` | `'none'` = clean atlas (no tiles, no key). `'osm'` = OpenStreetMap street tiles underneath. |
| `start` | `meta.root` | Node id to open first. |
| `show_labels` | `true` | Show region name chips on the map. |
| `max_label_features` | `90` | Above this many regions, chips are hidden (hover tooltip still works) to cut clutter. |
| `height` | container height | Optional CSS height applied to the portal. |

## Data JSON format

A portal file is a **node graph**: a `meta` block plus a flat `nodes` dictionary keyed by id.

```jsonc
{
  "version": "1.0",
  "portal_type": "interactive_map_portal",
  "meta": {
    "title": "India Geography Explorer",
    "attribution": "Boundaries: …",
    "root": "world"            // id of the node opened on load
  },
  "nodes": {
    "world": {
      "id": "world",
      "name": "World",
      "level": "World",          // shown as the panel "stamp" (World/Country/State/District/Place)
      "parent": null,            // id of parent node, or null for the root
      "view": {                  // camera for this level
        "center": [78, 20],      // [lng, lat]
        "zoom": 2.4,
        "bounds": [40, 0, 110, 42] // [west, south, east, north] — used with fitBounds when present
      },
      "children": ["india"],     // ids of nodes one level down
      "boundaries": {            // GeoJSON FeatureCollection of the CHILD regions to draw
        "type": "FeatureCollection",
        "features": [
          {
            "type": "Feature",
            "properties": {
              "nodeId": "india", // ← links this shape to the child node (click to drill)
              "name": "India",
              "center": [80, 22],          // label position [lng, lat]
              "bounds": [68, 6, 97, 37]    // optional, used when drilling in
            },
            "geometry": { "type": "Polygon", "coordinates": [ /* … */ ] }
          }
        ]
      },
      "data": { /* see below */ }
    },

    "in-uttar-pradesh": {
      "id": "in-uttar-pradesh", "name": "Uttar Pradesh", "level": "State",
      "parent": "india",
      "view": { "center": [80.9, 27.0], "zoom": 6, "bounds": [77.1,23.9,84.6,30.4] },
      "children": ["up-lucknow", "up-varanasi", "up-agra"],
      "boundaries": { /* FeatureCollection of district shapes */ },
      "data": { /* … */ }
    },

    "up-agra": {
      "id": "up-agra", "name": "Agra", "level": "District",
      "parent": "in-uttar-pradesh",
      "view": { "center": [78.02, 27.18], "zoom": 11, "bounds": [77.9,27.05,78.15,27.3] },
      "boundaries": null,        // leaf level — no child polygons
      "locations": [             // POPULAR LOCATIONS rendered as clickable blocks
        {
          "id": "taj-mahal",
          "name": "Taj Mahal",
          "type": "UNESCO",
          "center": [78.0421, 27.1751],
          "data": { "summary": "White-marble mausoleum…", "exam_facts": ["…"] }
        }
      ],
      "data": { /* … */ }
    }
  }
}
```

### The `data` block (rendered in the gazetteer panel)

Every field is optional; only the sections present are shown.

```jsonc
"data": {
  "summary": "One-line description shown under the title.",

  "demography": [                       // → "Human demography" stat table
    { "label": "Population (2011)", "value": "199,812,341", "note": "Census 2011" },
    { "label": "Sex ratio", "value": "912", "note": "females per 1000 males" }
  ],

  "popular_places": [                   // → "Popular places"
    { "name": "Taj Mahal", "type": "UNESCO", "note": "Mughal mausoleum." }
  ],

  "institutions": [                     // → "Popular institutions"
    { "name": "IIT Kanpur", "type": "Engineering", "note": "Est. 1959." }
  ],

  "agriculture": [                      // → "Agriculture & lands"
    { "name": "Sugarcane", "note": "India's largest producer." }
  ],

  "forests_wildlife": [                 // → "Forests & wildlife"
    { "name": "Dudhwa National Park", "type": "Tiger Reserve", "note": "Tarai region." }
  ],

  "exam_facts": [                       // → "Exam notes" (bullet list)
    "UP sends the most members to the Lok Sabha (80 seats)."
  ]
}
```

### How drilling works

* The engine draws the **current node's `boundaries`** as filled, outlined regions with name chips.
* **Hover** highlights a region and shows a tooltip; **click** opens that child's profile in the panel.
* If the clicked child can expand (it has `boundaries`, `children`, or `locations`), the panel shows an **Explore →** button that drills in and flies the camera to the child's `bounds`.
* At a leaf node, `locations` are drawn as clickable **blocks**; clicking one shows that place's `data`.
* The **breadcrumb** at the top walks back up via each node's `parent`.

### Splitting a big atlas across files

Host a base file (world + country + state outlines) and one file per state's districts, then list them in `jsonUrls`. Files are merged by combining their `nodes` objects, so a state node in the base file and its district nodes in another file link up automatically through `parent`/`children`/`nodeId`.

## Example data file

`india-exam-map.json` ships as a working example for **UPSC / SSC / State PSC / Railways / Banking / Defence** prep:

* **World** — India + 8 neighbours, with border facts (Radcliffe Line, LAC, Durand Line…).
* **India** — all 28 states + 8 UTs with real boundaries; Census-2011 demography, monuments, IIT/AIIMS/ISRO/RBI, crop belts, national symbols.
* **Uttar Pradesh** — drilled to all **75 districts**.
* **Lucknow, Varanasi, Agra** — popular locations as blocks (Taj Mahal, Kashi Vishwanath, Bara Imambara, BHU, Sarnath, Fatehpur Sikri…).

Boundaries are simplified from public GeoJSON (India districts by *udit-001*; world countries from *datasets/geo-countries* / Natural Earth). Replace the data values with your own — the format is yours to extend.

## Updating the engine

1. Edit `mapportal.css` / `mapportal.js`.
2. Commit and push a new tag (`v1.1.0`).
3. Update the version in your site's `<link>` / `<script>` URLs.
4. Old tagged versions stay live — existing embeds never break.

## Platforms

- Blogger (paste in the post HTML view + one head block)
- WordPress (Custom HTML block)
- Plain HTML pages
- Any site that allows injecting `<script>` tags
