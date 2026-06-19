const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM('<!doctype html><html><body><div id="host" style="width:1100px;height:640px"></div></body></html>',
  { pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
// jsdom elements lack layout; force a desktop-ish width so legend defaults to expanded
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth',  { get(){ return 1100; } });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get(){ return 640; } });
window.HTMLElement.prototype.getBoundingClientRect = () => ({left:0,top:0,width:1100,height:640,right:1100,bottom:640});

// ---- record of what the engine asked MapLibre to do ----
const rec = { sources:new Set(), layers:new Map(), removedLayers:[], layoutSets:[], handlers:[] };
let loadCb = null;
let queryResult = []; // controls overlayHitAt

function FakeMap(){
  this._canvas = { style:{} };
}
FakeMap.prototype.on = function(ev, a, b){
  if (ev === 'load'){ loadCb = a; return; }
  const fn = b || a, layer = b ? a : null;
  rec.handlers.push({ev, layer, fn});
};
FakeMap.prototype.off = function(ev, layer, fn){
  const i = rec.handlers.findIndex(h=>h.ev===ev && h.layer===layer && h.fn===fn);
  if (i>=0) rec.handlers.splice(i,1);
};
FakeMap.prototype.addControl = function(){};
FakeMap.prototype.addSource = function(id){ rec.sources.add(id); };
FakeMap.prototype.getSource = function(id){ return rec.sources.has(id) ? {} : undefined; };
FakeMap.prototype.removeSource = function(id){ rec.sources.delete(id); };
FakeMap.prototype.addLayer = function(spec){ rec.layers.set(spec.id, spec); };
FakeMap.prototype.getLayer = function(id){ return rec.layers.has(id) ? {} : undefined; };
FakeMap.prototype.removeLayer = function(id){ rec.layers.delete(id); rec.removedLayers.push(id); };
FakeMap.prototype.setLayoutProperty = function(id, k, v){
  rec.layoutSets.push({id,k,v});
  if (rec.layers.has(id)){ rec.layers.get(id).layout = rec.layers.get(id).layout||{}; rec.layers.get(id).layout[k]=v; }
};
FakeMap.prototype.setFeatureState = function(){};
FakeMap.prototype.getCanvas = function(){ return this._canvas; };
FakeMap.prototype.queryRenderedFeatures = function(){ return queryResult; };
FakeMap.prototype.fitBounds = function(){};
FakeMap.prototype.easeTo = function(){};
FakeMap.prototype.touchZoomRotate = { disableRotation(){} };

function FakeMarker(){ this._el=null; }
FakeMarker.prototype.setLngLat=function(){return this;};
FakeMarker.prototype.addTo=function(){return this;};
FakeMarker.prototype.remove=function(){};
function FakePopup(){}
FakePopup.prototype.setLngLat=function(){return this;};
FakePopup.prototype.setHTML=function(){return this;};
FakePopup.prototype.addTo=function(){return this;};
FakePopup.prototype.remove=function(){};

global.maplibregl = window.maplibregl = {
  Map: FakeMap,
  NavigationControl: function(){}, AttributionControl: function(){},
  Marker: function(){ return new FakeMarker(); },
  Popup: function(){ return new FakePopup(); }
};

// load engine
eval(fs.readFileSync('mapportal-portal/mapportal-engine/mapportal.js','utf8'));

// ---- simulate the multi-file merge the loader does, then init ----
const base = JSON.parse(fs.readFileSync('mapportal-portal/india-exam-map.json','utf8'));
const ov   = JSON.parse(fs.readFileSync('mapportal-portal/india-thematic-overlays.json','utf8'));

// replicate loader merge logic for the test
function mergeNodes(parts){
  let merged = { version:parts[0].version, portal_type:parts[0].portal_type, meta:parts[0].meta, nodes:{} };
  parts.forEach(p=>{ const ns=p.nodes||{}; Object.keys(ns).forEach(id=>{
    const incoming=ns[id], existing=merged.nodes[id];
    if (existing){ const c=(existing.overlays||[]).concat(incoming.overlays||[]);
      merged.nodes[id]=Object.assign({},existing,incoming); if(c.length) merged.nodes[id].overlays=c; }
    else merged.nodes[id]=incoming; });
  });
  return merged;
}
const data = mergeNodes([base, ov]);

let fail=0; const ok=(c,m)=>{ console.log((c?'  PASS':'  FAIL')+' - '+m); if(!c) fail++; };

// merge assertions
ok(data.nodes['in-uttar-pradesh'].overlays && data.nodes['in-uttar-pradesh'].overlays.length===9,
   'merge: UP node has 9 overlays from overlay file');
ok(data.nodes['in-uttar-pradesh'].boundaries && data.nodes['in-uttar-pradesh'].boundaries.features.length===75,
   'merge: UP base fields (75 district boundaries) preserved');
ok(data.nodes['india'].overlays && data.nodes['india'].overlays.length===4,
   'merge: India node has 4 overlays');
ok(data.nodes['india'].data && data.nodes['india'].data.demography,
   'merge: India base data preserved');

const api = window.initMapPortal('host', data, { start:'world' });
loadCb();  // fire map 'load' -> enterNode(world)

console.log('\n[world] expect no overlays');
ok([...rec.layers.keys()].filter(k=>k.startsWith('mp-ov-')).length===0, 'world: no overlay layers drawn');
let legend = document.querySelector('.mp-legend');
ok(legend.style.display==='none', 'world: legend hidden');

console.log('\n[india] drill in');
api.goTo('india');
let ovLayers = [...rec.layers.keys()].filter(k=>k.startsWith('mp-ov-'));
ok(ovLayers.some(k=>k.includes('in-rivers')&&k.endsWith('-line')), 'india: river LINE layer added');
ok(ovLayers.some(k=>k.includes('in-railtrunk')&&k.endsWith('-case')), 'india: railway CASING layer added (dashed style)');
ok(ovLayers.some(k=>k.includes('in-parks')&&k.endsWith('-fill')), 'india: national-park FILL layer added');
// highway default off => visibility none
let nh = rec.layers.get([...rec.layers.keys()].find(k=>k.includes('in-nh')&&k.endsWith('-line')));
ok(nh && nh.layout && nh.layout.visibility==='none', 'india: highways default-off respected (visibility none)');
let rivers = rec.layers.get([...rec.layers.keys()].find(k=>k.includes('in-rivers')&&k.endsWith('-line')));
ok(rivers && rivers.layout.visibility==='visible', 'india: rivers default-on (visibility visible)');
legend = document.querySelector('.mp-legend');
ok(legend.style.display!=='none', 'india: legend shown');
ok(legend.querySelectorAll('.mp-legend-row').length===4, 'india: legend has 4 rows');

console.log('\n[uttar pradesh] drill in');
api.goTo('in-uttar-pradesh');
ovLayers = [...rec.layers.keys()].filter(k=>k.startsWith('mp-ov-'));
ok([...rec.layers.keys()].filter(k=>k.includes('in-rivers')).length===0, 'UP: previous India overlay layers cleared');
ok(ovLayers.some(k=>k.includes('up-wetlands')&&k.endsWith('-fill')), 'UP: wetland FILL added');
ok(ovLayers.some(k=>k.includes('up-poi')&&k.endsWith('-circle')), 'UP: popular-location CIRCLE added');
ok(ovLayers.some(k=>k.includes('up-canals')&&k.endsWith('-line')), 'UP: waterway/canal LINE added');
ok(ovLayers.some(k=>k.includes('up-lakes')&&k.endsWith('-fill')), 'UP: lake/reservoir FILL added');
legend = document.querySelector('.mp-legend');
ok(legend.querySelectorAll('.mp-legend-row').length===9, 'UP: legend has 9 rows');

console.log('\n[toggle] turn Rivers off via legend, then drill away and back');
const rows = [...legend.querySelectorAll('.mp-legend-row')];
const riverRow = rows.find(r=>/Rivers/.test(r.textContent));
const cb = riverRow.querySelector('input');
cb.checked = false; cb.dispatchEvent(new window.Event('change'));
let setNone = rec.layoutSets.filter(s=>s.id.includes('up-rivers') && s.v==='none');
ok(setNone.length>0, 'toggle: river layers set to visibility none');
// persistence: drill to india and back to UP, rivers should re-add as hidden
api.goTo('india'); api.goTo('in-uttar-pradesh');
let upRiver = rec.layers.get([...rec.layers.keys()].find(k=>k.includes('up-rivers')&&k.endsWith('-line')));
ok(upRiver && upRiver.layout.visibility==='none', 'persistence: rivers stay OFF after navigating away and back');

console.log('\n[click guard] overlayHitAt suppresses region drill');
const fillClick = rec.handlers.find(h=>h.ev==='click' && h.layer==='mp-fill');
let drilled=false; const realGoTo=api.goTo;
queryResult = [{}]; // simulate an overlay feature under the click
// monkeypatch selectChild path: clicking mp-fill should early-return; we assert by checking no source/layer churn
const layerCountBefore = rec.layers.size;
fillClick.fn({ features:[{properties:{nodeId:'up-lucknow'}}], point:{x:1,y:1} });
ok(rec.layers.size===layerCountBefore, 'click guard: region did NOT drill while overlay feature under cursor');
queryResult = [];

console.log('\n[cleanup] handlers removed on node change (no leak)');
const before = rec.handlers.length;
api.goTo('india'); api.goTo('in-uttar-pradesh');
const after = rec.handlers.length;
ok(after <= before + 5, 'cleanup: overlay handler count stable across navigation (no unbounded leak): '+before+' -> '+after);

console.log('\n' + (fail===0 ? 'ALL TESTS PASSED' : (fail+' TEST(S) FAILED')));
process.exit(fail?1:0);
