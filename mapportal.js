/* ==============================================================
   INTERACTIVE MAP PORTAL ENGINE  v1
   --------------------------------------------------------------
   Host this file on GitHub, serve via jsDelivr CDN:
     https://cdn.jsdelivr.net/gh/YOUR-USER/mapportal-engine@VERSION/mapportal.js

   Load BEFORE this file:
     MapLibre CSS : https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css
     MapLibre JS  : https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js
     Portal CSS   : https://cdn.jsdelivr.net/gh/YOUR-USER/mapportal-engine@VERSION/mapportal.css

   Public API (mirrors the AI-MCQ engine):
     window.initMapPortal(containerId, dataJSON, settings)   // inline data
     window.loadMapPortal(containerId, { jsonUrl | jsonUrls, settings })  // remote data

   The data JSON is a node graph:
     { meta:{ root:"world", ... }, nodes:{ id: { ...node } } }
   Each node may carry:
     view{center,zoom,bounds}, boundaries(GeoJSON FeatureCollection of
     its children), children[ids], locations[point blocks], data{...}.
   Each boundary Feature links to a child via properties.nodeId.
   ============================================================== */
window.MAPPORTAL_CONFIG = window.MAPPORTAL_CONFIG || {};

(function () {
'use strict';

/* atlas tint ramp used to softly differentiate adjacent regions */
var TINTS = ['#efe2c4','#e7d6b2','#ecdcb9','#e3d1ab','#f1e6cc','#e9dbb6','#ead7ad','#f0e3c2'];
var WATER = '#c9dbe2';

function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
}
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
}

/* ------------------------------------------------------------------
   MAIN ENTRY — render a portal from already-parsed data
   ------------------------------------------------------------------ */
window.initMapPortal = function (containerId, data, settings) {
    settings = settings || {};
    var host = document.getElementById(containerId);
    if (!host) return;

    if (typeof maplibregl === 'undefined') {
        host.innerHTML = '';
        var w = el('div'); w.id = 'mapportal-root-scope';
        w.appendChild(buildError('Map library missing',
            'MapLibre GL JS did not load. Add its &lt;script&gt; and &lt;link&gt; tags before mapportal.js.'));
        host.appendChild(w);
        return;
    }

    var S = Object.assign({
        title: (data.meta && data.meta.title) || 'Interactive Map',
        basemap: 'none',          // 'none' (clean atlas) or 'osm' (street tiles)
        height: null,             // e.g. '620px'; if null, uses container/host height
        start: null,              // node id to open first (defaults to meta.root)
        show_labels: true,
        max_label_features: 90,   // hide region labels above this count to cut clutter
        cooperative_gestures: true // plain page scroll passes through; ctrl/⌘+scroll or two fingers zoom the map
    }, settings);

    var NODES = data.nodes || {};
    var ROOT = S.start || (data.meta && data.meta.root) || Object.keys(NODES)[0];

    /* ---------- DOM scaffold ---------- */
    host.innerHTML = '';
    var scope = el('div'); scope.id = 'mapportal-root-scope';
    if (S.height) scope.style.height = S.height;
    var mapEl = el('div', 'mp-map');
    var ui = el('div', 'mp-ui');

    var rail = el('div', 'mp-rail');
    var crumbs = el('nav', 'mp-crumbs'); crumbs.setAttribute('aria-label','Map level');
    rail.appendChild(crumbs);

    var tip = el('div', 'mp-tip');
    var panel = el('aside', 'mp-panel');
    panel.setAttribute('aria-label','Region information');

    // overlay holds only the map-anchored UI (breadcrumbs + hover tooltip)
    ui.appendChild(rail);
    ui.appendChild(tip);

    // map + its overlay live in a wrapper; the gazetteer panel sits BELOW it
    var mapWrap = el('div', 'mp-mapwrap');
    mapWrap.appendChild(mapEl);
    mapWrap.appendChild(ui);

    scope.appendChild(mapWrap);
    scope.appendChild(panel);
    host.appendChild(scope);

    var loading = buildLoading('Drawing the map\u2026');
    scope.appendChild(loading);

    /* ---------- state ---------- */
    var currentId = null;     // node whose children are drawn
    var selectedId = null;    // node shown in the panel
    var markers = [];         // active HTML markers (labels + locations)
    var idToFid = {};         // childNodeId -> numeric feature id (for feature-state)
    var hoverFid = null, selFid = null;

    /* ---------- map ---------- */
    var style = { version: 8, sources: {}, layers: [
        { id: 'mp-bg', type: 'background', paint: { 'background-color': WATER } }
    ]};
    if (S.basemap === 'osm') {
        style.sources['mp-osm'] = {
            type: 'raster', tileSize: 256,
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            attribution: '&copy; OpenStreetMap contributors'
        };
        style.layers.push({ id: 'mp-osm', type: 'raster', source: 'mp-osm', paint: { 'raster-opacity': .9 } });
    }

    var map = new maplibregl.Map({
        container: mapEl, style: style,
        center: [80, 22], zoom: 3, attributionControl: false,
        dragRotate: false, pitchWithRotate: false, maxZoom: 16,
        cooperativeGestures: S.cooperative_gestures !== false
    });
    map.touchZoomRotate && map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true,
        customAttribution: (data.meta && data.meta.attribution) || '' }), 'bottom-left');

    map.on('load', function () {
        if (loading.parentNode) loading.parentNode.removeChild(loading);
        bindRegionEvents();   // bound ONCE; layer is matched by id at dispatch time
        enterNode(ROOT, false);
    });

    /* ---------- camera ---------- */
    function camera(node, animate) {
        var pad = computePadding();
        if (node.view && node.view.bounds && node.view.bounds.length === 4) {
            var b = node.view.bounds;
            map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
                padding: pad, duration: animate ? 900 : 0, maxZoom: 13
            });
        } else if (node.view && node.view.center) {
            map.easeTo({ center: node.view.center, zoom: node.view.zoom || 5,
                padding: pad, duration: animate ? 900 : 0 });
        }
    }
    function computePadding() {
        var w = scope.clientWidth;
        // the gazetteer panel now sits BELOW the map, so the canvas is
        // unobstructed — pad symmetrically and let regions use full width
        if (w <= 760) return { top: 64, left: 16, right: 16, bottom: 24 };
        return { top: 80, left: 36, right: 36, bottom: 40 };
    }

    /* ---------- level rendering ---------- */
    function clearLayers() {
        ['mp-fill','mp-line','mp-line-case'].forEach(function (id) {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource('mp-regions')) map.removeSource('mp-regions');
        markers.forEach(function (m) { m.remove(); });
        markers = [];
        idToFid = {}; hoverFid = null; selFid = null;
    }

    function enterNode(nodeId, animate) {
        var node = NODES[nodeId];
        if (!node) return;
        currentId = nodeId;
        clearLayers();

        var hasRegions = node.boundaries && node.boundaries.features && node.boundaries.features.length;
        if (hasRegions) addRegions(node);
        if (node.locations && node.locations.length) addLocations(node);

        camera(node, animate);
        renderPanel(nodeId);       // show this node's own profile
        buildCrumbs(nodeId);
    }

    function addRegions(node) {
        var fc = { type: 'FeatureCollection', features: [] };
        node.boundaries.features.forEach(function (f, i) {
            var p = f.properties || {};
            var nf = {
                type: 'Feature', id: i + 1,
                properties: Object.assign({}, p, { _tint: TINTS[i % TINTS.length] }),
                geometry: f.geometry
            };
            if (p.nodeId) idToFid[p.nodeId] = i + 1;
            fc.features.push(nf);
        });
        map.addSource('mp-regions', { type: 'geojson', data: fc });

        map.addLayer({ id: 'mp-fill', type: 'fill', source: 'mp-regions', paint: {
            'fill-color': [ 'case',
                ['boolean', ['feature-state','selected'], false], '#e7a23c',
                ['boolean', ['feature-state','hover'], false], '#f0cd86',
                ['get', '_tint'] ],
            'fill-opacity': 0.92
        }});
        map.addLayer({ id: 'mp-line-case', type: 'line', source: 'mp-regions', paint: {
            'line-color': '#f7f2e7', 'line-width': 2.4, 'line-opacity': .7
        }});
        map.addLayer({ id: 'mp-line', type: 'line', source: 'mp-regions', paint: {
            'line-color': '#16233a',
            'line-width': ['case', ['boolean', ['feature-state','hover'], false], 2.0, 0.9]
        }});

        // region hover/click handlers are bound once at map load
        if (S.show_labels) addLabels(node);
    }

    function setFState(fid, key, val) {
        if (fid == null) return;
        map.setFeatureState({ source: 'mp-regions', id: fid }, (function () {
            var o = {}; o[key] = val; return o;
        })());
    }

    function bindRegionEvents() {
        map.on('mousemove', 'mp-fill', function (e) {
            if (!e.features.length) return;
            map.getCanvas().style.cursor = 'pointer';
            var f = e.features[0];
            if (hoverFid !== f.id) {
                setFState(hoverFid, 'hover', false);
                hoverFid = f.id; setFState(hoverFid, 'hover', true);
            }
            tip.textContent = f.properties.name || '';
            tip.classList.add('show');
            var r = mapEl.getBoundingClientRect();
            tip.style.left = (e.point.x) + 'px';
            tip.style.top = (e.point.y) + 'px';
        });
        map.on('mouseleave', 'mp-fill', function () {
            map.getCanvas().style.cursor = '';
            setFState(hoverFid, 'hover', false); hoverFid = null;
            tip.classList.remove('show');
        });
        map.on('click', 'mp-fill', function (e) {
            if (!e.features.length) return;
            var nid = e.features[0].properties.nodeId;
            if (nid && NODES[nid]) selectChild(nid);
        });
    }

    function addLabels(node) {
        var feats = node.boundaries.features;
        if (feats.length > S.max_label_features) {
            // too dense — labels only appear via hover tooltip
            return;
        }
        var sizeClass = feats.length > 25 ? 'lvl-small' : (feats.length > 8 ? 'lvl-mid' : 'lvl-big');
        feats.forEach(function (f) {
            var p = f.properties || {};
            if (!p.center) return;
            var lab = el('div', 'mp-label ' + sizeClass, esc(p.name || ''));
            var m = new maplibregl.Marker({ element: lab, anchor: 'center' })
                .setLngLat(p.center).addTo(map);
            markers.push(m);
        });
    }

    function addLocations(node) {
        node.locations.forEach(function (loc) {
            if (!loc.center) return;
            var b = el('div', 'mp-loc');
            b.setAttribute('tabindex', '0');
            b.setAttribute('role', 'button');
            b.innerHTML = '<span class="mp-loc-dot"></span>'
                + (loc.type ? '<span class="mp-loc-type">' + esc(loc.type) + '</span> ' : '')
                + '<span>' + esc(loc.name) + '</span>';
            function open() {
                markers.forEach(function (mm) {
                    if (mm._mpLocEl) mm._mpLocEl.classList.remove('is-active');
                });
                b.classList.add('is-active');
                renderLocationPanel(node, loc);
                if (scope.clientWidth <= 760) panel.classList.remove('is-collapsed');
            }
            b.addEventListener('click', open);
            b.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
            });
            var m = new maplibregl.Marker({ element: b, anchor: 'left' })
                .setLngLat(loc.center).addTo(map);
            m._mpLocEl = b;
            markers.push(m);
        });
    }

    /* clicking a child region: show its profile + offer to drill in */
    function selectChild(childId) {
        selFid != null && setFState(selFid, 'selected', false);
        var fid = idToFid[childId];
        if (fid != null) { selFid = fid; setFState(fid, 'selected', true); }
        renderPanel(childId);
        if (scope.clientWidth <= 760) panel.classList.remove('is-collapsed');
    }

    function isDrillable(node) {
        return !!(node && ((node.boundaries && node.boundaries.features && node.boundaries.features.length)
            || (node.locations && node.locations.length)
            || (node.children && node.children.length)));
    }

    /* ---------- breadcrumb ---------- */
    function pathTo(nodeId) {
        var chain = [], cur = nodeId, guard = 0;
        while (cur && NODES[cur] && guard++ < 40) {
            chain.unshift(cur);
            cur = NODES[cur].parent;
        }
        return chain;
    }
    function buildCrumbs(nodeId) {
        crumbs.innerHTML = '';
        var chain = pathTo(nodeId);
        chain.forEach(function (id, i) {
            if (i > 0) crumbs.appendChild(el('span', 'mp-crumb-sep', '\u203A'));
            var node = NODES[id];
            var btn = el('button', 'mp-crumb' + (id === nodeId ? ' is-current' : ''), esc(node.name));
            if (id !== nodeId) btn.addEventListener('click', function () { enterNode(id, true); });
            crumbs.appendChild(btn);
        });
    }

    /* ---------- panel rendering ---------- */
    function renderPanel(nodeId) {
        selectedId = nodeId;
        var node = NODES[nodeId];
        var d = node.data || {};
        panel.innerHTML = '';

        var head = el('div', 'mp-panel-head');
        head.appendChild(el('span', 'mp-stamp', esc(node.level || 'Region')));
        head.appendChild(el('h3', 'mp-title', esc(node.name)));
        if (d.summary) head.appendChild(el('p', 'mp-summary', esc(d.summary)));

        // offer drill-in when this node (a clicked child or current) can expand
        if (nodeId !== currentId && isDrillable(node)) {
            var label = node.locations && node.locations.length
                ? 'Explore ' + esc(node.name)
                : (node.level === 'Country' ? 'Explore states'
                    : node.level === 'State' ? 'Explore districts' : 'Explore ' + esc(node.name));
            var go = el('button', 'mp-explore',
                '<span>' + label + '</span><span class="mp-arrow">\u2192</span>');
            go.addEventListener('click', function () { enterNode(nodeId, true); });
            head.appendChild(go);
        }
        panel.appendChild(head);

        var body = el('div', 'mp-panel-body');
        renderSections(body, d);
        panel.appendChild(body);

        // re-attach mobile toggle
        var toggle = el('button', 'mp-panel-toggle');
        toggle.setAttribute('aria-label','Toggle details panel');
        toggle.addEventListener('click', function () { panel.classList.toggle('is-collapsed'); });
        panel.appendChild(toggle);
    }

    function renderLocationPanel(parentNode, loc) {
        selectedId = null;
        var d = loc.data || {};
        panel.innerHTML = '';
        var head = el('div', 'mp-panel-head');
        head.appendChild(el('span', 'mp-stamp', esc(loc.type || 'Place')));
        head.appendChild(el('h3', 'mp-title', esc(loc.name)));
        if (d.summary) head.appendChild(el('p', 'mp-summary', esc(d.summary)));
        var back = el('button', 'mp-explore',
            '<span class="mp-arrow">\u2190</span><span> Back to ' + esc(parentNode.name) + '</span>');
        back.addEventListener('click', function () {
            markers.forEach(function (mm) { if (mm._mpLocEl) mm._mpLocEl.classList.remove('is-active'); });
            renderPanel(parentNode.id);
        });
        head.appendChild(back);
        panel.appendChild(head);
        var body = el('div', 'mp-panel-body');
        renderSections(body, d);
        panel.appendChild(body);
        var toggle = el('button', 'mp-panel-toggle');
        toggle.setAttribute('aria-label', 'Toggle details panel');
        toggle.addEventListener('click', function () { panel.classList.toggle('is-collapsed'); });
        panel.appendChild(toggle);
    }

    function renderSections(body, d) {
        if (d.demography && d.demography.length) {
            var s = section('Human demography', 'facts');
            d.demography.forEach(function (r) {
                var row = el('div', 'mp-stat');
                row.appendChild(el('span', 'mp-stat-label', esc(r.label)));
                row.appendChild(el('span', 'mp-stat-lead'));
                row.appendChild(el('span', 'mp-stat-val', esc(r.value)));
                if (r.note) row.appendChild(el('span', 'mp-stat-note', esc(r.note)));
                s.appendChild(row);
            });
            body.appendChild(s);
        }
        itemSection(body, d.popular_places, 'Popular places', 'places');
        itemSection(body, d.institutions, 'Popular institutions', 'institutions');
        itemSection(body, d.agriculture, 'Agriculture & lands', 'agriculture');
        itemSection(body, d.forests_wildlife, 'Forests & wildlife', 'forests');
        if (d.exam_facts && d.exam_facts.length) {
            var f = section('Exam notes', 'facts');
            d.exam_facts.forEach(function (t) { f.appendChild(el('div', 'mp-fact', esc(t))); });
            body.appendChild(f);
        }
        if (!body.children.length) {
            body.appendChild(el('p', 'mp-summary', 'No additional data recorded for this area yet.'));
        }
    }

    function section(title, kind) {
        var s = el('section', 'mp-sec'); s.setAttribute('data-kind', kind);
        var h = el('div', 'mp-sec-head');
        h.appendChild(el('span', 'mp-tick'));
        h.appendChild(el('span', null, esc(title)));
        s.appendChild(h);
        return s;
    }
    function itemSection(body, arr, title, kind) {
        if (!arr || !arr.length) return;
        var s = section(title, kind);
        arr.forEach(function (it) {
            var card = el('div', 'mp-item');
            var top = el('div', 'mp-item-top');
            top.appendChild(el('span', 'mp-item-name', esc(it.name)));
            if (it.type) top.appendChild(el('span', 'mp-item-tag', esc(it.type)));
            card.appendChild(top);
            if (it.note) card.appendChild(el('div', 'mp-item-note', esc(it.note)));
            s.appendChild(card);
        });
        body.appendChild(s);
    }

    /* keep camera padding correct on resize */
    var raf;
    window.addEventListener('resize', function () {
        clearTimeout(raf);
        raf = setTimeout(function () {
            map.resize();
            if (currentId) camera(NODES[currentId], false);
        }, 200);
    });

    return { map: map, goTo: function (id) { enterNode(id, true); } };
};

/* helpers used before a scope exists */
function buildLoading(msg) {
    var d = document.createElement('div'); d.className = 'mp-loading';
    d.innerHTML = '<div class="mp-spin"></div><p>' + esc(msg) + '</p>';
    return d;
}
function buildError(title, msg) {
    var d = document.createElement('div'); d.className = 'mp-error';
    d.innerHTML = '<span class="mp-stamp">Error</span><h4>' + esc(title) + '</h4><p>' + msg + '</p>';
    return d;
}

/* ------------------------------------------------------------------
   REMOTE LOADER — window.loadMapPortal(containerId, opts)
   Fetches JSON from GitHub/jsDelivr exactly like the AI-MCQ engine.
     opts.jsonUrl   : single data file
     opts.jsonUrls  : array of files (merged: meta from first, nodes combined)
     opts.settings  : passed to initMapPortal
   ------------------------------------------------------------------ */
window.loadMapPortal = function (containerId, opts) {
    opts = opts || {};
    var host = document.getElementById(containerId);
    if (!host) return;

    host.innerHTML = '';
    var scope = document.createElement('div'); scope.id = 'mapportal-root-scope';
    scope.appendChild(buildLoading('Loading map data\u2026'));
    host.appendChild(scope);

    var urls = [];
    if (Array.isArray(opts.jsonUrls)) opts.jsonUrls.forEach(function (u) {
        if (u) urls.push(typeof u === 'string' ? u : u.jsonUrl);
    });
    if (opts.jsonUrl) urls.push(opts.jsonUrl);
    if (!urls.length) { host.innerHTML = ''; scope.appendChild(buildError('No data URL',
        'Provide a jsonUrl (or jsonUrls) pointing to your map data JSON.')); host.appendChild(scope); return; }

    function fetchOne(u) {
        return fetch(u, { redirect: 'follow' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (t) {
                var s = (t || '').trim();
                if (s.charAt(0) !== '{') throw new Error('Not JSON');
                return JSON.parse(s);
            })
            .catch(function (err) {
                if (window.console) console.warn('[mapportal] failed to load', u, err && err.message);
                return null;
            });
    }

    Promise.all(urls.map(fetchOne)).then(function (parts) {
        var ok = parts.filter(Boolean);
        if (!ok.length) {
            host.innerHTML = '';
            var s2 = document.createElement('div'); s2.id = 'mapportal-root-scope';
            s2.appendChild(buildError('Could not load map',
                'The data file failed to load. Check the URL is public and valid JSON.'));
            host.appendChild(s2);
            return;
        }
        var merged = ok[0];
        if (ok.length > 1) {
            merged = { version: ok[0].version, portal_type: ok[0].portal_type,
                       meta: ok[0].meta, nodes: {} };
            ok.forEach(function (p) { Object.assign(merged.nodes, p.nodes || {}); });
        }
        host.innerHTML = '';
        window.initMapPortal(containerId, merged, opts.settings || {});
    });
};

})();
