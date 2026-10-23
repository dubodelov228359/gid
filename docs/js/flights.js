// Перелёты: ближайший аэропорт к городу и ссылки на поиск билетов с маршрутом и датами.
// Живых цен бесплатно не даёт никто — цены смотрим по ссылкам, а примерный диапазон оценивает ИИ.
import { distance } from './geo.js';

let airportsP;
function loadAirports() {
  airportsP ??= fetch('data/airports.json').then((r) => r.json())
    .then((list) => list.map(([iata, lat, lon, large, city, cc]) => ({ iata, lat, lon, large: Boolean(large), city, cc })))
    .catch((e) => { airportsP = undefined; throw e; });
  return airportsP;
}

// Города с несколькими крупными аэропортами — ищем сразу по всем через код города.
const METRO = {
  SVO: 'MOW', DME: 'MOW', VKO: 'MOW', ZIA: 'MOW', LHR: 'LON', LGW: 'LON', STN: 'LON', LTN: 'LON', LCY: 'LON', SEN: 'LON',
  IST: 'IST', SAW: 'IST', CDG: 'PAR', ORY: 'PAR', BVA: 'PAR', MXP: 'MIL', LIN: 'MIL', BGY: 'MIL', FCO: 'ROM', CIA: 'ROM',
  JFK: 'NYC', LGA: 'NYC', EWR: 'NYC', NRT: 'TYO', HND: 'TYO', PEK: 'BJS', PKX: 'BJS', ICN: 'SEL', GMP: 'SEL',
  ARN: 'STO', BMA: 'STO', NYO: 'STO', DXB: 'DXB', DWC: 'DXB', BKK: 'BKK', DMK: 'BKK', LED: 'LED',
  TSF: 'VCE', VCE: 'VCE', BER: 'BER', OSL: 'OSL', TRF: 'OSL', KIX: 'OSA', ITM: 'OSA', GIG: 'RIO', SDU: 'RIO',
  GRU: 'SAO', CGH: 'SAO', VCP: 'SAO', IAD: 'WAS', DCA: 'WAS', BWI: 'WAS', ORD: 'CHI', MDW: 'CHI', YYZ: 'YTO', YTZ: 'YTO',
};
const METRO_NAME = { MOW: 'все аэропорты Москвы', LON: 'все аэропорты Лондона', IST: 'оба аэропорта Стамбула', PAR: 'все аэропорты Парижа',
  MIL: 'все аэропорты Милана', ROM: 'оба аэропорта Рима', NYC: 'все аэропорты Нью-Йорка', TYO: 'оба аэропорта Токио', BJS: 'оба аэропорта Пекина',
  SEL: 'оба аэропорта Сеула', STO: 'все аэропорты Стокгольма', BKK: 'оба аэропорта Бангкока', OSA: 'оба аэропорта Осаки', SAO: 'все аэропорты Сан-Паулу',
  WAS: 'все аэропорты Вашингтона', CHI: 'оба аэропорта Чикаго', YTO: 'оба аэропорта Торонто', RIO: 'оба аэропорта Рио', OSL: 'оба аэропорта Осло', DXB: 'оба аэропорта Дубая' };

/** Аэропорт для города: крупный в пределах ~150 км лучше маленького рядом. */
export async function nearestAirport(lat, lon) {
  const list = await loadAirports();
  let best = null;
  for (const a of list) {
    const d = distance(lat, lon, a.lat, a.lon);
    if (d > 250000) continue;
    const score = d - (a.large ? 80000 : 0);
    if (!best || score < best.score) best = { a, score, d };
  }
  if (!best) return null;
  const metro = METRO[best.a.iata];
  const multi = metro && metro !== best.a.iata ? metro : null;
  return { ...best.a, iata: multi || best.a.iata, airportNote: multi ? METRO_NAME[multi] : '', km: Math.round(best.d / 1000) };
}

/** Главный аэропорт страны — крупный, ближайший к столице (или любой крупный). */
export async function countryAirport(cc, capital) {
  const list = (await loadAirports()).filter((a) => a.cc === cc);
  if (!list.length) return null;
  const pool = list.some((a) => a.large) ? list.filter((a) => a.large) : list;
  if (!capital) return pool[0];
  return pool.reduce((b, a) => (distance(capital.lat, capital.lon, a.lat, a.lon) < distance(capital.lat, capital.lon, b.lat, b.lon) ? a : b));
}

/** Примерное время в полёте по прямой: ~800 км/ч плюс полчаса на взлёт и посадку. */
export function flightHours(from, to) {
  return Math.round((distance(from.lat, from.lon, to.lat, to.lon) / 1000 / 800 + 0.5) * 10) / 10;
}

const dmy = (s) => s.slice(8, 10) + s.slice(5, 7); // 2026-11-24 -> 2411
const ymd = (s) => s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10); // -> 261124

/** Ссылки на поиск: туда-обратно, 1 взрослый, эконом. */
export function searchLinks(from, to, depart, back) {
  const f = from.iata, t = to.iata;
  return [
    { title: 'Aviasales', url: `https://www.aviasales.com/search/${f}${dmy(depart)}${t}${back ? dmy(back) : ''}1` },
    { title: 'Google Flights', url: `https://www.google.com/travel/flights?hl=ru&q=${encodeURIComponent(`Flights from ${f} to ${t} on ${depart}${back ? ` through ${back}` : ''}`)}` },
    { title: 'Skyscanner', url: `https://www.skyscanner.net/transport/flights/${f.toLowerCase()}/${t.toLowerCase()}/${ymd(depart)}/${back ? `${ymd(back)}/` : ''}` },
  ];
}

/** Аэропорт по коду из встроенного списка (чтобы проверить код, который назвал ИИ). */
export async function airportByCode(iata) {
  return (await loadAirports()).find((a) => a.iata === iata) || null;
}
