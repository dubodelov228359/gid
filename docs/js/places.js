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

// ---------- Реальные места города — кандидаты для ИИ ----------

/**
 * Все именованные места вокруг точки из OpenStreetMap: координаты у них настоящие.
 * ИИ потом только выбирает из них лучшие и описывает — так места не окажутся в море.
 */
export async function fetchCandidates(lat, lon, radius) {
  const a = `(around:${radius},${lat},${lon})`;
  const data = await runOverpass(`[out:json][timeout:25];
(
  nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|aquarium|theme_park)$"]["name"]${a};
  nwr["historic"]["name"]${a};
  nwr["amenity"~"^(place_of_worship|marketplace|public_bath|theatre)$"]["name"]${a};
  nwr["leisure"~"^(park|garden|nature_reserve|beach_resort|marina)$"]["name"]${a};
  nwr["natural"~"^(beach|peak|cave_entrance)$"]["name"]${a};
  nwr["amenity"~"^(restaurant|cafe|bar|pub|ice_cream|biergarten)$"]["name"]${a};
  nwr["shop"~"^(bakery|pastry|confectionery)$"]["name"]${a};
);
out center tags 2000;`);
  return parseCandidates(data, lat, lon);
}

function candidateCategory(t) {
  if (t.natural === 'beach' || t.leisure === 'beach_resort' || t.leisure === 'nature_reserve' || t.leisure === 'marina') return 'park';
  if (t.natural === 'peak' || t.natural === 'cave_entrance') return 'viewpoint';
  if (t.amenity === 'marketplace') return 'food';
  if (t.tourism === 'museum') return 'museum';
  if (t.amenity === 'place_of_worship') return 'church';
  if (t.amenity === 'theatre' || t.historic) return 'sight';
  if (t.amenity === 'ice_cream' || t.shop) return 'cafe';
  if (t.amenity === 'biergarten') return 'bar';
  return categoryFor(t);
}

export function parseCandidates(data, lat, lon) {
  const seen = new Set();
  const list = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    const clat = e.lat ?? e.center?.lat;
    const clon = e.lon ?? e.center?.lon;
    if (!t.name || clat == null || clon == null) continue;
    const key = t.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const category = candidateCategory(t);
    const food = ['food', 'cafe', 'bar'].includes(category);
    // Чем больше признаков известности, тем выше в списке для ИИ.
    const score = (t.wikidata ? 4 : 0) + (t.wikipedia ? 3 : 0) + (t.tourism ? 2 : 0) + (t.website ? 1 : 0)
      + (t.opening_hours ? 1 : 0) + (t['name:en'] || t['name:ru'] ? 1 : 0);
    list.push({
      id: `osm-${e.type}-${e.id}`,
      name: t['name:ru'] || t['name:en'] || t.name,
      local: t.name,
      names: [t.name, t['name:ru'], t['name:en'], t['name:he'], t['name:ka'], t.alt_name, t.int_name].filter(Boolean),
      kind: Object.entries({ tourism: t.tourism, historic: t.historic, amenity: t.amenity, leisure: t.leisure, natural: t.natural, shop: t.shop, cuisine: t.cuisine })
        .filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', '),
      hours: t.opening_hours,
      category, food, score,
      lat: clat, lon: clon,
      dist: distance(lat, lon, clat, clon),
      url: t.website || (t.wikipedia ? wikipediaURL(t.wikipedia) : undefined),
    });
  }
  // Не больше ~250 достопримечательностей и ~200 заведений: важные и поближе к центру.
  const rank = (a, b) => b.score - a.score || a.dist - b.dist;
  return [
    ...list.filter((c) => !c.food).sort(rank).slice(0, 250),
    ...list.filter((c) => c.food).sort(rank).slice(0, 200),
  ];
}

// ---------- Сопоставление названий ----------

const STOPWORDS = new Set(['the', 'of', 'and', 'de', 'la', 'le', 'и', 'в', 'на', 'restaurant', 'ресторан', 'cafe', 'кафе', 'café', 'bar', 'бар']);

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

/** «Звучание» слова латиницей: «Пинати» и Pinati, «Галиль» и Galil дают одно и то же. */
function sound(w) {
  const lat = /[а-я]/.test(w) ? [...w].map((ch) => TRANSLIT[ch] ?? ch).join('') : w;
  if (!/^[a-z\d]+$/.test(lat)) return null; // иврит, грузинский и т.п. — сравниваем как есть
  return lat.replace(/kh/g, 'h').replace(/ph/g, 'f').replace(/c/g, 'k').replace(/w/g, 'v').replace(/[yj]/g, 'i').replace(/(.)\1+/g, '$1');
}

function words(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е')
    .replace(/[^\p{L}\d]+/gu, ' ').split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Насколько похожи два названия: 1 — совпадают, 0 — ничего общего. Разные алфавиты сравниваем по звучанию. */
export function nameSimilarity(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const key = (w) => sound(w) ?? w;
  const sb = new Set(wb.map(key));
  const common = new Set(wa.map(key).filter((k) => sb.has(k))).size;
  return common / Math.min(new Set(wa.map(key)).size, sb.size);
}

/** Ищет место среди кандидатов с карты по любому из названий; ближе к примерной точке — лучше. */
export function matchCandidate(place, candidates, maxDist = 15000) {
  const names = [place.name, place.localName].filter(Boolean);
  let best = null;
  for (const c of candidates) {
    const sim = Math.max(...names.flatMap((n) => c.names.map((cn) => nameSimilarity(n, cn))));
    if (sim < 0.6) continue;
    const d = distance(place.lat, place.lon, c.lat, c.lon);
    if (d > maxDist) continue;
    const score = sim * 10 - d / 2000;
    if (!best || score > best.score) best = { c, score };
  }
  return best?.c || null;
}
