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

