// ИИ-часть: подборка мест для любого города и умный план по дням.
// Два провайдера: Google Gemini (есть бесплатный тариф) и Claude. Ключи хранятся только на телефоне.
import { CATEGORIES, addDays, distance, humanDay } from './geo.js';
import { fetchCandidates } from './places.js';

export const PROVIDERS = {
  gemini: { title: 'Gemini', note: 'бесплатно', keyUrl: 'https://aistudio.google.com/apikey' },
  claude: { title: 'Claude', note: 'платно, точнее', keyUrl: 'https://platform.claude.com' },
};

function object(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

// ---------- Claude ----------

async function claudeRequest(key, prompt, schema, opts = {}) {
  let res, raw;
  const { signal, done, timedOut } = withTimeout(opts.signal, opts.quick ? 90000 : 240000);
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
      signal,
    });
    raw = await res.text(); // лимит времени действует, пока ответ не скачан целиком
  } catch {
    if (opts.signal?.aborted) throw cancelled();
    if (timedOut()) throw new Error('Claude слишком долго отвечает. Попробуй ещё раз.');
    throw new Error('Нет связи с Claude. Проверь интернет.');
  } finally {
    done();
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Неверный API-ключ Claude. Проверь его в настройках.');
    if (res.status === 429) throw new Error('Слишком много запросов к Claude. Подожди минуту.');
    throw new Error(`Ошибка Claude API (${res.status}): ${raw.slice(0, 200)}`);
  }
  const message = JSON.parse(raw);
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

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let thinkingConfigOK = true; // если модель не понимает настройку «думай меньше» — больше не шлём

// Google регулярно выпускает и убирает модели, поэтому список не зашиваем: спрашиваем у Google,
// какие модели доступны этому ключу, и берём свежие Flash и Flash-Lite. Список помним 12 часов.
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

function modelVersion(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

async function availableGeminiModels(key) {
  try {
    const cached = JSON.parse(localStorage.getItem('tg.geminiModels') || 'null');
    if (cached && cached.key === key.slice(-6) && Date.now() - cached.at < 12 * 3600 * 1000) return cached.models;
  } catch { /* нет хранилища — спросим заново */ }
  const { signal, done } = withTimeout(null, 10000);
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal });
    if (!res.ok) return null;
    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /flash/.test(n) && !/(image|tts|audio|live|embedding|exp|thinking|robotics|computer)/.test(n));
    try { localStorage.setItem('tg.geminiModels', JSON.stringify({ key: key.slice(-6), at: Date.now(), models })); } catch { /* ок */ }
    return models;
  } catch {
    return null;
  } finally {
    done();
  }
}

/** Порядок моделей: для быстрых задач сначала лёгкая (Flash-Lite), для тяжёлых — обычная Flash. */
async function geminiModels(key, quick) {
  const list = await availableGeminiModels(key);
  if (!list?.length) return FALLBACK_MODELS;
  const pick = (lite) => list
    .filter((n) => /lite/.test(n) === lite)
    // Свежая версия лучше; стабильная лучше preview; «latest» — запасной вариант той же линейки.
    .sort((a, b) => modelVersion(b) - modelVersion(a) || /preview/.test(a) - /preview/.test(b) || /latest/.test(a) - /latest/.test(b))
    .slice(0, 2);
  const flash = pick(false), lite = pick(true);
  const order = quick ? [lite[0], flash[0], lite[1], flash[1]] : [flash[0], lite[0], flash[1], lite[1]];
  return [...new Set(order.filter(Boolean))].slice(0, 3);
}

/** «Думай меньше»: у Gemini 3 это уровень, у Gemini 2.5 — бюджет. */
function lightThinking(model) {
  return modelVersion(model) >= 3 ? { thinkingLevel: 'low' } : { thinkingBudget: 512 };
}

async function geminiRequest(key, prompt, schema, opts) {
  let lastError;
  const errors = [];
  for (const model of await geminiModels(key, opts.quick)) {
    // Перегрузка у Google обычно на секунды — пробуем модель дважды с паузой, потом следующую.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await geminiCall(key, model, prompt, schema, opts);
      } catch (err) {
        lastError = err;
        errors.push(err);
        if (!err.retry) throw err;
        if (attempt === 0 && (err.status === 503 || err.status === 500)) await sleepMs(2500);
        else break;
      }
    }
  }
  // Показываем самую понятную причину, а не последнюю попавшуюся.
  const has = (st) => errors.some((e) => e.status === st);
  if (has(429)) throw new Error('Лимит бесплатных запросов Gemini на сейчас исчерпан. Подожди минуту-другую и попробуй снова.');
  if (has(503) || has(500)) throw new Error('Gemini сейчас перегружен — это на стороне Google, обычно проходит за пару минут.');
  if (has('timeout')) throw new Error('Gemini слишком долго отвечает. Попробуй ещё раз через минуту.');
  if (has(404)) {
    try { localStorage.removeItem('tg.geminiModels'); } catch { /* ок */ }
    throw new Error('Google сменил модели Gemini — я обновил список, нажми ещё раз.');
  }
  throw lastError;
}

function cancelled() {
  const e = new Error('Отменено');
  e.cancelled = true;
  return e;
}

/** Ограничение по времени плюс отмена пользователем — одним сигналом. */
function withTimeout(outer, ms) {
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => { fired = true; ctl.abort(); }, ms);
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort);
  return {
    signal: ctl.signal,
    timedOut: () => fired,
    done: () => { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); },
  };
}

function retryable(message, status) {
  const e = new Error(message);
  e.retry = true;
  e.status = status;
  return e;
}

async function geminiCall(key, model, prompt, schema, opts) {
  {
    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
      maxOutputTokens: 32768,
    };
    // Простым задачам долгие рассуждения не нужны — ответ приходит в разы быстрее.
    if (opts.quick && thinkingConfigOK) generationConfig.thinkingConfig = lightThinking(model);
    let res, raw;
    // Лимит времени — на весь ответ целиком, включая его скачивание, а не только до первых байт.
    const { signal, done, timedOut } = withTimeout(opts.signal, opts.quick ? 30000 : 90000);
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
        signal,
      });
      raw = await res.text();
    } catch {
      if (opts.signal?.aborted) throw cancelled();
      if (timedOut()) throw retryable('Gemini слишком долго думает.', 'timeout');
      throw new Error('Нет связи с Gemini. Проверь интернет.');
    } finally {
      done();
    }
    const parsed = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (res.status === 400 && generationConfig.thinkingConfig) {
      const body = parsed;
      if (/thinking/i.test(body.error?.message || '')) {
        thinkingConfigOK = false;
        return geminiCall(key, model, prompt, schema, opts);
      }
    }
    if (res.status === 404) throw retryable(`Модель ${model} недоступна.`, 404);
    if (res.status === 503 || res.status === 500) throw retryable('Gemini перегружен.', res.status);
    if (!res.ok) {
      const body = parsed;
      const msg = body.error?.message || '';
      const reason = body.error?.details?.find((d) => d.reason)?.reason;
      if (reason === 'API_KEY_INVALID') throw new Error('Неверный ключ Gemini. Проверь его в настройках.');
      if (/location is not supported/i.test(msg)) throw new Error('Gemini недоступен в твоей стране. Попробуй через VPN или выбери другой ИИ в настройках.');
      // У каждой модели свой бесплатный лимит — исчерпан у этой, пробуем следующую.
      if (res.status === 429) throw retryable('Лимит бесплатных запросов Gemini на сейчас исчерпан. Подожди минуту-другую и попробуй снова.', 429);
      throw new Error(`Ошибка Gemini (${res.status}): ${msg.slice(0, 200)}`);
    }
    const data = parsed;
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
}

/** opts.quick — простая задача (быстрее модель и ответ); opts.signal — отмена пользователем. */
function request(ai, prompt, schema, opts = {}) {
  return ai.provider === 'gemini' ? geminiRequest(ai.key, prompt, schema, opts) : claudeRequest(ai.key, prompt, schema, opts);
}

// ---------- Сверка с картой ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ИИ иногда ошибается с координатами или придумывает места. Ищем каждое место в OpenStreetMap
 * (Nominatim, не чаще 1 запроса в секунду — таковы правила сервиса): нашли рядом — берём точные
 * координаты, не нашли — помечаем «не проверено».
 */
async function verifyPlaces(places, city, center, progress, { anyDistance = false } = {}) {
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
    // Для мест без координат от ИИ (anyDistance) достаточно, что нашлось в пределах города.
    if (found && (anyDistance || distance(found.lat, found.lon, p.lat, p.lon) < 3000)) {
      p.lat = found.lat;
      p.lon = found.lon;
    } else {
      p.unverified = true;
    }
  }
  return places;
}

// ---------- Подборка мест ----------

const PLACE_FIELDS = {
  summary: { type: 'string' },
  mustSee: { type: 'boolean' },
  durationMin: { type: 'integer' },
  closedWeekdays: { type: 'array', items: { type: 'integer' } },
  ticketAdvanceDays: { type: 'integer' },
  ticketNote: { type: 'string' },
};

const PLACE_RULES = `- summary: 1–2 предложения по-русски, почему стоит сходить и полезный совет;
- mustSee: true только для действительно обязательных мест (не больше трети);
- durationMin: сколько времени закладывать;
- closedWeekdays: дни, когда место обычно закрыто (1 = воскресенье … 7 = суббота), или [];
- ticketAdvanceDays: за сколько дней нужно купить билет или забронировать столик, 0 если не нужно;
- ticketNote: где и как покупать билеты или бронировать, или пустая строка.`;

const placeExtras = (p) => ({
  summary: p.summary || '',
  mustSee: Boolean(p.mustSee),
  durationMin: Math.max(15, p.durationMin || 60),
  closedWeekdays: (p.closedWeekdays || []).filter((d) => d >= 1 && d <= 7),
  ticketAdvanceDays: p.ticketAdvanceDays > 0 ? p.ticketAdvanceDays : undefined,
  ticketNote: p.ticketNote || undefined,
});

/**
 * Подборка мест. Главный путь: берём с карты все реальные места города, а ИИ выбирает из них
 * лучшие и описывает — координаты всегда настоящие. Если карта недоступна — ИИ называет места
 * сам, а мы оставляем только те, что нашлись на карте.
 */
export async function discoverPlaces(ai, city, lat, lon, progress, days = 5) {
  const count = Math.max(10, Math.min(35, days * 8));
  let candidates = [];
  try {
    progress?.('Загружаю с карты реальные места города…');
    candidates = await fetchCandidates(lat, lon, 4000);
    if (candidates.length < 40) candidates = await fetchCandidates(lat, lon, 10000);
  } catch {
    candidates = [];
  }
  if (candidates.length >= 10) return pickFromCandidates(ai, city, candidates, count, days, { lat, lon }, progress);
  return discoverFreeform(ai, city, lat, lon, progress, count, days);
}

async function pickFromCandidates(ai, city, candidates, count, days, center, progress) {
  progress?.(`ИИ выбирает лучшее из ${candidates.length} мест на карте…`);
  // Короткие номера вместо длинных id — меньше текста и меньше шансов, что ИИ их перепутает.
  const lines = candidates.map((c, i) => `c${i} | ${c.name}${c.local !== c.name ? ` (${c.local})` : ''} | ${c.kind}${c.hours ? ` | часы: ${c.hours}` : ''}`);
  const prompt = `Ты — опытный местный гид. Турист проведёт ${days} дн. в городе ${city}.
Ниже — реальные места этого города с карты (номер | название | тип | часы работы). Выбери из них примерно ${count} лучших для туриста: главные достопримечательности, музеи, виды, пляжи и парки, и обязательно культовые гастрономические места (легендарные кафе, рынки, рестораны местной кухни, известные десерты, бары). Если город небольшой, выбери меньше. Не выбирай случайные сетевые заведения и малоизвестные точки.

${lines.join('\n')}

Для каждого выбранного места:
- id: номер из списка (например, c12) — только из списка;
- name: название по-русски, как его называют русскоязычные туристы;
- category: тип;
${PLACE_RULES}
closedWeekdays выводи из часов работы, если они указаны.

missing: если какого-то действительно знаменитого места города нет в списке (до 5 штук) — укажи его: name по-русски, localName на местном языке и остальные поля. Только если уверен, что оно существует.`;
  const chosenItem = object({ id: { type: 'string' }, name: { type: 'string' }, category: { type: 'string', enum: Object.keys(CATEGORIES) }, ...PLACE_FIELDS });
  const missingItem = object({ name: { type: 'string' }, localName: { type: 'string' }, category: { type: 'string', enum: Object.keys(CATEGORIES) }, ...PLACE_FIELDS });
  const result = await request(ai, prompt, object({
    places: { type: 'array', items: chosenItem },
    missing: { type: 'array', items: missingItem },
  }));

  const used = new Set();
  const places = [];
  for (const p of result.places || []) {
    const c = candidates[Number(String(p.id).replace(/\D/g, ''))];
    if (!c || used.has(c.id)) continue;
    used.add(c.id);
    places.push({
      id: c.id,
      name: p.name || c.name,
      localName: c.local,
      category: CATEGORIES[p.category] ? p.category : c.category,
      lat: c.lat, lon: c.lon,
      url: c.url,
      ...placeExtras(p),
    });
  }
  // Знаменитые места, которых не было в списке, — только если нашлись на карте.
  const missing = (result.missing || []).slice(0, 5).map((p, i) => ({
    id: `ai-${Date.now().toString(36)}-m${i}`, name: p.name, localName: p.localName || undefined,
    category: CATEGORIES[p.category] ? p.category : 'sight', lat: center.lat, lon: center.lon, ...placeExtras(p),
  }));
  if (missing.length) places.push(...(await verifyPlaces(missing, city, center, progress, { anyDistance: true })).filter((p) => !p.unverified));
  if (!places.length) throw new Error('ИИ не смог подобрать места для этого города.');
  return places;
}

async function discoverFreeform(ai, city, lat, lon, progress, count, days) {
  const prompt = `Ты — опытный местный гид. Составь подборку примерно из ${count} мест для туриста, который проведёт ${days} дн. в городе ${city} (центр примерно ${lat}, ${lon}). Если город небольшой, достаточно меньшего числа мест.
Нужны: главные достопримечательности, музеи, смотровые площадки, парки, и обязательно — культовые гастрономические места (легендарные кафе, рынки, заведения с местной кухней, знаменитые десерты, бары), ради которых сюда едут.
Включай только реально существующие и работающие места, в которых ты уверен. Лучше меньше мест, чем выдуманные.
Для каждого места:
- name: название по-русски, как его обычно называют русскоязычные туристы;
- localName: официальное название на местном языке (для поиска на карте);
- точные координаты (lat, lon);
${PLACE_RULES}`;
  const item = object({
    name: { type: 'string' }, localName: { type: 'string' }, category: { type: 'string', enum: Object.keys(CATEGORIES) },
    lat: { type: 'number' }, lon: { type: 'number' }, ...PLACE_FIELDS,
  });
  const result = await request(ai, prompt, object({ places: { type: 'array', items: item } }));
  const slug = city.toLowerCase().replace(/[^\p{L}]/gu, '');
  const stamp = Date.now().toString(36);
  const places = (result.places || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && CATEGORIES[p.category])
    .slice(0, 45)
    .map((p, i) => ({
      id: `ai-${slug}-${stamp}-${i}`, name: p.name, localName: p.localName || undefined, category: p.category,
      lat: p.lat, lon: p.lon, ...placeExtras(p),
    }))
    .filter((p) => distance(p.lat, p.lon, lat, lon) < 30000);
  // ИИ путается в координатах — оставляем только то, что нашлось на карте.
  const verified = (await verifyPlaces(places, city, { lat, lon }, progress)).filter((p) => !p.unverified);
  if (!verified.length) throw new Error('Не удалось найти на карте места, которые предложил ИИ.');
  return verified;
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
  const result = await request(ai, prompt, object({ cities: { type: 'array', items: city }, tips: { type: 'array', items: { type: 'string' } } }), { quick: true });
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
  const g = await request(ai, prompt, schema, { quick: true });
  return {
    source: 'ai',
    intro: g.intro || '',
    sections: (g.sections || []).filter((s) => s.title && s.text),
    highlights: g.highlights || [],
    tips: g.tips || [],
    savedAt: new Date().toISOString(),
  };
}

// ---------- Перелёт: оценка цен ----------

export async function flightEstimate(ai, { from, to, depart, back, backFrom }, signal) {
  const route = backFrom
    ? `туда ${from.city} (${from.iata}) → ${to.city} (${to.iata}) ${depart}, обратно ${backFrom.city} (${backFrom.iata}) → ${from.city} (${from.iata}) ${back}`
    : `${from.city} (${from.iata}) → ${to.city} (${to.iata}), вылет ${depart}${back ? `, обратно ${back}` : ''}`;
  const prompt = `Оцени перелёт туда и обратно, эконом, 1 взрослый: ${route}.
По-русски и честно, как опытный турагент:
- priceMin, priceMax: типичный диапазон общей цены туда и обратно в долларах США для этих дат и сезона (не самые редкие акции и не бизнес-класс);
- direct: есть ли обычно прямые рейсы;
- duration: сколько лететь (например, «4 ч 30 мин прямым» или «7–10 ч с пересадкой»);
- airlines: какие авиакомпании обычно летают;
- stopovers: через какие города обычно пересадки, если прямых нет или они дорогие;
- whenToBuy: когда лучше покупать для таких дат;
- tips: 2–4 совета, как найти дешевле (соседние аэропорты, лоукостеры, дни недели).
Если не уверен — давай более широкий диапазон, а не выдумывай точность.`;
  const r = await request(ai, prompt, object({
    priceMin: { type: 'integer' }, priceMax: { type: 'integer' }, direct: { type: 'boolean' }, duration: { type: 'string' },
    airlines: { type: 'array', items: { type: 'string' } }, stopovers: { type: 'array', items: { type: 'string' } },
    whenToBuy: { type: 'string' }, tips: { type: 'array', items: { type: 'string' } },
  }), { quick: true, signal });
  return { ...r, from: from.iata, to: to.iata, depart, back, savedAt: new Date().toISOString() };
}

// ---------- Обзор страны: что смотреть, сколько дней, бюджет ----------

export async function countryOverview(ai, country, home, signal) {
  const prompt = `Турист живёт в городе ${home} и думает поехать в страну ${country}, но почти ничего о ней не знает. Сделай короткий честный обзор по-русски:
- summary: 2–3 предложения — чем страна интересна и для кого;
- daysMin, daysOptimal: минимум дней, чтобы увидеть главное, и оптимально для первой поездки;
- mustSee: 5–8 обязательных мест (город или место) — name и why (одно предложение);
- budgetPerDay: расходы в день на одного без перелёта, в долларах США: budget (хостелы, стритфуд), mid (хорошие отели 3*, кафе), comfort (4–5*, рестораны);
- flightFromHome: примерная цена перелёта туда-обратно из ${home} в долларах: min, max, и есть ли прямые рейсы;
- bestSeason, avoidSeason: когда ехать лучше и когда не стоит;
- currency: валюта и как лучше платить (карты, наличные, обмен);
- language: язык и насколько поможет английский/русский;
- transport: как перемещаться между городами;
- visa: что обычно нужно знать про въезд (укажи, что правила зависят от гражданства и их надо проверить);
- watchOut: 3–5 подводных камней (мошенничество, жара, дресс-код, праздники).`;
  const r = await request(ai, prompt, object({
    summary: { type: 'string' },
    daysMin: { type: 'integer' }, daysOptimal: { type: 'integer' },
    mustSee: { type: 'array', items: object({ name: { type: 'string' }, why: { type: 'string' } }) },
    budgetPerDay: object({ budget: { type: 'integer' }, mid: { type: 'integer' }, comfort: { type: 'integer' } }),
    flightFromHome: object({ min: { type: 'integer' }, max: { type: 'integer' }, direct: { type: 'boolean' } }),
    bestSeason: { type: 'string' }, avoidSeason: { type: 'string' },
    currency: { type: 'string' }, language: { type: 'string' }, transport: { type: 'string' }, visa: { type: 'string' },
    watchOut: { type: 'array', items: { type: 'string' } },
  }), { quick: true, signal });
  return { ...r, country, home, savedAt: new Date().toISOString() };
}
