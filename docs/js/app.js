import { store } from './store.js';
import { CATEGORIES, isClosed, distance, formatDistance, walkingMinutes, humanDay, today, daysBetween, weekdayShort } from './geo.js';
import { makePlan, ticketReminders } from './planner.js';
import * as Places from './places.js';
import * as AI from './ai.js';
import { createMap, addPins, fitTo, userDot, drawRoute, bboxAround, downloadOffline } from './map.js';
import { startLocation, onLocation, position, directionsTo, directionsRoute, remind, openExternal, isAndroidApp, speak, stopSpeaking, backgroundCheckin } from './platform.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');

const allPlaces = (trip) => trip.stops.flatMap((s) => s.places);
const placeById = (trip, id) => allPlaces(trip).find((p) => p.id === id);
const cat = (p) => CATEGORIES[p.category] || CATEGORIES.sight;
const here = () => position.current;
const distTo = (p) => (here() ? distance(here().lat, here().lon, p.lat, p.lon) : null);

// ---------- Всплывашки и модальные окна ----------

function toast(text, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, Math.max(2600, text.length * 70));
}

const modals = [];

function openModal(html, { onClose, full = false } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `<div class="sheet${full ? ' full' : ''}" role="dialog">${html}</div>`;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  modals.push({ backdrop, onClose });
  return backdrop.firstElementChild;
}

function closeModal() {
  const m = modals.pop();
  if (!m) return false;
  m.onClose?.();
  m.backdrop.classList.remove('open');
  setTimeout(() => m.backdrop.remove(), 220);
  return true;
}

// Кнопка «назад» на Android: сначала закрываем окна, потом идём назад по экранам.
window.tgBack = () => {
  if (closeModal()) return true;
  if (window.location.hash && window.location.hash !== '#/') { history.back(); return true; }
  return false;
};

/** Перерисовка без прыжка прокрутки наверх (список обновляется при каждом шаге). */
function keepScroll(root, render) {
  const top = root.querySelector('.scroll')?.scrollTop || 0;
  render();
  const el = root.querySelector('.scroll');
  if (el) el.scrollTop = top;
}

// ---------- Общие куски разметки ----------

function placeRow(p, { distance: d, number } = {}) {
  const visited = store.isVisited(p.id);
  const meta = [];
  if (d != null) meta.push(`🚶 ${formatDistance(d)} · ${walkingMinutes(d)} мин`);
  if (p.ticketAdvanceDays) meta.push('🎟 бронь заранее');
  if (p.unverified) meta.push('⚠︎ не найдено на карте');
  if (store.guides[p.id]) meta.push('📖 гид скачан');
  return `
    <div class="row${visited ? ' visited' : ''}" data-place="${esc(p.id)}">
      ${number != null ? `<div class="num" style="--c:${cat(p).color}">${number}</div>` : ''}
      <div class="thumb" style="--c:${cat(p).color}">${cat(p).emoji}</div>
      <div class="row-main">
        <div class="row-title">${esc(p.name)}${p.mustSee ? ' <span class="star">★</span>' : ''}</div>
        ${p.summary ? `<div class="row-sub">${esc(p.summary)}</div>` : ''}
        ${meta.length ? `<div class="row-meta">${meta.join(' &nbsp; ')}</div>` : ''}
      </div>
      <button class="check${visited ? ' on' : ''}" data-visit="${esc(p.id)}" aria-label="Были здесь">${visited ? '✓' : ''}</button>
    </div>`;
}

function chips(places, filter) {
  const present = new Set(places.map((p) => p.category));
  const list = Object.entries(CATEGORIES).filter(([k]) => present.has(k));
  return `<div class="chips">
    <button class="chip${filter.size ? '' : ' on'}" data-chip="">Все</button>
    ${list.map(([k, c]) => `<button class="chip${filter.has(k) ? ' on' : ''}" data-chip="${k}">${c.emoji} ${c.title}</button>`).join('')}
  </div>`;
}

function toggleChip(filter, key) {
  if (!key) filter.clear();
  else if (filter.has(key)) filter.delete(key);
  else filter.add(key);
}

/** Общие клики: отметка «были» и открытие карточки места. */
function handleCommon(e, lookup) {
  const visit = e.target.closest('[data-visit]');
  if (visit) {
    const id = visit.dataset.visit;
    store.setVisited(id, !store.isVisited(id));
    return true;
  }
  const row = e.target.closest('[data-place]');
  if (row) {
    const p = lookup(row.dataset.place);
    if (p) openPlace(p);
    return true;
  }
  return false;
}

// ---------- Карточка места ----------

function openPlace(p) {
  const render = (sheet) => {
    const visited = store.isVisited(p.id);
    sheet.innerHTML = `
      <div class="grabber"></div>
      <div class="place-head">
        <div class="thumb big" style="--c:${cat(p).color}">${cat(p).emoji}</div>
        <div>
          <div class="muted small">${cat(p).title}${p.mustSee ? ' · <span class="star">★ обязательно</span>' : ''}</div>
          <h2>${esc(p.name)}</h2>
        </div>
      </div>
      ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
      <div class="facts">
        <div>⏱ Заложи ~${p.durationMin || 60} мин</div>
        ${distTo(p) != null ? `<div>🚶 ${formatDistance(distTo(p))} · ${walkingMinutes(distTo(p))} мин пешком</div>` : ''}
        ${p.unverified ? '<div class="warn">⚠︎ Место предложил ИИ, но на карте OpenStreetMap оно не нашлось — проверь, что оно существует и стоит там, где показано.</div>' : ''}
        ${p.closedWeekdays?.length ? `<div class="warn">📅 Выходной: ${p.closedWeekdays.slice().sort().map(weekdayShort).join(', ')}</div>` : ''}
        ${p.ticketAdvanceDays ? `<div>🎟 Бронировать за ${p.ticketAdvanceDays} дн.</div>` : ''}
        ${p.ticketNote ? `<div class="note">${esc(p.ticketNote)}</div>` : ''}
      </div>
      <div class="actions">
        <button class="btn ${visited ? 'success' : 'primary'}" data-act="visit">${visited ? '✓ Были здесь' : 'Отметить: были здесь'}</button>
        <button class="btn" data-act="guide">📖 Гид${store.guides[p.id] ? ' ✓' : ''}</button>
        <button class="btn" data-act="go">🚶 Как дойти</button>
        ${p.url ? '<button class="btn" data-act="site">Сайт</button>' : ''}
      </div>`;
  };
  const sheet = openModal('');
  render(sheet);
  sheet.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'visit') { store.setVisited(p.id, !store.isVisited(p.id)); render(sheet); }
    if (act === 'go') directionsTo(p);
    if (act === 'site') openExternal(p.url);
    if (act === 'guide') openGuide(p);
  });
}

// ---------- Гид по месту ----------

const cityOfPlace = (p) => {
  for (const t of store.trips) for (const st of t.stops) if (st.places.some((x) => x.id === p.id)) return st.name;
  return '';
};

/** Скачивает гид: через ИИ, если он настроен, иначе из Википедии. */
async function fetchGuide(p) {
  const city = cityOfPlace(p);
  const ai = store.ai();
  let guide;
  if (ai) {
    try {
      guide = await AI.generateGuide(ai, p, city);
    } catch (err) {
      // ИИ не ответил (лимит, сеть) — пробуем Википедию, а если и её нет — показываем ошибку ИИ.
      guide = await Places.wikiGuide(p, city).catch(() => { throw err; });
    }
  } else {
    guide = await Places.wikiGuide(p, city);
  }
  store.saveGuide(p.id, guide);
  return guide;
}

function openGuide(p) {
  let speaking = false;
  const sheet = openModal('', { full: true, onClose: () => stopSpeaking() });
  const paragraphs = (g) => [
    p.name,
    ...g.intro.split(/\n+/),
    ...g.sections.flatMap((s) => [s.title, ...s.text.split(/\n+/)]),
    g.highlights.length ? 'Не пропусти: ' + g.highlights.join('. ') : '',
  ];
  const render = (g, state = '') => {
    sheet.innerHTML = `
      <div class="sheet-bar">
        <button class="btn link" data-act="close">‹ Назад</button>
        <b>Гид</b>
        ${g ? `<button class="btn link strong" data-act="speak">${speaking ? '⏹ Стоп' : '🔊 Слушать'}</button>` : '<span style="width:60px"></span>'}
      </div>
      <div class="scroll pad guide">
        <h2>${esc(p.name)}</h2>
        ${state}
        ${g ? `
          <p class="muted small">${g.source === 'wiki' ? `Из Википедии: «${esc(g.title)}»` : 'Экскурсию подготовил ИИ — проверяй важное на месте'} · сохранён на телефоне, работает без интернета</p>
          ${g.intro.split(/\n+/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('')}
          ${g.highlights.length ? `<div class="card"><b>⭐ Не пропусти</b><ul>${g.highlights.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
          ${g.sections.map((s, i) => `<h3>${g.source === 'ai' ? `${i + 1}. ` : ''}${esc(s.title)}</h3>${s.text.split(/\n+/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('')}`).join('')}
          ${g.tips.length ? `<div class="card"><b>💡 Советы</b><ul>${g.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
          ${g.url ? '<button class="btn block" data-act="wiki">Открыть статью целиком</button>' : ''}
          <button class="btn block" data-act="refresh">↻ Обновить гид</button>` : ''}
      </div>`;
  };
  const load = async () => {
    render(null, `<div class="progress-card"><span class="spinner"></span><div>${store.ai() ? 'ИИ готовит экскурсию… обычно 15–40 секунд' : 'Загружаю из Википедии…'}</div></div>`);
    try {
      render(await fetchGuide(p));
    } catch (err) {
      render(null, `<p class="error">${esc(err.message)}</p><button class="btn block" data-act="retry">Попробовать ещё раз</button>`);
    }
  };
  sheet.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const g = store.guides[p.id];
    if (act === 'close') closeModal();
    if (act === 'retry' || act === 'refresh') { stopSpeaking(); speaking = false; load(); }
    if (act === 'wiki') openExternal(g.url);
    if (act === 'speak' && g) {
      if (speaking) { stopSpeaking(); speaking = false; }
      else {
        speaking = speak(paragraphs(g), () => { speaking = false; render(store.guides[p.id]); });
        if (!speaking) toast('На этом устройстве нет синтеза речи');
      }
      render(g);
    }
  });
  if (store.guides[p.id]) render(store.guides[p.id]); else load();
}

/** «Скачать гиды на день» — по очереди, чтобы не упереться в лимиты бесплатного ИИ. */
async function downloadDayGuides(places, onProgress) {
  let ok = 0, failed = 0, lastError = '';
  for (let i = 0; i < places.length; i++) {
    onProgress(i, places.length, places[i].name);
    if (store.guides[places[i].id]) { ok++; continue; }
    try {
      await fetchGuide(places[i]);
      ok++;
    } catch (err) {
      failed++;
      lastError = err.message;
    }
  }
  return { ok, failed, lastError };
}

// ---------- «Ты рядом» и автоотметка ----------

const NEAR_M = 50;
const DWELL_MS = 60000;
const dismissedNearby = new Set();
const nearSince = new Map(); // id места -> когда подошли
let banner = null;

/** Все непосещённые места из всех поездок — то, что можно отметить. */
function checkinCandidates() {
  const seen = new Map();
  for (const t of store.trips) for (const p of allPlaces(t)) if (!store.isVisited(p.id)) seen.set(p.id, p);
  return [...seen.values()];
}

function markVisitedAuto(p) {
  store.setVisited(p.id, true);
  navigator.vibrate?.([60, 60, 60]);
  toast(`✓ Отмечено: ${p.name}`, { label: 'Отменить', run: () => store.setVisited(p.id, false) });
}

function showNearbyBanner(p) {
  navigator.vibrate?.(80);
  banner = document.createElement('div');
  banner.className = 'banner';
  banner.innerHTML = `
    <div class="thumb" style="--c:${cat(p).color}">${cat(p).emoji}</div>
    <div class="row-main"><div class="muted small">Ты рядом</div><div class="row-title">${esc(p.name)}</div></div>
    <button class="btn success" data-b="yes">Были ✓</button>
    <button class="btn icon" data-b="no" aria-label="Закрыть">✕</button>`;
  banner.addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]')?.dataset.b;
    if (!b) return;
    if (b === 'yes') store.setVisited(p.id, true); else dismissedNearby.add(p.id);
    banner.remove();
    banner = null;
  });
  document.body.appendChild(banner);
}

/**
 * Раз в 15 секунд: кто из мест ближе 50 м и как давно. С автоотметкой — постоял минуту, и место
 * отмечено само; без неё — в поездке показываем плашку «Ты рядом».
 * Если на Android работает фоновый сервис, отмечает он, а мы только забираем его отметки.
 */
function checkNearby() {
  const loc = here();
  if (!loc || (loc.accuracy && loc.accuracy > 60)) return;
  if (store.autoCheckin && backgroundCheckin.supported) return;
  const now = Date.now();
  const near = checkinCandidates()
    .map((p) => [p, distance(loc.lat, loc.lon, p.lat, p.lon)])
    .filter(([, d]) => d < NEAR_M);
  const nearIds = new Set(near.map(([p]) => p.id));
  for (const id of [...nearSince.keys()]) if (!nearIds.has(id)) nearSince.delete(id);
  for (const [p] of near) if (!nearSince.has(p.id)) nearSince.set(p.id, now);

  if (store.autoCheckin) {
    for (const [p] of near) {
      if (now - nearSince.get(p.id) >= DWELL_MS) { nearSince.delete(p.id); markVisitedAuto(p); }
    }
    return;
  }
  if (banner || !window.location.hash.startsWith('#/trip/')) return;
  const closest = near.filter(([p]) => !dismissedNearby.has(p.id)).sort((a, b) => a[1] - b[1])[0];
  if (closest) showNearbyBanner(closest[0]);
}

function pullBackgroundVisits() {
  for (const v of backgroundCheckin.take()) {
    if (store.isVisited(v.id)) continue;
    store.setVisited(v.id, true);
    toast(`✓ Отмечено, пока телефон был в кармане: ${v.name}`, { label: 'Отменить', run: () => store.setVisited(v.id, false) });
  }
}

let lastSynced = '';
/** Держим список мест фонового сервиса в актуальном состоянии. */
function syncBackgroundCheckin() {
  if (!backgroundCheckin.supported) return;
  if (!store.autoCheckin) {
    if (lastSynced !== 'off') { backgroundCheckin.stop(); lastSynced = 'off'; }
    return;
  }
  const places = checkinCandidates().map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon }));
  const json = JSON.stringify(places);
  if (json === lastSynced) return;
  if (lastSynced === '' || lastSynced === 'off' || !backgroundCheckin.isOn()) backgroundCheckin.start(places);
  else backgroundCheckin.update(places);
  lastSynced = json;
}

window.tgAutoCheckinDenied = () => {
  store.setAutoCheckin(false);
  toast('Без доступа к геолокации автоотметка не работает');
};

setInterval(checkNearby, 15000);
onLocation(() => checkNearby());
setInterval(pullBackgroundVisits, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pullBackgroundVisits(); });

// ---------- Главный экран ----------

function HomeScreen() {
  let root;
  const tripCard = (t) => {
    const places = allPlaces(t);
    const done = places.filter((p) => store.isVisited(p.id)).length;
    const days = t.stops.reduce((s, x) => s + x.days, 0);
    const pct = places.length ? Math.round((done / places.length) * 100) : 0;
    return `
      <a class="card trip" href="#/trip/${t.id}/map">
        <div class="trip-title">${esc(t.title)}</div>
        <div class="muted">${t.stops.map((s) => esc(s.name)).join(' → ')}</div>
        <div class="trip-meta"><span>${humanDay(t.startDate, false)} · ${days} дн.</span><span>${done}/${places.length} мест</span></div>
        <div class="progress"><div style="width:${pct}%"></div></div>
      </a>`;
  };
  const render = () => keepScroll(root, draw);
  const draw = () => {
    const visitedCount = Object.keys(store.visited).length;
    root.innerHTML = `
      <header class="bar"><h1>Гид</h1><button class="btn icon" data-act="settings" aria-label="Настройки">⚙︎</button></header>
      <main class="scroll pad">
        <a class="card hero" href="#/explore">
          <div class="hero-icon">📍</div>
          <div><b>Что рядом со мной</b><div class="muted small">Интересные места вокруг, без всяких планов</div></div>
        </a>
        <div class="section-title">Мои поездки</div>
        ${store.trips.length ? store.trips.map(tripCard).join('') : '<div class="empty">Пока нет поездок.<br>Создай первую — например, Будапешт на 5 дней.</div>'}
        <button class="btn primary block" data-act="new">＋ Новая поездка</button>
        ${visitedCount ? `<p class="muted center small">✓ Уже посещено мест: ${visitedCount}</p>` : ''}
      </main>`;
  };
  return {
    mount(el) {
      root = el;
      render();
      root.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'new') openNewTrip();
        if (act === 'settings') openSettings();
      };
    },
    update: render,
  };
}

// ---------- Поездка ----------

const TABS = { map: 'Карта', near: 'Рядом', plan: 'План', tickets: 'Билеты' };

function TripScreen(id, initialTab) {
  let root, body, tab = TABS[initialTab] ? initialTab : 'map', current;
  const trip = () => store.trip(id);

  const showTab = (name) => {
    tab = name;
    history.replaceState(null, '', `#/trip/${id}/${name}`);
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    current?.unmount?.();
    body.innerHTML = '';
    current = { map: MapTab, near: NearTab, plan: PlanTab, tickets: TicketsTab }[name](trip);
    current.mount(body);
  };

  return {
    mount(el) {
      root = el;
      const t = trip();
      root.innerHTML = `
        <header class="bar">
          <button class="btn icon" data-act="back" aria-label="Назад">‹</button>
          <h1>${esc(t.title)}</h1>
          <button class="btn icon" data-act="menu" aria-label="Меню">⋯</button>
        </header>
        <nav class="tabs">${Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}">${v}</button>`).join('')}</nav>
        <div class="tab-body"></div>`;
      body = $('.tab-body', root);
      root.querySelector('header').onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'back') window.location.hash = '#/';
        if (act === 'menu') openTripMenu(trip());
      };
      root.querySelector('.tabs').onclick = (e) => {
        const b = e.target.closest('[data-tab]');
        if (b) showTab(b.dataset.tab);
      };
      startLocation();
      showTab(tab);
    },
    update() {
      if (!trip()) { window.location.hash = '#/'; return; }
      current?.update?.();
    },
    unmount() { current?.unmount?.(); },
  };
}

function MapTab(trip) {
  let root, map, removePins, dot, offLoc;
  const filter = new Set();
  let hideVisited = false;

  const visible = () => allPlaces(trip()).filter((p) =>
    (!filter.size || filter.has(p.category)) && !(hideVisited && store.isVisited(p.id)));

  const renderPins = () => {
    if (!map) return;
    removePins?.();
    removePins = addPins(map, visible(), { isVisited: (id) => store.isVisited(id), onSelect: openPlace });
  };
  const renderControls = () => {
    $('.chips-slot', root).innerHTML = chips(allPlaces(trip()), filter);
    $('[data-act=hide]', root).classList.toggle('on', hideVisited);
  };

  return {
    mount(el) {
      root = el;
      el.innerHTML = `
        <div class="chips-slot"></div>
        <div class="map-wrap">
          <div class="map"></div>
          <button class="float bl" data-act="hide">Скрыть посещённые</button>
          <button class="float br" data-act="me" aria-label="Где я">◎</button>
        </div>`;
      renderControls();
      el.onclick = (e) => {
        const chip = e.target.closest('[data-chip]');
        if (chip) { toggleChip(filter, chip.dataset.chip); renderControls(); renderPins(); return; }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'hide') { hideVisited = !hideVisited; renderControls(); renderPins(); }
        if (act === 'me') {
          if (here() && map) map.easeTo({ center: [here().lon, here().lat], zoom: 16 });
          else toast(position.error || 'Ищу, где ты…');
        }
      };
      const t = trip();
      createMap($('.map', el), { center: t.stops[0] }).then((m) => {
        map = m;
        renderPins();
        fitTo(map, allPlaces(t));
        dot = userDot(map);
        dot.update(here());
        offLoc = onLocation((loc) => dot.update(loc));
      }).catch(() => {
        $('.map', el).innerHTML = '<div class="empty">Карта не загрузилась: нет интернета.<br>Скачай карту города заранее через меню ⋯ — тогда она будет работать офлайн. Список мест и план доступны и так.</div>';
      });
    },
    update() { renderPins(); },
    unmount() { offLoc?.(); map?.remove(); },
  };
}

function NearTab(trip) {
  return NearList(() => allPlaces(trip()), (id) => placeById(trip(), id));
}

/** Список мест по расстоянию от текущей точки. Используется и в поездке, и в «Что рядом». */
function NearList(getPlaces, lookup) {
  let root, offLoc;
  const filter = new Set();
  let hideVisited = true, openToday = true;

  const render = () => keepScroll(root, draw);
  const draw = () => {
    const places = getPlaces();
    let list = '';
    if (!here()) {
      list = position.error ? `<div class="empty">${esc(position.error)}</div>` : '<div class="empty"><div class="spinner"></div>Определяю, где ты…</div>';
    } else {
      const items = places
        .filter((p) => (!filter.size || filter.has(p.category)) && !(hideVisited && store.isVisited(p.id)) && !(openToday && isClosed(p, today())))
        .map((p) => [p, distTo(p)])
        .sort((a, b) => a[1] - b[1]);
      list = items.length
        ? items.map(([p, d]) => placeRow(p, { distance: d })).join('')
        : '<div class="empty">Ничего не нашлось. Попробуй снять фильтры.</div>';
    }
    root.innerHTML = `
      ${chips(places, filter)}
      <div class="scroll">
        <div class="toggles">
          <button class="chip${hideVisited ? ' on' : ''}" data-t="hide">Скрыть посещённые</button>
          <button class="chip${openToday ? ' on' : ''}" data-t="open">Открыто сегодня</button>
        </div>
        <div class="list">${list}</div>
      </div>`;
  };

  return {
    mount(el) {
      root = el;
      startLocation();
      render();
      el.onclick = (e) => {
        const chip = e.target.closest('[data-chip]');
        if (chip) { toggleChip(filter, chip.dataset.chip); render(); return; }
        const t = e.target.closest('[data-t]')?.dataset.t;
        if (t === 'hide') { hideVisited = !hideVisited; render(); return; }
        if (t === 'open') { openToday = !openToday; render(); return; }
        handleCommon(e, lookup);
      };
      offLoc = onLocation(render);
    },
    update: render,
    unmount() { offLoc?.(); },
  };
}

function PlanTab(trip) {
  let root, busy = false, error = '';
  const guideProgress = {}; // номер дня -> текст прогресса скачивания гидов
  let alive = true; // после ухода с вкладки фоновые загрузки не должны рисовать поверх другой

  const render = () => { if (alive) keepScroll(root, draw); };
  const draw = () => {
    const t = trip();
    const urgent = ticketReminders(t).filter((r) => !store.isVisited(r.place.id) && daysBetween(today(), r.buyBy) <= 2);
    root.innerHTML = `<div class="scroll pad">
      ${urgent.length ? `<div class="alert">⚠️ Пора бронировать: ${urgent.map((r) => esc(r.place.name)).join(', ')}. Подробности — во вкладке «Билеты».</div>` : ''}
      ${t.plan.map((day, i) => {
        const places = day.placeIds.map((pid) => placeById(t, pid)).filter(Boolean);
        return `<section class="day">
          <div class="day-head">
            <div><b>День ${i + 1}</b> · ${humanDay(day.date)}</div>
            ${t.stops.length > 1 ? `<div class="muted small">${esc(day.city)}</div>` : ''}
          </div>
          ${day.note ? `<p class="muted">${esc(day.note)}</p>` : ''}
          ${i === 0 || t.plan[i - 1].city !== day.city ? (() => { const st = t.stops.find((x) => x.name === day.city); return st?.why && t.stops.length > 1 ? `<p class="muted small">📍 ${esc(st.why)}</p>` : ''; })() : ''}
          <div class="list">
            ${places.length ? places.map((p, n) => placeRow(p, { number: n + 1 })).join('') : '<div class="empty small">Свободный день — отдохни или загляни во вкладку «Рядом».</div>'}
          </div>
          <div class="actions">
            ${places.length > 1 ? `<button class="btn" data-day="${i}">🗺 Маршрут</button>` : ''}
            ${!places.length ? '' : guideProgress[i] ? '<button class="btn" disabled>Скачиваю…</button>'
              : places.every((p) => store.guides[p.id]) ? '<button class="btn" disabled>📖 Гиды скачаны</button>'
              : `<button class="btn" data-guides="${i}">📥 Скачать гиды</button>`}
          </div>
          ${guideProgress[i] ? `<div class="guides-progress">${guideProgress[i]}</div>` : ''}
        </section>`;
      }).join('')}
      ${t.transportTips?.length ? `<section class="day"><div class="day-head"><b>Переезды между городами</b></div><ul class="tips">${t.transportTips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
      ${t.tips?.length ? `<section class="day"><div class="day-head"><b>Советы</b></div><ul class="tips">${t.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
      <button class="btn block" data-act="replan" ${busy ? 'disabled' : ''}>${busy ? `<span class="spinner"></span> Пересобираю…${store.ai() ? ' ИИ обычно думает до 1,5 минуты' : ''}` : '↻ Пересобрать план без посещённых мест'}</button>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <p class="muted small center">${store.ai() ? `План составляет ИИ (${AI.PROVIDERS[store.ai().provider].title}).` : 'План собран встроенным алгоритмом: места сгруппированы по районам, выходные учтены.'}</p>
    </div>`;
  };

  return {
    mount(el) {
      root = el;
      render();
      el.onclick = async (e) => {
        const dayBtn = e.target.closest('[data-day]');
        if (dayBtn) {
          const day = trip().plan[Number(dayBtn.dataset.day)];
          openDayMap(day.placeIds.map((pid) => placeById(trip(), pid)).filter(Boolean), Number(dayBtn.dataset.day) + 1);
          return;
        }
        const gBtn = e.target.closest('[data-guides]');
        if (gBtn) {
          const i = Number(gBtn.dataset.guides);
          const places = trip().plan[i].placeIds.map((pid) => placeById(trip(), pid)).filter(Boolean);
          const res = await downloadDayGuides(places, (n, total, name) => {
            guideProgress[i] = `<div class="progress-card"><span class="spinner"></span><div class="row-main"><div>Гид ${n + 1} из ${total}: ${esc(name)}</div><div class="muted small">${store.ai() ? 'ИИ — примерно 15–40 секунд на место' : 'из Википедии'}</div></div></div>`;
            render();
          });
          delete guideProgress[i];
          render();
          toast(res.failed ? `Скачано ${res.ok} из ${res.ok + res.failed}. ${res.lastError}` : `Все гиды дня скачаны — работают без интернета`);
          return;
        }
        if (e.target.closest('[data-act=replan]')) {
          busy = true; error = ''; render();
          try {
            store.saveTrip(await replan(trip()));
            toast('План обновлён');
          } catch (err) {
            error = err.message;
          }
          busy = false; render();
          return;
        }
        handleCommon(e, (pid) => placeById(trip(), pid));
      };
    },
    update: render,
    unmount() { alive = false; },
  };
}

function openDayMap(places, dayNumber) {
  let map;
  const sheet = openModal(`
    <div class="sheet-bar"><b>Маршрут дня ${dayNumber}</b><button class="btn icon" data-act="close" aria-label="Закрыть">✕</button></div>
    <div class="map day-map"></div>
    <button class="btn primary block" data-act="go">🚶 Пешком в ${/iPhone|iPad/.test(navigator.userAgent) ? 'Apple Картах' : 'Google Картах'}</button>`,
  { full: true, onClose: () => map?.remove() });
  sheet.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeModal();
    if (act === 'go') directionsRoute(places.filter((p) => !store.isVisited(p.id)));
  });
  createMap($('.day-map', sheet), { center: places[0] }).then((m) => {
    map = m;
    drawRoute(map, places);
    addPins(map, places, { isVisited: (id) => store.isVisited(id), onSelect: openPlace, numbered: true });
    fitTo(map, places, 40);
    userDot(map).update(here());
  }).catch(() => { $('.day-map', sheet).innerHTML = '<div class="empty">Карта недоступна без интернета.</div>'; });
}

function TicketsView(trip) {
  const t = trip();
  const reminders = ticketReminders(t).filter((r) => !store.isVisited(r.place.id));
  if (!reminders.length) {
    return '<div class="empty">🎟<br>Для мест из плана заранее ничего покупать не нужно.</div>';
  }
  const badge = (buyBy) => {
    const d = daysBetween(today(), buyBy);
    if (d < 0) return '<span class="badge red">уже пора!</span>';
    if (d === 0) return '<span class="badge red">сегодня</span>';
    return `<span class="badge ${d <= 2 ? 'orange' : 'green'}">через ${d} дн.</span>`;
  };
  return `
    <p class="muted small">Места из плана, куда билеты или столики лучше брать заранее. «Купить до» считается от дня, на который место стоит в плане.</p>
    ${reminders.map((r, i) => `
      <div class="card ticket">
        <div class="ticket-head"><b>${cat(r.place).emoji} ${esc(r.place.name)}</b>${badge(r.buyBy)}</div>
        <div class="muted small">Визит: ${humanDay(r.visitDate)} · купить до ${humanDay(r.buyBy, false)}</div>
        ${r.place.ticketNote ? `<p>${esc(r.place.ticketNote)}</p>` : ''}
        <div class="actions">
          ${r.place.url ? `<button class="btn" data-site="${i}">Сайт</button>` : ''}
          <button class="btn" data-remind="${i}">${isAndroidApp ? '🔔 Напомнить' : '📅 В календарь'}</button>
        </div>
      </div>`).join('')}`;
}

function TicketsTab(trip) {
  let root;
  const render = () => keepScroll(root, () => { root.innerHTML = `<div class="scroll pad">${TicketsView(trip)}</div>`; });
  return {
    mount(el) {
      root = el;
      render();
      el.onclick = (e) => {
        const reminders = ticketReminders(trip()).filter((r) => !store.isVisited(r.place.id));
        const site = e.target.closest('[data-site]');
        if (site) openExternal(reminders[Number(site.dataset.site)].place.url);
        const rb = e.target.closest('[data-remind]');
        if (rb) {
          const r = reminders[Number(rb.dataset.remind)];
          const ok = remind({
            id: `${r.place.id}-${r.visitDate}`,
            title: `Пора купить билеты: ${r.place.name}`,
            text: r.place.ticketNote || `Визит ${humanDay(r.visitDate)}`,
            date: r.buyBy,
          });
          if (isAndroidApp) toast(ok ? `Напомню ${humanDay(r.buyBy, false)} в 10:00` : 'Разреши уведомления для приложения');
        }
      };
    },
    update: render,
  };
}

function openTripMenu(trip) {
  const offline = store.offline[trip.id];
  const sheet = openModal(`
    <div class="grabber"></div>
    <h2>${esc(trip.title)}</h2>
    <div class="menu">
      <button data-act="offline">⬇️ Скачать карту для офлайна${offline ? `<small>Скачано ${new Date(offline.date).toLocaleDateString('ru-RU')} — обновить</small>` : '<small>Карта города будет работать без интернета (~10–40 МБ)</small>'}</button>
      <button data-act="replan">↻ Пересобрать план<small>Без мест, где ты уже был</small></button>
      <button data-act="delete" class="danger">🗑 Удалить поездку</button>
    </div>
    <div class="progress-slot"></div>`);
  sheet.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'delete') {
      if (confirm(`Удалить поездку «${trip.title}»? Отметки «были» сохранятся.`)) {
        closeModal();
        store.deleteTrip(trip.id);
        window.location.hash = '#/';
      }
    }
    if (act === 'replan') {
      $('.progress-slot', sheet).innerHTML = '<p class="center"><span class="spinner"></span> Пересобираю…</p>';
      try {
        store.saveTrip(await replan(store.trip(trip.id)));
        closeModal();
        toast('План обновлён');
      } catch (err) {
        $('.progress-slot', sheet).innerHTML = `<p class="error">${esc(err.message)}</p>`;
      }
    }
    if (act === 'offline') {
      const slot = $('.progress-slot', sheet);
      slot.innerHTML = '<p class="small">Готовлю загрузку…</p><div class="progress"><div style="width:0"></div></div>';
      try {
        const bboxes = trip.stops.map((s) => bboxAround(s.places.length ? s.places : [s]));
        const result = await downloadOffline(bboxes, (done, total) => {
          slot.innerHTML = `<p class="small">Скачиваю карту: ${done} из ${total}</p><div class="progress"><div style="width:${Math.round((done / total) * 100)}%"></div></div>`;
        });
        store.setOffline(trip.id, { date: new Date().toISOString(), total: result.total });
        slot.innerHTML = result.failed
          ? `<p class="error">Скачано, но ${result.failed} кусочков не загрузились. Нажми ещё раз, чтобы докачать.</p>`
          : '<p class="success-text">✓ Карта скачана — теперь она работает без интернета.</p>';
      } catch (err) {
        slot.innerHTML = `<p class="error">${esc(err.message || 'Не получилось скачать. Проверь интернет.')}</p>`;
      }
    }
  });
}

// ---------- Создание поездки ----------

async function replan(trip, progress = () => {}) {
  const visited = store.visitedSet();
  const ai = store.ai();
  if (ai) {
    progress('ИИ составляет план по дням…');
    try {
      const { plan, tips } = await AI.generatePlan(ai, trip, visited);
      // Пустой план от ИИ хуже алгоритма — тогда используем алгоритм.
      if (plan.some((d) => d.placeIds.length)) return { ...trip, plan, tips };
      toast('ИИ вернул пустой план — собрал план сам');
    } catch (err) {
      toast(`${err.message} План собран встроенным алгоритмом.`);
    }
  }
  progress('Составляю план по дням');
  return { ...trip, plan: makePlan(trip, visited) };
}

async function loadStop(stop, useAI, progress, country) {
  const c = Places.curated(stop.name);
  if (c) {
    progress(`${stop.name}: беру готовую подборку мест`);
    return { name: stop.name, lat: c.lat, lon: c.lon, days: stop.days, places: c.places };
  }
  progress(`${stop.name}: ищу город на карте`);
  const query = [stop.localName || stop.name, country].filter(Boolean).join(', ');
  const city = await Places.geocode(query).catch(() => Places.geocode(stop.name));
  const name = stop.why ? stop.name : city.name;
  let places;
  if (useAI) {
    progress(`${name}: ИИ подбирает места и культовую еду…`, 'обычно 20–60 секунд');
    places = await AI.discoverPlaces(store.ai(), name, city.lat, city.lon, (t) => progress(t, 'не чаще раза в секунду — таковы правила бесплатной карты'), stop.days);
  } else {
    progress(`${name}: загружаю места из OpenStreetMap`, 'обычно 5–30 секунд');
    places = await Places.fetchAround(city.lat, city.lon, 6000);
  }
  return { name, lat: city.lat, lon: city.lon, days: stop.days, places, why: stop.why || undefined };
}

/** Карточка ожидания: шаг, что происходит, сколько обычно ждать и сколько уже прошло. */
function progressCard(sheet) {
  // Поверх формы, чтобы было видно, даже если форма длинная и прокручена.
  const slot = document.createElement('div');
  slot.className = 'busy-overlay';
  sheet.appendChild(slot);
  const started = Date.now();
  let step = 0, total = 1, text = '', hint = '';
  const draw = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    const time = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    slot.innerHTML = `<div class="progress-card">
      <span class="spinner"></span>
      <div class="row-main">
        ${total > 1 ? `<div class="muted small">Шаг ${step} из ${total}</div>` : ''}
        <div>${esc(text)}</div>
        <div class="muted small">${hint ? esc(hint) + ' · ' : ''}прошло ${time}</div>
      </div>
    </div>`;
  };
  const timer = setInterval(draw, 1000);
  return {
    setTotal(n) { total = n; },
    next(t, h = '') { step++; text = t; hint = h; draw(); },
    update(t, h) { text = t; if (h !== undefined) hint = h; draw(); },
    stop() { clearInterval(timer); slot.remove(); },
  };
}

function openNewTrip() {
  let mode = 'single'; // single | multi | country
  let stops = [{ name: 'Будапешт', days: 5 }];
  let country = '', countryDays = 10, countryName = '', transportTips = [];
  let startDate = today();
  const ai = store.ai();
  let useAI = Boolean(ai);
  let busy = false;

  const sheet = openModal('', { full: true });
  const stopRow = (s, i) => `
    <div class="stop">
      <input class="input" data-name="${i}" value="${esc(s.name)}" placeholder="Например, Прага" autocomplete="off">
      <div class="stepper">
        <button data-dec="${i}" aria-label="Меньше">−</button>
        <span>${s.days} дн.</span>
        <button data-inc="${i}" aria-label="Больше">+</button>
      </div>
      ${mode === 'multi' && stops.length > 1 ? `<button class="btn icon" data-del="${i}" aria-label="Убрать">✕</button>` : ''}
    </div>
    ${s.why ? `<p class="muted small why">${esc(s.why)}</p>` : ''}`;

  const aiSwitch = () => `
    <label class="switch ${ai ? '' : 'disabled'}">
      <input type="checkbox" data-ai ${useAI ? 'checked' : ''} ${ai ? '' : 'disabled'}>
      <span>С ИИ${ai ? ` (${AI.PROVIDERS[ai.provider].title})` : ''}</span>
    </label>`;

  const render = () => {
    const total = stops.reduce((n, s) => n + s.days, 0);
    sheet.innerHTML = `
      <div class="sheet-bar">
        <button class="btn link" data-act="cancel">Отмена</button>
        <b>Новая поездка</b>
        <button class="btn link strong" data-act="${mode === 'country' ? 'suggest' : 'create'}">${mode === 'country' ? 'Далее' : 'Создать'}</button>
      </div>
      <div class="scroll form">
        <div class="segmented">
          <button class="${mode === 'single' ? 'on' : ''}" data-mode="single">Город</button>
          <button class="${mode === 'multi' ? 'on' : ''}" data-mode="multi">Маршрут</button>
          <button class="${mode === 'country' ? 'on' : ''}" data-mode="country">Страна</button>
        </div>
        ${mode === 'country' ? `
          <label class="label">Страна</label>
          <input class="input" data-country value="${esc(country)}" placeholder="Например, Грузия" autocomplete="off">
          <label class="label">Сколько дней всего</label>
          <div class="stepper wide">
            <button data-cdec aria-label="Меньше">−</button>
            <span>${countryDays} дн.</span>
            <button data-cinc aria-label="Больше">+</button>
          </div>
          ${aiSwitch()}
          <p class="muted small">${ai && useAI
            ? 'ИИ предложит города, порядок и сколько дней где провести — с горами, побережьем и прочим, ради чего туда едут. Маршрут можно будет поправить.'
            : 'Без ИИ предложу крупнейшие города страны в удобном порядке. С ИИ маршрут получится интереснее — ключ в настройках ⚙︎.'}</p>
          <button class="btn primary block" data-act="suggest">Предложить маршрут</button>` : `
          ${countryName ? `<div class="alert">Маршрут по стране «${esc(countryName)}» на ${total} дн. Поправь города и дни, если хочешь, и нажми «Создать».</div>` : ''}
          <label class="label">${mode === 'multi' ? 'Города по порядку' : 'Город'}</label>
          ${stops.map(stopRow).join('')}
          ${mode === 'multi' ? '<button class="btn block" data-act="add">＋ Добавить город</button>' : ''}
          ${aiSwitch()}
          <p class="muted small">${ai && useAI
            ? 'ИИ подберёт места с культовой едой, сверит их с картой и составит план с учётом выходных и билетов. Обычно 1–2 минуты на город.'
            : ai ? 'План строит встроенный алгоритм — быстро, но проще.' : 'Без API-ключа план строится встроенным алгоритмом, а места для других городов берутся из OpenStreetMap. Ключ можно добавить в настройках ⚙︎.'}</p>`}
        <label class="label">Начало поездки</label>
        <input class="input" type="date" data-date value="${startDate}">
        <div class="status"></div>
      </div>`;
    if (busy) sheet.querySelectorAll('button, input').forEach((b) => { if (b.dataset.act !== 'cancel') b.disabled = true; });
  };
  render();

  const status = (html) => { $('.status', sheet).innerHTML = html; };
  const setBusy = (v) => { busy = v; render(); };

  async function suggest() {
    if (!country.trim()) { status('<p class="error">Напиши страну.</p>'); return; }
    setBusy(true);
    const pc = progressCard(sheet);
    try {
      let cities;
      if (useAI && ai) {
        pc.next('ИИ продумывает маршрут по стране…', 'обычно 15–40 секунд');
        const r = await AI.suggestRoute(ai, country.trim(), countryDays);
        cities = r.cities;
        transportTips = r.tips;
      } else {
        pc.next('Ищу главные города страны…', 'обычно 5–30 секунд');
        cities = await Places.suggestRouteOSM(country.trim(), countryDays);
        transportTips = [];
      }
      pc.stop();
      countryName = country.trim();
      stops = cities.map((c) => ({ name: c.name, localName: c.localName, days: c.days, why: c.why }));
      mode = 'multi';
      busy = false;
      render();
    } catch (err) {
      pc.stop();
      busy = false;
      render();
      status(`<p class="error">${esc(err.message)}</p>`);
    }
  }

  async function create() {
    const clean = stops.map((s) => ({ ...s, name: s.name.trim() })).filter((s) => s.name);
    if (!clean.length) { status('<p class="error">Укажи хотя бы один город.</p>'); return; }
    const withAI = Boolean(useAI && ai);
    setBusy(true);
    const pc = progressCard(sheet);
    pc.setTotal(clean.length + 1);
    let current = 0;
    const progress = (text, hint) => {
      // Новый город — новый шаг; сообщения внутри города — обновление того же шага.
      const cityIndex = clean.findIndex((s, i) => i >= current && text.startsWith(s.name));
      if (cityIndex >= current) { current = cityIndex + 1; pc.next(text, hint); } else pc.update(text, hint);
    };
    try {
      const loaded = [];
      for (const s of clean) loaded.push(await loadStop(s, withAI, progress, countryName));
      let trip = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: countryName && loaded.length > 1 ? countryName : loaded.map((s) => s.name).join(' → '),
        startDate,
        stops: loaded,
        plan: [],
        tips: [],
        transportTips,
        createdAt: new Date().toISOString(),
      };
      pc.next(withAI ? 'ИИ составляет план по дням…' : 'Составляю план по дням', withAI ? 'обычно 30–90 секунд' : '');
      trip = withAI ? await replan(trip) : { ...trip, plan: makePlan(trip, store.visitedSet()) };
      pc.stop();
      store.saveTrip(trip);
      closeModal();
      window.location.hash = `#/trip/${trip.id}/plan`;
    } catch (err) {
      pc.stop();
      busy = false;
      render();
      status(`<p class="error">${esc(err.message)}</p>`);
    }
  }

  sheet.addEventListener('input', (e) => {
    const d = e.target.dataset;
    if (d.name != null) stops[Number(d.name)].name = e.target.value;
    if (d.country != null) country = e.target.value;
    if (d.date != null) startDate = e.target.value || today();
    if (d.ai != null) { useAI = e.target.checked; render(); }
  });
  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.act === 'cancel') { closeModal(); return; }
    if (busy) return;
    if (d.mode) {
      mode = d.mode;
      if (mode === 'single') stops = stops.slice(0, 1);
      if (mode !== 'multi') countryName = '';
      render();
    }
    if (d.inc) { stops[d.inc].days = Math.min(30, stops[d.inc].days + 1); render(); }
    if (d.dec) { stops[d.dec].days = Math.max(1, stops[d.dec].days - 1); render(); }
    if (d.cinc != null) { countryDays = Math.min(30, countryDays + 1); render(); }
    if (d.cdec != null) { countryDays = Math.max(2, countryDays - 1); render(); }
    if (d.del) { stops.splice(Number(d.del), 1); render(); }
    if (d.act === 'add') { stops.push({ name: '', days: 2 }); render(); $(`[data-name="${stops.length - 1}"]`, sheet)?.focus(); }
    if (d.act === 'suggest') suggest();
    if (d.act === 'create') create();
  });
}

// ---------- Настройки ----------

function openSettings() {
  let provider = store.aiProvider;
  let auto = store.autoCheckin;
  const keys = { ...store.aiKeys };
  const sheet = openModal('');
  const render = () => {
    const info = AI.PROVIDERS[provider];
    sheet.innerHTML = `
      <div class="grabber"></div>
      <h2>Настройки</h2>
      <label class="label">ИИ для подборки мест и плана</label>
      <div class="segmented">
        <button class="${provider === 'none' ? 'on' : ''}" data-p="none">Без ИИ</button>
        ${Object.entries(AI.PROVIDERS).map(([k, v]) => `<button class="${provider === k ? 'on' : ''}" data-p="${k}">${v.title}<small>${v.note}</small></button>`).join('')}
      </div>
      ${provider === 'none' ? `
        <p class="muted small">План строит встроенный алгоритм, места для городов кроме Будапешта берутся из OpenStreetMap. Всё бесплатно и без ключей.</p>` : `
        <label class="label">Ключ ${info.title}</label>
        <input class="input" type="password" data-key placeholder="${provider === 'gemini' ? 'AIza…' : 'sk-ant-…'}" value="${esc(keys[provider] || '')}" autocomplete="off" autocapitalize="off" spellcheck="false">
        ${provider === 'gemini' ? `
          <div class="steps small">
            <b>Как получить бесплатный ключ (2 минуты):</b>
            <ol>
              <li>Открой <a href="#" data-link="${info.keyUrl}">aistudio.google.com/apikey</a> и войди Google-аккаунтом.</li>
              <li>Нажми «Create API key» и скопируй ключ (начинается с AIza).</li>
              <li>Вставь его сюда и нажми «Сохранить».</li>
            </ol>
            Бесплатный тариф ограничен по числу запросов в минуту и в день — на создание поездок хватает с запасом.
          </div>` : `
          <p class="muted small">Ключ создаётся на <a href="#" data-link="${info.keyUrl}">platform.claude.com</a>, оплата отдельно от подписки Claude Pro. Одна поездка — примерно 10–30 центов.</p>`}
        <p class="muted small">Ключ хранится только на этом телефоне.</p>`}
      <label class="label">Автоотметка</label>
      <label class="switch">
        <input type="checkbox" data-auto ${auto ? 'checked' : ''}>
        <span>Отмечать места автоматически</span>
      </label>
      <p class="muted small">Постоял у достопримечательности около минуты — место отмечено само, без нажатий. ${backgroundCheckin.supported
        ? 'Работает и в фоне, когда телефон в кармане: в шторке будет висеть уведомление «Гид отмечает места», а на каждое отмеченное место придёт уведомление. Немного расходует батарею — выключай, когда не гуляешь.'
        : 'В веб-версии работает, пока приложение открыто на экране.'}</p>
      <button class="btn primary block" data-act="save">Сохранить</button>
      <div class="facts">
        <div>Поездок: ${store.trips.length}</div>
        <div>Посещено мест: ${Object.keys(store.visited).length}</div>
      </div>
      <p class="muted small">Места, планы и отметки хранятся на телефоне — после создания поездки всё доступно без интернета. Карту города можно скачать в меню поездки ⋯.</p>
      <p class="muted small">Карта: © OpenFreeMap, © OpenMapTiles, © участники OpenStreetMap.</p>
      <p class="muted small center" data-version></p>`;
    fetch('version.json', { cache: 'no-store' }).then((r) => r.text()).then((v) => {
      const el = $('[data-version]', sheet);
      if (el) el.textContent = `Версия приложения: ${v.trim()}`;
    }).catch(() => {});
  };
  render();
  sheet.addEventListener('input', (e) => {
    if (e.target.dataset.key != null) keys[provider] = e.target.value;
    if (e.target.dataset.auto != null) auto = e.target.checked;
  });
  sheet.addEventListener('click', (e) => {
    const p = e.target.closest('[data-p]')?.dataset.p;
    if (p) { provider = p; render(); return; }
    const link = e.target.closest('[data-link]');
    if (link) { e.preventDefault(); openExternal(link.dataset.link); return; }
    if (e.target.closest('[data-act=save]')) {
      if (provider !== 'none' && !(keys[provider] || '').trim()) { toast('Вставь ключ или выбери «Без ИИ»'); return; }
      store.setAI(provider, keys[provider] || '');
      if (auto !== store.autoCheckin) {
        store.setAutoCheckin(auto);
        if (auto) startLocation();
      }
      closeModal();
      toast(provider === 'none' ? 'Работаем без ИИ' : `Подключено: ${AI.PROVIDERS[provider].title}`);
    }
  });
}

// ---------- «Что рядом со мной» без поездки ----------

function ExploreScreen() {
  let root, list, map, removePins, dot, offLoc, loadedAt = null, loading = false, error = '';
  let places = [];
  let showMap = false;
  const lookup = (id) => places.find((p) => p.id === id);

  const load = async (force = false) => {
    const loc = here();
    if (!loc || loading || (!force && places.length)) return;
    loading = true;
    error = '';
    renderStatus();
    // Места из встроенных подборок и всех поездок рядом с нами — работают даже без сети.
    const result = new Map();
    for (const p of [...store.trips.flatMap(allPlaces), ...Places.allCuratedPlaces()]) {
      if (distance(loc.lat, loc.lon, p.lat, p.lon) < 3000) result.set(p.id, p);
    }
    try {
      for (const p of await Places.fetchAround(loc.lat, loc.lon, 2000)) {
        // Не дублируем то, что уже есть в подборке под другим id.
        if (![...result.values()].some((q) => distance(q.lat, q.lon, p.lat, p.lon) < 40)) result.set(p.id, p);
      }
    } catch (err) {
      if (!result.size) error = err.message;
    }
    places = [...result.values()];
    loadedAt = loc;
    loading = false;
    renderStatus();
    list?.update();
    renderPins();
  };

  const renderStatus = () => {
    const s = $('.explore-status', root);
    if (!s) return;
    s.innerHTML = loading && !places.length ? '<div class="empty"><div class="spinner"></div>Ищу интересное рядом…<br><span class="small">Бесплатный сервер мест иногда думает до 30 секунд</span></div>'
      : error ? `<div class="empty">${esc(error)}<br><button class="btn" data-act="retry" style="margin-top:12px">Попробовать ещё раз</button></div>` : '';
  };

  const renderPins = () => {
    if (!map) return;
    removePins?.();
    removePins = addPins(map, places, { isVisited: (id) => store.isVisited(id), onSelect: openPlace });
  };

  const renderBody = () => {
    list?.unmount?.();
    list = null;
    map?.remove();
    map = null;
    offLoc?.();
    const body = $('.explore-body', root);
    body.innerHTML = '';
    body.onclick = null;
    $('[data-act=toggle]', root).textContent = showMap ? '☰' : '🗺';
    if (showMap) {
      body.innerHTML = '<div class="map-wrap"><div class="map"></div></div>';
      const loc = here();
      createMap($('.map', body), { center: loc || { lat: 47.4979, lon: 19.0402 }, zoom: 15 }).then((m) => {
        map = m;
        dot = userDot(map);
        dot.update(here());
        offLoc = onLocation((l) => dot.update(l));
        renderPins();
      }).catch(() => { $('.map', body).innerHTML = '<div class="empty">Карта недоступна без интернета.</div>'; });
    } else {
      list = NearList(() => places, lookup);
      list.mount(body);
    }
  };

  let offLoad;
  return {
    mount(el) {
      root = el;
      el.innerHTML = `
        <header class="bar">
          <button class="btn icon" data-act="back" aria-label="Назад">‹</button>
          <h1>Что рядом</h1>
          <button class="btn icon" data-act="refresh" aria-label="Обновить">↻</button>
          <button class="btn icon" data-act="toggle" aria-label="Карта или список">🗺</button>
        </header>
        <div class="explore-status"></div>
        <div class="tab-body explore-body"></div>`;
      el.querySelector('header').onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'back') window.location.hash = '#/';
        if (act === 'refresh') load(true);
        if (act === 'toggle') { showMap = !showMap; renderBody(); }
      };
      $('.explore-status', el).onclick = (e) => {
        if (e.target.closest('[data-act=retry]')) load(true);
      };
      startLocation();
      renderBody();
      offLoad = onLocation((loc) => {
        // Первая точка — загружаем; ушёл больше чем на километр — обновляем подборку.
        if (loc && (!loadedAt || distance(loc.lat, loc.lon, loadedAt.lat, loadedAt.lon) > 1000)) load(true);
      });
      load();
    },
    update() { list?.update(); renderPins(); },
    unmount() { offLoad?.(); offLoc?.(); list?.unmount?.(); map?.remove(); },
  };
}

// ---------- Навигация ----------

let screen = null;

function route() {
  while (modals.length) closeModal();
  banner?.remove();
  banner = null;
  screen?.unmount?.();
  const [name, id, tab] = window.location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'trip' && store.trip(id)) screen = TripScreen(id, tab);
  else if (name === 'explore') screen = ExploreScreen();
  else screen = HomeScreen();
  app.innerHTML = '';
  app.onclick = null;
  screen.mount(app);
}

window.addEventListener('hashchange', route);
store.subscribe(() => { screen?.update?.(); syncBackgroundCheckin(); });
route();
if (store.autoCheckin) startLocation();
syncBackgroundCheckin();
pullBackgroundVisits();

if ('serviceWorker' in navigator && !isAndroidApp && window.location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
