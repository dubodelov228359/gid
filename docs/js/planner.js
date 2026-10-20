// План по дням без интернета и без ИИ:
// группирует места по районам, учитывает выходные дни мест и время на день.
import { addDays, dist, distance, isClosed, isFood } from './geo.js';

const DAY_BUDGET = 7 * 60;
const HOP = 25;

const score = (p) => (p.mustSee ? 100 : 0) + (p.ticketAdvanceDays ? 5 : 0) + Math.floor(Math.min(p.durationMin || 60, 120) / 30);
const cost = (p) => (p.durationMin || 60) + HOP;
const load = (ps) => ps.reduce((s, p) => s + cost(p), 0);
const closedCount = (ps, day) => ps.filter((p) => isClosed(p, day)).length;
const minBy = (arr, f) => arr.reduce((best, x) => (best === undefined || f(x) < f(best) ? x : best), undefined);
const maxBy = (arr, f) => minBy(arr, (x) => -f(x));

function centroid(ps) {
  if (!ps.length) return null;
  return { lat: ps.reduce((s, p) => s + p.lat, 0) / ps.length, lon: ps.reduce((s, p) => s + p.lon, 0) / ps.length };
}

function distanceToCenter(p, group) {
  const c = centroid(group);
  return c ? dist(p, c) : 5000; // пустой день — средний приоритет
}

/** Культовые места с едой важнее близости: готовы пройти до них лишние ~2 км. */
const mealRank = (p, c) => dist(p, c) - (p.mustSee ? 2000 : 0);

function kMeans(places, k, iterations = 15) {
  if (k <= 0 || !places.length) return [];
  // Начальные центры: самое важное место, затем каждый раз самое дальнее от уже выбранных.
  const centers = [{ lat: places[0].lat, lon: places[0].lon }];
  const minDist = (p) => Math.min(...centers.map((c) => dist(p, c)));
  while (centers.length < k) {
    const far = maxBy(places, minDist);
    centers.push({ lat: far.lat, lon: far.lon });
  }
  let groups = [];
  for (let it = 0; it < iterations; it++) {
    groups = centers.map(() => []);
    for (const p of places) {
      const i = minBy([...centers.keys()], (j) => dist(p, centers[j]));
      groups[i].push(p);
    }
    groups.forEach((g, j) => { centers[j] = centroid(g) || centers[j]; });
  }
  return groups.filter((g) => g.length);
}

/** Ближайший сосед, начиная с крайней точки — получается маршрут без возвратов. */
function orderRoute(places) {
  if (places.length <= 2) return places.slice();
  const c = centroid(places);
  const rest = places.slice();
  const start = maxBy([...rest.keys()], (i) => dist(rest[i], c));
  const route = rest.splice(start, 1);
  while (rest.length) {
    const last = route[route.length - 1];
    const i = minBy([...rest.keys()], (j) => dist(rest[j], last));
    route.push(rest.splice(i, 1)[0]);
  }
  return route;
}

function detour(p, route, i) {
  const before = i > 0 ? dist(p, route[i - 1]) : 0;
  const after = i < route.length ? dist(p, route[i]) : 0;
  const direct = i > 0 && i < route.length ? dist(route[i - 1], route[i]) : 0;
  return before + after - direct;
}

function insertionIndex(meal, route, preferred) {
  if (!route.length) return 0;
  const options = [];
  for (let i = Math.max(0, preferred - 1); i <= Math.min(route.length, preferred + 1); i++) options.push(i);
  return minBy(options, (i) => detour(meal, route, i)) ?? preferred;
}

export function planStop(stop, dates, visited) {
  const k = dates.length;
  if (!k) return [];

  const candidates = stop.places.filter((p) => !visited.has(p.id));
  const sights = candidates.filter((p) => !isFood(p)).sort((a, b) => score(b) - score(a));
  const food = candidates.filter(isFood).sort((a, b) => score(b) - score(a));

  // Берём столько, сколько влезает по времени во все дни.
  const picked = [];
  let total = 0;
  for (const p of sights) {
    if (total + cost(p) <= DAY_BUDGET * k) { picked.push(p); total += cost(p); }
  }

  const clusters = kMeans(picked, Math.min(k, picked.length));
  while (clusters.length < k) clusters.push([]);

  // Кластер -> день: каждому кластеру день, где меньше всего закрытых мест.
  const days = dates.map(() => []);
  let freeDays = [...dates.keys()];
  for (const cluster of clusters.slice().sort((a, b) => b.length - a.length)) {
    const best = minBy(freeDays, (d) => closedCount(cluster, dates[d]));
    days[best] = cluster.slice();
    freeDays = freeDays.filter((d) => d !== best);
  }

  // Если место закрыто в свой день — переносим в ближайший открытый день со свободным временем.
  for (let d = 0; d < k; d++) {
    for (const p of days[d].filter((x) => isClosed(x, dates[d]))) {
      days[d] = days[d].filter((x) => x.id !== p.id);
      const options = [...dates.keys()].filter((e) => e !== d && !isClosed(p, dates[e]) && load(days[e]) + cost(p) <= DAY_BUDGET + 60);
      const target = minBy(options, (e) => distanceToCenter(p, days[e]));
      if (target !== undefined) days[target].push(p);
    }
  }

  // Выравниваем дни: переносим из самого загруженного в самый свободный то, что ближе к его району.
  for (let it = 0; it < 60; it++) {
    const loads = days.map(load);
    const heavy = maxBy([...loads.keys()], (i) => loads[i]);
    const light = minBy([...loads.keys()], (i) => loads[i]);
    const gap = loads[heavy] - loads[light];
    if (gap <= 90) break;
    const movable = days[heavy].filter((p) => cost(p) < gap && !isClosed(p, dates[light]));
    let candidate;
    if (!days[light].length) {
      const c = centroid(days[heavy]);
      candidate = maxBy(movable, (p) => dist(p, c));
    } else {
      candidate = minBy(movable, (p) => distanceToCenter(p, days[light]));
    }
    if (!candidate) break;
    days[heavy] = days[heavy].filter((p) => p.id !== candidate.id);
    days[light].push(candidate);
  }

  // Перегруженные дни: выкидываем наименее важное.
  for (let d = 0; d < k; d++) {
    while (load(days[d]) > DAY_BUDGET + 30) {
      const worst = minBy(days[d].filter((p) => !p.mustSee), score);
      if (!worst) break;
      days[d] = days[d].filter((p) => p.id !== worst.id);
    }
  }

  const usedFood = new Set();
  return dates.map((date, d) => {
    const route = orderRoute(days[d]);
    const center = centroid(route) || { lat: stop.lat, lon: stop.lon };
    // Обед — еда или кафе; вечер — ресторан или бар.
    const pickMeal = (kinds) => food
      .filter((p) => kinds.includes(p.category) && !usedFood.has(p.id) && !isClosed(p, date))
      .sort((a, b) => mealRank(a, center) - mealRank(b, center))[0];
    const lunch = pickMeal(['food', 'cafe']);
    if (lunch) {
      usedFood.add(lunch.id);
      // После середины маршрута, рядом с той точкой.
      route.splice(insertionIndex(lunch, route, Math.ceil(route.length / 2)), 0, lunch);
    }
    const dinner = pickMeal(['food', 'bar']);
    if (dinner) {
      usedFood.add(dinner.id);
      route.push(dinner);
    }
    return { date, city: stop.name, placeIds: route.map((p) => p.id), note: '' };
  });
}

export function makePlan(trip, visited) {
  const plan = [];
  let offset = 0;
  for (const stop of trip.stops) {
    const dates = Array.from({ length: stop.days }, (_, i) => addDays(trip.startDate, offset + i));
    plan.push(...planStop(stop, dates, visited));
    offset += stop.days;
  }
  return plan;
}

/** Что и когда купить заранее, по плану поездки. */
export function ticketReminders(trip) {
  const byId = new Map(trip.stops.flatMap((s) => s.places).map((p) => [p.id, p]));
  const result = [];
  for (const day of trip.plan) {
    for (const id of day.placeIds) {
      const place = byId.get(id);
      if (!place || !(place.ticketAdvanceDays > 0)) continue;
      result.push({ place, visitDate: day.date, buyBy: addDays(day.date, -place.ticketAdvanceDays) });
    }
  }
  return result.sort((a, b) => (a.buyBy < b.buyBy ? -1 : a.buyBy > b.buyBy ? 1 : 0));
}

export { distance };
