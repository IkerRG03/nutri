// Entrada para Vercel (base de datos Upstash Redis, conectada desde Vercel ▸ Storage)
import { handle, upstashStore } from '../lib/nutri.js';

function env() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return {
    APP_TOKEN: process.env.APP_TOKEN,
    USDA_API_KEY: process.env.USDA_API_KEY,
    STORE: url && token ? upstashStore(url, token) : null,
    STORE_HINT: 'En Vercel: Storage → conecta una base Upstash Redis a este proyecto y vuelve a desplegar.',
  };
}

// vercel.json manda todas las rutas aquí con ?__path=/ruta-original
async function run(request) {
  const url = new URL(request.url);
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.pathname = original || '/';
    url.searchParams.delete('__path');
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
    request = new Request(url, { method: request.method, headers: request.headers, body });
  }
  return handle(request, env());
}

export const GET = run;
export const POST = run;
