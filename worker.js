// LIMINAL — relais Cloudflare Worker
// Rôle : vérifier le sceau d'invitation, limiter les tours par jour, relayer vers Groq.
//
// À configurer dans Cloudflare (Settings > Variables and secrets / Bindings) :
//   Secret   GROQ_API_KEY   ta clé Groq (gsk_...)
//   Secret   CODES          tes codes, séparés par des virgules : VOILE-8RD,AUTRE-CODE,...
//   Binding  LIMINAL_KV     un espace KV (variable name = LIMINAL_KV)
// Optionnel (Text variables) :
//   DAILY_LIMIT   tours par code et par jour   (défaut 6)
//   GLOBAL_LIMIT  tours au total par jour      (défaut 100)

const MODELS = {
  narrator: 'openai/gpt-oss-120b',
  small: 'openai/gpt-oss-20b',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function originAllowed(origin) {
  return (
    origin === 'https://fictiph.github.io' ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Liminal-Code, X-Liminal-Tier, X-Liminal-Action',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

function parseCodes(raw) {
  return new Set(
    String(raw || '')
      .split(/[\s,;]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') {
      return json({ error: { code: 'method', message: 'Method not allowed' } }, 405, cors);
    }
    if (origin && !originAllowed(origin)) {
      return json({ error: { code: 'origin', message: 'Origine non autorisée' } }, 403, cors);
    }
    if (!env.LIMINAL_KV || !env.GROQ_API_KEY || !env.CODES) {
      return json({ error: { code: 'config', message: 'Relais mal configuré (secrets ou KV manquants)' } }, 500, cors);
    }

    // ── Sceau d'invitation ──
    const code = (request.headers.get('X-Liminal-Code') || '').trim().toUpperCase();
    if (!code || !parseCodes(env.CODES).has(code)) {
      return json({ error: { code: 'invalid_code', message: 'Sceau non reconnu' } }, 401, cors);
    }

    // ── Quota ──
    const day = new Date().toISOString().slice(0, 10);   // repart à minuit UTC
    const kUser = `u:${day}:${code}`;
    const kGlobal = `g:${day}`;
    const dailyLimit = parseInt(env.DAILY_LIMIT, 10) || 6;
    const globalLimit = parseInt(env.GLOBAL_LIMIT, 10) || 100;
    let used = parseInt(await env.LIMINAL_KV.get(kUser), 10) || 0;
    let gUsed = parseInt(await env.LIMINAL_KV.get(kGlobal), 10) || 0;
    const quotaOf = () => ({
      left: Math.max(0, dailyLimit - used),
      limit: dailyLimit,
      globalLeft: Math.max(0, globalLimit - gUsed),
    });

    // Simple consultation du quota (ne consomme rien)
    if (request.headers.get('X-Liminal-Action') === 'status') {
      return json(quotaOf(), 200, cors);
    }

    const tier = request.headers.get('X-Liminal-Tier') === 'small' ? 'small' : 'narrator';

    if (tier === 'narrator') {
      if (used >= dailyLimit) {
        return json({ error: { code: 'daily_limit', message: 'Le Voile se referme.' }, quota: quotaOf() }, 429, cors);
      }
      if (gUsed >= globalLimit) {
        return json({ error: { code: 'global_limit', message: 'Le Voile se referme.' }, quota: quotaOf() }, 429, cors);
      }
    }

    // ── Requête ──
    let body;
    try { body = await request.json(); } catch (_) {
      return json({ error: { code: 'bad_request', message: 'JSON invalide' } }, 400, cors);
    }
    const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : null;
    if (!messages || !messages.length) {
      return json({ error: { code: 'bad_request', message: 'messages manquants' } }, 400, cors);
    }
    const clean = messages.map(m => ({
      role: ['system', 'user', 'assistant'].includes(m && m.role) ? m.role : 'user',
      content: String((m && m.content) || '').slice(0, 12000),
    }));

    const payload = {
      model: MODELS[tier],
      messages: clean,
      max_tokens: Math.min(parseInt(body.max_tokens, 10) || 600, 1000),
      reasoning_effort: 'low',   // modèles gpt-oss : limite la réflexion pour garder de la place à la réponse
      temperature: Math.min(Math.max(Number(body.temperature ?? 0.85), 0), 1.5),
    };

    let res, data;
    try {
      res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify(payload),
      });
      data = await res.json();
    } catch (e) {
      return json({ error: { code: 'upstream', message: 'Groq injoignable' } }, 502, cors);
    }

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Erreur Groq ${res.status}`;
      const status = res.status === 429 ? 429 : 502;
      return json({ error: { code: res.status === 429 ? 'rate_limit' : 'upstream', message: msg } }, status, cors);
    }

    // Tour consommé seulement si Groq a répondu
    if (tier === 'narrator') {
      used += 1; gUsed += 1;
      await Promise.all([
        env.LIMINAL_KV.put(kUser, String(used), { expirationTtl: 172800 }),
        env.LIMINAL_KV.put(kGlobal, String(gUsed), { expirationTtl: 172800 }),
      ]);
    }
    return json({ ...data, quota: quotaOf() }, 200, cors);
  },
};
