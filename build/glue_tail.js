
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
