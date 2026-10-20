// Расстояния, даты и категории — общие помощники.

export const CATEGORIES = {
  sight:     { title: 'Достопримечательности', emoji: '🏛', color: '#2f6fde' },
  museum:    { title: 'Музеи',                 emoji: '🖼', color: '#8a4fd8' },
  church:    { title: 'Храмы',                 emoji: '⛪️', color: '#5a5fd6' },
  viewpoint: { title: 'Виды',                  emoji: '🌄', color: '#159a9c' },
  park:      { title: 'Парки',                 emoji: '🌳', color: '#2e9e4f' },
  bath:      { title: 'Купальни',              emoji: '♨️', color: '#1aa3c8' },
  food:      { title: 'Еда',                   emoji: '🍲', color: '#e07a1f' },
  cafe:      { title: 'Кафе и десерты',        emoji: '☕️', color: '#9a6b45' },
  bar:       { title: 'Бары',                  emoji: '🍷', color: '#d04a86' },
};

export const isFood = (p) => p.category === 'food' || p.category === 'cafe' || p.category === 'bar';

/** Расстояние по сфере в метрах. */
export function distance(lat1, lon1, lat2, lon2) {
  const r = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const dist = (a, b) => distance(a.lat, a.lon, b.lat, b.lon);

/** Пешком ~4.8 км/ч с поправкой на непрямые улицы. */
export const walkingMinutes = (m) => Math.max(1, Math.round((m * 1.3) / 80));

export const formatDistance = (m) => (m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(1)} км`);

// Даты храним строками YYYY-MM-DD в местном времени — без сюрпризов с часовыми поясами.
export function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDay(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function addDays(s, n) {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return formatDay(d);
}

export const today = () => formatDay(new Date());

export function daysBetween(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / 86400000);
}

/** 1 = воскресенье … 7 = суббота (как в данных). */
export const weekday = (s) => parseDay(s).getDay() + 1;

export const isClosed = (p, day) => (p.closedWeekdays || []).includes(weekday(day));

const WEEKDAYS = ['', 'вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const weekdayShort = (n) => WEEKDAYS[n];

export function humanDay(s, withWeekday = true) {
  return parseDay(s).toLocaleDateString('ru-RU', withWeekday
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long' });
}
