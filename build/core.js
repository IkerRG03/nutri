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

