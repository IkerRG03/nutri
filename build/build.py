# Genera src/index.js (lo que despliega Cloudflare) a partir de las piezas
import pathlib
b = pathlib.Path(__file__).parent; root = b.parent
ui = (root / 'src' / 'ui.html').read_text(encoding='utf-8')
assert '`' not in ui and '${' not in ui
parts = [
  (b / 'glue_head.js').read_text(encoding='utf-8'),
  '\n// ───────────────────────── motor de nutrición ─────────────────────────\n',
  (b / 'core.js').read_text(encoding='utf-8'),
  '\n// ───────────────────────── vistas para la interfaz ─────────────────────────\n',
  (b / 'app.js').read_text(encoding='utf-8'),
  (b / 'glue_tail.js').read_text(encoding='utf-8'),
  '\n// ───────────────────────── interfaz (tu diseño) ─────────────────────────\n',
  'const UI_HTML = String.raw`' + ui + '`;\n',
  "const ICON_PNG_B64 = '" + (b / 'icon.b64').read_text().strip() + "';\n",
]
out = ''.join(parts)
(root / 'lib').mkdir(exist_ok=True)
(root / 'lib' / 'nutri.js').write_text(out, encoding='utf-8')
print('lib/nutri.js', len(out.encode('utf-8')), 'bytes')
