// Состояние приложения в localStorage — всё живёт на телефоне и работает без интернета.

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Хранилище недоступно (приватный режим) — работаем в памяти.
  }
}

const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const store = {
  trips: read('tg.trips', []),
  /** id места -> дата отметки. Общий для всех поездок, чтобы не было дублей. */
  visited: read('tg.visited', {}),
  /** ИИ: 'none' | 'gemini' | 'claude' и ключ для каждого. */
  aiProvider: read('tg.aiProvider', read('tg.apiKey', '') ? 'claude' : 'none'),
  aiKeys: read('tg.aiKeys', { claude: read('tg.apiKey', '') }),
  offline: read('tg.offline', {}), // id поездки -> { tiles, date }
  autoCheckin: read('tg.autoCheckin', false),
  guides: read('tg.guides', {}), // id места -> скачанный гид (работает без интернета)
  /** Откуда обычно летаем — для подбора билетов. */
  home: read('tg.home', { name: 'Тель-Авив', lat: 32.0809, lon: 34.7806, cc: 'IL' }),

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  trip(id) { return this.trips.find((t) => t.id === id); },

  saveTrip(trip) {
    const i = this.trips.findIndex((t) => t.id === trip.id);
    if (i >= 0) this.trips[i] = trip; else this.trips.unshift(trip);
    write('tg.trips', this.trips);
    notify();
  },

  deleteTrip(id) {
    this.trips = this.trips.filter((t) => t.id !== id);
    write('tg.trips', this.trips);
    notify();
  },

  isVisited(id) { return Boolean(this.visited[id]); },

  setVisited(id, value) {
    if (value) this.visited[id] = new Date().toISOString(); else delete this.visited[id];
    write('tg.visited', this.visited);
    notify();
  },

  visitedSet() { return new Set(Object.keys(this.visited)); },

  /** Настроенный ИИ или null, если работаем без него. */
  ai() {
    const key = this.aiKeys[this.aiProvider];
    return this.aiProvider !== 'none' && key ? { provider: this.aiProvider, key } : null;
  },

  setAI(provider, key) {
    this.aiProvider = provider;
    if (provider !== 'none') this.aiKeys[provider] = key.trim();
    write('tg.aiProvider', this.aiProvider);
    write('tg.aiKeys', this.aiKeys);
    notify();
  },

  setAutoCheckin(on) {
    this.autoCheckin = on;
    write('tg.autoCheckin', on);
    notify();
  },

  saveGuide(placeId, guide) {
    this.guides[placeId] = guide;
    write('tg.guides', this.guides);
    notify();
  },

  /** Страны, где уже были: [{ cc, name }] — чтобы реже предлагать их в «Куда полететь». */
  visitedCountries: read('tg.visitedCountries', []),

  toggleVisitedCountry(cc, name) {
    const has = this.visitedCountries.some((c) => c.cc === cc);
    this.visitedCountries = has ? this.visitedCountries.filter((c) => c.cc !== cc)
      : [...this.visitedCountries, { cc, name }].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    write('tg.visitedCountries', this.visitedCountries);
    notify();
  },

  setHome(home) {
    this.home = home;
    write('tg.home', home);
    notify();
  },

  setOffline(tripId, info) {
    this.offline[tripId] = info;
    write('tg.offline', this.offline);
    notify();
  },
};
