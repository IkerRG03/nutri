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

// ───────────────────────── motor de nutrición ─────────────────────────
function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.;:"“”]/g, ' ').replace(/\s+/g, ' ').trim();
}
// como normalize, pero conserva los decimales ("82,4" → "82.4") y quita puntos de miles ("1.900" → "1900")
function normNum(s) {
  const t = String(s || '').replace(/\b(\d{1,3})\.(\d{3})\b(?![.,]\d)/g, '$1$2').replace(/(\d)[.,](\d)/g, '$1§$2');
  return normalize(t).replace(/§/g, '.');
}
function lowerClean(s) {
  return String(s || '').toLowerCase().replace(/[¿?¡!;:"“”]/g, ' ').replace(/(\D)\.(\D|$)/g, '$1 $2').replace(/\s+/g, ' ').trim();
}
const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fmt = (n) => r0(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const f1 = (n) => (Math.round(n * 10) / 10).toString().replace('.', ',');
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const round5 = (n) => Math.round(n / 5) * 5;
const round10 = (n) => Math.round(n / 10) * 10;

// "82,4 kg" · "9.800" · "1.234,5" · 512 → número
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MEALS = ['desayuno', 'almuerzo', 'comida', 'merienda', 'cena'];
function mealFor(d = new Date()) {
  const zp = zparts(d); const h = zp.h + zp.min / 60;
  if (h >= 5 && h < 11.5) return 'desayuno';
  if (h >= 11.5 && h < 16.5) return 'comida';
  if (h >= 16.5 && h < 20) return 'merienda';
  return 'cena';
}
function mealFromText(t) {
  const n = normalize(t);
  if (/\b(desayun\w*)\b/.test(n)) return 'desayuno';
  if (/\b(almuerz\w*|almorz\w*)\b/.test(n)) return 'almuerzo';
  if (/\b(merienda|merendar|merendado)\b/.test(n)) return 'merienda';
  if (/\b(cena|cenar|cenado)\b/.test(n)) return 'cena';
  if (/\b(para comer|de comida|a mediodia)\b/.test(n)) return 'comida';
  return null;
}

// ───────────────────────── base de alimentos (por 100 g) ─────────────────────────
// [nombre, alias separados por |, kcal, proteína, carbohidratos, grasa, gramos por unidad/ración]
const BASE_FOODS = [
  ["entrecot de ternera", "entrecot|entrecote|chuleton|lomo alto|ribeye", 220, 20, 0, 15.5, 250],
  ["solomillo de ternera", "solomillo|solomillo de vaca", 150, 21, 0, 7, 180],
  ["filete de ternera", "ternera|filete de vaca|vaca", 130, 21, 0, 5, 150],
  ["carne picada de ternera", "carne picada|picada de ternera|hamburguesa de ternera", 215, 18.6, 0, 15, 120],
  ["lomo de cerdo", "lomo|cinta de lomo", 143, 21, 0, 6.3, 120],
  ["pechuga de pollo", "pollo|pechuga|filete de pollo", 120, 22.5, 0, 2.6, 150],
  ["pechuga de pollo a la plancha", "pollo a la plancha|pechuga a la plancha|pollo cocinado", 165, 31, 0, 3.6, 120],
  ["muslo de pollo", "contramuslo|muslo", 177, 18, 0, 11.5, 120],
  ["pavo", "pechuga de pavo|filete de pavo", 114, 23.5, 0, 1.5, 150],
  ["jamon serrano", "serrano|jamon", 240, 30, 0, 13, 20],
  ["jamon cocido", "jamon york|york|jamon dulce", 110, 18, 1.5, 3.5, 20],
  ["salmon", "salmon fresco|lomo de salmon", 208, 20, 0, 13.4, 150],
  ["merluza", "pescadilla|bacalao fresco|pescado blanco", 86, 17, 0, 1.8, 150],
  ["atun en lata al natural", "atun al natural|atun natural", 116, 26, 0, 1, 56],
  ["atun en aceite", "atun en lata|atun", 198, 29, 0, 8.2, 56],
  ["gambas", "langostinos|gamba", 85, 20, 0, 0.5, 15],
  ["huevo", "huevo cocido|huevo duro", 143, 12.6, 0.7, 9.5, 55],
  ["huevo frito", "huevos fritos", 196, 13.6, 0.8, 15, 60],
  ["clara de huevo", "claras|clara", 52, 11, 0.7, 0.2, 33],
  ["tortilla de patatas", "tortilla|tortilla espanola|pincho de tortilla", 190, 6.5, 14, 12, 120],
  ["pan blanco", "pan|barra de pan|baguette|pan de barra|tostada|tostadas|bocadillo", 266, 8.5, 52, 1.6, 40],
  ["pan integral", "pan de molde integral|pan de centeno", 250, 9, 45, 3.5, 40],
  ["pan de molde", "pan bimbo|rebanada de pan de molde", 265, 8, 49, 4, 28],
  ["arroz cocido", "arroz blanco|arroz hervido|arroz", 130, 2.7, 28, 0.3, 200],
  ["arroz crudo", "arroz en crudo|arroz seco", 360, 7, 79, 0.6, 80],
  ["pasta cocida", "pasta|macarrones|espaguetis|espagueti|tallarines|spaghetti", 158, 5.8, 31, 0.9, 220],
  ["pasta cruda", "pasta en crudo|pasta seca|macarrones crudos", 371, 13, 75, 1.5, 80],
  ["copos de avena", "avena|porridge|gachas de avena", 379, 13, 67, 6.5, 40],
  ["lentejas cocidas", "lentejas|plato de lentejas", 116, 9, 20, 0.4, 300],
  ["garbanzos cocidos", "garbanzos|cocido", 164, 8.9, 27, 2.6, 300],
  ["alubias cocidas", "alubias|judias blancas|frijoles", 127, 8.7, 23, 0.5, 300],
  ["patata cocida", "patata|patatas cocidas|patata hervida|patatas", 87, 1.9, 20, 0.1, 150],
  ["patatas fritas", "patatas fritas caseras|fritas", 312, 3.4, 41, 15, 150],
  ["patatas fritas de bolsa", "patatas chips|chips", 536, 7, 53, 34, 30],
  ["platano", "banana|platano de canarias", 89, 1.1, 23, 0.3, 120],
  ["manzana", "manzanas", 52, 0.3, 14, 0.2, 180],
  ["naranja", "naranjas|mandarina", 47, 0.9, 12, 0.1, 150],
  ["fresas", "fresa|fresones", 32, 0.7, 7.7, 0.3, 12],
  ["kiwi", "kiwis", 61, 1.1, 15, 0.5, 75],
  ["aguacate", "palta", 160, 2, 8.5, 14.7, 150],
  ["tomate", "tomates|tomate natural", 18, 0.9, 3.9, 0.2, 120],
  ["lechuga", "ensalada verde|ensalada", 15, 1.4, 2.9, 0.2, 100],
  ["brocoli", "brecol", 34, 2.8, 7, 0.4, 150],
  ["verduras a la plancha", "verduras|parrillada de verduras|calabacin|berenjena", 35, 1.5, 6, 0.5, 200],
  ["leche entera", "leche", 64, 3.2, 4.7, 3.6, 250],
  ["leche semidesnatada", "leche semi", 46, 3.2, 4.7, 1.6, 250],
  ["leche desnatada", "leche desnatada", 35, 3.4, 5, 0.1, 250],
  ["cafe con leche semidesnatada", "cafe con leche|cortado|leche manchada", 30, 2, 3, 1, 200],
  ["cafe solo", "cafe|espresso|expreso|americano", 2, 0.1, 0, 0, 40],
  ["yogur natural", "yogur|yogurt", 61, 3.5, 4.7, 3.3, 125],
  ["yogur griego natural", "yogur griego|griego", 115, 4, 4, 9.5, 125],
  ["queso fresco", "queso de burgos|burgos", 175, 12.5, 3, 12.5, 60],
  ["queso fresco batido 0%", "queso batido|skyr|queso fresco batido", 50, 8, 4, 0.2, 125],
  ["queso curado", "queso manchego|manchego|queso", 420, 28, 0.5, 34, 30],
  ["aceite de oliva", "aceite|aove|aceite de oliva virgen extra", 884, 0, 0, 100, 10],
  ["mantequilla", "mantequilla", 717, 0.9, 0.1, 81, 10],
  ["almendras", "almendra|frutos secos", 579, 21, 22, 50, 30],
  ["nueces", "nuez", 654, 15, 14, 65, 30],
  ["crema de cacahuete", "mantequilla de cacahuete", 588, 25, 20, 50, 15],
  ["chocolate negro", "chocolate negro 70|chocolate", 598, 7.8, 46, 43, 20],
  ["azucar", "azucar blanco|sobre de azucar", 387, 0, 100, 0, 7],
  ["miel", "miel", 304, 0.3, 82, 0, 20],
  ["pizza", "porcion de pizza|pizza margarita", 266, 11, 33, 10, 110],
  ["hamburguesa completa", "burger|hamburguesa con pan", 250, 13, 24, 11, 220],
  ["cerveza", "cana|tercio|birra|cerveza con alcohol", 43, 0.5, 3.6, 0, 200],
  ["cerveza sin alcohol", "cerveza 0,0|cerveza 0 0|sin alcohol", 25, 0.3, 5.5, 0, 330],
  ["vino tinto", "vino|copa de vino|vino blanco", 85, 0.1, 2.6, 0, 150],
  ["coca-cola", "coca cola|cocacola|refresco de cola", 42, 0, 10.6, 0, 330],
  ["coca-cola zero", "coca cola zero|cola zero|refresco zero|cocacola zero", 0.3, 0, 0, 0, 330],
  ["zumo de naranja", "zumo|zumo natural", 45, 0.7, 10.4, 0.2, 200],
  ["proteina whey", "whey|batido de proteinas|proteina en polvo|scoop de proteina", 380, 78, 8, 5, 30],
  ["quinoa cocida", "quinoa|quinua", 120, 4.4, 21.3, 1.9, 180],
  ["cuscus cocido", "cuscus|couscous", 112, 3.8, 23, 0.2, 180],
  ["arroz integral cocido", "arroz integral", 123, 2.7, 25.6, 1, 200],
  ["boniato asado", "boniato|batata|moniato", 90, 2, 21, 0.2, 150],
  ["tortitas de arroz", "tortita de arroz|tortitas de maiz", 387, 8, 81, 3, 8],
  ["cereales de desayuno", "cereales|corn flakes|copos de maiz", 375, 7.5, 82, 2, 30],
  ["granola", "muesli", 471, 10, 64, 20, 40],
  ["galletas maria", "galleta|galletas|galleta maria", 436, 7, 75, 12, 6],
  ["croissant", "cruasan|croasan|napolitana", 406, 8, 46, 21, 60],
  ["magdalena", "magdalenas|muffin", 430, 6, 50, 23, 30],
  ["donut", "dónut|rosquilla", 420, 5, 50, 22, 60],
  ["pan tostado", "biscotes|biscote|pan tostado de paquete", 400, 11, 74, 6, 9],
  ["sardinas en aceite", "sardinas|lata de sardinas", 208, 24.6, 0, 11.5, 85],
  ["caballa", "caballa en aceite|melva", 205, 19, 0, 14, 100],
  ["lubina", "dorada|pescado a la plancha|corvina", 97, 18.5, 0, 2.5, 200],
  ["calamares a la romana", "calamares|rabas|chocos fritos", 220, 13, 15, 12, 150],
  ["pulpo", "pulpo a la gallega|pulpo cocido", 164, 30, 4.4, 2.1, 150],
  ["mejillones", "mejillon|mejillones al vapor", 172, 24, 7.4, 4.5, 150],
  ["chorizo", "chorizo iberico", 455, 24, 2, 38, 30],
  ["fuet", "salchichon|longaniza", 450, 26, 1.5, 38, 30],
  ["salchichas", "salchicha|frankfurt|perrito caliente", 290, 11, 2.5, 26, 40],
  ["bacon", "beicon|panceta", 450, 14, 1, 44, 20],
  ["albondigas", "albondigas en salsa|albondiga", 200, 12, 8, 13, 30],
  ["croquetas", "croqueta|croquetas de jamon|croquetas caseras", 250, 8, 22, 14, 30],
  ["paella", "paella mixta|paella de marisco|arroz con pollo", 150, 8, 20, 4.5, 350],
  ["gazpacho", "gazpacho andaluz", 45, 0.8, 4, 3, 250],
  ["salmorejo", "salmorejo cordobes", 100, 2, 9, 6.5, 250],
  ["ensaladilla rusa", "ensaladilla", 170, 3.5, 10, 13, 200],
  ["huevos revueltos", "revuelto|huevo revuelto|revuelto de huevo", 148, 10, 1.6, 11, 120],
  ["hummus", "humus", 166, 8, 14, 10, 30],
  ["guacamole", "guacamole", 150, 2, 8, 13, 50],
  ["pimiento", "pimientos|pimiento rojo|pimiento verde", 31, 1, 6, 0.3, 150],
  ["cebolla", "cebollas", 40, 1.1, 9.3, 0.1, 110],
  ["zanahoria", "zanahorias", 41, 0.9, 9.6, 0.2, 70],
  ["champinones", "champinon|setas", 22, 3.1, 3.3, 0.3, 100],
  ["espinacas", "espinaca|acelgas", 23, 2.9, 3.6, 0.4, 150],
  ["judias verdes", "judia verde|vainas", 31, 1.8, 7, 0.2, 200],
  ["pepino", "pepinos", 15, 0.7, 3.6, 0.1, 200],
  ["uvas", "uva", 69, 0.7, 18, 0.2, 150],
  ["pera", "peras", 57, 0.4, 15, 0.1, 170],
  ["melon", "tajada de melon", 34, 0.8, 8, 0.2, 200],
  ["sandia", "tajada de sandia", 30, 0.6, 7.6, 0.2, 300],
  ["pina", "pina natural", 50, 0.5, 13, 0.1, 150],
  ["mango", "mangos", 60, 0.8, 15, 0.4, 200],
  ["arandanos", "frutos rojos|frambuesas|moras", 57, 0.7, 14.5, 0.3, 100],
  ["datiles", "datil", 282, 2.5, 75, 0.4, 8],
  ["pasas", "uvas pasas|orejones", 299, 3, 79, 0.5, 30],
  ["cacahuetes", "cacahuete|mani", 567, 26, 16, 49, 30],
  ["pistachos", "pistacho", 560, 20, 28, 45, 30],
  ["anacardos", "anacardo", 553, 18, 30, 44, 30],
  ["bebida de avena", "leche de avena", 42, 0.3, 6.5, 1.5, 250],
  ["bebida de soja", "leche de soja", 39, 3.3, 2.5, 1.8, 250],
  ["kefir", "kéfir", 60, 3.5, 4.5, 3.2, 200],
  ["queso cottage", "cottage|requeson", 98, 11, 3.4, 4.3, 100],
  ["mozzarella", "mozzarella fresca|burrata", 250, 18, 2, 19, 125],
  ["queso de untar", "philadelphia|queso crema", 235, 6, 4, 22, 20],
  ["nata", "nata para cocinar|nata liquida", 300, 2.3, 3.5, 30, 15],
  ["mayonesa", "mahonesa|alioli", 680, 1, 1, 75, 15],
  ["ketchup", "catsup", 112, 1.2, 26, 0.1, 15],
  ["tomate frito", "salsa de tomate", 75, 1.5, 10, 3, 50],
  ["mermelada", "confitura", 250, 0.4, 62, 0, 15],
  ["crema de cacao", "nocilla|nutella", 539, 6.3, 57, 31, 15],
  ["cacao soluble", "cola cao|colacao|nesquik", 380, 6, 78, 3, 15],
  ["helado", "bola de helado|helados", 207, 3.5, 24, 11, 70],
  ["tarta", "pastel|bizcocho|tarta de queso|tarta de chocolate", 350, 5, 45, 17, 120],
  ["kebab", "doner|durum", 215, 12, 20, 10, 350],
  ["sushi", "maki|nigiri|piezas de sushi", 145, 5, 28, 1.5, 30],
  ["tofu", "tofu firme", 120, 13, 2, 7, 100],
  ["seitan", "seitán", 120, 23, 4, 2, 100],
  ["barrita proteica", "barrita de proteinas|barrita", 370, 30, 35, 12, 45],
  ["agua", "agua mineral|vaso de agua|agua con gas", 0, 0, 0, 0, 250],
  ["infusion", "te|manzanilla|poleo", 1, 0, 0.2, 0, 250],
  ["refresco de naranja", "fanta|fanta de naranja|fanta de limon|refresco", 40, 0, 10, 0, 330],
  ["bebida isotonica", "aquarius|powerade|isotonica", 24, 0, 6, 0, 330],
  ["bebida energetica", "red bull|monster", 45, 0, 11, 0, 250],
  ["gin tonic", "cubata|combinado|ron cola|whisky cola|copa de gin", 66, 0, 7, 0, 250],
];

function buildFoodIndex() {
  const byName = new Map();
  for (const [name, aliases, kcal, protein, carbs, fat, unit_g] of BASE_FOODS) {
    byName.set(normalize(name), { name, aliases, kcal, protein, carbs, fat, unit_g, source: 'base' });
  }
  // los tuyos (aprendidos/corregidos) mandan sobre la base
  for (const f of db.foods) byName.set(normalize(f.name), { ...byName.get(normalize(f.name)), ...f });
  return [...byName.values()].map(f => ({
    ...f,
    terms: [normalize(f.name), ...String(f.aliases || '').split('|').map(normalize)].filter(Boolean),
  }));
}
let FOODS = [];   // se construye en cada petición, al cargar tus datos

function learnFood(name, data, alias) {
  const n = normalize(name);
  let f = db.foods.find(x => normalize(x.name) === n);
  if (!f) {
    const base = FOODS.find(x => normalize(x.name) === n);
    f = { name: n, aliases: base ? base.aliases : '' };
    db.foods.push(f);
  }
  Object.assign(f, data);
  if (alias) {
    const a = normalize(alias);
    const list = String(f.aliases || '').split('|').filter(Boolean);
    if (a && a !== n && !list.includes(a)) { list.push(a); f.aliases = list.join('|'); }
  }
  f.updated = new Date().toISOString();
  save('foods', db.foods);
  FOODS = buildFoodIndex();
  return f;
}

// ───────────────────────── intérprete de comidas ─────────────────────────
const NUM_WORDS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, medio: 0.5, media: 0.5,
};
const WEIGHT_UNITS = {
  g: 1, gr: 1, grs: 1, gramo: 1, gramos: 1, kg: 1000, kilo: 1000, kilos: 1000,
  ml: 1, mililitros: 1, cl: 10, centilitros: 10, l: 1000, litro: 1000, litros: 1000,
};
const CONTAINERS = {
  vaso: 250, vasos: 250, taza: 200, tazas: 200, tazon: 300, tazones: 300,
  cucharada: 13, cucharadas: 13, cucharadita: 5, cucharaditas: 5,
  lata: 330, latas: 330, plato: 300, platos: 300, racion: 200, raciones: 200,
  porcion: 150, porciones: 150, rebanada: 30, rebanadas: 30, rodaja: 30, rodajas: 30,
  punado: 30, punados: 30, loncha: 20, lonchas: 20, filete: 150, filetes: 150,
  bol: 250, cuenco: 250, cana: 200, canas: 200, copa: 150, copas: 150, tercio: 330,
  botellin: 200, botella: 500, trozo: null, trozos: null, pieza: null, piezas: null, unidad: null, unidades: null,
};
const STOP = new Set(['de', 'del', 'con', 'a', 'al', 'la', 'el', 'los', 'las', 'en', 'y', 'sin', 'un', 'una']);
const contentWords = (s) => s.split(' ').filter(w => w && !STOP.has(w));

function splitItems(text) {
  let t = lowerClean(text);
  const FILLER = /^(he (comido|tomado|desayunado|cenado|merendado|bebido|almorzado)|me he (comido|tomado|bebido)|acabo de (comer|tomar|beber|cenar|desayunar)|registra(r)?|apunta(r)?|anota(r)?|añade|anade|para (desayunar|comer|cenar|merendar)|de (desayuno|comida|cena|merienda)|en el (desayuno|almuerzo)|en la (comida|cena|merienda))\b\s*/;
  for (let i = 0; i < 4; i++) t = t.replace(FILLER, '');
  t = t.replace(/\b(en el|en la|para el|para la|de|al?) (desayuno|almuerzo|comida|merienda|cena)\b/g, ' ');
  return t.split(/\s*(?:,|\+|\sy\s|\se\s|\smás\s|\smas\s|\sademás\s|\stambién\s)\s*/).map(s => s.trim()).filter(Boolean);
}

function parseItem(raw) {
  let s = raw.trim().replace(/^(y|e|tambien|también)\s+/, '');
  let qty = null; let unit = null;
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (m) { qty = parseFloat(m[1].replace(',', '.')); s = m[2]; }
  else {
    const w = s.split(' ')[0];
    if (normalize(w) in NUM_WORDS) { qty = NUM_WORDS[normalize(w)]; s = s.slice(w.length).trim(); }
  }
  const w2 = s.split(' ')[0];
  const u = normalize(w2);
  if (w2 && (u in WEIGHT_UNITS || u in CONTAINERS)) { unit = u; s = s.slice(w2.length).trim(); }
  s = s.replace(/^(y medio|y media)\s+/, () => { if (qty != null) qty += 0.5; return ''; });
  s = s.replace(/^de (la |el |los |las )?/, '').trim();
  if (!s && unit && unit in CONTAINERS) s = w2;   // "una caña", "una copa"
  return { qty, unit, name: s };
}

function gramsFor(p, food) {
  const unitG = food && food.unit_g ? Number(food.unit_g) : null;
  if (p.unit && p.unit in WEIGHT_UNITS) return (p.qty ?? 1) * WEIGHT_UNITS[p.unit];
  if (p.unit && p.unit in CONTAINERS) return (p.qty ?? 1) * (CONTAINERS[p.unit] ?? unitG ?? 100);
  if (p.qty != null) return p.qty >= 20 ? p.qty : p.qty * (unitG ?? 100);
  return unitG ?? 100;
}
const saidWeight = (p) => (p.unit && p.unit in WEIGHT_UNITS) || (p.qty != null && p.qty >= 20 && !p.unit);

// Busca en la base local. Acepta si el término empieza el nombre o cubre la mitad de sus palabras.
function matchLocalTerm(name, minCover = 0.5) {
  const norm = normalize(name);
  const n = ` ${norm} `;
  const nWords = contentWords(norm).length || 1;
  let best = null; let bestHit = null; let bestLen = 0;
  for (const f of FOODS) {
    for (const t of f.terms) {
      if (t.length <= bestLen) continue;
      let hit = null;
      if (n.includes(` ${t} `)) hit = t;
      else if (n.includes(` ${t}s `)) hit = `${t}s`;
      else if (n.includes(` ${t}es `)) hit = `${t}es`;
      if (!hit) continue;
      if (norm.startsWith(hit) || contentWords(t).length / nWords >= minCover) { best = f; bestHit = hit; bestLen = t.length; }
    }
  }
  return best ? { food: best, hit: bestHit } : null;
}
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function localResolve(p) {
  const norm = normalize(p.name);
  const whole = matchLocalTerm(p.name);
  // el nombre completo es un alimento ("café con leche", "entrecot de ternera")
  if (whole && (whole.hit.includes(' con ') || contentWords(whole.hit).length >= contentWords(norm).length)) {
    return [{ name: p.name, food: whole.food, grams: gramsFor(p, whole.food) }];
  }
  // "entrecot con patatas fritas": la cantidad es del principal; lo que va con "con" es guarnición
  if (/\scon\s/.test(` ${norm} `)) {
    const [head, ...tail] = p.name.split(/\s+con\s+/i);
    const mh = matchLocalTerm(head);
    if (mh) {
      const out = [{ name: head, food: mh.food, grams: gramsFor({ ...p, name: head }, mh.food) }];
      for (const t of tail) {
        const mt = matchLocalTerm(t);
        if (mt) out.push({ name: t, food: mt.food, grams: Number(mt.food.unit_g) || 100 });
      }
      return out;
    }
  }
  if (!whole) return null;
  return [{ name: p.name, food: whole.food, grams: gramsFor(p, whole.food) }];
}

// ───────────────────────── consultas externas (solo alimentos) ─────────────────────────
// Diccionario español → inglés para buscar en la USDA sin IA.
const ES_EN = {
  pollo: 'chicken', pechuga: 'breast', muslo: 'thigh', contramuslo: 'thigh', alitas: 'wing', ala: 'wing',
  ternera: 'beef', vaca: 'beef', buey: 'beef', cerdo: 'pork', cordero: 'lamb', conejo: 'rabbit', pavo: 'turkey',
  pato: 'duck', faisan: 'pheasant', codorniz: 'quail', perdiz: 'quail', jabali: 'wild boar', ciervo: 'venison',
  venado: 'venison', higado: 'liver', rinon: 'kidney', lomo: 'loin', solomillo: 'tenderloin', costilla: 'ribs',
  costillas: 'ribs', chuleta: 'chop', chuletas: 'chop', picada: 'ground', hamburguesa: 'ground', carrillada: 'cheek',
  secreto: 'pork shoulder', presa: 'pork shoulder', panceta: 'pork belly',
  salmon: 'salmon', atun: 'tuna', bonito: 'tuna', merluza: 'hake', bacalao: 'cod', sardina: 'sardine', sardinas: 'sardine',
  boqueron: 'anchovy', boquerones: 'anchovy', anchoa: 'anchovy', anchoas: 'anchovy', trucha: 'trout', lenguado: 'flatfish',
  rape: 'monkfish', rodaballo: 'turbot', emperador: 'swordfish', pez: 'fish', pescado: 'fish', gamba: 'shrimp',
  gambas: 'shrimp', langostino: 'shrimp', langostinos: 'shrimp', calamar: 'squid', calamares: 'squid', pulpo: 'octopus',
  sepia: 'cuttlefish', mejillon: 'mussel', mejillones: 'mussel', almeja: 'clam', almejas: 'clam', ostra: 'oyster',
  ostras: 'oyster', cangrejo: 'crab', langosta: 'lobster', vieira: 'scallop', vieiras: 'scallop',
  alcachofa: 'artichoke', alcachofas: 'artichoke', esparrago: 'asparagus', esparragos: 'asparagus', berenjena: 'eggplant',
  calabacin: 'zucchini', calabaza: 'pumpkin', coliflor: 'cauliflower', col: 'cabbage', repollo: 'cabbage',
  lombarda: 'red cabbage', puerro: 'leek', puerros: 'leek', apio: 'celery', ajo: 'garlic', cebolla: 'onion',
  pimiento: 'pepper', pimientos: 'pepper', pepino: 'cucumber', tomate: 'tomato', tomates: 'tomato', lechuga: 'lettuce',
  rucula: 'arugula', espinaca: 'spinach', espinacas: 'spinach', acelga: 'chard', acelgas: 'chard', judias: 'beans',
  guisantes: 'peas', guisante: 'peas', habas: 'broad beans', maiz: 'corn', remolacha: 'beet', rabano: 'radish',
  nabo: 'turnip', champinon: 'mushroom', champinones: 'mushroom', setas: 'mushroom', seta: 'mushroom',
  patata: 'potato', patatas: 'potato', boniato: 'sweet potato', zanahoria: 'carrot', zanahorias: 'carrot',
  aguacate: 'avocado', aceituna: 'olive', aceitunas: 'olive', garbanzos: 'chickpeas', garbanzo: 'chickpeas',
  lentejas: 'lentils', lenteja: 'lentils', alubias: 'beans', alubia: 'beans', soja: 'soybeans', edamame: 'edamame',
  manzana: 'apple', pera: 'pear', platano: 'banana', naranja: 'orange', mandarina: 'tangerine', limon: 'lemon',
  pomelo: 'grapefruit', fresa: 'strawberries', fresas: 'strawberries', cereza: 'cherries', cerezas: 'cherries',
  ciruela: 'plum', ciruelas: 'plum', melocoton: 'peach', albaricoque: 'apricot', nectarina: 'nectarine', uva: 'grapes',
  uvas: 'grapes', higo: 'figs', higos: 'figs', kiwi: 'kiwifruit', mango: 'mango', papaya: 'papaya', pina: 'pineapple',
  melon: 'melon', sandia: 'watermelon', granada: 'pomegranate', frambuesa: 'raspberries', frambuesas: 'raspberries',
  mora: 'blackberries', moras: 'blackberries', arandanos: 'blueberries', coco: 'coconut', datil: 'dates', datiles: 'dates',
  arroz: 'rice', pasta: 'pasta', espaguetis: 'spaghetti', macarrones: 'macaroni', fideos: 'noodles', pan: 'bread',
  harina: 'flour', avena: 'oats', quinoa: 'quinoa', cuscus: 'couscous', trigo: 'wheat', centeno: 'rye', cebada: 'barley',
  leche: 'milk', yogur: 'yogurt', queso: 'cheese', mantequilla: 'butter', nata: 'cream', huevo: 'egg', huevos: 'egg',
  clara: 'egg white', claras: 'egg white', yema: 'egg yolk',
  almendra: 'almonds', almendras: 'almonds', nuez: 'walnuts', nueces: 'walnuts', avellana: 'hazelnuts',
  avellanas: 'hazelnuts', cacahuete: 'peanuts', cacahuetes: 'peanuts', pistachos: 'pistachio', anacardos: 'cashew',
  pipas: 'sunflower seeds', semillas: 'seeds', chia: 'chia seeds', lino: 'flaxseed', sesamo: 'sesame',
  aceite: 'oil', oliva: 'olive', azucar: 'sugar', miel: 'honey', chocolate: 'chocolate', cacao: 'cocoa',
  cafe: 'coffee', te: 'tea', zumo: 'juice', vino: 'wine', cerveza: 'beer',
  // preparación
  crudo: 'raw', cruda: 'raw', cocido: 'cooked', cocida: 'cooked', hervido: 'boiled', hervida: 'boiled',
  asado: 'roasted', asada: 'roasted', plancha: 'grilled', frito: 'fried', frita: 'fried', fritos: 'fried', fritas: 'fried',
  horno: 'baked', parrilla: 'grilled', guisado: 'stewed', integral: 'whole wheat', desnatado: 'skim', desnatada: 'skim',
  entero: 'whole', entera: 'whole', natural: 'plain', ahumado: 'smoked', magro: 'lean', blanco: 'white', rojo: 'red',
  verde: 'green', dulce: 'sweet', lata: 'canned', conserva: 'canned', seco: 'dried', secos: 'dried',
};
const MEAT_FISH = new Set(['chicken', 'beef', 'pork', 'lamb', 'rabbit', 'turkey', 'duck', 'pheasant', 'quail', 'venison', 'salmon', 'tuna', 'hake', 'cod', 'trout', 'fish', 'monkfish', 'turbot', 'swordfish', 'flatfish']);

function toEnglish(name) {
  const words = contentWords(normalize(name));
  const en = []; let known = 0;
  for (const w of words) {
    const t = ES_EN[w] || (w.endsWith('s') ? ES_EN[w.slice(0, -1)] : null);
    if (t) { en.push(t); known++; }
  }
  if (!known || known < Math.ceil(words.length / 2)) return null;   // demasiado desconocido
  const q = [...new Set(en.join(' ').split(' '))];
  const hasMeat = q.some(w => MEAT_FISH.has(w));
  const hasPrep = q.some(w => ['raw', 'cooked', 'boiled', 'roasted', 'grilled', 'fried', 'baked', 'stewed', 'smoked', 'canned', 'dried'].includes(w));
  if (hasMeat && !hasPrep) q.push('raw');
  return q.join(' ');
}

async function httpJSON(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'NutriPersonal/1.0 (uso personal)' }, opts.headers || {}),
    body: opts.body,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function usdaSearch(query) {
  if (!CONFIG.USE_USDA || !query) return null;
  const key = db.settings.usda_key || (ENV && ENV.USDA_API_KEY) || 'DEMO_KEY';
  const data = await httpJSON(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, dataType: ['Foundation', 'SR Legacy'], pageSize: 10 }),
  });
  const PREP = new Set(['raw', 'cooked', 'boiled', 'roasted', 'grilled', 'fried', 'baked', 'stewed', 'smoked', 'canned', 'dried', 'whole', 'plain', 'lean', 'white', 'red', 'green', 'sweet', 'skim', 'wheat']);
  const words = query.split(' ');
  const main = words.filter(w => !PREP.has(w));
  let best = null; let bestScore = -Infinity;
  for (const food of (data && data.foods) || []) {
    const desc = String(food.description || '').toLowerCase();
    const has = (w) => desc.includes(w) || desc.includes(w.replace(/s$/, ''));
    const mainHits = main.filter(has).length;
    if (!mainHits || mainHits < Math.ceil(main.length / 2)) continue;   // el alimento principal tiene que aparecer
    const score = mainHits * 2 + words.filter(has).length - desc.split(',').length * 0.05;
    const get = (ids) => {
      for (const id of ids) {
        const n = (food.foodNutrients || []).find(x => x.nutrientId === id && (id !== 1008 || /kcal/i.test(x.unitName || 'kcal')));
        if (n && n.value != null) return Number(n.value);
      }
      return null;
    };
    const protein = get([1003]) ?? 0; const fat = get([1004]) ?? 0; const carbs = get([1005, 1050]) ?? 0;
    let kcal = get([1008, 2047, 2048]);
    if (kcal == null) kcal = protein * 4 + carbs * 4 + fat * 9;
    if (kcal > 0 && score > bestScore) { bestScore = score; best = { kcal, protein, carbs, fat, source: `USDA: ${food.description}` }; }
  }
  return best;
}

function offNutrients(p) {
  const n = p.nutriments || {};
  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n.energy_100g != null) kcal = n.energy_100g / 4.184;
  if (kcal == null) return null;
  return {
    kcal: Number(kcal), protein: Number(n.proteins_100g || 0), carbs: Number(n.carbohydrates_100g || 0),
    fat: Number(n.fat_100g || 0), unit_g: p.serving_quantity ? Number(p.serving_quantity) : null,
    label: p.product_name || null,
    source: `Open Food Facts: ${[p.product_name, p.brands].filter(Boolean).join(' · ')}`,
  };
}

async function offSearch(query) {
  if (!CONFIG.USE_OPEN_FOOD_FACTS || !query) return null;
  const u = 'https://world.openfoodfacts.org/cgi/search.pl?' + [
    ['search_terms', query], ['search_simple', '1'], ['action', 'process'], ['json', '1'],
    ['page_size', '8'], ['lc', 'es'], ['cc', 'es'], ['fields', 'code,product_name,brands,nutriments,serving_quantity'],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const data = await httpJSON(u);
  for (const p of (data && data.products) || []) {
    const f = offNutrients(p);
    if (f && f.kcal > 0) return f;
  }
  return null;
}

async function offBarcode(code) {
  const data = await httpJSON(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}?fields=code,product_name,brands,nutriments,serving_quantity`);
  return data && data.product ? offNutrients(data.product) : null;
}

async function externalResolve(name) {
  let f = null;
  const en = toEnglish(name);
  try { if (en) f = await usdaSearch(en); } catch (e) { f = null; }
  if (!f) { try { f = await offSearch(name); } catch (e) { f = null; } }
  if (!f) return null;
  return learnFood(name, { kcal: r1(f.kcal), protein: r1(f.protein), carbs: r1(f.carbs), fat: r1(f.fat), unit_g: f.unit_g || null, source: f.source });
}

// ───────────────────────── registro de comidas ─────────────────────────
function addEntries(items, raw, meal) {
  const day = today(); const ts = new Date().toISOString();
  const added = [];
  for (const it of items) {
    const k = it.grams / 100; const f = it.food;
    const e = {
      id: Date.now() + Math.floor(Math.random() * 1000) + added.length, day, ts, meal,
      name: it.name, grams: r0(it.grams), kcal: r0(f.kcal * k), protein: r1(f.protein * k),
      carbs: r1(f.carbs * k), fat: r1(f.fat * k), source: f.source || 'base', raw,
    };
    db.entries.push(e); added.push(e);
  }
  db.settings.last_raw = raw;
  db.settings.last_ids = added.map(e => e.id);
  persist('entries', 'settings');
  return added;
}

// Interpreta sin guardar (la app enseña la vista previa y tú confirmas)
async function resolveText(text) {
  const meal = mealFromText(text) || mealFor();
  const found = []; const missing = [];
  for (const raw of splitItems(text)) {
    const p = parseItem(raw);
    if (!p.name) continue;
    const local = localResolve(p);
    if (local) { found.push(...local); continue; }
    const food = await externalResolve(p.name);
    if (food) found.push({ name: p.name, food, grams: gramsFor(p, food) });
    else missing.push(p.name);
  }
  return { raw: text, meal, found, missing };
}

function notFoundMessage(missing) {
  return missing.length
    ? `No he encontrado ${missing.join(', ')}. Puedes añadirlo en Alimentos o decir: "añade alimento ${missing[0]}, 200 calorías, 10 de proteína, 20 de carbohidratos y 8 de grasa".`
    : 'No he entendido qué has comido.';
}

function commitResolved(r) {
  const added = addEntries(r.found, r.raw, r.meal);
  const s = summary();
  const parts = added.map(a => `${cap(a.name)}, ${fmt(a.grams)} gramos: ${fmt(a.kcal)} kilocalorías`);
  if (r.missing.length) parts.push(`No he encontrado ${r.missing.join(', ')}`);
  return `${parts.join('. ')}. ${s.speech}`;
}

async function logFood(text) {
  const r = await resolveText(text);
  if (!r.found.length) return notFoundMessage(r.missing);
  return commitResolved(r);
}

async function previewFood(text) {
  const r = await resolveText(text);
  if (!r.found.length) return notFoundMessage(r.missing);
  return { kind: 'preview', resolved: r };
}

function undoLast() {
  const ids = db.settings.last_ids || [];
  let removed = db.entries.filter(e => ids.includes(e.id));
  if (!removed.length && db.entries.length) removed = [db.entries[db.entries.length - 1]];
  if (!removed.length) return 'No hay nada que borrar.';
  const rm = new Set(removed.map(e => e.id));
  db.entries = db.entries.filter(e => !rm.has(e.id));
  db.settings.last_ids = [];
  persist('entries', 'settings');
  return `He borrado ${removed.map(e => e.name).join(', ')}. ${summary().speech}`;
}

// ───────────────────────── resumen ─────────────────────────
function latestMetric(key, maxDays = 3650) {
  const days = Object.keys(db.metrics).sort().reverse();
  const limit = daysAgo(maxDays);
  for (const d of days) {
    if (d < limit) break;
    if (db.metrics[d][key] != null) return { day: d, value: db.metrics[d][key] };
  }
  return null;
}

function summary(day = today()) {
  const g = db.goals;
  const list = db.entries.filter(e => e.day === day);
  const tot = list.reduce((a, e) => ({ kcal: a.kcal + e.kcal, protein: a.protein + e.protein, carbs: a.carbs + e.carbs, fat: a.fat + e.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const m = db.metrics[day] || {};
  const budget = g.kcal + (g.add_active && m.active_kcal ? m.active_kcal : 0);
  const remaining = { kcal: r0(budget - tot.kcal), protein: r1(g.protein - tot.protein), carbs: r1(g.carbs - tot.carbs), fat: r1(g.fat - tot.fat) };
  let speech = remaining.kcal >= 0
    ? `Llevas ${fmt(tot.kcal)} de ${fmt(budget)}. Te quedan ${fmt(remaining.kcal)} kilocalorías${remaining.protein > 0 ? ` y ${fmt(remaining.protein)} gramos de proteína` : ''}.`
    : `Llevas ${fmt(tot.kcal)} kilocalorías, ${fmt(-remaining.kcal)} por encima del objetivo de hoy.`;
  if (g.provisional) speech += ' Tu objetivo aún es provisional: di "diagnóstico" para calcular el tuyo.';
  return {
    day, budget: r0(budget), entries: list, speech,
    consumed: { kcal: r0(tot.kcal), protein: r1(tot.protein), carbs: r1(tot.carbs), fat: r1(tot.fat) }, remaining,
    pct: {
      kcal: budget ? tot.kcal / budget : 0, protein: g.protein ? tot.protein / g.protein : 0,
      carbs: g.carbs ? tot.carbs / g.carbs : 0, fat: g.fat ? tot.fat / g.fat : 0,
    },
  };
}

function weekly() {
  const days = []; for (let i = 1; i <= 7; i++) days.push(daysAgo(i));
  const totals = days.map(d => db.entries.filter(e => e.day === d).reduce((a, e) => ({ kcal: a.kcal + e.kcal, protein: a.protein + e.protein }), { kcal: 0, protein: 0 }));
  const logged = totals.filter(t => t.kcal >= 800);
  if (!logged.length) return 'No tengo días completos registrados en la última semana.';
  const avgK = logged.reduce((a, t) => a + t.kcal, 0) / logged.length;
  const avgP = logged.reduce((a, t) => a + t.protein, 0) / logged.length;
  let s = `Últimos 7 días: ${logged.length} días registrados, media de ${fmt(avgK)} kilocalorías y ${fmt(avgP)} gramos de proteína. Tu objetivo es ${fmt(db.goals.kcal)}.`;
  const now = latestMetric('weight', 3); const before = latestMetric('weight', 3650);
  const old = Object.keys(db.metrics).sort().filter(d => d <= daysAgo(6) && db.metrics[d].weight != null).pop();
  if (now && old) {
    const diff = now.value - db.metrics[old].weight;
    s += ` Peso: ${f1(now.value)} kilos, ${diff <= 0 ? 'bajando' : 'subiendo'} ${f1(Math.abs(diff))} desde el ${old.slice(8)}/${old.slice(5, 7)}.`;
  } else if (before) s += ` Último peso: ${f1(before.value)} kilos.`;
  return s;
}

// ───────────────────────── medidas corporales ─────────────────────────
function setMetrics(values, day = today()) {
  const m = db.metrics[day] || {};
  for (const [k, v] of Object.entries(values)) if (v != null && Number.isFinite(v)) m[k] = v;
  db.metrics[day] = m;
  save('metrics', db.metrics);
  return m;
}

function weightMessage(w) {
  const old = Object.keys(db.metrics).sort().filter(d => d <= daysAgo(6) && db.metrics[d].weight != null).pop();
  let s = `Peso guardado: ${f1(w)} kilos.`;
  if (old) {
    const diff = w - db.metrics[old].weight;
    s += ` El ${old.slice(8)}/${old.slice(5, 7)} pesabas ${f1(db.metrics[old].weight)}: ${diff <= 0 ? 'menos' : 'más'} ${f1(Math.abs(diff))}.`;
  }
  return s;
}

function parseMetricsText(t) {
  const n = ' ' + normNum(t) + ' ';
  const out = {};
  let m;
  if ((m = n.match(/\b(?:peso|pesaba|me he pesado|he pesado|hoy peso|pesando)\s*(?:de\s*)?(\d{2,3}(?:\.\d{1,2})?)/))) out.weight = Number(m[1]);
  else if ((m = n.match(/^\s*(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|kilos)\s*$/))) out.weight = Number(m[1]);
  if ((m = n.match(/\bgrasa(?: corporal)?\s*(?:de\s*)?(\d{1,2}(?:\.\d)?)/))) out.body_fat = Number(m[1]);
  if ((m = n.match(/\bcintura\s*(?:de\s*)?(\d{2,3}(?:\.\d)?)/))) out.waist = Number(m[1]);
  if ((m = n.match(/\bgrasa visceral\s*(?:de\s*)?(\d{1,2}(?:\.\d)?)/))) { out.visceral = Number(m[1]); if (out.body_fat === out.visceral) delete out.body_fat; }
  if ((m = n.match(/\bmusculo\s*(?:de\s*)?(\d{1,3}(?:\.\d)?)/))) out.muscle = Number(m[1]);
  return out;
}

// Datos que manda el atajo "Nutri Salud" (Zepp Life → Salud → atajo)
function saveHealth(p) {
  let bf = numOrNull(p.grasa ?? p.body_fat);
  if (bf != null && bf > 0 && bf < 1) bf = bf * 100;              // Salud puede darlo como fracción
  const vals = {
    weight: numOrNull(p.peso ?? p.weight), body_fat: bf, bmi: numOrNull(p.imc ?? p.bmi),
    lean_mass: numOrNull(p.masa_magra ?? p.lean_mass), active_kcal: numOrNull(p.energia_activa ?? p.active_kcal),
    resting_kcal: numOrNull(p.energia_reposo ?? p.resting_kcal), steps: numOrNull(p.pasos ?? p.steps),
  };
  setMetrics(vals);
  db.settings.health_synced = new Date().toISOString(); save('settings', db.settings);
  const got = Object.entries(vals).filter(([, v]) => v != null).map(([k]) => k);
  return got.length ? `Datos de Salud guardados (${got.length}).` : 'No he recibido datos de Salud.';
}

// CSV exportado por Zepp Life (Perfil ▸ Ajustes ▸ … ▸ Exportar datos), archivo BODY
function importZeppCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { count: 0, msg: 'El archivo está vacío.' };
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const head = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const col = (...keys) => { for (const k of keys) { const i = head.findIndex(h => h === k); if (i >= 0) return i; } for (const k of keys) { const i = head.findIndex(h => h.includes(k)); if (i >= 0) return i; } return -1; };
  const C = {
    time: col('time', 'timestamp', 'date', 'fecha'),
    weight: col('weight', 'peso'),
    bmi: col('bmi', 'imc'),
    visceral: col('visceralfat', 'visceral'),
    fat: col('fatrate', 'bodyfat', 'body fat', 'fat', 'grasa'),
    muscle: col('musclerate', 'musclemass', 'muscle', 'musculo'),
    water: col('bodywaterrate', 'water', 'agua'),
    bone: col('bonemass', 'bone', 'hueso'),
    bmr: col('metabolism', 'bmr', 'basal'),
  };
  if (C.fat === C.visceral) C.fat = head.findIndex((h, i) => i !== C.visceral && /fat|grasa/.test(h));
  if (C.weight < 0) return { count: 0, msg: 'No encuentro la columna de peso en el archivo.' };
  let count = 0; let lastDay = null;
  const rows = lines.slice(1).map(l => l.split(sep).map(x => x.trim().replace(/^"|"$/g, '')));
  rows.sort((a, b) => String(a[C.time]).localeCompare(String(b[C.time])));
  for (const r of rows) {
    const w = numOrNull(r[C.weight]);
    if (!w || w < 20) continue;
    let d = null; const tv = r[C.time];
    if (/^\d{9,13}$/.test(tv || '')) d = new Date(Number(tv) * (tv.length > 10 ? 1 : 1000));
    else if (tv) d = new Date(String(tv).replace(' ', 'T').replace(/\+0000$/, 'Z'));
    if (!d || isNaN(d)) continue;
    const g = (i) => (i >= 0 ? numOrNull(r[i]) : null);
    const nz = (v) => (v ? v : null);
    setMetricsQuiet(dayOf(d), {
      weight: w, bmi: nz(g(C.bmi)), body_fat: nz(g(C.fat)), muscle: nz(g(C.muscle)), water: nz(g(C.water)),
      bone: nz(g(C.bone)), visceral: nz(g(C.visceral)), bmr_scale: nz(g(C.bmr)),
    });
    count++; lastDay = dayOf(d);
  }
  save('metrics', db.metrics);
  return { count, lastDay, msg: count ? `Importadas ${count} mediciones de Zepp Life (la última, del ${lastDay}).` : 'No he encontrado mediciones válidas.' };
}
function setMetricsQuiet(day, values) {
  const m = db.metrics[day] || {};
  for (const [k, v] of Object.entries(values)) if (v != null && Number.isFinite(v)) m[k] = v;
  db.metrics[day] = m;
}

// ───────────────────────── diagnóstico (fórmulas) ─────────────────────────
const ACTIVITY = {
  sedentario: { f: 1.2, label: 'sedentario' },
  ligero: { f: 1.375, label: 'ligero (1-3 entrenos/semana)' },
  moderado: { f: 1.55, label: 'moderado (3-5 entrenos/semana)' },
  activo: { f: 1.725, label: 'activo (6-7 entrenos/semana)' },
  muy_activo: { f: 1.9, label: 'muy activo' },
};
const RATE_WORDS = { suave: 0.25, lento: 0.25, normal: 0.5, moderado: 0.5, rapido: 0.75, agresivo: 0.75 };

function parseQuickProfile(text) {
  let t = ' ' + String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2').replace(/[;:]/g, ' ').replace(/\s+/g, ' ') + ' ';
  t = t.replace(/\bmedio kilo\b/g, '0.5 kilos').replace(/\bun kilo\b/g, '1 kilos').replace(/\bcuarto de kilo\b/g, '0.25 kilos');
  const out = {};
  const take = (re, fn) => { const m = t.match(re); if (!m) return false; if (fn(m) === false) return false; t = t.replace(m[0], ' '); return true; };
  const num = (x) => parseFloat(x);
  take(/\b(hombre|varon|masculino|chico)\b/, () => { out.sex = 'h'; }) || take(/\b(mujer|femenino|chica)\b/, () => { out.sex = 'm'; });
  take(/\b(?:objetivo|meta|quiero pesar|llegar a|bajar a|hasta)\s*(?:de\s*)?(\d{2,3}(?:\.\d)?)\s*(?:kg|kilos)?\b/, m => { out.target_weight = num(m[1]); });
  take(/\b(?:bajar|perder|quitarme|adelgazar)\s*(\d{1,2}(?:\.\d)?)\s*(?:kg|kilos)\b/, m => { out.lose_kg = num(m[1]); });
  take(/\b(\d(?:\.\d{1,2})?)\s*(?:kg|kilos)?\s*(?:por|a la|cada|\/)\s*semana\b/, m => { out.rate_kg = num(m[1]); });
  take(/\britmo\s*(suave|lento|normal|moderado|rapido|agresivo)\b/, m => { out.rate_pct = RATE_WORDS[m[1]]; });
  take(/\bcintura\s*(?:de\s*)?(\d{2,3}(?:\.\d)?)\s*(?:cm)?\b/, m => { out.waist = num(m[1]); });
  take(/\b(?:grasa(?: corporal)?|bf)\s*(?:de\s*|del\s*)?(\d{1,2}(?:\.\d)?)\s*(?:%|por ciento)?/, m => { out.body_fat = num(m[1]); }) ||
    take(/\b(\d{1,2}(?:\.\d)?)\s*(?:%|por ciento)(?:\s*de)?(?:\s*grasa)?/, m => { out.body_fat = num(m[1]); });
  take(/\b(\d{2})\s*anos\b/, m => { out.age = num(m[1]); }) || take(/\bedad\s*(?:de\s*)?(\d{2})\b/, m => { out.age = num(m[1]); });
  take(/\b(\d{3})\s*(?:cm|centimetros)\b/, m => { out.height = num(m[1]); }) ||
    take(/\bmido\s*(1\.\d{1,2}|\d{3})\b/, m => { const v = num(m[1]); out.height = v < 3 ? Math.round(v * 100) : v; }) ||
    take(/\b(1\.\d{1,2}|2\.[0-2]\d?)\s*(?:m\b|metros\b)/, m => { out.height = Math.round(num(m[1]) * 100); }) ||
    take(/\b(1\.[4-9]\d)\b/, m => { out.height = Math.round(num(m[1]) * 100); });
  take(/\b(\d{2,3}(?:\.\d)?)\s*(?:kg|kilos|kilogramos)\b/, m => { out.weight = num(m[1]); }) ||
    take(/\b(?:peso|pesando)\s*(?:de\s*)?(\d{2,3}(?:\.\d)?)\b/, m => { out.weight = num(m[1]); });
  take(/\bmuy activ[oa]\b/, () => { out.activity = 'muy_activo'; }) ||
    take(/\b(sedentari[oa]|nada activ[oa]|trabajo de oficina)\b/, () => { out.activity = 'sedentario'; }) ||
    take(/\b(poco activ[oa]|ligero|ligera|ligeramente activ[oa]|algo activ[oa])\b/, () => { out.activity = 'ligero'; }) ||
    take(/\b(moderad[oa]|moderadamente activ[oa])\b/, () => { out.activity = 'moderado'; }) ||
    take(/\b(bastante activ[oa]|activ[oa])\b/, () => { out.activity = 'activo'; });
  if (!out.activity) {
    const TRAIN = '(?:entreno|entrenamiento|entrenar|gimnasio|gym|deporte|ejercicio)';
    take(new RegExp(`\\b(?:${TRAIN}\\s*)?(\\d)\\s*(?:dias|veces)\\b(?:\\s*(?:a la|por|a|cada|\\/)\\s*semana)?(?:\\s*(?:de\\s*)?${TRAIN})?`), m => {
      if (!/entren|gimnas|gym|deporte|ejercicio|semana/.test(m[0])) return false;
      const d = num(m[1]);
      out.activity = d === 0 ? 'sedentario' : d <= 2 ? 'ligero' : d <= 4 ? 'moderado' : d <= 6 ? 'activo' : 'muy_activo';
    });
  }
  const nums = (t.match(/\b\d{2,3}(?:\.\d)?\b/g) || []).map(Number);
  const rest = [];
  for (const n of nums) { if (!out.height && Number.isInteger(n) && n >= 140 && n <= 230) out.height = n; else rest.push(n); }
  for (const n of rest) {
    if (!out.age && n >= 16 && n <= 99 && Number.isInteger(n) && (out.weight || rest.length > 1)) { out.age = n; continue; }
    if (!out.weight && n >= 35 && n <= 300) { out.weight = n; continue; }
    if (!out.age && n >= 16 && n <= 99 && Number.isInteger(n)) out.age = n;
  }
  return out;
}

// Gasto real: ingesta media − tendencia de peso × 7.700 (≥10 días completos y ≥4 pesajes en ≥14 días)
function adaptiveTdee(days = 28) {
  const from = daysAgo(days); const to = today();
  const byDay = {};
  for (const e of db.entries) if (e.day >= from && e.day < to) byDay[e.day] = (byDay[e.day] || 0) + e.kcal;
  const full = Object.values(byDay).filter(k => k >= 800);
  const ws = Object.keys(db.metrics).sort().filter(d => d >= from && db.metrics[d].weight != null).map(d => ({ d, w: db.metrics[d].weight }));
  if (full.length < 10 || ws.length < 4) return null;
  const t0 = Date.parse(ws[0].d);
  const xs = ws.map(x => (Date.parse(x.d) - t0) / 86400000); const ys = ws.map(x => x.w);
  if (xs[xs.length - 1] < 14) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0; let den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const avg = full.reduce((a, b) => a + b, 0) / full.length;
  const tdee = avg - slope * 7700;
  if (tdee < 1200 || tdee > 5000) return null;
  return { tdee: r0(tdee), avg_intake: r0(avg), kg_per_week: Math.round(slope * 7 * 100) / 100, logged_days: full.length, weigh_ins: ws.length };
}

function diagnose(pf, scale, adaptive) {
  const h = pf.height / 100; const w = pf.weight; const male = pf.sex === 'h';
  const notes = [];
  const bmi = w / (h * h);
  const bmiCat = bmi < 18.5 ? 'bajo peso' : bmi < 25 ? 'normal' : bmi < 30 ? 'sobrepeso' : bmi < 35 ? 'obesidad grado I' : bmi < 40 ? 'obesidad grado II' : 'obesidad grado III';
  const measured = pf.body_fat != null;
  let bf = pf.body_fat; let bfSource = scale.body_fat_from || 'medido';
  if (!measured && pf.waist) { bf = 64 - 20 * (pf.height / pf.waist) + (male ? 0 : 12); bfSource = 'estimado por cintura (RFM)'; }
  if (bf == null) { bf = 1.2 * bmi + 0.23 * pf.age - 10.8 * (male ? 1 : 0) - 5.4; bfSource = 'estimado por IMC (Deurenberg), orientativo'; }
  const lbm = w * (1 - bf / 100);
  const bmrMifflin = 10 * w + 6.25 * pf.height - 5 * pf.age + (male ? 5 : -161);
  const bmrKatch = 370 + 21.6 * lbm;
  const bmr = measured ? (bmrMifflin + bmrKatch) / 2 : bmrMifflin;
  const actKey = ACTIVITY[pf.activity] ? pf.activity : 'ligero';
  if (!ACTIVITY[pf.activity]) notes.push('No dijiste tu actividad; uso "ligero".');
  const tdeeFormula = bmr * ACTIVITY[actKey].f;
  let tdee = tdeeFormula; let tdeeSource = `fórmula, actividad ${ACTIVITY[actKey].label}`;
  if (adaptive) { tdee = adaptive.tdee; tdeeSource = `real, con ${adaptive.logged_days} días registrados y ${adaptive.weigh_ins} pesajes`; }

  const floor = Math.max(male ? 1500 : 1200, bmr);
  const rateWanted = pf.rate_kg != null ? pf.rate_kg : w * (pf.rate_pct != null ? pf.rate_pct : 0.5) / 100;
  let deficit = rateWanted * 7700 / 7;
  const maxDeficit = Math.max(0, Math.min(0.25 * tdee, tdee - floor));
  if (bmi < 18.5) {
    deficit = 0;
    notes.push('Con un IMC por debajo de 18,5 no propongo déficit: quedas en mantenimiento. Si quieres cambiar tu composición corporal, mejor con un profesional.');
  } else if (deficit > maxDeficit) {
    deficit = maxDeficit;
    notes.push(`El ritmo pedido exigía un déficit demasiado grande; lo limito para no bajar del 25 % de tu gasto ni de tu metabolismo basal (${fmt(floor)}).`);
  }
  const kcal = round10(tdee - deficit);
  const rateKg = deficit * 7 / 7700;

  const refW = bmi > 25 ? 25 * h * h : w;
  let protein = measured ? 2.2 * lbm : (bmi > 25 ? 2.0 * refW : 1.8 * w);
  protein = round5(Math.min(protein, 2.4 * w));
  let fat = Math.round(Math.max(0.25 * kcal / 9, 0.7 * refW));
  let carbs = (kcal - protein * 4 - fat * 9) / 4;
  if (carbs < 80) { fat = Math.round(Math.max(0.2 * kcal / 9, 0.6 * refW)); carbs = (kcal - protein * 4 - fat * 9) / 4; }
  carbs = Math.max(0, round5(carbs));

  let target = pf.target_weight != null ? pf.target_weight : null;
  const minHealthy = Math.ceil(18.5 * h * h);
  if (target != null && target < minHealthy) { notes.push(`Tu peso objetivo daría un IMC por debajo de 18,5; lo calculo con ${minHealthy} kilos.`); target = minHealthy; }
  let weeks = null; let eta = null;
  if (target != null && target < w && rateKg > 0) {
    weeks = Math.ceil(((w - target) / rateKg) * 1.15);
    eta = dayOf(new Date(Date.now() + weeks * 7 * 86400000));
  }
  const whtr = pf.waist ? pf.waist / pf.height : null;
  const visceralCat = scale.visceral != null ? (scale.visceral <= 9 ? 'normal' : scale.visceral <= 14 ? 'alta' : 'muy alta') : null;

  return {
    bmi: r1(bmi), bmi_category: bmiCat, body_fat: r1(bf), body_fat_measured: measured, body_fat_source: bfSource,
    lean_mass: r1(lbm), bmr: r0(bmr), bmr_mifflin: r0(bmrMifflin), bmr_katch: measured ? r0(bmrKatch) : null,
    bmr_scale: scale.bmr_scale ?? null, tdee: r0(tdee), tdee_formula: r0(tdeeFormula), tdee_source: tdeeSource,
    adaptive, target_kcal: kcal, deficit: r0(deficit), rate_kg_week: Math.round(rateKg * 100) / 100,
    macros: { protein, carbs, fat }, water_l: r1(0.035 * w), fiber_g: Math.round(14 * kcal / 1000),
    target_weight: target, weeks, eta,
    waist_height: whtr ? Math.round(whtr * 100) / 100 : null,
    waist_risk: whtr ? (whtr >= 0.6 ? 'alto' : whtr >= 0.5 ? 'aumentado' : 'bajo') : null,
    visceral: scale.visceral ?? null, visceral_category: visceralCat,
    muscle: scale.muscle ?? null, water_pct: scale.water ?? null, notes,
  };
}

function runDiagnosis(text, apply = true) {
  const q = parseQuickProfile(text);
  const st = db.profile;
  const wLatest = latestMetric('weight', 30);
  const bfLatest = latestMetric('body_fat', 30);
  const pf = {
    sex: q.sex || st.sex || null,
    age: q.age || st.age || null,
    height: q.height || st.height || null,
    weight: q.weight || (wLatest && wLatest.value) || st.weight || null,
    body_fat: q.body_fat ?? (bfLatest ? bfLatest.value : null),
    waist: q.waist || (latestMetric('waist', 60) || {}).value || st.waist || null,
    activity: q.activity || st.activity || null,
    rate_kg: q.rate_kg ?? (q.rate_pct != null ? null : st.rate_kg ?? null),
    rate_pct: q.rate_pct ?? (q.rate_kg != null ? null : st.rate_pct ?? null),
    target_weight: q.target_weight ?? st.target_weight ?? null,
  };
  if (q.lose_kg && pf.weight && q.target_weight == null) pf.target_weight = Math.round((pf.weight - q.lose_kg) * 10) / 10;

  const missing = [];
  if (!pf.sex) missing.push('si eres hombre o mujer');
  if (!pf.age) missing.push('edad');
  if (!pf.height) missing.push('altura');
  if (!pf.weight) missing.push('peso');
  if (missing.length) return `Para el diagnóstico me falta: ${missing.join(', ')}. Di por ejemplo: diagnóstico, hombre, 34 años, 180 centímetros, 82 kilos, moderado, objetivo 75.`;
  if (pf.age < 18) return 'Estas fórmulas están pensadas para adultos. Para menores de 18 años, mejor que lo valore un profesional sanitario.';

  db.profile = { ...st, ...pf, updated: new Date().toISOString() };
  save('profile', db.profile);
  if (q.weight) setMetrics({ weight: q.weight });
  if (q.body_fat != null) setMetrics({ body_fat: q.body_fat });
  if (q.waist) setMetrics({ waist: q.waist });

  const scaleDay = Object.keys(db.metrics).sort().reverse().find(d => d >= daysAgo(30) && (db.metrics[d].visceral != null || db.metrics[d].muscle != null || db.metrics[d].bmr_scale != null));
  const scale = scaleDay ? { ...db.metrics[scaleDay] } : {};
  scale.body_fat_from = q.body_fat != null ? 'dicho por ti' : (bfLatest ? `báscula (${bfLatest.day})` : null);
  const d = diagnose(pf, scale, adaptiveTdee());
  db.settings.last_diagnosis = { ...d, at: new Date().toISOString() };
  save('settings', db.settings);
  if (apply) { db.goals = { kcal: d.target_kcal, protein: d.macros.protein, carbs: d.macros.carbs, fat: d.macros.fat, add_active: !!db.goals.add_active }; save('goals', db.goals); }

  let s = `IMC ${f1(d.bmi)}, ${d.bmi_category}. Grasa ${f1(d.body_fat)} por ciento${d.body_fat_measured ? '' : ' aproximado'}. `;
  if (d.visceral != null) s += `Grasa visceral ${f1(d.visceral)}, ${d.visceral_category}. `;
  if (d.waist_risk) s += `Cintura y altura: riesgo ${d.waist_risk}. `;
  s += `Gasto diario ${d.adaptive ? 'real' : 'estimado'} ${fmt(d.tdee)} kilocalorías. `;
  s += d.deficit > 0 ? `Para perder unos ${f1(d.rate_kg_week)} kilos por semana: ${fmt(d.target_kcal)} kilocalorías, ` : `Mantenimiento: ${fmt(d.target_kcal)} kilocalorías, `;
  s += `${d.macros.protein} gramos de proteína, ${d.macros.carbs} de carbohidratos y ${d.macros.fat} de grasa. `;
  if (d.weeks) s += `A ${f1(d.target_weight)} kilos llegarías en unas ${d.weeks} semanas. `;
  if (d.notes.length) s += d.notes.join(' ') + ' ';
  s += apply ? 'Objetivos guardados.' : 'No he cambiado tus objetivos.';
  return s;
}

// ───────────────────────── tu base de alimentos por voz ─────────────────────────
function addFoodByVoice(text) {
  const n = normNum(text);
  const m = n.match(/^(?:anade|añade|crea|nuevo)\s+alimento\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:kcal|calorias|kilocalorias)/);
  if (!m) return null;
  const name = m[1].replace(/\s+(con|de)$/, '').trim();
  const get = (re) => { const x = n.match(re); return x ? Number(x[1]) : 0; };
  const data = {
    kcal: Number(m[2]),
    protein: get(/(\d+(?:\.\d+)?)\s*(?:g\s*)?(?:de\s*)?proteinas?/),
    carbs: get(/(\d+(?:\.\d+)?)\s*(?:g\s*)?(?:de\s*)?(?:carbohidratos|hidratos)/),
    fat: get(/(\d+(?:\.\d+)?)\s*(?:g\s*)?(?:de\s*)?grasas?/),
    source: 'tuyo',
  };
  const unit = n.match(/(?:racion|unidad|pieza) de (\d+)\s*(?:g|gramos)/);
  if (unit) data.unit_g = Number(unit[1]);
  learnFood(name, data);
  return `Guardado ${name}: ${fmt(data.kcal)} kilocalorías por 100 gramos${data.protein ? `, ${f1(data.protein)} de proteína` : ''}.`;
}

function correctFood(text) {
  const n = normNum(text);
  const m = n.match(/^(?:corrige|cambia|actualiza)\s+(?:el |la |los |las )?(.+?)\s+(?:a\s+|tiene\s+|son\s+)?(\d+(?:\.\d+)?)\s*(?:kcal|calorias|kilocalorias)/);
  if (!m) return null;
  const name = m[1].trim(); const kcal = Number(m[2]);
  const hit = matchLocalTerm(name);
  const base = hit ? hit.food : null;
  const k = base && base.kcal ? kcal / base.kcal : 1;
  learnFood(base ? base.name : name, {
    kcal, protein: base ? r1(base.protein * k) : 0, carbs: base ? r1(base.carbs * k) : 0, fat: base ? r1(base.fat * k) : 0,
    unit_g: base ? base.unit_g : null, source: 'corregido por ti',
  });
  return `Corregido: ${base ? base.name : name} tiene ahora ${fmt(kcal)} kilocalorías por 100 gramos.`;
}

// ───────────────────────── enrutador: qué hacer con lo que dices ─────────────────────────
async function route(raw, opts = {}) {
  const text = String(raw || '').trim();
  const n = normNum(text);
  if (!n) return 'No te he oído. Dime qué has comido, tu peso, o pregunta cuánto te queda.';

  if (/^(ayuda|que puedes hacer|que se hacer)\b/.test(n)) {
    return 'Puedes decir lo que has comido, "peso 82,4", "cuánto me queda", "resumen de la semana", "borra lo último", "diagnóstico" con tus datos, "guarda como" y un nombre para repetir la última comida, o "corrige" un alimento con sus calorías.';
  }
  if (/^(borra|borrar|deshaz|deshacer|elimina|quita)\b|me he equivocado/.test(n)) return undoLast();
  if (/\b(semana|semanal)\b/.test(n) && /\b(resumen|como voy|balance|media)\b/.test(n)) return weekly();
  if (/(cuanto me queda|que me queda|cuantas calorias llevo|cuanto llevo|como voy|balance|resumen)/.test(n)) return summary().speech;
  if (/^(diagnostico|recalcula|recalcular|calcula mis objetivos|mis objetivos)/.test(n) ||
      (/\b(hombre|mujer)\b/.test(n) && /\b(anos|cm|centimetros|mido)\b/.test(n))) {
    return runDiagnosis(text.replace(/^\s*(diagn[oó]stico|recalcular?|calcula mis objetivos|mis objetivos)[,:]?\s*/i, ''));
  }
  const goal = n.match(/^(?:objetivo|ponme|pon el objetivo en)\s*(?:de\s*)?(\d{3,4})\s*(?:kcal|calorias|kilocalorias)/);
  if (goal) {
    const kcal = Number(goal[1]); const g = db.goals;
    const carbs = Math.max(0, round5((kcal - g.protein * 4 - g.fat * 9) / 4));
    db.goals = { ...g, kcal, carbs, provisional: false }; save('goals', db.goals);
    return `Objetivo guardado: ${fmt(kcal)} kilocalorías, manteniendo ${g.protein} gramos de proteína y ${g.fat} de grasa.`;
  }
  const save1 = n.match(/^guarda(?:lo)?\s+como\s+(.+)$/);
  if (save1) {
    if (!db.settings.last_raw) return 'Todavía no has registrado nada que guardar.';
    db.presets[save1[1].trim()] = db.settings.last_raw; save('presets', db.presets);
    return `Guardado. Cuando digas "${save1[1].trim()}", registraré: ${db.settings.last_raw}.`;
  }
  if (/^(mis rapidos|mis comidas guardadas|que tengo guardado|lista de rapidos)/.test(n)) {
    const names = Object.keys(db.presets);
    return names.length ? `Tienes guardado: ${names.join(', ')}.` : 'No tienes comidas guardadas.';
  }
  const added = addFoodByVoice(text); if (added) return added;
  const corrected = correctFood(text); if (corrected) return corrected;

  // medidas: "peso 82,4", "me he pesado 82.4", "82,4 kilos", "cintura 90", "grasa visceral 9"
  const met = parseMetricsText(text);
  if (Object.keys(met).length && !/\b(gramos|g)\b/.test(n)) {
    setMetrics(met);
    const parts = [];
    if (met.weight) parts.push(weightMessage(met.weight));
    if (met.body_fat != null) parts.push(`Grasa corporal ${f1(met.body_fat)} %.`);
    if (met.visceral != null) parts.push(`Grasa visceral ${f1(met.visceral)}.`);
    if (met.waist) parts.push(`Cintura ${f1(met.waist)} centímetros.`);
    if (met.muscle) parts.push(`Músculo ${f1(met.muscle)}.`);
    return parts.join(' ') || 'Medida guardada.';
  }

  // comida guardada ("desayuno habitual")
  const pname = n.replace(/^(he tomado|he comido|mi|el|la|un|una)\s+/, '');
  const preset = Object.keys(db.presets).find(k => normalize(k) === pname || normalize(k) === n);
  if (preset) return opts.preview ? await previewFood(db.presets[preset]) : await logFood(db.presets[preset]);

  return opts.preview ? await previewFood(text) : await logFood(text);
}

// ───────────────────────── entrada desde Atajos ─────────────────────────
async function handleShortcutInput(p) {
  if (typeof p === 'string') {
    const s = p.trim();
    if (/\n/.test(s) && /weight|peso/i.test(s.split('\n')[0]) && /[,;]/.test(s.split('\n')[0])) return importZeppCsv(s).msg;
    if (s.startsWith('{')) { try { return await handleShortcutInput(JSON.parse(s)); } catch (e) { /* texto normal */ } }
    return await route(s);
  }
  if (p && typeof p === 'object') {
    const accion = normalize(p.accion || p.action || '');
    if (accion === 'salud') return saveHealth(p);
    if (accion === 'codigo' || p.codigo || p.code) {
      const code = String(p.codigo || p.code || '').replace(/\D/g, '');
      if (!code) return 'No he leído ningún código.';
      const f = await offBarcode(code).catch(() => null);
      if (!f) return 'No encuentro ese producto en Open Food Facts.';
      const name = normalize(f.label || `producto ${code}`);
      const food = learnFood(name, { kcal: r1(f.kcal), protein: r1(f.protein), carbs: r1(f.carbs), fat: r1(f.fat), unit_g: f.unit_g, source: f.source }, `codigo ${code}`);
      const grams = numOrNull(p.gramos ?? p.grams) || f.unit_g || 100;
      const [e] = addEntries([{ name, food, grams }], `código ${code}`, mealFor());
      return `${cap(e.name)}, ${fmt(e.grams)} gramos: ${fmt(e.kcal)} kilocalorías. ${summary().speech}`;
    }
    if (accion === 'csv' && p.texto) return importZeppCsv(p.texto).msg;
    if (p.texto || p.text) return await route(p.texto || p.text);
  }
  return 'No he recibido nada.';
}


// ───────────────────────── vistas para la interfaz ─────────────────────────
let PENDING = null; let JUST_SAVED = null; let MESSAGE = null; let FOOD_RESULTS = null; let GO_TAB = null;
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const dLabel = (day) => { const [, m, d] = day.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const hhmm = (dt) => { const zp = zparts(dt); return `${pad(zp.h)}:${pad(zp.min)}`; };
function whenLabel(iso) {
  if (!iso) return 'sin sincronizar';
  const dt = new Date(iso); const d = dayOf(dt);
  if (d === today()) return `hoy ${hhmm(dt)}`;
  if (d === daysAgo(1)) return `ayer ${hhmm(dt)}`;
  return dLabel(d);
}
const sourceTag = (s) => /^USDA/.test(s || '') ? 'USDA' : /^Open Food/.test(s || '') ? 'Open Food Facts' : 'Tu base';

function pendingView() {
  if (!PENDING) return null;
  const items = PENDING.found.map(it => {
    const k = it.grams / 100; const f = it.food;
    return { name: it.name, grams: r0(it.grams), kcal: r0(f.kcal * k), protein: r1(f.protein * k), carbs: r1(f.carbs * k), fat: r1(f.fat * k), source: f.source || 'base' };
  });
  const total = items.reduce((a, i) => ({ kcal: a.kcal + i.kcal, protein: r1(a.protein + i.protein), carbs: r1(a.carbs + i.carbs), fat: r1(a.fat + i.fat) }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  return { raw: PENDING.raw, meal: PENDING.meal, items, total, missing: PENDING.missing, sources: [...new Set(items.map(i => sourceTag(i.source)))] };
}

function bodyView() {
  const days = Object.keys(db.metrics).sort();
  const h = db.profile.height ? db.profile.height / 100 : null;
  const series = { bf: [], lean: [], bmi: [], weight: [] };
  let count = 0;
  for (const d of days) {
    const m = db.metrics[d]; const label = dLabel(d);
    if (m.weight != null || m.body_fat != null) count++;
    if (m.body_fat != null) series.bf.push({ d, label, v: r1(m.body_fat) });
    const lean = m.lean_mass ?? (m.weight && m.body_fat != null ? m.weight * (1 - m.body_fat / 100) : null);
    if (lean != null) series.lean.push({ d, label, v: r1(lean) });
    const bmi = m.bmi ?? (m.weight && h ? m.weight / (h * h) : null);
    if (bmi != null) series.bmi.push({ d, label, v: r1(bmi) });
    if (m.weight != null) series.weight.push({ d, label, v: r1(m.weight) });
  }
  for (const k of Object.keys(series)) series[k] = series[k].slice(-24);
  const w = latestMetric('weight'); const bf = latestMetric('body_fat');
  const vis = latestMetric('visceral'); const bone = latestMetric('bone');
  const lastDay = [w, bf].filter(Boolean).map(x => x.day).sort().pop();
  return {
    series, count,
    stats: { weight: w ? w.value : null, fatMass: w && bf ? r1(w.value * bf.value / 100) : null, visceral: vis ? vis.value : null, bone: bone ? bone.value : null },
    source: lastDay ? `Báscula Zepp Life y tus registros · última ${dLabel(lastDay)} · en tu base privada` : 'Sin mediciones todavía',
  };
}

function feedView() {
  const groups = new Map();
  for (const e of db.entries.filter(x => x.day === today())) {
    const g = groups.get(e.ts) || { key: e.ts, meal: e.meal, raw: e.raw || '', items: [] };
    g.items.push(e); groups.set(e.ts, g);
  }
  return [...groups.values()].reverse().map(g => {
    const t = g.items.reduce((a, e) => ({ kcal: a.kcal + e.kcal, p: a.p + e.protein, c: a.c + e.carbs, f: a.f + e.fat }), { kcal: 0, p: 0, c: 0, f: 0 });
    return {
      key: g.key, meal: g.meal, time: hhmm(new Date(g.key)), raw: g.raw, ids: g.items.map(e => e.id), kcal: r0(t.kcal),
      desc: g.items.map(e => `${e.name} ${fmt(e.grams)} g`).join(', '),
      detail: `P ${f1(t.p)} · C ${f1(t.c)} · G ${f1(t.f)} g · ${[...new Set(g.items.map(e => sourceTag(e.source)))].join(' + ')}`,
    };
  });
}

function searchFoods(q) {
  const n = normalize(q);
  if (!n) return [];
  return FOODS.filter(f => f.terms.some(t => t.includes(n)))
    .sort((a, b) => (normalize(a.name).startsWith(n) ? 0 : 1) - (normalize(b.name).startsWith(n) ? 0 : 1))
    .slice(0, 30)
    .map(f => ({ name: f.name, kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, unit_g: f.unit_g, source: f.source === 'base' ? 'base incluida' : f.source }));
}

function uiState() {
  const s = summary(); const zn = zparts(new Date());
  const d = db.settings.last_diagnosis || null;
  return {
    dateLabel: `${WEEKDAYS[zn.wd]}, ${zn.d} ${MONTHS[zn.m - 1]}`,
    summary: { consumed: s.consumed, remaining: s.remaining, budget: s.budget },
    goals: db.goals, goalsProvisional: !!db.goals.provisional,
    pending: pendingView(), justSaved: JUST_SAVED, message: MESSAGE,
    health: { label: 'Salud', when: whenLabel(db.settings.health_synced) },
    serverTime: new Date().toISOString(),
    body: bodyView(), feed: feedView(),
    presets: Object.keys(db.presets),
    diagnosis: d ? { ...d, atLabel: d.at ? dLabel(dayOf(new Date(d.at))) : '' } : null,
    foods: {
      base: BASE_FOODS.length, learned: db.foods.length, results: FOOD_RESULTS,
      recent: db.foods.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || ''))).slice(0, 15)
        .map(f => ({ name: f.name, kcal: f.kcal, source: f.source || '' })),
    },
    usdaKeySet: !!(db.settings.usda_key || (ENV && ENV.USDA_API_KEY)),
  };
}


// ───────────────────────── acciones de la interfaz ─────────────────────────
// La vista previa pendiente se guarda en tus ajustes para que sobreviva entre peticiones.
const slimPending = (r) => r && ({
  raw: r.raw, meal: r.meal, missing: r.missing,
  found: r.found.map(it => ({ name: it.name, grams: it.grams, food: { kcal: it.food.kcal, protein: it.food.protein, carbs: it.food.carbs, fat: it.food.fat, unit_g: it.food.unit_g || null, source: it.food.source || 'base' } })),
});
function setPending(r) { PENDING = slimPending(r); db.settings.pending = PENDING; save('settings'); }

function applyRouteResult(r) {
  if (r && typeof r === 'object' && r.kind === 'preview') setPending(r.resolved);
  else MESSAGE = String(r || '');
}

async function handleAction(a) {
  const d = a.data || {};
  MESSAGE = null; JUST_SAVED = null; GO_TAB = null; FOOD_RESULTS = null;
  PENDING = db.settings.pending || null;
  let clear = false;
  switch (a.type) {
    case 'state': break;
    case 'text': if (d.text && String(d.text).trim()) { applyRouteResult(await route(String(d.text), { preview: true })); clear = true; } break;
    case 'preset': if (db.presets[d.name]) applyRouteResult(await previewFood(db.presets[d.name])); break;
    case 'confirm':
      if (PENDING) {
        const meal = PENDING.meal; commitResolved(PENDING); setPending(null);
        JUST_SAVED = `Guardado · ${cap(meal)}, ${hhmm(new Date())}`;
      }
      break;
    case 'discard': setPending(null); break;
    case 'delete': {
      const ids = new Set((d.ids || []).map(Number));
      db.entries = db.entries.filter(e => !ids.has(e.id)); save('entries');
      MESSAGE = 'Registro borrado.'; break;
    }
    case 'savePreset':
      if (d.name && String(d.name).trim() && d.raw) {
        db.presets[normalize(d.name)] = d.raw; save('presets');
        MESSAGE = `Guardado. Toca «${String(d.name).trim()}» en Voz o díselo a Siri para registrarlo.`;
      }
      break;
    case 'searchFoods': FOOD_RESULTS = searchFoods(d.q || ''); break;
    case 'saveFood': {
      const kcal = numOrNull(d.kcal);
      if (!d.name || kcal == null) { MESSAGE = 'Pon al menos el nombre y las kcal por 100 g.'; break; }
      const f = learnFood(d.name, { kcal, protein: numOrNull(d.protein) || 0, carbs: numOrNull(d.carbs) || 0, fat: numOrNull(d.fat) || 0, unit_g: numOrNull(d.unit_g), source: 'tuyo' });
      MESSAGE = `Guardado ${f.name}: ${fmt(kcal)} kcal por 100 g.`; clear = true; break;
    }
    case 'usdaKey': db.settings.usda_key = String(d.key || '').trim(); save('settings'); MESSAGE = db.settings.usda_key ? 'Clave USDA guardada.' : 'Clave USDA borrada.'; clear = true; break;
    case 'diagnose': MESSAGE = d.text ? runDiagnosis(String(d.text)) : 'Escribe o dicta tus datos: sexo, edad, altura, peso, actividad y objetivo.'; if (d.text) clear = true; break;
    case 'recalc': MESSAGE = runDiagnosis(''); break;
    case 'weight': {
      const w = numOrNull(d.value);
      if (!w || w < 25 || w > 400) { MESSAGE = 'Ese peso no parece correcto.'; break; }
      MESSAGE = weightMessage(w); setMetrics({ weight: w }); clear = true; break;
    }
    case 'importCsv': MESSAGE = d.text ? importZeppCsv(String(d.text)).msg : 'El archivo está vacío.'; break;
    case 'undo': MESSAGE = undoLast(); break;
    default: MESSAGE = `Acción desconocida: ${a.type}`;
  }
  const st = uiState(); st.clearInputs = clear; if (GO_TAB) st.goTab = GO_TAB;
  return st;
}

// ───────────────────────── servidor HTTP ─────────────────────────
// Una petición cada vez (es una app de una sola persona)
let chain = Promise.resolve();
const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const text = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

function authorized(request, url) {
  const h = request.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (request.headers.get('X-Nutri-Token') || url.searchParams.get('token') || '');
  return !!ENV.APP_TOKEN && t === ENV.APP_TOKEN;
}

async function readBody(request) {
  const raw = await request.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

function bytesFromB64(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

export async function handle(request, env) {
    ENV = env;
    const url = new URL(request.url);
    const path = url.pathname;
    const secHeaders = { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'", 'referrer-policy': 'no-referrer' };

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...secHeaders } });
    }
    if (path === '/manifest.webmanifest') {
      return new Response(JSON.stringify({ name: 'Nutri', short_name: 'Nutri', display: 'standalone', background_color: '#0A0A0C', theme_color: '#0A0A0C', lang: 'es', icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] }), { headers: { 'content-type': 'application/manifest+json' } });
    }
    if (path === '/icon.png' || path === '/apple-touch-icon.png') {
      return new Response(bytesFromB64(ICON_PNG_B64), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    }
    if (!path.startsWith('/api/')) return text('No encontrado', 404);
    if (!env.APP_TOKEN) return json({ error: 'Falta configurar el secreto APP_TOKEN en Cloudflare.' }, 500);
    if (!env.STORE) return json({ error: `Falta conectar la base de datos. ${env.STORE_HINT || ''}` }, 500);
    if (!authorized(request, url)) return json({ error: 'Clave incorrecta' }, 401);

    try {
      if (path === '/api/action' && request.method === 'POST') {
        const body = await readBody(request);
        return json(await exclusive(async () => { await loadDb(); const st = await handleAction(body); await flush(); return st; }));
      }
      // Siri y Atajos: devuelve texto plano para que Siri lo lea
      if (path === '/api/shortcut' && request.method === 'POST') {
        const body = await readBody(request);
        return text(await exclusive(async () => { await loadDb(); const out = await handleShortcutInput(body); await flush(); return out; }));
      }
      if (path === '/api/today' && request.method === 'GET') {
        return json(await exclusive(async () => { await loadDb(); const s = summary(); return { day: s.day, budget: s.budget, consumed: s.consumed, remaining: s.remaining, pct: s.pct, speech: s.speech, last: s.entries.length ? s.entries[s.entries.length - 1] : null }; }));
      }
      if (path === '/api/export' && request.method === 'GET') {
        const all = await env.STORE.getAll();
        return new Response(JSON.stringify({ exported_at: new Date().toISOString(), data: all }, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="nutri-${today()}.json"` } });
      }
      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
}

// ───────────────────────── interfaz (tu diseño) ─────────────────────────
const UI_HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Nutri">
<meta name="theme-color" content="#0A0A0C">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>Nutri</title>
<style>
:root{
  --bg:#0A0A0C; --text:#F4F4F5; --muted:#9A9AA3; --soft:#B4B4BC; --dim:#6E6E76;
  --card:rgba(255,255,255,0.045); --line:rgba(255,255,255,0.08); --sep:rgba(255,255,255,0.07);
  --amber:#F5A524; --amberSoft:rgba(245,165,36,0.10); --amberLine:rgba(245,165,36,0.28); --amberGlow:rgba(245,165,36,0.45); --amberGhost:rgba(245,165,36,0.30);
  --green:#34E27A; --greenSoft:rgba(52,226,122,0.10); --greenLine:rgba(52,226,122,0.26); --greenFaint:rgba(52,226,122,0.08);
  --fat:#E4DCCB; --red:#FF7A6B;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,'SF Pro Text','SF Pro Display',system-ui,sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button,input,textarea{font:inherit;color:inherit}
button{cursor:pointer}
main{padding:calc(env(safe-area-inset-top) + 18px) 16px calc(env(safe-area-inset-bottom) + 110px);display:flex;flex-direction:column;gap:14px;max-width:560px;margin:0 auto}
.card{padding:16px;border-radius:22px;background:var(--card);border:1px solid var(--line)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.col{display:flex;flex-direction:column}
.muted{color:var(--muted)} .soft{color:var(--soft)}
.small{font-size:12px} .xs{font-size:11px}
h1{margin:0;font-size:34px;line-height:41px;font-weight:700;letter-spacing:-0.02em}
h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-0.01em}
.sectionhead{margin-top:14px;display:flex;align-items:baseline;justify-content:space-between;padding:0 4px}
.eyebrow{font-size:13px;font-weight:600;letter-spacing:0.02em;color:var(--muted);text-transform:uppercase}
.iconbtn{width:40px;height:40px;border-radius:20px;border:1px solid rgba(255,255,255,0.10);background:rgba(255,255,255,0.06);color:#D4D4D8;display:flex;align-items:center;justify-content:center;padding:0}
.pill{font-size:12px;font-weight:600;padding:4px 9px;border-radius:999px;white-space:nowrap}
.pill.green{color:var(--green);background:var(--greenSoft)} .pill.amber{color:var(--amber);background:var(--amberSoft)}
.privacy{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:16px;background:var(--greenSoft);border:1px solid var(--greenLine)}
.shield{width:30px;height:30px;border-radius:9px;background:var(--greenSoft);color:var(--green);display:flex;align-items:center;justify-content:center;flex:none}
.cal{display:flex;align-items:center;gap:18px;padding:18px;border-radius:22px;background:var(--card);border:1px solid var(--line)}
.big{font-size:32px;line-height:36px;font-weight:700;letter-spacing:-0.02em}
.macros{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.macro{display:flex;flex-direction:column;gap:8px;padding:14px 12px;border-radius:18px;background:var(--card);border:1px solid var(--line)}
.track{height:6px;border-radius:3px;background:rgba(255,255,255,0.08);display:flex;overflow:hidden}
.voice{margin-top:10px;display:flex;flex-direction:column;gap:14px;padding:18px;border-radius:24px;background:linear-gradient(180deg,var(--amberSoft),rgba(255,255,255,0.035));border:1px solid var(--amberLine)}
.dot{width:8px;height:8px;border-radius:4px;background:var(--amber)}
.live{animation:pulse 1.6s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(245,165,36,.55)}70%{box-shadow:0 0 0 8px rgba(245,165,36,0)}100%{box-shadow:0 0 0 0 rgba(245,165,36,0)}}
.say{margin:0;font-size:20px;line-height:27px;font-weight:600;letter-spacing:-0.01em}
.mic{width:56px;height:56px;border-radius:28px;border:0;background:var(--amber);color:#1A1206;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 8px 28px var(--amberGlow);flex:none}
.mic.big{width:84px;height:84px;border-radius:42px}
.mic:disabled{opacity:.5}
.item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--sep)}
.btn{height:50px;padding:0 18px;border-radius:14px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:6px}
.btn.primary{border:0;background:var(--green);color:#04200E;font-size:16px;font-weight:700;flex:1 1 auto}
.btn.amber{border:0;background:var(--amber);color:#1A1206;font-weight:700}
.btn.ghost{height:40px;background:transparent;border:0;color:var(--muted);font-size:14px}
.btn.block{width:100%}
.saved{min-height:50px;border-radius:14px;background:var(--greenSoft);border:1px solid var(--greenLine);color:var(--green);display:flex;align-items:center;justify-content:center;gap:8px;font-size:15px;font-weight:600;padding:8px 12px;text-align:center}
.msg{padding:14px 16px;border-radius:18px;background:rgba(255,255,255,0.06);border:1px solid var(--line);font-size:15px;line-height:21px;display:flex;gap:10px;align-items:flex-start}
.msg .x{margin-left:auto;background:none;border:0;color:var(--muted);padding:0 0 0 8px;font-size:20px;line-height:20px}
.seg{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;padding:2px;border-radius:10px;background:rgba(255,255,255,0.07)}
.seg button{height:30px;border:0;border-radius:8px;background:transparent;color:#A1A1AA;font-size:13px;font-weight:600}
.seg button[aria-pressed="true"]{background:rgba(255,255,255,0.16);color:var(--text)}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.stat{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:14px;background:rgba(255,255,255,0.04)}
.stat b{font-size:16px;font-weight:600}
.feedrow{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--sep);background:none;border-left:0;border-right:0;border-bottom:0;width:100%;text-align:left;color:inherit}
.feedrow:first-child{border-top:0}
.ficon{width:36px;height:36px;flex:none;border-radius:11px;background:rgba(255,255,255,0.06);color:#D4D4D8;display:flex;align-items:center;justify-content:center}
.ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.danger{height:36px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,122,107,0.4);background:rgba(255,122,107,0.12);color:var(--red);font-size:14px;font-weight:600}
textarea,input[type=text],input[type=number],input[type=search]{width:100%;border-radius:14px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);padding:12px 14px;font-size:16px;outline:none}
textarea{min-height:84px;resize:none;line-height:22px}
textarea:focus,input:focus{border-color:var(--amberLine)}
label{font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.chip{height:36px;padding:0 14px;border-radius:999px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);font-size:14px;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.kv{display:flex;justify-content:space-between;padding:9px 0;border-top:1px solid var(--sep);font-size:14px}
.kv:first-child{border-top:0}
.kv span:last-child{font-weight:600;text-align:right}
nav{position:fixed;left:0;right:0;bottom:0;padding:8px 12px calc(env(safe-area-inset-bottom) + 6px);display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:rgba(16,16,19,0.78);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-top:1px solid var(--line)}
nav button{border:0;background:none;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:4px;padding:4px 0;font-size:11px;font-weight:500;position:relative;min-height:48px}
nav button[aria-current="page"]{color:var(--green);font-weight:600}
nav .badge{position:absolute;top:2px;left:50%;margin-left:10px;width:7px;height:7px;border-radius:4px;background:var(--amber)}
.empty{padding:18px 4px;text-align:center;color:var(--muted);font-size:14px}
.spin{width:14px;height:14px;border-radius:7px;border:2px solid var(--amberLine);border-top-color:var(--amber);animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<main id="view" aria-live="polite"><div class="empty" style="margin-top:40vh">Cargando Nutri…</div></main>
<nav id="tabs" aria-label="Secciones"></nav>
<script>
window.onerror = function (msg, src, line) {
  var v = document.getElementById('view');
  if (v) v.innerHTML = '<div class="msg" style="margin-top:30vh">No se ha podido dibujar la app: ' + String(msg).replace(/</g, '&lt;') + ' (línea ' + line + '). Haz una captura y pásamela.</div>';
};
(function () {
  // ───── conexión con tu servidor ─────
  var TOKEN_KEY = 'nutri_token';
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return window.__tok || ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { window.__tok = t; } }
  var B = {
    send: function (type, data) {
      UI.busy = type; render();
      return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() }, body: JSON.stringify({ type: type, data: data || {} }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
        .then(function (res) {
          if (res.status === 401) { setToken(''); UI.busy = null; UI.loginError = 'Clave incorrecta'; S = null; render(); return; }
          if (!res.ok) { UI.busy = null; if (S) { S.message = 'Error del servidor: ' + (res.j && res.j.error); } else UI.loginError = res.j && res.j.error; render(); return; }
          B.receive(res.j);
        })
        .catch(function () { UI.busy = null; if (S) { S.message = 'Sin conexión con el servidor. Revisa internet e inténtalo de nuevo.'; } else { UI.loginError = 'Sin conexión con el servidor.'; } render(); });
    },
    receive: function (s) { UI.busy = null; UI.loginError = null; S = s; if (s.goTab) UI.tab = s.goTab; render(); }
  };
  var S = null;
  var UI = { tab: 'hoy', metric: 'bf', busy: null, editing: false, openFeed: null, foodQuery: '', compose: false, loginError: null };

  // ───── utilidades ─────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { n = Math.round(Number(n) || 0); var neg = n < 0; n = Math.abs(n); return (neg ? '−' : '') + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function f1(n) { return n == null ? '—' : (Math.round(n * 10) / 10).toString().replace('.', ','); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  var ICON = {
    user: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path></svg>',
    shield: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"></path><path d="M9 12l2 2 4-4"></path></svg>',
    sync: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 13.7-5.7L20 8"></path><path d="M20 4v4h-4"></path><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16"></path><path d="M4 20v-4h4"></path></svg>',
    lock: '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>',
    mic: function (s) { s = s || 24; return '<svg aria-hidden="true" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>'; },
    edit: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"></path></svg>',
    check: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>',
    home: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"></path></svg>',
    wave: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h2"></path><path d="M7 8v8"></path><path d="M11 5v14"></path><path d="M15 9v6"></path><path d="M19 7v10"></path></svg>',
    db: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="7" ry="2.5"></ellipse><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"></path><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"></path></svg>',
    body: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h6"></path></svg>'
  };

  // ───── piezas ─────
  function header(eyebrow, title) {
    return '<header class="row" style="align-items:flex-end;padding:0 4px">' +
      '<div class="col" style="gap:2px"><span class="eyebrow">' + esc(eyebrow) + '</span><h1>' + esc(title) + '</h1></div>' +
      '<button class="iconbtn" aria-label="Perfil y diagnóstico" data-tab="cuerpo" style="margin-bottom:2px">' + ICON.user + '</button></header>';
  }

  function privacy() {
    return '<section class="privacy" aria-label="Privacidad"><div class="row" style="justify-content:flex-start;gap:10px">' +
      '<span class="shield">' + ICON.shield + '</span><div class="col" style="gap:1px">' +
      '<span style="font-size:14px;font-weight:600;color:var(--green)">Base de datos privada</span>' +
      '<span class="small soft">Solo tú · sin IA · solo se consultan alimentos</span></div></div>' +
      '<div class="row small soft" style="gap:6px;justify-content:flex-end;text-align:right">' + ICON.sync + '<span>' + esc(S.health.label) + '<br>' + esc(S.health.when) + '</span></div></section>';
  }

  function message() {
    if (!S.message) return '';
    return '<div class="msg" role="status"><span>' + esc(S.message) + '</span><button class="x" data-act="dismiss" aria-label="Cerrar mensaje">×</button></div>';
  }

  function ring() {
    var sm = S.summary, p = S.pending ? S.pending.total : null;
    var C = 2 * Math.PI * 34, pct = sm.budget ? sm.consumed.kcal / sm.budget : 0;
    var a = Math.max(0, Math.min(1, pct)) * C;
    var pp = p ? Math.max(0, Math.min(1 - Math.min(1, pct), p.kcal / sm.budget)) * C : 0;
    var over = sm.remaining.kcal < 0;
    var leftAfter = sm.remaining.kcal - (p ? p.kcal : 0);
    return '<section class="cal" aria-label="Calorías de hoy">' +
      '<svg role="img" aria-label="' + fmt(sm.consumed.kcal) + ' de ' + fmt(sm.budget) + ' kcal" width="92" height="92" viewBox="0 0 92 92" style="flex:none">' +
      '<circle cx="46" cy="46" r="34" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10"></circle>' +
      (pp ? '<circle cx="46" cy="46" r="34" fill="none" stroke="var(--amberGhost)" stroke-width="10" stroke-dasharray="' + pp.toFixed(1) + ' ' + C.toFixed(1) + '" stroke-dashoffset="' + (-a).toFixed(1) + '" transform="rotate(-90 46 46)"></circle>' : '') +
      (a > 0 ? '<circle cx="46" cy="46" r="34" fill="none" stroke="' + (over ? 'var(--red)' : 'var(--amber)') + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + a.toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 46 46)"></circle>' : '') +
      '<text x="46" y="44" text-anchor="middle" fill="#F4F4F5" font-size="17" font-weight="700">' + Math.round(pct * 100) + '%</text>' +
      '<text x="46" y="59" text-anchor="middle" fill="#9A9AA3" font-size="10">del objetivo</text></svg>' +
      '<div class="col" style="gap:6px;min-width:0"><span style="font-size:13px;font-weight:600" class="muted">Calorías' + (S.goalsProvisional ? ' · objetivo provisional' : '') + '</span>' +
      '<div class="row" style="justify-content:flex-start;align-items:baseline;gap:6px"><span class="big">' + fmt(sm.consumed.kcal) + '</span><span class="muted" style="font-size:15px">/ ' + fmt(sm.budget) + ' kcal</span></div>' +
      '<div class="row" style="justify-content:flex-start;gap:14px;font-size:13px;flex-wrap:wrap">' +
      (over ? '<span style="color:var(--red)"><b style="font-weight:600">' + fmt(-sm.remaining.kcal) + '</b> de más</span>' : '<span style="color:#D4D4D8"><b style="font-weight:600">' + fmt(sm.remaining.kcal) + '</b> restantes</span>') +
      (p ? '<span style="color:var(--amber)">+' + fmt(p.kcal) + ' pendientes → ' + (leftAfter >= 0 ? fmt(leftAfter) + ' restantes' : fmt(-leftAfter) + ' de más') + '</span>' : '') +
      '</div></div></section>';
  }

  function macros() {
    var sm = S.summary, g = S.goals, p = S.pending ? S.pending.total : null;
    var defs = [['Proteína', 'protein', 'var(--green)', 'rgba(52,226,122,0.32)'], ['Carbohidratos', 'carbs', 'var(--amber)', 'rgba(245,165,36,0.32)'], ['Grasa', 'fat', 'var(--fat)', 'rgba(228,220,203,0.32)']];
    return '<section class="macros" aria-label="Macronutrientes">' + defs.map(function (d) {
      var v = sm.consumed[d[1]], goal = g[d[1]], add = p ? p[d[1]] : 0;
      var pct = goal ? Math.min(100, v / goal * 100) : 0, pend = goal ? Math.max(0, Math.min(100 - pct, add / goal * 100)) : 0;
      var rem = goal - v;
      var foot = p ? '+' + f1(add) + ' g pendientes' : (rem >= 0 ? 'quedan ' + fmt(rem) + ' g' : fmt(-rem) + ' g de más');
      return '<div class="macro"><span class="small muted" style="font-weight:600">' + d[0] + '</span>' +
        '<div class="row" style="justify-content:flex-start;align-items:baseline;gap:3px"><span style="font-size:22px;font-weight:700;letter-spacing:-0.01em">' + fmt(v) + '</span><span class="small muted">/ ' + fmt(goal) + ' g</span></div>' +
        '<div class="track"><div style="height:6px;width:' + pct.toFixed(1) + '%;background:' + d[2] + ';border-radius:3px"></div><div style="height:6px;width:' + pend.toFixed(1) + '%;background:' + d[3] + '"></div></div>' +
        '<span class="xs" style="color:' + (rem < 0 && !p ? 'var(--red)' : d[2]) + '">' + foot + '</span></div>';
    }).join('') + '</section>';
  }

  function voiceCard(large) {
    var busy = UI.busy === 'dictate' || UI.busy === 'text' || UI.busy === 'preset';
    var title = busy ? (UI.busy === 'dictate' ? 'Escuchando' : 'Interpretando') : (S.pending ? 'Interpretado' : 'Listo');
    var body;
    if (busy) body = '<p class="say"><span class="spin"></span> <span class="muted" style="font-weight:500">' + (UI.busy === 'dictate' ? 'Te escucho… habla ahora' : 'Buscando en tu base de alimentos…') + '</span></p>';
    else if (UI.compose) body = '<label for="compose" class="soft" style="font-size:13px">' + (UI.listening ? 'Te escucho… habla ahora' : 'Pulsa el micro del teclado y habla, o escribe') + '</label><textarea id="compose" placeholder="200 g de pollo a la plancha y 150 g de arroz"></textarea>' + (SRC && !UI.listening ? '<button class="btn ghost" data-act="listen" style="align-self:flex-start;padding:0">' + ICON.mic(16) + ' Escuchar sin teclado</button>' : '') + '<div class="row" style="gap:10px"><button class="btn" data-act="closeCompose">Cancelar</button><button class="btn amber" style="flex:1 1 auto" data-act="sendCompose">Interpretar</button></div>';
    else if (S.pending) body = '<p class="say">“' + esc(S.pending.raw) + '”</p>';
    else body = '<p class="say" style="color:#D4D4D8">Toca el micro y di qué has comido.</p>';
    return '<section class="voice" aria-label="Registro por voz">' +
      '<div class="row"><div class="row" style="justify-content:flex-start;gap:8px"><span class="dot' + (busy ? ' live' : '') + '"></span>' +
      '<span style="font-size:13px;font-weight:600;color:var(--amber)">' + title + '</span></div>' +
      '<span class="small muted">«Oye Siri, Nutri»</span></div>' + body +
      '<div class="row"><span class="row small soft" style="gap:6px;justify-content:flex-start">' + ICON.lock + 'Dictado de Apple · se guarda en tu base</span>' +
      '<button class="mic' + (large ? ' big' : '') + '" data-act="dictate" aria-label="Hablar" ' + (busy ? 'disabled' : '') + '>' + ICON.mic(large ? 32 : 24) + '</button></div>' +
      '</section>';
  }

  function pendingCard() {
    var p = S.pending;
    if (!p) {
      if (S.justSaved) return '<div class="saved">' + ICON.check + '<span>' + esc(S.justSaved) + '</span></div>';
      return '';
    }
    if (UI.editing) {
      return '<section class="card col" style="gap:12px" aria-label="Editar registro"><span style="font-size:17px;font-weight:600">Editar lo que dijiste</span>' +
        '<textarea id="editText" aria-label="Texto del registro">' + esc(p.raw) + '</textarea>' +
        '<div class="row" style="gap:10px"><button class="btn" data-act="cancelEdit">Cancelar</button><button class="btn primary" data-act="reparse">Volver a interpretar</button></div></section>';
    }
    var srcs = p.sources.join(' + ');
    return '<section class="card col" style="gap:12px" aria-label="Registro interpretado">' +
      '<div class="row"><div class="col" style="gap:2px"><span style="font-size:17px;font-weight:600">Interpretado · ' + p.items.length + (p.items.length === 1 ? ' alimento' : ' alimentos') + '</span>' +
      '<span class="small muted">' + esc(srcs) + ' · ' + esc(cap(p.meal)) + '</span></div>' +
      (p.missing.length ? '<span class="pill amber">' + p.missing.length + ' sin encontrar</span>' : '<span class="pill green">Todo encontrado</span>') + '</div>' +
      '<div class="col">' + p.items.map(function (it) {
        return '<div class="item"><div class="col" style="gap:3px;min-width:0"><span style="font-size:15px;font-weight:600">' + esc(cap(it.name)) + '</span>' +
          '<span class="small muted">' + fmt(it.grams) + ' g · P ' + f1(it.protein) + ' · C ' + f1(it.carbs) + ' · G ' + f1(it.fat) + '</span></div>' +
          '<span style="font-size:15px;font-weight:600;white-space:nowrap">' + fmt(it.kcal) + ' <span class="small muted" style="font-weight:400">kcal</span></span></div>';
      }).join('') +
      (p.missing.length ? '<div class="item"><span class="small" style="color:var(--amber)">Sin encontrar: ' + esc(p.missing.join(', ')) + '. Añádelo en Alimentos.</span></div>' : '') +
      '<div class="item" style="padding-bottom:2px"><span style="font-size:13px" class="soft">Total · P ' + f1(p.total.protein) + ' · C ' + f1(p.total.carbs) + ' · G ' + f1(p.total.fat) + '</span>' +
      '<span style="font-size:17px;font-weight:700;color:var(--amber)">' + fmt(p.total.kcal) + ' kcal</span></div></div>' +
      '<div class="row" style="gap:10px"><button class="btn" data-act="edit">' + ICON.edit + 'Editar</button>' +
      '<button class="btn primary" data-act="confirm">' + ICON.check + 'Confirmar y guardar</button></div>' +
      '<button class="btn ghost" data-act="discard">Descartar</button></section>';
  }

  function chartCard(showHead) {
    var b = S.body, key = UI.metric, ser = b.series[key] || [];
    var labels = { bf: ['Grasa corporal', '%'], lean: ['Masa magra', 'kg'], bmi: ['IMC', ''], weight: ['Peso', 'kg'] };
    var seg = [['bf', 'Grasa'], ['lean', 'Masa magra'], ['bmi', 'IMC']].map(function (s) {
      return '<button data-metric="' + s[0] + '" aria-pressed="' + (s[0] === key ? 'true' : 'false') + '">' + s[1] + '</button>';
    }).join('');
    var inner;
    if (ser.length < 2) {
      inner = '<div class="empty">' + (ser.length ? 'Solo hay una medición (' + f1(ser[0].v) + ' ' + labels[key][1] + '). La gráfica aparece con dos o más.' : 'Aún no hay mediciones. Sincroniza Salud o importa el archivo de Zepp Life en «Cuerpo».') + '</div>';
    } else {
      var vals = ser.map(function (x) { return x.v; });
      var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      var pad = (max - min) * 0.25 || 1; min -= pad; max += pad;
      var x0 = 10, x1 = 282, top = 12, bot = 100;
      var pts = ser.map(function (x, i) { return [x0 + (x1 - x0) * i / (ser.length - 1), bot - (x.v - min) / (max - min) * (bot - top)]; });
      var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' 104 L' + pts[0][0].toFixed(1) + ' 104 Z';
      var dots = ser.length <= 14 ? pts.slice(0, -1).map(function (p) { return 'M' + (p[0] - 3.5).toFixed(1) + ' ' + p[1].toFixed(1) + ' a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0'; }).join(' ') : '';
      var last = pts[pts.length - 1];
      var g = function (f) { return f1(min + (max - min) * f); };
      var first = ser[0], lastv = ser[ser.length - 1], delta = lastv.v - first.v;
      var ticks = [ser[0], ser[Math.floor((ser.length - 1) / 2)], ser[ser.length - 1]];
      inner = '<div class="row" style="align-items:flex-end"><div class="col" style="gap:2px"><span style="font-size:13px" class="muted">' + labels[key][0] + ' · última</span>' +
        '<div class="row" style="justify-content:flex-start;align-items:baseline;gap:4px"><span style="font-size:38px;line-height:42px;font-weight:700;letter-spacing:-0.02em">' + f1(lastv.v) + '</span><span class="muted" style="font-size:17px">' + labels[key][1] + '</span></div></div>' +
        '<span class="pill ' + ((key === 'lean' ? delta >= 0 : delta <= 0) ? 'green' : 'amber') + '" style="font-size:13px;padding:5px 10px">' + (delta > 0 ? '+' : delta < 0 ? '−' : '') + f1(Math.abs(delta)) + (labels[key][1] === '%' ? ' pts' : labels[key][1] ? ' ' + labels[key][1] : '') + ' desde ' + esc(first.label) + '</span></div>' +
        '<div class="col" style="gap:6px"><svg role="img" aria-label="' + labels[key][0] + ': ' + vals.map(f1).join(', ') + '" width="100%" height="112" viewBox="0 0 326 112" preserveAspectRatio="none" style="display:block">' +
        '<line x1="0" y1="34" x2="292" y2="34" stroke="rgba(255,255,255,0.09)" stroke-dasharray="3 4"></line><line x1="0" y1="56" x2="292" y2="56" stroke="rgba(255,255,255,0.09)" stroke-dasharray="3 4"></line><line x1="0" y1="78" x2="292" y2="78" stroke="rgba(255,255,255,0.09)" stroke-dasharray="3 4"></line><line x1="0" y1="104" x2="292" y2="104" stroke="rgba(255,255,255,0.14)"></line>' +
        '<text x="326" y="37" text-anchor="end" fill="#8E8E96" font-size="11">' + g(0.75) + '</text><text x="326" y="59" text-anchor="end" fill="#8E8E96" font-size="11">' + g(0.5) + '</text><text x="326" y="81" text-anchor="end" fill="#8E8E96" font-size="11">' + g(0.25) + '</text>' +
        '<path d="' + area + '" fill="var(--greenFaint)"></path><path d="' + line + '" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
        (dots ? '<path d="' + dots + '" fill="#0F1012" stroke="var(--green)" stroke-width="1.8"></path>' : '') +
        '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="5.5" fill="var(--green)" stroke="#0F1012" stroke-width="2.5"></circle></svg>' +
        '<div class="row xs" style="padding-right:34px;color:#8E8E96"><span>' + esc(ticks[0].label) + '</span><span>' + esc(ticks[1].label) + '</span><span>' + esc(ticks[2].label) + '</span></div></div>';
    }
    var st = b.stats;
    return (showHead ? '<div class="sectionhead"><h2>Composición corporal</h2><span style="font-size:13px" class="muted">' + b.count + (b.count === 1 ? ' medición' : ' mediciones') + '</span></div>' : '') +
      '<section class="card col" style="gap:14px" aria-label="Medidas corporales"><div class="seg" role="group" aria-label="Medida">' + seg + '</div>' + inner +
      '<div class="stats"><div class="stat"><span class="xs muted">Masa grasa</span><b>' + f1(st.fatMass) + ' <span class="small muted" style="font-weight:400">kg</span></b></div>' +
      '<div class="stat"><span class="xs muted">' + (st.visceral != null ? 'Grasa visceral' : 'Hueso') + '</span><b>' + (st.visceral != null ? f1(st.visceral) : f1(st.bone) + ' <span class="small muted" style="font-weight:400">kg</span>') + '</b></div>' +
      '<div class="stat"><span class="xs muted">Peso</span><b>' + f1(st.weight) + ' <span class="small muted" style="font-weight:400">kg</span></b></div></div>' +
      '<span class="row small muted" style="gap:6px;justify-content:flex-start">' + ICON.lock + esc(b.source) + '</span></section>';
  }

  function feed() {
    var f = S.feed;
    var head = '<div class="sectionhead"><h2>Antes, hoy</h2><span style="font-size:13px" class="muted">' + fmt(S.summary.consumed.kcal) + ' kcal</span></div>';
    if (!f.length) return head + '<section class="card"><div class="empty">Aún no has registrado nada hoy.</div></section>';
    return head + '<section class="card col" style="padding:4px 16px" aria-label="Registro de hoy">' + f.map(function (x, i) {
      var open = UI.openFeed === x.key;
      return '<div><button class="feedrow" data-feed="' + esc(x.key) + '" aria-expanded="' + open + '"><span class="ficon">' + ICON.mic(17) + '</span>' +
        '<span class="col" style="gap:2px;min-width:0;flex:1 1 auto"><span style="font-size:15px;font-weight:600">' + esc(cap(x.meal)) + ' <span class="muted" style="font-weight:400">· ' + esc(x.time) + '</span></span>' +
        '<span class="small muted ellipsis">' + esc(x.desc) + '</span></span><span style="font-size:15px;font-weight:600;white-space:nowrap">' + fmt(x.kcal) + '</span></button>' +
        (open ? '<div class="row" style="padding:0 0 12px 48px;gap:8px;justify-content:flex-start;flex-wrap:wrap"><span class="small soft" style="flex:1 1 100%">' + esc(x.detail) + '</span><button class="danger" data-act="delete" data-ids="' + x.ids.join(',') + '">Borrar</button><button class="chip" data-act="savePresetFrom" data-raw="' + esc(x.raw) + '">Guardar como rápido</button></div>' : '') +
        '</div>';
    }).join('') + '</section>';
  }

  // ───── pantallas ─────
  function screenHoy() {
    return header(S.dateLabel, 'Hoy') + privacy() + message() + ring() + macros() + voiceCard(false) + pendingCard() + chartCard(true) + feed();
  }

  function screenVoz() {
    var presets = S.presets.map(function (p) { return '<button class="chip" data-act="preset" data-name="' + esc(p) + '">' + esc(cap(p)) + '</button>'; }).join('');
    var examples = ['250 g de entrecot con patatas fritas', 'Para desayunar un café con leche y dos tostadas con aceite', 'Peso 82,4', 'Cuánto me queda', 'Resumen de la semana', 'Borra lo último', 'Guarda como desayuno habitual', 'Corrige entrecot 180 calorías'];
    return header(S.dateLabel, 'Voz') + message() + voiceCard(true) + pendingCard() +
      '<section class="card col" style="gap:10px"><label for="typed">O escríbelo como lo dirías</label><textarea id="typed" placeholder="200 g de pollo a la plancha y 150 g de arroz"></textarea>' +
      '<button class="btn amber block" data-act="typed">Interpretar</button></section>' +
      '<div class="sectionhead"><h2>Comidas guardadas</h2><span style="font-size:13px" class="muted">' + S.presets.length + '</span></div>' +
      '<section class="card col" style="gap:10px">' + (presets ? '<div class="chips">' + presets + '</div>' : '<div class="empty">Registra algo y di «guarda como» y un nombre.</div>') + '</section>' +
      '<div class="sectionhead"><h2>Puedes decir</h2></div><section class="card col" style="gap:8px">' + examples.map(function (e) {
        return '<button class="chip" style="height:auto;min-height:40px;padding:8px 14px;text-align:left;border-radius:14px" data-example="' + esc(e) + '">«' + esc(e) + '»</button>';
      }).join('') + '</section>';
  }

  function screenAlimentos() {
    var F = S.foods;
    var results = (F.results || []).map(function (f) {
      return '<div class="item"><div class="col" style="gap:3px;min-width:0"><span style="font-size:15px;font-weight:600">' + esc(cap(f.name)) + '</span>' +
        '<span class="small muted">P ' + f1(f.protein) + ' · C ' + f1(f.carbs) + ' · G ' + f1(f.fat) + (f.unit_g ? ' · ración ' + fmt(f.unit_g) + ' g' : '') + ' · ' + esc(f.source) + '</span></div>' +
        '<span style="font-size:15px;font-weight:600;white-space:nowrap">' + fmt(f.kcal) + ' <span class="small muted" style="font-weight:400">/100 g</span></span></div>';
    }).join('');
    return header(S.dateLabel, 'Alimentos') + message() +
      '<section class="card col" style="gap:0"><div class="kv"><span class="muted">Base incluida</span><span>' + fmt(F.base) + ' alimentos</span></div>' +
      '<div class="kv"><span class="muted">Aprendidos y tuyos</span><span>' + fmt(F.learned) + '</span></div>' +
      '<div class="kv"><span class="muted">Consultas externas</span><span>USDA · Open Food Facts</span></div>' +
      '<div class="kv"><span class="muted">Qué se envía</span><span>solo el nombre del alimento</span></div></section>' +
      '<section class="card col" style="gap:10px"><label for="fq">Buscar en tu base</label><div class="row" style="gap:8px"><input id="fq" type="search" placeholder="pollo, arroz, yogur…" value="' + esc(UI.foodQuery) + '"><button class="btn" data-act="searchFoods">Buscar</button></div>' +
      (F.results ? (results ? '<div class="col">' + results + '</div>' : '<div class="empty">No está en tu base. Si lo registras, se buscará en USDA u Open Food Facts y se guardará.</div>') : '') + '</section>' +
      '<div class="sectionhead"><h2>Añadir o corregir</h2><span style="font-size:13px" class="muted">por 100 g</span></div>' +
      '<section class="card col" style="gap:10px"><label>Nombre<input id="nf_name" type="text" placeholder="rabo de toro"></label>' +
      '<div class="grid4"><label>kcal<input id="nf_kcal" type="number" inputmode="decimal"></label><label>Prot.<input id="nf_p" type="number" inputmode="decimal"></label><label>Carb.<input id="nf_c" type="number" inputmode="decimal"></label><label>Grasa<input id="nf_f" type="number" inputmode="decimal"></label></div>' +
      '<label>Gramos de una ración (opcional)<input id="nf_u" type="number" inputmode="decimal"></label><button class="btn amber block" data-act="saveFood">Guardar alimento</button></section>' +
      '<div class="sectionhead"><h2>Aprendidos</h2></div><section class="card col" style="padding:4px 16px">' +
      (F.recent.length ? F.recent.map(function (f) {
        return '<div class="item" style="border-top-color:var(--sep)"><div class="col" style="gap:3px;min-width:0"><span style="font-size:15px;font-weight:600">' + esc(cap(f.name)) + '</span><span class="small muted ellipsis">' + esc(f.source) + '</span></div><span style="font-weight:600;white-space:nowrap">' + fmt(f.kcal) + ' <span class="small muted" style="font-weight:400">/100 g</span></span></div>';
      }).join('') : '<div class="empty">Todavía no ha aprendido ninguno.</div>') + '</section>' +
      '<div class="sectionhead"><h2>Clave USDA</h2><span style="font-size:13px" class="muted">' + (S.usdaKeySet ? 'configurada' : 'demo') + '</span></div>' +
      '<section class="card col" style="gap:10px"><span class="small muted">Gratis en fdc.nal.usda.gov/api-key-signup. Sin clave, la USDA solo permite unas pocas búsquedas por hora.</span>' +
      '<div class="row" style="gap:8px"><input id="usda" type="text" autocomplete="off" placeholder="Pega aquí tu clave"><button class="btn" data-act="usdaKey">Guardar</button></div></section>';
  }

  function screenCuerpo() {
    var d = S.diagnosis, g = S.goals;
    var diag = d ? '<section class="card col" style="gap:0">' +
      '<div class="kv"><span class="muted">IMC</span><span>' + f1(d.bmi) + ' · ' + esc(d.bmi_category) + '</span></div>' +
      '<div class="kv"><span class="muted">Grasa corporal</span><span>' + f1(d.body_fat) + ' %' + (d.body_fat_measured ? '' : ' (aprox.)') + '</span></div>' +
      (d.visceral != null ? '<div class="kv"><span class="muted">Grasa visceral</span><span>' + f1(d.visceral) + ' · ' + esc(d.visceral_category) + '</span></div>' : '') +
      (d.waist_risk ? '<div class="kv"><span class="muted">Cintura / altura</span><span>' + f1(d.waist_height) + ' · riesgo ' + esc(d.waist_risk) + '</span></div>' : '') +
      '<div class="kv"><span class="muted">Metabolismo basal</span><span>' + fmt(d.bmr) + ' kcal' + (d.bmr_scale ? ' · báscula ' + fmt(d.bmr_scale) : '') + '</span></div>' +
      '<div class="kv"><span class="muted">Gasto diario</span><span>' + fmt(d.tdee) + ' kcal · ' + (d.adaptive ? 'real' : 'estimado') + '</span></div>' +
      '<div class="kv"><span class="muted">Ritmo</span><span>' + (d.deficit > 0 ? '−' + f1(d.rate_kg_week) + ' kg/semana' : 'mantenimiento') + '</span></div>' +
      (d.weeks ? '<div class="kv"><span class="muted">Hasta ' + f1(d.target_weight) + ' kg</span><span>~' + d.weeks + ' semanas</span></div>' : '') +
      '<div class="kv"><span class="muted">Agua · fibra</span><span>' + f1(d.water_l) + ' L · ' + d.fiber_g + ' g</span></div>' +
      (d.notes && d.notes.length ? '<div class="kv"><span class="small" style="color:var(--amber);font-weight:400;text-align:left">' + esc(d.notes.join(' ')) + '</span></div>' : '') +
      '<div class="kv"><span class="small muted" style="font-weight:400;text-align:left">Calculado el ' + esc(d.atLabel) + '. Estimación orientativa, no es un diagnóstico médico.</span></div></section>'
      : '<section class="card"><div class="empty">Aún no has hecho el diagnóstico. Dímelo con tus datos y calculo tus objetivos.</div></section>';
    return header(S.dateLabel, 'Cuerpo') + message() +
      '<div class="sectionhead" style="margin-top:0"><h2>Objetivos diarios</h2><span style="font-size:13px" class="muted">' + (S.goalsProvisional ? 'provisionales' : 'tuyos') + '</span></div>' +
      '<section class="macros"><div class="macro"><span class="small muted" style="font-weight:600">Calorías</span><span style="font-size:22px;font-weight:700">' + fmt(g.kcal) + '</span></div>' +
      '<div class="macro"><span class="small muted" style="font-weight:600">Proteína</span><span style="font-size:22px;font-weight:700">' + fmt(g.protein) + ' <span class="small muted">g</span></span></div>' +
      '<div class="macro"><span class="small muted" style="font-weight:600">Carb. · Grasa</span><span style="font-size:22px;font-weight:700">' + fmt(g.carbs) + '<span class="small muted"> · </span>' + fmt(g.fat) + '</span></div></section>' +
      '<div class="sectionhead"><h2>Diagnóstico</h2>' + (d ? '<button class="chip" data-act="recalc">Recalcular</button>' : '') + '</div>' + diag +
      '<section class="card col" style="gap:10px"><label for="dx">' + (d ? 'Actualizar datos' : 'Tus datos') + '</label><textarea id="dx" placeholder="Hombre, 34 años, 180 cm, 82 kilos, moderado, objetivo 75">' + '</textarea>' +
      '<div class="row" style="gap:10px"><button class="btn" data-act="dictateDx">' + ICON.mic(18) + 'Dictar</button><button class="btn amber" style="flex:1 1 auto" data-act="diagnose">Calcular objetivos</button></div>' +
      '<span class="xs muted">Sexo, edad, altura, peso, actividad (sedentario, ligero, moderado, activo) y objetivo. Opcional: grasa %, cintura, ritmo.</span></section>' +
      chartCard(true) +
      '<section class="card col" style="gap:10px"><label for="wt">Registrar peso de hoy</label><div class="row" style="gap:8px"><input id="wt" type="number" inputmode="decimal" placeholder="82,4"><button class="btn" data-act="weight">Guardar</button></div></section>' +
      '<div class="sectionhead"><h2>Báscula y datos</h2></div><section class="card col" style="gap:10px">' +
      '<div class="kv"><span class="muted">Salud (Zepp Life)</span><span>' + esc(S.health.label) + ' ' + esc(S.health.when) + '</span></div>' +
      '<button class="btn block" data-act="importCsv">Importar archivo de Zepp Life (CSV)</button><input id="csvfile" type="file" accept=".csv,text/csv,text/plain" style="display:none">' +
      '<button class="btn block" data-act="export">Exportar mis datos (JSON)</button>' +
      '<button class="btn ghost block" data-act="logout">Cerrar sesión en este dispositivo</button>' +
      '<span class="xs muted">Tus datos están en tu base de datos de Cloudflare, protegida con tu clave. Exportar descarga una copia completa.</span></section>';
  }

  // ───── render y eventos ─────
  function tabs() {
    var t = [['hoy', 'Hoy', ICON.home], ['voz', 'Voz', ICON.wave], ['alimentos', 'Alimentos', ICON.db], ['cuerpo', 'Cuerpo', ICON.body]];
    return t.map(function (x) {
      return '<button data-tab="' + x[0] + '"' + (UI.tab === x[0] ? ' aria-current="page"' : '') + '>' + (x[0] === 'voz' && S && S.pending ? '<span class="badge" aria-label="Registro pendiente"></span>' : '') + x[2] + x[1] + '</button>';
    }).join('');
  }

  function loginScreen() {
    return '<section class="card col" style="gap:14px;margin-top:18vh"><h1>Nutri</h1>' +
      '<span class="soft" style="font-size:15px;line-height:21px">Escribe tu clave de acceso (la que pusiste como APP_TOKEN en Cloudflare). Solo se pide una vez en este dispositivo.</span>' +
      '<input id="tok" type="password" autocomplete="current-password" placeholder="Clave de acceso">' +
      (UI.loginError ? '<span class="small" style="color:var(--red)">' + esc(UI.loginError) + '</span>' : '') +
      '<button class="btn amber block" data-act="login">Entrar</button></section>';
  }

  function render() {
    var view = document.getElementById('view');
    if (!S) {
      if (!getToken()) { view.innerHTML = loginScreen(); document.getElementById('tabs').innerHTML = ''; return; }
      view.innerHTML = '<div class="empty" style="margin-top:40vh">' + (UI.loginError ? esc(UI.loginError) + '<br><br><button class="btn" data-act="retry">Reintentar</button> <button class="btn ghost" data-act="logout">Cambiar clave</button>' : 'Cargando…') + '</div>';
      return;
    }
    var keep = {};
    ['typed', 'dx', 'fq', 'nf_name', 'nf_kcal', 'nf_p', 'nf_c', 'nf_f', 'nf_u', 'usda', 'wt', 'editText', 'compose'].forEach(function (id) { var el = document.getElementById(id); if (el) keep[id] = el.value; });
    var html = UI.tab === 'voz' ? screenVoz() : UI.tab === 'alimentos' ? screenAlimentos() : UI.tab === 'cuerpo' ? screenCuerpo() : screenHoy();
    view.innerHTML = html;
    document.getElementById('tabs').innerHTML = tabs();
    Object.keys(keep).forEach(function (id) { var el = document.getElementById(id); if (el && !S.clearInputs) el.value = keep[id]; });
    if (S.clearInputs) S.clearInputs = false;
  }

  // Micro: abre la caja de texto con el teclado (su micro dicta siempre, en el propio iPhone).
  // Si el navegador tiene reconocimiento de voz, se ofrece además «Escuchar».
  var SRC = window.SpeechRecognition || window.webkitSpeechRecognition;
  var REC = null;
  function startDictation(target) {
    if (target === 'dx') { var dx = document.getElementById('dx'); if (dx) dx.focus(); return; }
    UI.compose = true; UI.listening = false; render();
    var c = document.getElementById('compose'); if (c) c.focus();
  }
  function listen() {
    if (!SRC) return;
    var got = false, done = false;
    var finish = function () { if (done) return; done = true; clearTimeout(REC && REC._t); REC = null; UI.listening = false; render(); };
    try {
      var r = new SRC(); r.lang = 'es-ES'; r.interimResults = false; r.maxAlternatives = 1;
      r.onresult = function (e) { got = true; var t = e.results[0][0].transcript; finish(); var c = document.getElementById('compose'); if (c) c.value = t; };
      r.onerror = finish; r.onend = finish;
      r._t = setTimeout(function () { try { r.stop(); } catch (e) {} finish(); }, 10000);
      REC = r; UI.listening = true; render(); r.start();
    } catch (e) { finish(); }
  }

  function exportData() {
    fetch('/api/export', { headers: { 'Authorization': 'Bearer ' + getToken() } }).then(function (r) { return r.blob(); }).then(function (b) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'nutri-datos.json'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }).catch(function () { if (S) { S.message = 'No se ha podido exportar.'; render(); } });
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('button');
    if (!el || el.disabled) return;
    if (el.dataset.tab) { UI.tab = el.dataset.tab; UI.editing = false; render(); window.scrollTo(0, 0); return; }
    if (el.dataset.metric) { UI.metric = el.dataset.metric; render(); return; }
    if (el.dataset.feed) { UI.openFeed = UI.openFeed === el.dataset.feed ? null : el.dataset.feed; render(); return; }
    if (el.dataset.example) { UI.tab = 'voz'; render(); var t = document.getElementById('typed'); t.value = el.dataset.example; t.focus(); return; }
    var a = el.dataset.act;
    if (!a) return;
    if (a === 'login') { var t = val('tok'); if (!t) return; setToken(t); UI.loginError = null; render(); B.send('state'); return; }
    if (a === 'retry') { UI.loginError = null; render(); B.send('state'); return; }
    if (a === 'logout') { setToken(''); S = null; UI.loginError = null; render(); return; }
    if (a === 'dictate') { startDictation('text'); return; }
    if (a === 'dictateDx') { startDictation('dx'); return; }
    if (a === 'closeCompose') { if (REC) { try { REC.abort(); } catch (e) {} } UI.compose = false; UI.listening = false; render(); return; }
    if (a === 'listen') { listen(); return; }
    if (a === 'sendCompose') { var c = val('compose'); UI.compose = false; if (c) B.send('text', { text: c }); else render(); return; }
    if (a === 'savePresetFrom') { var nm = window.prompt('Nombre para esta comida (p. ej. desayuno habitual)'); if (nm) B.send('savePreset', { raw: el.dataset.raw, name: nm }); return; }
    if (a === 'importCsv') { var fi = document.getElementById('csvfile'); fi.onchange = function () { var f = fi.files && fi.files[0]; if (!f) return; var rd = new FileReader(); rd.onload = function () { B.send('importCsv', { text: String(rd.result || '') }); }; rd.readAsText(f); }; fi.click(); return; }
    if (a === 'export') { exportData(); return; }
    if (a === 'edit') { UI.editing = true; render(); return; }
    if (a === 'cancelEdit') { UI.editing = false; render(); return; }
    if (a === 'reparse') { UI.editing = false; B.send('text', { text: val('editText') }); return; }
    if (a === 'typed') { var tx = val('typed'); if (tx) B.send('text', { text: tx }); return; }
    if (a === 'preset') { B.send('preset', { name: el.dataset.name }); return; }
    if (a === 'delete') { UI.openFeed = null; B.send('delete', { ids: el.dataset.ids.split(',').map(Number) }); return; }
    if (a === 'searchFoods') { UI.foodQuery = val('fq'); B.send('searchFoods', { q: UI.foodQuery }); return; }
    if (a === 'saveFood') { B.send('saveFood', { name: val('nf_name'), kcal: val('nf_kcal'), protein: val('nf_p'), carbs: val('nf_c'), fat: val('nf_f'), unit_g: val('nf_u') }); return; }
    if (a === 'usdaKey') { B.send('usdaKey', { key: val('usda') }); return; }
    if (a === 'diagnose') { B.send('diagnose', { text: val('dx') }); return; }
    if (a === 'weight') { var w = val('wt'); if (w) B.send('weight', { value: w }); return; }
    B.send(a, {});
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'fq') { ev.preventDefault(); UI.foodQuery = val('fq'); B.send('searchFoods', { q: UI.foodQuery }); }
  });

  render();
  if (getToken()) B.send('state');
})();
</script>
</body>
</html>
`;
const ICON_PNG_B64 = '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';
