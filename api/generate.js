export const config = { runtime: 'edge' };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

// Access gate: only valid Starter Kit owners may use this proxy. The access
// Worker verifies the signed token AND honors revocation (deleted KV key).
const ACCESS_API = 'https://virtueasy-pricing-tool-verification.morgan-2bf.workers.dev';
const ALLOWED_ORIGINS = [
  'https://virtueasy.com',
  'https://virtueasyproducts-cmd.github.io',
];

function corsFor(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const CORS = corsFor(origin);
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // A browser on another site can't call this (its Origin won't match). Server
  // callers send no Origin — they're stopped by the token gate below instead.
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Forbidden origin' }, 403);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'API key not configured' }, 500);

  let body;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { prompt, token } = body;
  if (!prompt) return json({ error: 'Missing prompt' }, 400);

  // Require a valid Starter Kit access token — ties AI usage to paying customers.
  if (!token) return json({ error: 'Access required' }, 401);
  try {
    const vr = await fetch(ACCESS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'product-verify', product: 'starterkit', token }),
    });
    const vd = await vr.json();
    if (!vd || !vd.valid) return json({ error: 'Access denied' }, 401);
  } catch {
    return json({ error: 'Access check failed' }, 503);
  }

  const anthropicRes = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text();
    return json({ error: 'Anthropic API error', detail: err }, anthropicRes.status);
  }

  const data = await anthropicRes.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return json({ result: text });
}
