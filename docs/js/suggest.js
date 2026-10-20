// Подсказки при вводе страны и города. Списки встроены (data/*.json из GeoNames),
// поэтому ищут мгновенно и без интернета; редкие места — кнопкой «Найти на карте».

const COUNTRY_FIX = { GB: 'Великобритания', KR: 'Южная Корея', KP: 'Северная Корея' };
const COUNTRY_ALIASES = {
  GB: ['Англия', 'Великобритания', 'Британия', 'UK'], NL: ['Голландия'], AE: ['Эмираты', 'Дубай'],
  KR: ['Корея'], US: ['Америка', 'Соединённые Штаты'], CZ: ['Чешская Республика'], CN: ['КНР'],
  TR: ['Турция'], VN: ['Вьетнам'], TH: ['Тайланд'], CH: ['Швейцария'], BY: ['Белоруссия'],
};

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d ]+/gu, ' ').replace(/\s+/g, ' ').trim();

let countriesP, citiesP;

function loadCountries() {
  countriesP ??= fetch('data/countries.json').then((r) => r.json()).then((list) => list.map(([ru, en, cc]) => {
    const name = COUNTRY_FIX[cc] || ru;
    return { name, en, cc, keys: [name, ru, en, ...(COUNTRY_ALIASES[cc] || [])].map(norm) };
  })).catch((e) => { countriesP = undefined; throw e; });
  return countriesP;
}

function loadCities() {
  citiesP ??= fetch('data/cities.json').then((r) => r.json()).then((list) => list.map(([ru, en, cc, lat, lon, popK, cap]) => ({
    name: ru, en: en || ru, cc, lat, lon, popK, cap: Boolean(cap), ruKey: norm(ru), enKey: norm(en || ru),
  }))).catch((e) => { citiesP = undefined; throw e; });
  return citiesP;
}

export async function countryName(cc) {
  return (await loadCountries()).find((c) => c.cc === cc)?.name || cc;
}

/** Совпадение с начала названия или с начала любого слова в нём. */
function matchRank(key, q) {
  if (key === q) return 0;
  if (key.startsWith(q)) return 1;
  if (key.includes(' ' + q)) return 2;
  return -1;
}

export async function searchCountries(query, limit = 6) {
  const q = norm(query);
  if (!q) return [];
  const list = await loadCountries();
  return list
    .map((c) => ({ c, r: Math.min(...c.keys.map((k) => matchRank(k, q)).filter((x) => x >= 0), 9) }))
    .filter((x) => x.r < 9)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name, 'ru'))
    .slice(0, limit)
    .map((x) => ({ name: x.c.name, sub: x.c.en, cc: x.c.cc }));
}

/** Города: сначала точные и столицы, потом по населению. cc — ограничить страной. */
export async function searchCities(query, { cc, limit = 7 } = {}) {
  const q = norm(query);
  if (q.length < 2) return [];
  const [list, countries] = await Promise.all([loadCities(), loadCountries()]);
  const ccName = new Map(countries.map((c) => [c.cc, c.name]));
  const hits = [];
  for (const c of list) {
    if (cc && c.cc !== cc) continue;
    const r = Math.min(...[matchRank(c.ruKey, q), matchRank(c.enKey, q)].filter((x) => x >= 0), 9);
    if (r < 9) hits.push({ c, r });
  }
  return hits
    .sort((a, b) => a.r - b.r || (b.c.cap - a.c.cap) || b.c.popK - a.c.popK)
    .slice(0, limit)
    .map(({ c }) => ({
      name: c.name, sub: [ccName.get(c.cc) || c.cc, c.en !== c.name ? c.en : ''].filter(Boolean).join(' · '),
      cc: c.cc, lat: c.lat, lon: c.lon,
    }));
}

/** Редкие места (горные посёлки и т.п.) — разовый поиск по карте по кнопке. */
export async function searchOnMap(query, cc) {
  const params = new URLSearchParams({ q: query, format: 'json', limit: '6', 'accept-language': 'ru', addressdetails: '1' });
  if (cc) params.set('countrycodes', cc.toLowerCase());
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error('Поиск по карте сейчас недоступен.');
  const list = await res.json();
  return list
    .filter((h) => ['city', 'town', 'village', 'hamlet', 'suburb', 'administrative', 'island', 'peak', 'locality'].includes(h.type) || h.class === 'place')
    .map((h) => ({
      name: h.name || h.display_name.split(',')[0],
      sub: [h.address?.state, h.address?.country].filter(Boolean).join(' · '),
      cc: (h.address?.country_code || '').toUpperCase(),
      lat: Number(h.lat), lon: Number(h.lon),
    }));
}
