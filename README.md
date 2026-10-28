# Nutri — web app personal de nutrición

Tu interfaz (Hoy · Voz · Alimentos · Cuerpo) y una base de datos privada, gratis, en Cloudflare o en Vercel. En el iPhone se abre desde un icono en la pantalla de inicio, a pantalla completa, como una app. No hay nada que instalar ni copiar en el móvil.

- **Datos:** en tu propia base de datos (Cloudflare D1 o Upstash en Vercel), protegida con tu clave. Sin IA.
- **Conexiones externas:** solo el servidor consulta alimentos a USDA y Open Food Facts, y solo envía el nombre del alimento.
- **Actualizar:** cada cambio que subas a GitHub se publica solo.

## Montarlo (unos 15 minutos)

Este repositorio funciona tanto en **Cloudflare** como en **Vercel**; elige uno de los dos. Los nombres de los menús pueden variar un poco.

### 1. Sube este proyecto a GitHub (para cualquiera de los dos)
1. En github.com: **New repository** → nombre `nutri` → **Private** → *Create repository*.
2. En el repositorio vacío: **uploading an existing file** → arrastra **todo el contenido** de esta carpeta (carpetas incluidas) → *Commit changes*.

### 2A. Opción Cloudflare (base de datos D1)
1. Crea una cuenta gratis en dash.cloudflare.com.
2. **Storage & Databases → D1 SQL Database → Create** → nombre `nutri`. Si te deja elegir ubicación, elige *Western Europe*.
3. Entra en la base → **Console** → pega el contenido de `schema.sql` → **Execute**.
4. Copia el **Database ID**. En GitHub, edita `wrangler.toml` y sustituye `00000000-0000-0000-0000-000000000000` por tu ID → *Commit changes*.
5. **Workers & Pages → Create → Import a repository** → autoriza GitHub → elige `nutri` → **Deploy**.
6. En el worker **nutri → Settings → Variables and Secrets → Add** (tipo *Secret*): `APP_TOKEN` y `USDA_API_KEY`. Están explicadas más abajo.
7. Tu app: `https://nutri.TU-SUBDOMINIO.workers.dev`

### 2B. Opción Vercel (base de datos Upstash Redis)
1. Crea una cuenta gratis en vercel.com (con tu GitHub).
2. **Add New → Project** → importa `nutri` → *Framework Preset*: **Other** → **Deploy**. El primer despliegue dará el aviso de que falta la base de datos; es normal.
3. En el proyecto: **Storage → Create Database → Upstash (Redis)** → plan gratuito → región en Europa (por ejemplo, Frankfurt) → **Connect** a este proyecto. Vercel añade solo las variables de conexión.
4. **Settings → Environment Variables**: añade `APP_TOKEN` y `USDA_API_KEY`.
5. **Deployments → … → Redeploy**, para que coja las variables.
6. Tu app: `https://nutri-XXXX.vercel.app` (aparece en el proyecto). Si al abrirla te pide iniciar sesión en Vercel, desactiva *Settings → Deployment Protection*. Tu app ya está protegida con tu clave.

### 3. Las dos claves (iguales en ambas opciones)
- `APP_TOKEN`: tu clave de acceso. Inventa una larga; es la contraseña de tu app y de Siri.
- `USDA_API_KEY`: clave gratuita de https://fdc.nal.usda.gov/api-key-signup (llega al instante por email). Es recomendable: sin ella la USDA permite muy pocas búsquedas.

### 4. Ponla en tu iPhone
1. Abre la dirección de tu app en **Safari** → escribe tu clave → *Entrar*.
2. Botón **Compartir → Añadir a pantalla de inicio** → *Añadir*.
3. Abre el icono **Nutri**. Te pedirá la clave una vez más, porque la app de la pantalla de inicio guarda sus datos aparte de Safari.
4. Lo primero: **Cuerpo → Diagnóstico** con tus datos, para fijar tus objetivos.

**Para hablar dentro de la app:** toca el micro naranja; se abre un cuadro con el teclado. Pulsa el micro del teclado, di lo que has comido y toca *Interpretar*. Revisas lo que ha entendido y pulsas *Confirmar y guardar*.

## Siri: "Oye Siri, Nutri"
En la app **Atajos**, crea un atajo llamado **Nutri** con estas acciones:
1. **Dictar texto**: idioma *Español (España)*, dejar de escuchar *Tras una pausa*.
2. **Obtener contenido de URL**:
   - URL: `https://TU-APP/api/shortcut` (tu dirección de Cloudflare o Vercel + `/api/shortcut`)
   - Método: **POST**
   - Encabezados: `Authorization` = `Bearer TU_CLAVE`
   - Cuerpo de la solicitud: **JSON** → campo `text` = *Texto dictado*
3. **Mostrar resultado** (*Contenido de la URL*). Siri lo lee en voz alta.

Puedes decir: "250 gramos de entrecot con patatas fritas", "cuánto me queda", "peso 82,4", "resumen de la semana", "borra lo último", "guarda como desayuno habitual", "diagnóstico, hombre, 34 años…". Con Siri se guarda directamente, sin vista previa.

## Báscula Zepp Life
- **Peso y % de grasa vía Salud (automático):** crea el atajo *Nutri Salud*:
  1. **Buscar muestras de salud** (*Peso*, el más reciente; *Porcentaje de grasa corporal*, el más reciente; *Energía activa* y *Pasos* de hoy con *Calcular estadísticas → Suma*).
  2. **Obtener contenido de URL**: la misma URL, POST y encabezado de antes, con cuerpo JSON `accion` = `salud`, `peso`, `grasa`, `energia_activa`, `pasos`.
  3. Prográmalo en **Automatización → Hora del día**.
- **Grasa visceral, músculo, agua y metabolismo:** en Zepp Life exporta tus datos y, en la app, **Cuerpo → Importar archivo de Zepp Life (CSV)**.

## Copia de tus datos
**Cuerpo → Exportar mis datos (JSON)** descarga todo lo que hay en tu base.

## Para quien edite el código
- `lib/nutri.js` es el motor completo (intérprete, alimentos, diagnóstico, API e interfaz). Se genera con `python3 build/build.py` a partir de `build/` y `src/ui.html`.
- `src/index.js` es la entrada de Cloudflare y `api/index.js` la de Vercel. `vercel.json` manda todas las rutas a esa función.
