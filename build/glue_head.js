// ═══════════════════════════════════════════════════════════════════════
//  Nutri — web app personal. Motor de nutrición + API + interfaz.
//  Lo usan src/index.js (Cloudflare) y api/index.js (Vercel). Generado por build/build.py.
//  Secretos: APP_TOKEN (obligatorio) · USDA_API_KEY (recomendado)
// ═══════════════════════════════════════════════════════════════════════

const TZ = 'Europe/Madrid';
let ENV = null;

// ───────────────────────── almacenamiento (D1, tabla store) ─────────────────────────
const DEFAULT_GOALS = { kcal: 2000, protein: 150, carbs: 200, fat: 65, add_active: false, provisional: true };
const DEFAULT_PRESETS = {
  'cafe con leche': 'un cafe con leche',
  'tostada con aceite y tomate': '60 g de pan, 10 g de aceite de oliva y 50 g de tomate',
};
let db = null;
let DIRTY = new Set();
let LOADED_MONTHS = [];
const CONFIG = { USE_USDA: true, USE_OPEN_FOOD_FACTS: true };
const monthBefore = (m) => { let [y, mm] = m.split('-').map(Number); mm -= 1; if (!mm) { mm = 12; y -= 1; } return `${y}-${String(mm).padStart(2, '0')}`; };

// Almacenes: Cloudflare D1 (tabla store) o Upstash Redis (Vercel). Mismo formato: clave → JSON.
export function d1Store(DB) {
  return {
    async getMany(keys) {
      const { results } = await DB.prepare(`SELECT k, v FROM store WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
      const o = {}; for (const r of results) o[r.k] = JSON.parse(r.v); return o;
    },
    async setMany(items) {
      const now = new Date().toISOString();
      await DB.batch(items.map(([k, v]) => DB.prepare('INSERT INTO store (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated').bind(k, JSON.stringify(v), now)));
    },
    async getAll() {
      const { results } = await DB.prepare('SELECT k, v FROM store ORDER BY k').all();
      const o = {}; for (const r of results) o[r.k] = JSON.parse(r.v); return o;
    },
  };
}

export function upstashStore(url, token, prefix = 'nutri:') {
  const base = String(url).replace(/\/+$/, '');
  const call = async (cmds) => {
    const r = await fetch(`${base}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
    if (!r.ok) throw new Error(`Base de datos (Upstash) ${r.status}`);
    const j = await r.json();
    return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
  };
  return {
    async getMany(keys) {
      const [vals] = await call([['MGET', ...keys.map(k => prefix + k)]]);
      const o = {}; keys.forEach((k, i) => { if (vals[i] != null) o[k] = JSON.parse(vals[i]); }); return o;
    },
    async setMany(items) { await call(items.map(([k, v]) => ['SET', prefix + k, JSON.stringify(v)])); },
    async getAll() {
      const [keys] = await call([['KEYS', `${prefix}*`]]);
      if (!keys.length) return {};
      const [vals] = await call([['MGET', ...keys]]);
      const o = {}; keys.forEach((k, i) => { if (vals[i] != null) o[k.slice(prefix.length)] = JSON.parse(vals[i]); }); return o;
    },
  };
}

async function loadDb() {
  const m0 = today().slice(0, 7); const m1 = monthBefore(m0);
  LOADED_MONTHS = [m1, m0];
  const o = await ENV.STORE.getMany(['foods', 'metrics', 'goals', 'profile', 'presets', 'settings', `entries:${m1}`, `entries:${m0}`]);
  db = {
    entries: [...(o[`entries:${m1}`] || []), ...(o[`entries:${m0}`] || [])],
    foods: o.foods || [], metrics: o.metrics || {}, goals: o.goals || { ...DEFAULT_GOALS }, profile: o.profile || {},
    presets: o.presets || { ...DEFAULT_PRESETS }, settings: o.settings || {},
  };
  DIRTY = new Set();
  FOODS = buildFoodIndex();
}
function save(name) { DIRTY.add(name); }
const persist = (...keys) => keys.forEach(k => save(k));
async function flush() {
  const items = [];
  for (const k of DIRTY) {
    if (k === 'entries') {
      const by = {}; for (const m of LOADED_MONTHS) by[m] = [];
      for (const e of db.entries) { const m = e.day.slice(0, 7); (by[m] = by[m] || []).push(e); }
      for (const [m, list] of Object.entries(by)) items.push([`entries:${m}`, list]);
    } else items.push([k, db[k]]);
  }
  if (items.length) await ENV.STORE.setMany(items);
  DIRTY.clear();
}

// ───────────────────────── fechas en hora de Madrid ─────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const DTF = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
function zparts(d = new Date()) {
  const o = {}; for (const p of DTF.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, min: +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
function dayOf(d = new Date()) { const p = zparts(d); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
const today = () => dayOf(new Date());
const daysAgo = (n) => dayOf(new Date(Date.now() - n * 86400000));
