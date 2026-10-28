// Entrada para Cloudflare Workers (base de datos D1, binding "DB")
import { handle, d1Store } from '../lib/nutri.js';

export default {
  fetch(request, env) {
    return handle(request, {
      APP_TOKEN: env.APP_TOKEN,
      USDA_API_KEY: env.USDA_API_KEY,
      STORE: env.DB ? d1Store(env.DB) : null,
      STORE_HINT: 'En Cloudflare: crea la base D1 "nutri" y pon su Database ID en wrangler.toml.',
    });
  },
};
