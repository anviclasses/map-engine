/* ==============================================================
   Atlas Map Portal — Engine v1  (conflict-free edition)
   JS — host on GitHub, serve via jsDelivr CDN:
   https://cdn.jsdelivr.net/gh/YOUR-USER/atlasmap-engine@VERSION/atlasmap.js

   Public API (both attached to window):
     initAtlasMap(containerId, mapDataJSON, settings)
     loadAtlasMapFromUrl(containerId, { jsonUrl, settings })

   The engine renders an interactive, drill-down atlas from plain
   GeoJSON-backed "map data" JSON files (see README for the schema).
   No external map library required — boundaries are projected and
   drawn as SVG, so the same file works inside Blogger / WordPress.
   ============================================================== */
(function () {
  "use strict";

  var UID = 0;
  var INDIA_NF = (function () {
    try { return new Intl.NumberFormat("en-IN"); } catch (e) { return null; }
  })();

  /* ---------------- small utilities ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function el(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function fmtNumber(v, fmt) {
    if (v == null || v === "") return "—";
    var n = Number(v);
    if (!isFinite(n)) return esc(v);
    if (fmt === "compact") {
      var a = Math.abs(n);
      if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
      if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
      if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "K";
      return String(n);
    }
    return INDIA_NF ? INDIA_NF.format(n) : String(n);
  }

  /* ---------------- projection ---------------- */
  // Web-Mercator (lat clamped). Returns [mx, my] in radians-ish units.
  function mercator(lon, lat) {
    var x = lon * Math.PI / 180;
    var l = clamp(lat, -83, 83) * Math.PI / 180;
    var y = Math.log(Math.tan(Math.PI / 4 + l / 2));
    return [x, y];
  }

  // Colour interpolation for choropleth (light -> deep terracotta).
  function lerpColor(t) {
    var a = [246, 234, 208], b = [156, 61, 18]; // #f6ead0 -> #9c3d12
    t = clamp(t, 0, 1);
    var r = Math.round(a[0] + (b[0] - a[0]) * t);
    var g = Math.round(a[1] + (b[1] - a[1]) * t);
    var bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return "rgb(" + r + "," + g + "," + bl + ")";
  }

  /* ============================================================
     INSTANCE
     ============================================================ */
  function AtlasMap(container, rootRef, rootJSON, settings) {
    this.uid = "amx" + (++UID);
    this.container = container;
    this.S = Object.assign({
      title: null, subtitle: null,
      height: null,                 // auto if null
      show_search: true,
      show_legend: true,
      show_locations: true,
      enable_zoom: true,
      attribution: "Boundaries: Natural Earth · india-maps-data (ODbL)",
      resolve: null,                // function(ref) -> json | Promise | null
      urlTransform: null,           // function(url) -> url
      onSelect: null                // function({level,region|location}) callback
    }, settings || {});
    this.cache = {};
    this.stack = [];                // [{ref, json}]
    this.metric = undefined;
    this.selected = null;           // region id
    this.selectedLoc = null;        // location id
    this.view = null;               // {x,y,w,h}
    this.base = null;               // base viewBox
    this._raf = null;
    this._boot(rootRef, rootJSON);
  }

  AtlasMap.prototype._boot = function (rootRef, rootJSON) {
    var self = this;
    if (rootJSON) {
      this.stack = [{ ref: rootRef || { __json: rootJSON }, json: rootJSON }];
      this._renderLoader();
      this._renderLevel();
    } else {
      this._renderLoader("Loading map data…");
      this._getData(rootRef).then(function (json) {
        if (!json) { self._renderSleep(); return; }
        self.stack = [{ ref: rootRef, json: json }];
        self._renderLevel();
      }).catch(function () { self._renderSleep(); });
    }
  };

  /* ---------------- data fetching ---------------- */
  AtlasMap.prototype._getData = function (ref) {
    var self = this;
    if (!ref) return Promise.resolve(null);
    if (ref.__json) return Promise.resolve(ref.__json);
    if (this.S.resolve) {
      var r = this.S.resolve(ref);
      if (r) return Promise.resolve(r);
    }
    var url = ref.url;
    if (!url) return Promise.resolve(null);
    if (this.S.urlTransform) url = this.S.urlTransform(url);
    if (this.cache[url]) return Promise.resolve(this.cache[url]);
    return fetch(url, { redirect: "follow" })
      .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.text(); })
      .then(function (txt) {
        var t = (txt || "").trim();
        if (t.charAt(0) !== "{" && t.charAt(0) !== "[") throw new Error("not JSON");
        var j = JSON.parse(t);
        self.cache[url] = j;
        return j;
      });
  };

  /* ---------------- level layout (projection + screen paths) ---- */
  AtlasMap.prototype._layout = function (json) {
    var W = 1000, PAD = 26;
    var regions = json.regions || [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    // collect projected extent
    function eachCoord(geom, cb) {
      if (!geom) return;
      var c = geom.coordinates, type = geom.type;
      if (type === "Polygon") c.forEach(function (ring) { ring.forEach(cb); });
      else if (type === "MultiPolygon") c.forEach(function (poly) { poly.forEach(function (ring) { ring.forEach(cb); }); });
    }
    regions.forEach(function (rg) {
      eachCoord(rg.geometry, function (pt) {
        var m = mercator(pt[0], pt[1]);
        if (m[0] < minX) minX = m[0]; if (m[0] > maxX) maxX = m[0];
        if (m[1] < minY) minY = m[1]; if (m[1] > maxY) maxY = m[1];
      });
    });
    if (!isFinite(minX)) { minX = -Math.PI; maxX = Math.PI; minY = -1; maxY = 1; }

    var spanX = (maxX - minX) || 1e-6, spanY = (maxY - minY) || 1e-6;
    var innerW = W - 2 * PAD;
    var aspect = spanX / spanY;
    var rawH = innerW / aspect + 2 * PAD;
    var H = clamp(rawH, 460, 880);
    var innerH = H - 2 * PAD;
    var s = Math.min(innerW / spanX, innerH / spanY);
    var offX = PAD + (innerW - spanX * s) / 2;
    var offY = PAD + (innerH - spanY * s) / 2;

    function toS(lon, lat) {
      var m = mercator(lon, lat);
      return [offX + (m[0] - minX) * s, offY + (maxY - m[1]) * s];
    }
    function pathOf(geom) {
      var d = "";
      function ring(r) {
        for (var i = 0; i < r.length; i++) {
          var p = toS(r[i][0], r[i][1]);
          d += (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1);
        }
        d += "Z";
      }
      if (!geom) return d;
      if (geom.type === "Polygon") geom.coordinates.forEach(ring);
      else if (geom.type === "MultiPolygon") geom.coordinates.forEach(function (poly) { poly.forEach(ring); });
      return d;
    }

    // metric values
    var metricKey = this.metric;
    var vmin = Infinity, vmax = -Infinity, anyVal = false;
    if (metricKey) {
      regions.forEach(function (rg) {
        var v = rg.facts && rg.facts[metricKey];
        if (v != null && isFinite(Number(v))) { v = Number(v); anyVal = true; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
      });
    }

    var feats = regions.map(function (rg) {
      var cen = rg.centroid ? toS(rg.centroid[0], rg.centroid[1]) : null;
      // screen bbox
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      eachCoord(rg.geometry, function (pt) {
        var p = toS(pt[0], pt[1]);
        if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
        if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
      });
      var val = (metricKey && rg.facts) ? rg.facts[metricKey] : null;
      var t = (anyVal && val != null && isFinite(Number(val)) && vmax > vmin)
        ? (Number(val) - vmin) / (vmax - vmin) : null;
      return {
        id: rg.id, name: rg.name, facts: rg.facts || {}, child: rg.child || null,
        highlight: !!rg.highlight, path: pathOf(rg.geometry), label: cen,
        bbox: [bx0, by0, bx1, by1], value: val, t: t
      };
    });

    var locs = (this.S.show_locations && Array.isArray(json.locations)) ? json.locations.map(function (lc) {
      var p = lc.coordinates ? toS(lc.coordinates[0], lc.coordinates[1]) : null;
      return { id: lc.id, name: lc.name, category: lc.category, facts: lc.facts || {}, note: lc.note, coordinates: lc.coordinates, xy: p };
    }) : [];

    return { W: W, H: H, feats: feats, locs: locs, metricKey: metricKey, vmin: vmin, vmax: vmax, anyVal: anyVal };
  };

  /* ---------------- rendering ---------------- */
  AtlasMap.prototype._renderLoader = function (msg) {
    this.container.innerHTML =
      '<div class="atlasmap"><div class="amx-shell"><div class="amx-center">' +
      '<div class="amx-spin"></div><p>' + esc(msg || "Loading map…") + "</p>" +
      "</div></div></div>";
  };
  AtlasMap.prototype._renderSleep = function () {
    this.container.innerHTML =
      '<div class="atlasmap"><div class="amx-shell"><div class="amx-center">' +
      '<p style="font-size:30px;margin:0">🗺️</p>' +
      '<p style="font-weight:600;color:#1d2a3a;font-size:16px;margin-top:8px">Map data unavailable</p>' +
      '<p>Please refresh or check the data URL.</p>' +
      "</div></div></div>";
  };

  AtlasMap.prototype._currentJSON = function () { return this.stack[this.stack.length - 1].json; };

  AtlasMap.prototype._renderLevel = function () {
    var self = this;
    var json = this._currentJSON();

    // default metric for this level
    if (this.metric === undefined) this.metric = json.default_metric || null;
    // verify metric exists in this level's data_fields, else null
    var fields = json.data_fields || [];
    var metricFields = fields.filter(function (f) { return f.type === "number" || f.choropleth; });
    if (this.metric && !metricFields.some(function (f) { return f.key === self.metric; })) this.metric = null;

    var lay = this._layout(json);
    this.layout = lay;
    this.base = { x: 0, y: 0, w: lay.W, h: lay.H };
    this.view = Object.assign({}, this.base);
    this.selected = null; this.selectedLoc = null;

    var levelLabel = (json.level || "region").toUpperCase();
    var title = (this.stack.length === 1 && this.S.title) ? this.S.title : (json.name || "Atlas");
    var subtitle = (this.stack.length === 1 && this.S.subtitle) ? this.S.subtitle : (json.subtitle || "");

    /* --- breadcrumb --- */
    var crumbs = "";
    var rootParent = this.stack[0].json.parent;
    if (rootParent && rootParent.name) {
      crumbs += '<button data-amx="up">' + esc(rootParent.name) + "</button>" +
        '<span class="amx-sep">›</span>';
    }
    this.stack.forEach(function (entry, i) {
      var nm = entry.json.name || "—";
      if (i === self.stack.length - 1) {
        crumbs += '<span class="amx-crumb-here">' + esc(nm) + "</span>";
      } else {
        crumbs += '<button data-amx="crumb" data-i="' + i + '">' + esc(nm) + "</button>" +
          '<span class="amx-sep">›</span>';
      }
    });

    /* --- metric selector --- */
    var metricSel = "";
    if (metricFields.length) {
      metricSel = '<select class="amx-metric" data-amx="metric"><option value="">Shade: none</option>';
      metricFields.forEach(function (f) {
        metricSel += '<option value="' + esc(f.key) + '"' + (self.metric === f.key ? " selected" : "") +
          ">Shade: " + esc(f.label) + "</option>";
      });
      metricSel += "</select>";
    }

    /* --- search --- */
    var searchBox = this.S.show_search ?
      '<div class="amx-search"><svg viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
      '<input type="text" placeholder="Search ' + esc(json.name || "map") + '…" data-amx="search" autocomplete="off">' +
      '<div class="amx-search-pop" data-amx="searchpop"></div></div>' : "";

    /* --- svg --- */
    var svg = this._svgMarkup(lay);

    /* --- legend --- */
    var legend = "";
    if (this.S.show_legend && this.metric && lay.anyVal && lay.vmax > lay.vmin) {
      var fObj = fields.filter(function (f) { return f.key === self.metric; })[0] || {};
      var fmt = fObj.format;
      legend =
        '<div class="amx-legend"><div class="amx-legend-t">' + esc(fObj.label || self.metric) + "</div>" +
        '<div class="amx-legend-bar" style="background:linear-gradient(90deg,' + lerpColor(0) + "," + lerpColor(.5) + "," + lerpColor(1) + ')"></div>' +
        '<div class="amx-legend-scale"><span>' + fmtNumber(lay.vmin, fmt) + "</span><span>" + fmtNumber(lay.vmax, fmt) + "</span></div></div>";
    }

    var zoomCtl = this.S.enable_zoom ?
      '<div class="amx-zoom"><button data-amx="zin" title="Zoom in">+</button>' +
      '<button data-amx="zout" title="Zoom out">−</button>' +
      '<button data-amx="zreset" title="Reset view">⟲</button></div>' : "";

    var height = this.S.height ? (' style="max-height:' + this.S.height + 'px"') : "";

    this.container.innerHTML =
      '<div class="atlasmap" id="' + this.uid + '">' +
        '<div class="amx-shell">' +
          '<div class="amx-head">' +
            '<div class="amx-titles">' +
              '<p class="amx-eyebrow">' + esc(levelLabel) + " ATLAS</p>" +
              '<h2 class="amx-title">' + esc(title) + "</h2>" +
              (subtitle ? '<p class="amx-sub">' + esc(subtitle) + "</p>" : "") +
            "</div>" +
            '<div class="amx-tools">' + searchBox + metricSel +
              '<button class="amx-btn" data-amx="home" title="Back to top level">⌂ Top</button>' +
            "</div>" +
          "</div>" +
          '<div class="amx-body">' +
            '<div class="amx-stage-wrap"' + height + '>' +
              '<div class="amx-corners"><i></i><i></i><i></i><i></i></div>' +
              '<div class="amx-crumbs">' + crumbs + "</div>" +
              svg + legend + zoomCtl +
            "</div>" +
            '<aside class="amx-panel" data-amx="panel">' + this._panelDefault(json, lay) + "</aside>" +
          "</div>" +
          '<div class="amx-foot"><span>Click a region to explore · scroll to zoom · drag to pan</span>' +
            '<span>' + esc(this.S.attribution) + "</span></div>" +
        "</div>" +
      "</div>";

    this._bind();
  };

  AtlasMap.prototype._svgMarkup = function (lay) {
    var self = this;
    var parts = ['<svg class="amx-stage" data-amx="svg" viewBox="0 0 ' + lay.W + " " + lay.H +
      '" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">'];
    parts.push('<g data-amx="regions">');
    lay.feats.forEach(function (f) {
      var fill = (self.metric && f.t != null) ? lerpColor(f.t) : "var(--amx-land)";
      var cls = "amx-region" + (f.child ? " amx-has-child" : "") + (f.highlight ? " amx-highlight" : "");
      parts.push('<path class="' + cls + '" data-id="' + esc(f.id) + '" d="' + f.path +
        '" style="fill:' + fill + '"></path>');
    });
    parts.push("</g>");
    // labels
    parts.push('<g data-amx="labels" style="pointer-events:none">');
    lay.feats.forEach(function (f) {
      if (!f.label) return;
      var diag = Math.hypot(f.bbox[2] - f.bbox[0], f.bbox[3] - f.bbox[1]);
      if (diag < 26) return; // hide tiny-region labels to avoid clutter
      var fs = clamp(diag / 9, 8, 13);
      parts.push('<text class="amx-label" x="' + f.label[0].toFixed(1) + '" y="' +
        (f.label[1] + fs * 0.34).toFixed(1) + '" style="font-size:' + fs.toFixed(1) + 'px">' +
        esc(f.name) + "</text>");
    });
    parts.push("</g>");
    // location pins
    if (lay.locs.length) {
      parts.push('<g data-amx="pins">');
      lay.locs.forEach(function (l) {
        if (!l.xy) return;
        parts.push('<g class="amx-pin" data-loc="' + esc(l.id) + '">' +
          '<circle cx="' + l.xy[0].toFixed(1) + '" cy="' + l.xy[1].toFixed(1) + '" r="5"></circle>' +
          '<text x="' + l.xy[0].toFixed(1) + '" y="' + (l.xy[1] - 9).toFixed(1) + '" text-anchor="middle">' +
          esc(l.name) + "</text></g>");
      });
      parts.push("</g>");
    }
    parts.push("</svg>");
    return parts.join("");
  };

  /* ---------------- panel content ---------------- */
  AtlasMap.prototype._panelDefault = function (json, lay) {
    var nRegions = lay.feats.length;
    var nLoc = lay.locs.length;
    var states = lay.feats.filter(function (f) { return (f.facts.type || "").indexOf("State") === 0; }).length;
    var uts = lay.feats.filter(function (f) { return (f.facts.type || "").indexOf("Union") === 0; }).length;
    var rowA = (states && uts)
      ? '<div class="amx-stat"><div class="amx-stat-n">' + states + '</div><div class="amx-stat-l">States</div></div>' +
        '<div class="amx-stat"><div class="amx-stat-n">' + uts + '</div><div class="amx-stat-l">Union Territories</div></div>'
      : '<div class="amx-stat"><div class="amx-stat-n">' + nRegions + '</div><div class="amx-stat-l">Regions</div></div>';
    var rowB = nLoc ? '<div class="amx-stat"><div class="amx-stat-n">' + nLoc + '</div><div class="amx-stat-l">Key sites</div></div>' : "";
    return '<div class="amx-panel-empty">' +
      "<p>Hover a region for a quick fact; click to see full details" +
      (this._hasAnyChild(lay) ? " or drill deeper" : "") + ". Orange pins mark famous landmarks.</p>" +
      '<div class="amx-stat-row">' + rowA + rowB + "</div>" +
      "</div>";
  };
  AtlasMap.prototype._hasAnyChild = function (lay) {
    return lay.feats.some(function (f) { return f.child; });
  };

  AtlasMap.prototype._panelRegion = function (f) {
    var json = this._currentJSON();
    var fields = json.data_fields || [];
    var rows = "";
    fields.forEach(function (fl) {
      if (fl.key === "note") return; // rendered separately as wide
      var v = f.facts[fl.key];
      if (v == null || v === "") return;
      var disp = (fl.type === "number") ? fmtNumber(v, fl.format) : esc(v);
      rows += '<li><span class="amx-fk">' + esc(fl.label) + '</span><span class="amx-fv">' + disp + "</span></li>";
    });
    var note = f.facts.note;
    var noteRow = note ? '<li class="amx-wide"><span class="amx-fk">Exam note</span><span class="amx-fv">' + esc(note) + "</span></li>" : "";
    var drill = f.child ? '<button class="amx-drill" data-amx="drill" data-id="' + esc(f.id) + '">' +
      esc(f.child.label || "Explore →") + "</button>" : "";
    var cat = (json.level || "region");
    return '<p class="amx-card-cat">' + esc(cat) + "</p>" +
      '<h3 class="amx-card-name">' + esc(f.name) + "</h3>" +
      '<ul class="amx-facts">' + rows + noteRow + "</ul>" + drill;
  };

  AtlasMap.prototype._panelLocation = function (l) {
    var rows = "";
    Object.keys(l.facts || {}).forEach(function (k) {
      rows += '<li><span class="amx-fk">' + esc(k.replace(/_/g, " ")) + '</span><span class="amx-fv">' + esc(l.facts[k]) + "</span></li>";
    });
    var coords = l.coordinates ? '<p class="amx-coords">⌖ ' + l.coordinates[1].toFixed(4) + "°N, " + l.coordinates[0].toFixed(4) + "°E</p>" : "";
    return '<p class="amx-card-cat">' + esc(l.category || "Landmark") + "</p>" +
      '<h3 class="amx-card-name">' + esc(l.name) + "</h3>" +
      (l.note ? '<p class="amx-card-note">' + esc(l.note) + "</p>" : "") +
      (rows ? '<ul class="amx-facts">' + rows + "</ul>" : "") + coords;
  };

  /* ---------------- interactions ---------------- */
  AtlasMap.prototype._bind = function () {
    var self = this, root = el(this.uid);
    if (!root) return;
    var svg = root.querySelector('[data-amx="svg"]');
    var panel = root.querySelector('[data-amx="panel"]');
    var tip = this._ensureTip();

    function featById(id) { return self.layout.feats.filter(function (f) { return f.id === id; })[0]; }
    function locById(id) { return self.layout.locs.filter(function (l) { return l.id === id; })[0]; }

    /* region hover + click (delegated) */
    svg.addEventListener("mousemove", function (e) {
      var path = e.target.closest ? e.target.closest(".amx-region") : null;
      var pin = e.target.closest ? e.target.closest(".amx-pin") : null;
      if (pin) {
        var l = locById(pin.getAttribute("data-loc"));
        if (l) { tip.innerHTML = "<b>" + esc(l.name) + "</b><br>" + esc(l.category || ""); self._tipAt(tip, e); }
        return;
      }
      if (path) {
        var f = featById(path.getAttribute("data-id"));
        if (f) {
          var extra = "";
          if (self.metric && f.value != null) {
            var fl = (self._currentJSON().data_fields || []).filter(function (x) { return x.key === self.metric; })[0] || {};
            extra = '<br><span class="amx-tip-v">' + esc(fl.label || self.metric) + ": " + fmtNumber(f.value, fl.format) + "</span>";
          } else if (f.facts.capital) {
            extra = '<br><span class="amx-tip-v">' + esc(f.facts.capital) + "</span>";
          }
          tip.innerHTML = "<b>" + esc(f.name) + "</b>" + (f.child ? " ›" : "") + extra;
          self._tipAt(tip, e);
        }
      } else { tip.style.opacity = 0; }
    });
    svg.addEventListener("mouseleave", function () { tip.style.opacity = 0; });

    svg.addEventListener("click", function (e) {
      var pin = e.target.closest ? e.target.closest(".amx-pin") : null;
      if (pin) { self._selectLocation(locById(pin.getAttribute("data-loc"))); return; }
      var path = e.target.closest ? e.target.closest(".amx-region") : null;
      if (path) {
        var f = featById(path.getAttribute("data-id"));
        if (!f) return;
        if (f.child) { self._drill(f); }
        else { self._selectRegion(f); }
      }
    });

    /* panel drill button */
    panel.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest('[data-amx="drill"]') : null;
      if (b) { var f = featById(b.getAttribute("data-id")); if (f) self._drill(f); }
    });

    /* breadcrumb / toolbar */
    root.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-amx]") : null;
      if (!t) return;
      var k = t.getAttribute("data-amx");
      if (k === "crumb") { self.stack = self.stack.slice(0, +t.getAttribute("data-i") + 1); self.metric = undefined; self._renderLevel(); }
      else if (k === "up") { self._goParent(); }
      else if (k === "home") { self.stack = self.stack.slice(0, 1); self.metric = undefined; self._renderLevel(); }
      else if (k === "zin") { self._zoom(0.7); }
      else if (k === "zout") { self._zoom(1 / 0.7); }
      else if (k === "zreset") { self._animateView(self.base); }
    });

    /* metric select */
    var sel = root.querySelector('[data-amx="metric"]');
    if (sel) sel.addEventListener("change", function () { self.metric = this.value || null; self._renderLevel(); });

    /* search */
    if (this.S.show_search) this._bindSearch(root);

    /* zoom + pan */
    if (this.S.enable_zoom) this._bindZoomPan(svg);
  };

  AtlasMap.prototype._ensureTip = function () {
    var t = document.querySelector(".amx-tip-" + this.uid);
    if (!t) {
      t = document.createElement("div");
      t.className = "amx-tip amx-tip-" + this.uid;
      // wrap in .atlasmap scope by adding class to a host
      var host = document.createElement("div"); host.className = "atlasmap";
      host.style.cssText = "position:absolute;top:0;left:0";
      host.appendChild(t); document.body.appendChild(host);
    }
    return t;
  };
  AtlasMap.prototype._tipAt = function (tip, e) {
    tip.style.left = e.clientX + "px"; tip.style.top = e.clientY + "px"; tip.style.opacity = 1;
  };

  AtlasMap.prototype._setSelectedClass = function (id, isLoc) {
    var root = el(this.uid); if (!root) return;
    root.querySelectorAll(".amx-region.amx-selected").forEach(function (n) { n.classList.remove("amx-selected"); });
    root.querySelectorAll(".amx-pin.amx-pin-sel").forEach(function (n) { n.classList.remove("amx-pin-sel"); });
    if (isLoc) { var p = root.querySelector('.amx-pin[data-loc="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); if (p) p.classList.add("amx-pin-sel"); }
    else { var n = root.querySelector('.amx-region[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); if (n) n.classList.add("amx-selected"); }
  };

  AtlasMap.prototype._selectRegion = function (f, noZoom) {
    if (!f) return;
    this.selected = f.id; this.selectedLoc = null;
    this._setSelectedClass(f.id, false);
    var panel = el(this.uid).querySelector('[data-amx="panel"]');
    panel.innerHTML = this._panelRegion(f);
    if (!noZoom) this._zoomToBBox(f.bbox);
    if (this.S.onSelect) try { this.S.onSelect({ level: this._currentJSON().level, region: f }); } catch (e) {}
  };
  AtlasMap.prototype._selectLocation = function (l) {
    if (!l) return;
    this.selectedLoc = l.id; this.selected = null;
    this._setSelectedClass(l.id, true);
    var panel = el(this.uid).querySelector('[data-amx="panel"]');
    panel.innerHTML = this._panelLocation(l);
    if (l.xy) this._zoomToBBox([l.xy[0] - 40, l.xy[1] - 40, l.xy[0] + 40, l.xy[1] + 40]);
    if (this.S.onSelect) try { this.S.onSelect({ level: this._currentJSON().level, location: l }); } catch (e) {}
  };

  /* ---------------- navigation ---------------- */
  AtlasMap.prototype._drill = function (f) {
    var self = this;
    var panel = el(this.uid).querySelector('[data-amx="panel"]');
    if (panel) panel.innerHTML = '<div class="amx-panel-empty"><div class="amx-spin" style="margin:8px auto"></div><p style="text-align:center">Loading ' + esc(f.name) + "…</p></div>";
    this._getData(f.child).then(function (json) {
      if (!json) { self._selectRegion(f, true); return; }
      self.stack.push({ ref: f.child, json: json });
      self.metric = undefined;
      self._renderLevel();
    }).catch(function () { self._selectRegion(f, true); });
  };
  AtlasMap.prototype._goParent = function () {
    var self = this;
    var parent = this.stack[0].json.parent;
    if (!parent) return;
    this._renderLoader("Loading " + (parent.name || "map") + "…");
    this._getData(parent).then(function (json) {
      if (!json) { self._renderSleep(); return; }
      self.stack = [{ ref: parent, json: json }];
      self.metric = undefined;
      self._renderLevel();
    }).catch(function () { self._renderSleep(); });
  };

  /* ---------------- zoom / pan ---------------- */
  AtlasMap.prototype._applyView = function () {
    var svg = el(this.uid) && el(this.uid).querySelector('[data-amx="svg"]');
    if (svg) svg.setAttribute("viewBox", this.view.x + " " + this.view.y + " " + this.view.w + " " + this.view.h);
  };
  AtlasMap.prototype._zoom = function (factor, cx, cy) {
    var v = this.view, b = this.base;
    var nw = clamp(v.w * factor, b.w * 0.12, b.w * 1.6);
    var nh = nw * (b.h / b.w);
    if (cx == null) { cx = v.x + v.w / 2; cy = v.y + v.h / 2; }
    var rx = (cx - v.x) / v.w, ry = (cy - v.y) / v.h;
    var nx = cx - rx * nw, ny = cy - ry * nh;
    this.view = this._clampView({ x: nx, y: ny, w: nw, h: nh });
    this._applyView();
  };
  AtlasMap.prototype._clampView = function (v) {
    var b = this.base, m = b.w * 0.3;
    v.x = clamp(v.x, b.x - m, b.x + b.w + m - v.w);
    v.y = clamp(v.y, b.y - m, b.y + b.h + m - v.h);
    return v;
  };
  AtlasMap.prototype._zoomToBBox = function (bb) {
    var b = this.base, pad = 30;
    var w = (bb[2] - bb[0]) + pad * 2, h = (bb[3] - bb[1]) + pad * 2;
    var ar = b.w / b.h;
    if (w / h > ar) h = w / ar; else w = h * ar;
    w = clamp(w, b.w * 0.14, b.w); h = w / ar;
    var cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    this._animateView(this._clampView({ x: cx - w / 2, y: cy - h / 2, w: w, h: h }));
  };
  AtlasMap.prototype._animateView = function (target) {
    var self = this, start = Object.assign({}, this.view), t0 = null, dur = 420;
    if (this._raf) cancelAnimationFrame(this._raf);
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { this.view = target; this._applyView(); return; }
    function step(ts) {
      if (t0 == null) t0 = ts;
      var k = clamp((ts - t0) / dur, 0, 1);
      var e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
      self.view = {
        x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e,
        w: start.w + (target.w - start.w) * e, h: start.h + (target.h - start.h) * e
      };
      self._applyView();
      if (k < 1) self._raf = requestAnimationFrame(step);
    }
    this._raf = requestAnimationFrame(step);
  };
  AtlasMap.prototype._bindZoomPan = function (svg) {
    var self = this, drag = null;
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var pt = self._svgPoint(svg, e.clientX, e.clientY);
      self._zoom(e.deltaY > 0 ? 1 / 0.88 : 0.88, pt.x, pt.y);
    }, { passive: false });
    svg.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, vx: self.view.x, vy: self.view.y };
      svg.classList.add("dragging"); svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var rect = svg.getBoundingClientRect();
      var sx = self.view.w / rect.width, sy = self.view.h / rect.height;
      self.view.x = drag.vx - (e.clientX - drag.x) * sx;
      self.view.y = drag.vy - (e.clientY - drag.y) * sy;
      self.view = self._clampView(self.view);
      self._applyView();
    });
    function end() { drag = null; svg.classList.remove("dragging"); }
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
  };
  AtlasMap.prototype._svgPoint = function (svg, clientX, clientY) {
    var rect = svg.getBoundingClientRect();
    return {
      x: this.view.x + (clientX - rect.left) / rect.width * this.view.w,
      y: this.view.y + (clientY - rect.top) / rect.height * this.view.h
    };
  };

  /* ---------------- search ---------------- */
  AtlasMap.prototype._bindSearch = function (root) {
    var self = this;
    var input = root.querySelector('[data-amx="search"]');
    var pop = root.querySelector('[data-amx="searchpop"]');
    if (!input || !pop) return;
    function items() {
      var out = self.layout.feats.map(function (f) { return { id: f.id, name: f.name, kind: "region", sub: f.facts.capital || "", ref: f }; });
      self.layout.locs.forEach(function (l) { out.push({ id: l.id, name: l.name, kind: "loc", sub: l.category || "", ref: l }); });
      return out;
    }
    function render(q) {
      q = q.trim().toLowerCase();
      if (!q) { pop.classList.remove("show"); pop.innerHTML = ""; return; }
      var hits = items().filter(function (it) { return it.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 8);
      if (!hits.length) { pop.innerHTML = '<button disabled style="color:#9c958860">No matches</button>'; pop.classList.add("show"); return; }
      pop.innerHTML = hits.map(function (h) {
        return '<button data-kind="' + h.kind + '" data-id="' + esc(h.id) + '">' + esc(h.name) +
          (h.sub ? " <small>" + esc(h.sub) + "</small>" : "") + "</button>";
      }).join("");
      pop.classList.add("show");
    }
    input.addEventListener("input", function () { render(this.value); });
    input.addEventListener("focus", function () { if (this.value) render(this.value); });
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-id]"); if (!b) return;
      pop.classList.remove("show"); input.value = b.textContent.trim();
      if (b.getAttribute("data-kind") === "loc") {
        var l = self.layout.locs.filter(function (x) { return x.id === b.getAttribute("data-id"); })[0];
        self._selectLocation(l);
      } else {
        var f = self.layout.feats.filter(function (x) { return x.id === b.getAttribute("data-id"); })[0];
        self._selectRegion(f);
      }
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest || !e.target.closest(".amx-search")) pop.classList.remove("show");
    });
  };

  /* ============================================================
     PUBLIC API
     ============================================================ */
  window.initAtlasMap = function (containerId, mapDataJSON, settings) {
    var c = el(containerId);
    if (!c) { console.warn("[atlasmap] container not found:", containerId); return null; }
    return new AtlasMap(c, { __json: mapDataJSON }, mapDataJSON, settings || {});
  };

  window.loadAtlasMapFromUrl = function (containerId, opts) {
    opts = opts || {};
    var c = el(containerId);
    if (!c) { console.warn("[atlasmap] container not found:", containerId); return null; }
    if (!opts.jsonUrl) { console.warn("[atlasmap] jsonUrl required"); return null; }
    return new AtlasMap(c, { url: opts.jsonUrl }, null, opts.settings || {});
  };
})();
