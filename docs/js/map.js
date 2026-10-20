// Карта на MapLibre + OpenFreeMap (бесплатно, без ключей).
// Все тайлы, шрифты и стиль идут через свой протокол cached:// и сохраняются в Cache Storage,
// поэтому однажды скачанный город открывается без интернета.
import { CATEGORIES } from './geo.js';

const maplibregl = window.maplibregl;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const CACHE_NAME = 'tg-map-v1';

let cachePromise;
function openCache() {
  if (!('caches' in window)) return Promise.resolve(null);
  cachePromise ??= caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

async function cachedFetch(url) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit;
  }
  const res = await fetch(url);
  if (res.ok && cache) cache.put(url, res.clone()).catch(() => {});
  return res;
}

async function isCached(url) {
  const cache = await openCache();
  return cache ? Boolean(await cache.match(url)) : false;
}

maplibregl.addProtocol('cached', async (params) => {
  const res = await cachedFetch(params.url.slice('cached://'.length));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (params.type === 'json') return { data: await res.json() };
  if (params.type === 'string') return { data: await res.text() };
  return { data: await res.arrayBuffer() };
});

let stylePromise;
function loadStyle() {
  stylePromise ??= (async () => {
    const style = await (await cachedFetch(STYLE_URL)).json();
    for (const [name, src] of Object.entries(style.sources)) {
      if (src.url) {
        const tj = await (await cachedFetch(src.url)).json();
        style.sources[name] = {
          type: src.type,
          tiles: tj.tiles,
          minzoom: tj.minzoom ?? 0,
          maxzoom: tj.maxzoom ?? 14,
          attribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap',
        };
      }
      const s = style.sources[name];
      if (s.tiles) s.tiles = s.tiles.map((t) => 'cached://' + t);
    }
    style.sprite = 'cached://' + style.sprite;
    style.glyphs = 'cached://' + style.glyphs;
    return style;
  })().catch((e) => {
    stylePromise = undefined;
    throw e;
  });
  return stylePromise;
}

export async function createMap(container, { center, zoom = 13 }) {
  const style = await loadStyle();
  const map = new maplibregl.Map({
    container,
    style,
    center: [center.lon, center.lat],
    zoom,
    attributionControl: { compact: true },
    dragRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  return map;
}

function pinElement(place, { visited, number }) {
  const cat = CATEGORIES[place.category] || CATEGORIES.sight;
  // Внешний div позиционирует MapLibre — ему нельзя задавать position, поэтому стиль на внутренней кнопке.
  const el = document.createElement('div');
  el.innerHTML = `<button class="pin${visited ? ' visited' : ''}${place.mustSee ? ' must' : ''}" style="--pin:${cat.color}" aria-label="${place.name.replace(/"/g, '&quot;')}"><span>${number ?? cat.emoji}</span>${visited ? '<i>✓</i>' : ''}</button>`;
  return el;
}

/** Пины мест. Возвращает функцию, которая их удаляет. */
export function addPins(map, places, { isVisited, onSelect, numbered = false }) {
  const markers = places.map((p, i) => {
    const el = pinElement(p, { visited: isVisited(p.id), number: numbered ? i + 1 : undefined });
    el.addEventListener('click', (e) => { e.stopPropagation(); onSelect(p); });
    return new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  });
  return () => markers.forEach((m) => m.remove());
}

export function fitTo(map, points, padding = 50) {
  if (!points.length) return;
  if (points.length === 1) {
    map.jumpTo({ center: [points[0].lon, points[0].lat], zoom: 15 });
    return;
  }
  const b = new maplibregl.LngLatBounds();
  points.forEach((p) => b.extend([p.lon, p.lat]));
  map.fitBounds(b, { padding, maxZoom: 16, duration: 0 });
}

/** Точка «я здесь». */
export function userDot(map) {
  const el = document.createElement('div');
  el.className = 'me';
  const marker = new maplibregl.Marker({ element: el });
  let added = false;
  return {
    update(loc) {
      if (!loc) return;
      marker.setLngLat([loc.lon, loc.lat]);
      if (!added) { marker.addTo(map); added = true; }
    },
    remove() { marker.remove(); },
  };
}

export function drawRoute(map, places) {
  const add = () => {
    map.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: places.map((p) => [p.lon, p.lat]) } },
    });
    map.addLayer({
      id: 'route', type: 'line', source: 'route',
      paint: { 'line-color': '#2f6fde', 'line-width': 4, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] },
    });
  };
  if (map.isStyleLoaded()) add(); else map.once('load', add);
}

// ---------- Офлайн-загрузка ----------

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function tileURLs(template, bbox, minz, maxz) {
  const urls = [];
  for (let z = minz; z <= maxz; z++) {
    const x0 = lon2x(bbox.west, z), x1 = lon2x(bbox.east, z);
    const y0 = lat2y(bbox.north, z), y1 = lat2y(bbox.south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) urls.push(template.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  }
  return urls;
}

/** Рамка вокруг мест с запасом ~3 км. */
export function bboxAround(points, marginKm = 3) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const dLat = marginKm / 111;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = marginKm / (111 * Math.cos((midLat * Math.PI) / 180));
  return {
    south: Math.min(...lats) - dLat, north: Math.max(...lats) + dLat,
    west: Math.min(...lons) - dLon, east: Math.max(...lons) + dLon,
  };
}

/** Всё, что нужно карте в этих рамках: тайлы, иконки, шрифты для латиницы и кириллицы. */
async function offlineURLs(bboxes) {
  const style = await loadStyle();
  const strip = (u) => u.replace(/^cached:\/\//, '');
  const urls = new Set([STYLE_URL]);
  for (const src of Object.values(style.sources)) {
    if (!src.tiles) continue;
    const template = strip(src.tiles[0]);
    const maxz = Math.min(src.maxzoom ?? 14, 14);
    for (const bbox of bboxes) tileURLs(template, bbox, src.minzoom ?? 0, maxz).forEach((u) => urls.add(u));
  }
  const sprite = strip(style.sprite);
  ['.json', '.png', '@2x.json', '@2x.png'].forEach((s) => urls.add(sprite + s));
  const fonts = new Set();
  for (const layer of style.layers) {
    const f = layer.layout?.['text-font'];
    if (Array.isArray(f) && f.every((x) => typeof x === 'string')) fonts.add(f.join(','));
  }
  const glyphs = strip(style.glyphs);
  for (const font of fonts) {
    for (const range of ['0-255', '256-511', '1024-1279', '8192-8447']) {
      urls.add(glyphs.replace('{fontstack}', font).replace('{range}', range));
    }
  }
  return [...urls];
}

export async function downloadOffline(bboxes, onProgress) {
  if (!('caches' in window)) throw new Error('Это устройство не поддерживает офлайн-хранилище.');
  const urls = await offlineURLs(bboxes);
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        if (!(await isCached(url))) {
          const res = await cachedFetch(url);
          if (!res.ok && res.status !== 404) failed++;
        }
      } catch {
        failed++;
      }
      done++;
      onProgress?.(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { total: urls.length, failed };
}
