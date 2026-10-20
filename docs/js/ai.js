// ИИ-часть: подборка мест для любого города и умный план по дням.
// Два провайдера: Google Gemini (есть бесплатный тариф) и Claude. Ключи хранятся только на телефоне.
import { CATEGORIES, addDays, distance, humanDay } from './geo.js';

export const PROVIDERS = {
  gemini: { title: 'Gemini', note: 'бесплатно', keyUrl: 'https://aistudio.google.com/apikey' },
  claude: { title: 'Claude', note: 'платно, точнее', keyUrl: 'https://platform.claude.com' },
};

function object(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

// ---------- Claude ----------

async function claudeRequest(key, prompt, schema) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        // Запрос идёт прямо с телефона, без своего сервера — ключ видим только мы сами.
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        // Если запрос отклонят фильтры безопасности, API само повторит его на подходящей модели.
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    throw new Error('Нет связи с Claude. Проверь интернет.');
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Неверный API-ключ Claude. Проверь его в настройках.');
    if (res.status === 429) throw new Error('Слишком много запросов к Claude. Подожди минуту.');
    const body = await res.text().catch(() => '');
    throw new Error(`Ошибка Claude API (${res.status}): ${body.slice(0, 200)}`);
  }
  const message = await res.json();
  if (message.stop_reason === 'refusal') throw new Error('Claude отказался отвечать на этот запрос.');
  const text = message.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Claude вернул пустой ответ.');
  return JSON.parse(text);
}

// ---------- Gemini ----------

/** JSON Schema -> схема Gemini (типы заглавными, без additionalProperties). */
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.required = s.required;
    out.propertyOrdering = Object.keys(s.properties);
  }
  return out;
}

// «latest»-псевдоним Google сам переводит на актуальную Flash-модель; вторая — запасная.
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash'];

async function geminiRequest(key, prompt, schema) {
  let lastError;
  for (const model of GEMINI_MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(schema),
            maxOutputTokens: 32768,
          },
        }),
      });
    } catch {
      throw new Error('Нет связи с Gemini. Проверь интернет.');
    }
    if (res.status === 404) { lastError = new Error(`Модель ${model} недоступна.`); continue; }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.error?.message || '';
      const reason = body.error?.details?.find((d) => d.reason)?.reason;
      if (reason === 'API_KEY_INVALID') throw new Error('Неверный ключ Gemini. Проверь его в настройках.');
      if (/location is not supported/i.test(msg)) throw new Error('Gemini недоступен в твоей стране. Попробуй через VPN или выбери другой ИИ в настройках.');
      if (res.status === 429) throw new Error('Лимит бесплатных запросов Gemini на сейчас исчерпан. Подожди минуту-другую и попробуй снова.');
      throw new Error(`Ошибка Gemini (${res.status}): ${msg.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.promptFeedback?.blockReason) throw new Error('Gemini отказался отвечать на этот запрос.');
    const cand = data.candidates?.[0];
    const text = cand?.content?.parts?.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    if (!text) throw new Error(cand?.finishReason === 'MAX_TOKENS' ? 'Ответ Gemini не поместился. Попробуй меньше дней.' : 'Gemini вернул пустой ответ.');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Gemini ответил в неправильном формате. Попробуй ещё раз.');
    }
  }
  throw lastError;
}

function request(ai, prompt, schema) {
  return ai.provider === 'gemini' ? geminiRequest(ai.key, prompt, schema) : claudeRequest(ai.key, prompt, schema);
}

// ---------- Сверка с картой ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ИИ иногда ошибается с координатами или придумывает места. Ищем каждое место в OpenStreetMap
 * (Nominatim, не чаще 1 запроса в секунду — таковы правила сервиса): нашли рядом — берём точные
 * координаты, не нашли — помечаем «не проверено».
 */
async function verifyPlaces(places, city, center, progress) {
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    progress?.(`Сверяю места с картой: ${i + 1} из ${places.length}`);
    let found = null;
    for (const q of [p.localName || p.name]) {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=3&q=${encodeURIComponent(`${q}, ${city}`)}`;
        const res = await fetch(url);
        const hits = res.ok ? await res.json() : [];
        found = hits
          .map((h) => ({ lat: Number(h.lat), lon: Number(h.lon) }))
          .filter((h) => distance(h.lat, h.lon, center.lat, center.lon) < 30000)
          .sort((a, b) => distance(a.lat, a.lon, p.lat, p.lon) - distance(b.lat, b.lon, p.lat, p.lon))[0];
      } catch {
        // Нет сети или сервис занят — оставляем как есть.
      }
      await sleep(1100);
      if (found) break;
    }
    if (found && distance(found.lat, found.lon, p.lat, p.lon) < 3000) {
      p.lat = found.lat;
      p.lon = found.lon;
    } else {
      p.unverified = true;
    }
  }
  return places;
}

// ---------- Подборка мест ----------

export async function discoverPlaces(ai, city, lat, lon, progress, days = 5) {
  // Мест — по количеству дней: так и ИИ, и сверка с картой работают быстрее.
  const count = Math.max(10, Math.min(35, days * 8));
  const prompt = `Ты — опытный местный гид. Составь подборку примерно из ${count} мест для туриста, который проведёт ${days} дн. в городе ${city} (центр примерно ${lat}, ${lon}). Если город небольшой, достаточно меньшего числа мест.
Нужны: главные достопримечательности, музеи, смотровые площадки, парки, и обязательно — культовые гастрономические места (легендарные кафе, рынки, заведения с местной кухней, знаменитые десерты, бары), ради которых сюда едут.
Включай только реально существующие и работающие места, в которых ты уверен. Лучше меньше мест, чем выдуманные.
Для каждого места:
- name: название по-русски, как его обычно называют русскоязычные туристы;
- localName: официальное название на местном языке (для поиска на карте);
- точные координаты (lat, lon);
- summary: 1–2 предложения по-русски, почему стоит сходить и полезный совет;
- mustSee: true только для действительно обязательных мест (не больше трети);
- durationMin: сколько времени закладывать;
- closedWeekdays: дни, когда место обычно закрыто (1 = воскресенье … 7 = суббота), или [];
- ticketAdvanceDays: за сколько дней нужно купить билет или забронировать столик, 0 если не нужно;
- ticketNote: где и как покупать билеты или бронировать, или пустая строка.`;
  const item = object({
    name: { type: 'string' },
    localName: { type: 'string' },
    category: { type: 'string', enum: Object.keys(CATEGORIES) },
    lat: { type: 'number' },
    lon: { type: 'number' },
    summary: { type: 'string' },
    mustSee: { type: 'boolean' },
    durationMin: { type: 'integer' },
    closedWeekdays: { type: 'array', items: { type: 'integer' } },
    ticketAdvanceDays: { type: 'integer' },
    ticketNote: { type: 'string' },
  });
  const result = await request(ai, prompt, object({ places: { type: 'array', items: item } }));
  const slug = city.toLowerCase().replace(/[^\p{L}]/gu, '');
  const stamp = Date.now().toString(36);
  const places = (result.places || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && CATEGORIES[p.category])
    .slice(0, 45)
    .map((p, i) => ({
      id: `ai-${slug}-${stamp}-${i}`,
      name: p.name,
      localName: p.localName || undefined,
      category: p.category,
      lat: p.lat, lon: p.lon,
      summary: p.summary,
      mustSee: Boolean(p.mustSee),
      durationMin: Math.max(15, p.durationMin || 60),
      closedWeekdays: (p.closedWeekdays || []).filter((d) => d >= 1 && d <= 7),
      ticketAdvanceDays: p.ticketAdvanceDays > 0 ? p.ticketAdvanceDays : undefined,
      ticketNote: p.ticketNote || undefined,
    }))
    // Место дальше 30 км от центра — точно ошибка.
    .filter((p) => distance(p.lat, p.lon, lat, lon) < 30000);
  if (!places.length) throw new Error('ИИ не смог подобрать места для этого города.');
  return verifyPlaces(places, city, { lat, lon }, progress);
}

// ---------- План по дням ----------

export async function generatePlan(ai, trip, visited) {
  const days = [];
  let offset = 0;
  for (const stop of trip.stops) {
    for (let d = 0; d < stop.days; d++) days.push({ date: addDays(trip.startDate, offset + d), city: stop.name });
    offset += stop.days;
  }
  const dayLines = days.map((d, i) => `День ${i}: ${humanDay(d.date)} — ${d.city}`);
  const placeLines = trip.stops.flatMap((stop) => stop.places.filter((p) => !visited.has(p.id)).map((p) => {
    let line = `${p.id} | ${stop.name} | ${p.name} | ${p.category} | ${p.lat.toFixed(5)},${p.lon.toFixed(5)} | ${p.durationMin} мин`;
    if (p.mustSee) line += ' | обязательно';
    if (p.closedWeekdays?.length) line += ` | закрыто по дням недели [${p.closedWeekdays}] (1=вс…7=сб)`;
    if (p.ticketAdvanceDays) line += ` | билеты за ${p.ticketAdvanceDays} дн.`;
    return line;
  }));

  const prompt = `Составь план поездки по дням.

Дни:
${dayLines.join('\n')}

Доступные места (id | город | название | категория | координаты | время | пометки):
${placeLines.join('\n')}

Правила:
- в каждый день ставь только места того города, где турист находится в этот день;
- не ставь место в день, когда оно закрыто;
- группируй места по районам, чтобы не ездить через весь город, и выстраивай их в логичном пешем порядке;
- примерно 6–8 часов активностей в день, включая обед и ужин из категорий food/cafe/bar рядом с маршрутом;
- сначала распредели обязательные места, первый день сделай полегче;
- вечерние активности (круизы, бары, виды на закате) ставь в конец дня;
- note: 1–2 предложения по-русски — идея дня и практический совет (транспорт, во сколько лучше прийти);
- используй только id из списка, каждое место — не больше одного раза;
- tips: 5–8 коротких практичных советов по-русски на всю поездку (транспорт и проездные, чаевые, деньги, что купить заранее, типичные ловушки для туристов).`;

  const day = object({ dayIndex: { type: 'integer' }, placeIds: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } });
  const result = await request(ai, prompt, object({
    days: { type: 'array', items: day },
    tips: { type: 'array', items: { type: 'string' } },
  }));

  // id места -> город, где оно находится.
  const cityOf = new Map(trip.stops.flatMap((s) => s.places.map((p) => [p.id, s.name])));
  const used = new Set();
  const plan = days.map((d, i) => {
    const g = (result.days || []).find((x) => x.dayIndex === i);
    // Отсекаем выдуманные id, повторы и места из другого города.
    const placeIds = (g?.placeIds || []).filter((id) => cityOf.get(id) === d.city && !used.has(id) && used.add(id));
    return { date: d.date, city: d.city, placeIds, note: g?.note || '' };
  });
  return { plan, tips: result.tips || [] };
}

// ---------- Маршрут по стране ----------

export async function suggestRoute(ai, country, totalDays) {
  const prompt = `Турист едет в страну ${country} на ${totalDays} дн. и не знает, какие города посетить. Составь лучший маршрут.
Правила:
- начни с города, куда обычно прилетают (главный аэропорт), закончи там, откуда удобно улететь;
- города и места в логичном географическом порядке, без лишних возвратов;
- на крупные города больше дней, на маленькие — 1–2 дня; переезды учитывай во времени;
- сумма дней ровно ${totalDays};
- включай и природные места или небольшие городки, если ради них сюда едут (горы, побережье, винные регионы), — указывай их как отдельную точку маршрута с ближайшим населённым пунктом;
- name: название по-русски; localName: на местном языке или по-английски (для поиска на карте);
- why: 1 предложение по-русски — чем это место интересно;
- tips: 3–6 коротких советов по-русски о переездах между городами (поезд, маршрутка, аренда авто, сколько ехать).`;
  const city = object({ name: { type: 'string' }, localName: { type: 'string' }, days: { type: 'integer' }, why: { type: 'string' } });
  const result = await request(ai, prompt, object({ cities: { type: 'array', items: city }, tips: { type: 'array', items: { type: 'string' } } }));
  const cities = (result.cities || []).filter((c) => c.name).map((c) => ({ ...c, days: Math.max(1, c.days || 1) }));
  if (!cities.length) throw new Error('ИИ не смог предложить маршрут.');
  // Подгоняем сумму дней, если ИИ ошибся: разницу — первому городу.
  const diff = totalDays - cities.reduce((s, c) => s + c.days, 0);
  cities[0].days = Math.max(1, cities[0].days + diff);
  return { cities, tips: result.tips || [] };
}

// ---------- Гид по месту ----------

export async function generateGuide(ai, place, city) {
  const food = ['food', 'cafe', 'bar'].includes(place.category);
  const prompt = food
    ? `Ты — гастрономический гид. Расскажи туристу о заведении «${place.name}»${place.localName ? ` (${place.localName})` : ''} в городе ${city}.
Нужно по-русски, живо и по делу: история и чем знаменито, что обязательно заказать (конкретные блюда и напитки), примерный чек, когда лучше приходить, как не попасть в очередь, на что обратить внимание в интерьере.
Только факты, в которых ты уверен; если чего-то не знаешь — не выдумывай.`
    : `Ты — профессиональный экскурсовод. Подготовь подробную экскурсию по месту «${place.name}»${place.localName ? ` (${place.localName})` : ''} в городе ${city} — турист будет слушать её на месте, как аудиогид.
Нужно по-русски, живым разговорным языком, как будто ты идёшь рядом:
- intro: 2–3 абзаца — что это, почему важно, главная история;
- sections: экскурсия по порядку осмотра — снаружи, затем внутри по залам/частям, как обычно проходит маршрут; в каждой секции — что перед глазами, история, интересные детали и легенды, на что посмотреть внимательно; 4–8 секций, у крупных мест подробнее;
- highlights: 3–6 вещей, которые нельзя пропустить;
- tips: 3–6 практических советов (вход, билеты, фото, во сколько приходить, дресс-код, сколько времени);
Только факты, в которых ты уверен. Если не уверен в планировке залов — опиши то, что точно знаешь, и не выдумывай.`;
  const schema = object({
    intro: { type: 'string' },
    sections: { type: 'array', items: object({ title: { type: 'string' }, text: { type: 'string' } }) },
    highlights: { type: 'array', items: { type: 'string' } },
    tips: { type: 'array', items: { type: 'string' } },
  });
  const g = await request(ai, prompt, schema);
  return {
    source: 'ai',
    intro: g.intro || '',
    sections: (g.sections || []).filter((s) => s.title && s.text),
    highlights: g.highlights || [],
    tips: g.tips || [],
    savedAt: new Date().toISOString(),
  };
}
