// Разница между Android-приложением (есть мост AndroidBridge) и iPhone/браузером.
import { distance } from './geo.js';

const bridge = window.AndroidBridge;
export const isAndroidApp = Boolean(bridge);
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

export function openExternal(url) {
  if (bridge) bridge.openUrl(url);
  else window.open(url, '_blank', 'noopener');
}

/** Пешая навигация до места: Google Maps на Android, Apple Карты на iPhone. */
export function directionsTo(place) {
  const ll = `${place.lat},${place.lon}`;
  openExternal(isIOS
    ? `https://maps.apple.com/?daddr=${ll}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=walking`);
}

/** Весь маршрут дня. Google Maps умеет промежуточные точки, Apple Карты — только одну цель. */
export function directionsRoute(places) {
  if (!places.length) return;
  if (isIOS || places.length === 1) return directionsTo(places[0]);
  const last = places[places.length - 1];
  const waypoints = places.slice(0, -1).slice(0, 9).map((p) => `${p.lat},${p.lon}`).join('|');
  openExternal(`https://www.google.com/maps/dir/?api=1&destination=${last.lat},${last.lon}&waypoints=${encodeURIComponent(waypoints)}&travelmode=walking`);
}

/** Напоминание купить билеты. На Android — системное уведомление, иначе — событие в календаре. */
export function remind({ id, title, text, date }) {
  const [y, m, d] = date.split('-').map(Number);
  let when = new Date(y, m - 1, d, 10, 0, 0);
  if (when < new Date()) when = new Date(Date.now() + 60000);
  if (bridge) return bridge.scheduleReminder(id, title, text, when.getTime());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = (t) => `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}T${p(t.getUTCHours())}${p(t.getUTCMinutes())}00Z`;
  const end = new Date(when.getTime() + 15 * 60000);
  const esc = (s) => s.replace(/[,;\\]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TripGuide//RU',
    'BEGIN:VEVENT', `UID:${id}@tripguide`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(when)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(text)}`,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
  a.download = 'bilety.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

// ---------- Геолокация ----------

const locListeners = new Set();
export const position = { current: null, error: null, started: false };

export function startLocation() {
  if (position.started) return;
  position.started = true;
  if (!('geolocation' in navigator)) {
    position.error = 'Геолокация не поддерживается';
    return;
  }
  const onPos = (pos) => {
    const next = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
    // Игнорируем дрожание меньше 10 м.
    if (position.current && distance(position.current.lat, position.current.lon, next.lat, next.lon) < 10) return;
    position.current = next;
    position.error = null;
    locListeners.forEach((fn) => fn(next));
  };
  // Быстрая примерная точка (по сети), пока GPS ищет спутники.
  navigator.geolocation.getCurrentPosition(onPos, () => {}, { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 });
  navigator.geolocation.watchPosition(
    onPos,
    (err) => {
      if (position.current) return; // уже есть примерная точка — не пугаем ошибкой
      position.error = err.code === 1
        ? 'Нет доступа к геолокации. Разреши его в настройках телефона.'
        : 'Не удаётся определить, где ты.';
      locListeners.forEach((fn) => fn(null));
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
  );
}

export function onLocation(fn) {
  locListeners.add(fn);
  return () => locListeners.delete(fn);
}

// ---------- Чтение вслух ----------

/** Читает текст вслух по абзацам. На Android — системный синтез речи, иначе — speechSynthesis браузера. */
export function speak(paragraphs, onEnd) {
  stopSpeaking();
  const parts = paragraphs.filter(Boolean);
  if (bridge?.speak) {
    window.tgSpeechEnded = onEnd;
    bridge.speak(JSON.stringify(parts));
    return true;
  }
  if (!('speechSynthesis' in window)) return false;
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('ru'));
  parts.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    if (voice) u.voice = voice;
    if (i === parts.length - 1 && onEnd) u.onend = onEnd;
    speechSynthesis.speak(u);
  });
  return true;
}

export function stopSpeaking() {
  if (bridge?.stopSpeaking) bridge.stopSpeaking();
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ---------- Автоотметка в фоне (только Android-приложение) ----------

export const backgroundCheckin = {
  supported: Boolean(bridge?.startAutoCheckin),
  start(places) { bridge?.startAutoCheckin(JSON.stringify(places)); },
  update(places) { bridge?.updateAutoCheckinPlaces(JSON.stringify(places)); },
  stop() { bridge?.stopAutoCheckin(); },
  isOn() { return Boolean(bridge?.isAutoCheckinOn?.()); },
  /** Отметки, сделанные сервисом, пока приложение было свёрнуто. */
  take() {
    try { return JSON.parse(bridge?.takeVisits?.() || '[]'); } catch { return []; }
  },
};
