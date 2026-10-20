// Места: встроенные подборки (сейчас — Будапешт) и OpenStreetMap для любых других городов.
import { BUDAPEST } from './data-budapest.js';
import { distance } from './geo.js';

const CURATED = {
  budapest: { places: BUDAPEST, lat: 47.4979, lon: 19.0402 },
  'будапешт': { places: BUDAPEST, lat: 47.4979, lon: 19.0402 },
};

export function curated(cityName) {
  const entry = CURATED[cityName.trim().toLowerCase()];
  return entry ? { ...entry, places: entry.places.map((p) => ({ ...p })) } : null;
}

export const allCuratedPlaces = () => BUDAPEST;

async function fetchJSON(url, opts = {}, timeoutMs = 40000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Сервер слишком долго не отвечает. Попробуй ещё раз.');
    if (e instanceof TypeError) throw new Error('Нет интернета или сервер недоступен.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function geocode(query, what = 'город') {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ru&q=${encodeURIComponent(query)}`;
  const [hit] = await fetchJSON(url);
  if (!hit) throw new Error(`Не нашёл ${what} «${query}». Попробуй написать по-английски.`);
  return { name: hit.name || query, lat: Number(hit.lat), lon: Number(hit.lon), osmType: hit.osm_type, osmId: Number(hit.osm_id) };
}

// Бесплатные сервера Overpass бывают перегружены — пробуем по очереди.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Заметные места вокруг точки. Достопримечательности берём все с названием,
 * а еду и парки — только известные (со ссылкой на Wikidata), чтобы не тонуть в случайных кафе.
 */
export async function fetchAround(lat, lon, radius) {
  const a = `(around:${radius},${lat},${lon})`;
  const query = `[out:json][timeout:20];
(
  nwr["tourism"~"^(attraction|museum|viewpoint|gallery)$"]["name"]${a};
  nwr["historic"~"^(castle|monument|ruins|city_gate|fort|manor)$"]["name"]${a};
  nwr["amenity"~"^(restaurant|cafe|bar|pub)$"]["wikidata"]${a};
  nwr["amenity"="place_of_worship"]["wikidata"]${a};
  nwr["leisure"~"^(park|garden)$"]["wikidata"]${a};
  nwr["amenity"="public_bath"]["name"]${a};
);
out center tags 200;`;
  return parseOverpass(await runOverpass(query));
}

async function runOverpass(query) {
  const body = 'data=' + encodeURIComponent(query);
  let lastError;
  for (const url of OVERPASS) {
    try {
      const data = await fetchJSON(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 25000);
      return data;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Сервер с картой мест не отвечает (${lastError?.message || 'ошибка'}). Попробуй ещё раз через минуту.`);
}

export function parseOverpass(data) {
  const seen = new Set();
  const places = [];
  for (const e of data.elements || []) {
    const tags = e.tags || {};
    const name = tags['name:ru'] || tags.name;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!name || lat == null || lon == null || seen.has(name)) continue;
    seen.add(name);
    const category = categoryFor(tags);
    places.push({
      id: `osm-${e.type}-${e.id}`,
      name,
      category,
      lat, lon,
      summary: tags['description:ru'] || tags.description || '',
      mustSee: Boolean(tags.wikipedia) && ['sight', 'museum', 'church', 'viewpoint'].includes(category),
      durationMin: DURATION[category],
      closedWeekdays: [],
      url: tags.website || (tags.wikipedia ? wikipediaURL(tags.wikipedia) : undefined),
    });
  }
  // Сначала известные (со статьёй в Википедии), потом остальные.
  return places.sort((x, y) => Number(Boolean(y.url)) - Number(Boolean(x.url)));
}

const DURATION = { museum: 90, bath: 120, park: 60, food: 60, cafe: 40, bar: 40, viewpoint: 30, church: 30, sight: 40 };

function categoryFor(t) {
  if (t.amenity === 'restaurant' || t.amenity === 'pub') return 'food';
  if (t.amenity === 'cafe') return 'cafe';
  if (t.amenity === 'bar') return 'bar';
  if (t.amenity === 'place_of_worship') return 'church';
  if (t.amenity === 'public_bath') return 'bath';
  if (t.tourism === 'museum' || t.tourism === 'gallery') return 'museum';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  return 'sight';
}

/** "en:Hungarian Parliament Building" -> https://en.wikipedia.org/wiki/Hungarian_Parliament_Building */
function wikipediaURL(tag) {
  const i = tag.indexOf(':');
  if (i < 0) return `https://wikipedia.org/wiki/${encodeURIComponent(tag)}`;
  return `https://${tag.slice(0, i)}.wikipedia.org/wiki/${encodeURIComponent(tag.slice(i + 1).replace(/ /g, '_'))}`;
}

/**
 * Маршрут по стране без ИИ: крупнейшие города (столица — первой), не ближе 40 км друг к другу,
 * в порядке «ближайший следующий». Дни делятся поровну, остаток — столице.
 */
export async function suggestRouteOSM(countryName, totalDays) {
  const country = await geocode(countryName, 'страну');
  if (country.osmType !== 'relation') throw new Error(`«${countryName}» не похоже на страну. Попробуй написать иначе.`);
  const data = await runOverpass(`[out:json][timeout:25];
area(id:${3600000000 + country.osmId})->.c;
(node["place"="city"](area.c); node["place"="town"]["population"](area.c););
out tags 300;`);
  const cities = (data.elements || [])
    .map((e) => ({
      name: e.tags['name:ru'] || e.tags.name,
      lat: e.lat, lon: e.lon,
      population: parseInt(String(e.tags.population || '0').replace(/\D/g, ''), 10) || 0,
      capital: e.tags.capital === 'yes' || e.tags.capital === '2',
    }))
    .filter((c) => c.name)
    .sort((a, b) => (b.capital - a.capital) || (b.population - a.population));
  if (!cities.length) throw new Error('Не нашёл городов в этой стране.');

  const count = Math.max(1, Math.min(6, Math.round(totalDays / 2.5)));
  const picked = [];
  for (const c of cities) {
    if (picked.length >= count) break;
    if (picked.every((p) => distance(p.lat, p.lon, c.lat, c.lon) > 40000)) picked.push(c);
  }
  const route = [picked.shift()];
  while (picked.length) {
    const last = route[route.length - 1];
    picked.sort((a, b) => distance(last.lat, last.lon, a.lat, a.lon) - distance(last.lat, last.lon, b.lat, b.lon));
    route.push(picked.shift());
  }
  const base = Math.floor(totalDays / route.length);
  return route.map((c, i) => ({
    name: c.name,
    days: Math.max(1, base + (i === 0 ? totalDays - base * route.length : 0)),
    why: c.capital ? 'Столица' : '',
  }));
}

// ---------- Гид из Википедии (без ИИ) ----------

const WIKI = 'https://ru.wikipedia.org/w/api.php?format=json&origin=*';

export async function wikiGuide(place, city) {
  let title;
  const m = place.url?.match(/^https:\/\/ru\.wikipedia\.org\/wiki\/(.+)$/);
  if (m) title = decodeURIComponent(m[1]).replace(/_/g, ' ');
  if (!title) {
    const s = await fetchJSON(`${WIKI}&action=query&list=search&srlimit=1&srsearch=${encodeURIComponent(`${place.name} ${city}`)}`, {}, 20000);
    title = s.query?.search?.[0]?.title;
  }
  if (!title) throw new Error('В Википедии об этом месте ничего не нашлось.');
  const d = await fetchJSON(`${WIKI}&action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(title)}`, {}, 20000);
  const page = Object.values(d.query?.pages || {})[0];
  const text = page?.extract;
  if (!text) throw new Error('В Википедии об этом месте ничего не нашлось.');

  // "== Заголовок ==" -> секции; служебные разделы в конце выкидываем.
  const SKIP = /^(Примечания|Литература|Ссылки|См\. также|Источники|Галерея)$/i;
  const parts = text.split(/\n(={2,})\s*(.+?)\s*\1\n/);
  const intro = parts[0].trim();
  const sections = [];
  for (let i = 1; i + 2 < parts.length + 1; i += 3) {
    const sectionTitle = parts[i + 1];
    const body = (parts[i + 2] || '').trim();
    if (!sectionTitle || SKIP.test(sectionTitle) || body.length < 80) continue;
    sections.push({ title: sectionTitle, text: body.slice(0, 3000) });
    if (sections.length >= 8) break;
  }
  return {
    source: 'wiki',
    title: page.title,
    url: `https://ru.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    intro: intro.slice(0, 3000),
    sections,
    highlights: [],
    tips: [],
    savedAt: new Date().toISOString(),
  };
}
