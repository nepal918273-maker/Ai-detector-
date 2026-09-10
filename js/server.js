const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const APP_ROOT = path.resolve(__dirname, '..');

loadEnvFile();

const { register, login, createApiKey, authenticateJwt, authenticateApiKey, requireDatabase } = require('./auth');

const ROOT = APP_ROOT;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DETECTION_GUIDE = loadDetectionGuide();
const PORT = Number(process.env.PORT || 8000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REVENUECAT_PUBLIC_API_KEY = process.env.REVENUECAT_PUBLIC_API_KEY;
const REVENUECAT_SECRET_API_KEY = process.env.REVENUECAT_SECRET_API_KEY;
const REVENUECAT_WEBHOOK_AUTH = process.env.REVENUECAT_WEBHOOK_AUTH;
const PLANS = [
  { id: 'free', name: 'Free', credits: 3, duration: 'forever', price_cents: 0 },
  { id: 'three-day', product_id: 'three-day', name: '3 Days', credits: 8, duration: '3 days', price_cents: 199 },
  { id: 'monthly', product_id: 'monthly', name: '1 Month', credits: 100, duration: '1 month', price_cents: 999 },
  { id: 'yearly', product_id: 'yearly', name: '1 Year', credits: 1000, duration: '1 year', price_cents: 7999 }
];
const rateLimitWindowMs = 60 * 1000;
const rateLimitMax = 60;
const rateLimitBuckets = new Map();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function safeGeminiFallback(error, text) {
  const fallback = localTextAnalysis(String(text || ''));
  fallback.message = `Gemini unavailable: ${error.message || 'request failed'}. Local analysis was used instead.`;
  return fallback;
}

function loadEnvFile() {
  for (const name of ['.env', '.env.txt']) {
    const filename = path.join(APP_ROOT, name);
    if (!fs.existsSync(filename)) continue;
    for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*["']?(.*?)["']?\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  }
}

function loadDetectionGuide() {
  const guidePath = path.join(APP_ROOT, 'detection.txt');
  if (!fs.existsSync(guidePath)) return '';
  return fs.readFileSync(guidePath, 'utf8').trim();
}

function detectionPrompt(instruction) {
  return `${instruction}

Use the following detection rubric as guidance. Treat each item as a possible indicator, not proof by itself. Weigh multiple independent signals, distinguish missing evidence from contradictory evidence, and avoid claiming certainty. Return only the format requested by the caller.

${DETECTION_GUIDE}`;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function requireAuthenticatedUser(request) {
  const user = await authenticateJwt(request);
  if (!user) {
    const error = new Error('Please sign in before using credits');
    error.statusCode = 401;
    throw error;
  }
  return user;
}

async function consumeCredit(userId) {
  const client = await requireDatabase().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('UPDATE users SET credits = credits - 1 WHERE id = $1 AND credits > 0 RETURNING credits', [userId]);
    if (!result.rows[0]) {
      const error = new Error('No credits remaining. Choose a plan to continue.');
      error.statusCode = 402;
      throw error;
    }
    await client.query('COMMIT');
    return result.rows[0].credits;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function refundCredit(userId) {
  await requireDatabase().query('UPDATE users SET credits = credits + 1 WHERE id = $1', [userId]);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseFormUrlEncoded(body) {
  const fields = {};
  const query = body.toString('utf8');
  for (const [key, value] of new URLSearchParams(query).entries()) {
    fields[key] = value;
  }
  return { fields, files: [] };
}

function parseMultipart(body, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('Multipart boundary is missing');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const partStart = start + boundary.length;
    if (body.slice(partStart, partStart + 2).toString() === '--') break;
    const headerStart = partStart + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;
    const headers = body.slice(headerStart, headerEnd).toString('utf8');
    const nextBoundary = body.indexOf(boundary, headerEnd + 4);
    if (nextBoundary < 0) break;
    const value = body.slice(headerEnd + 4, nextBoundary - 2);
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i);
    if (disposition) {
      const name = (disposition[1].match(/name="([^"]+)"/) || [])[1];
      const filename = (disposition[1].match(/filename="([^"]*)"/) || [])[1];
      const type = (headers.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || 'application/octet-stream';
      if (filename !== undefined) files.push({ name, filename, contentType: type, data: value });
      else if (name) fields[name] = value.toString('utf8');
    }
    cursor = nextBoundary;
  }
  return { fields, files };
}

async function requestData(request) {
  const body = await readBody(request);
  const contentType = request.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) return parseMultipart(body, contentType);
  if (contentType.includes('application/x-www-form-urlencoded')) return parseFormUrlEncoded(body);
  if (contentType.includes('application/json')) {
    try { return { fields: JSON.parse(body.toString('utf8') || '{}'), files: [] }; }
    catch { const error = new Error('Invalid JSON request body'); error.statusCode = 400; throw error; }
  }
  return { fields: {}, files: [] };
}

function localTextAnalysis(text) {
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/[a-z0-9']+/g) || [];
  const wordCount = words.length;
  const markers = [
    'in conclusion', 'it is important to note', 'furthermore', 'moreover', 'in summary',
    'overall', 'therefore', 'however', 'to summarize', 'in today\'s world', 'in today\'s fast-paced world',
    'delve into', 'cutting-edge', 'robust', 'comprehensive', 'enhance', 'utilize', 'leverage',
    'transformative', 'seamless', 'innovative', 'foster', 'dynamic', 'elevate'
  ];
  const detectedMarkers = markers.filter(marker => lower.includes(marker));
  const aiKeywordBoost = /(?:ai-generated|generated by ai|large language model|llm|chatgpt|machine-generated)/i.test(lower) ? 28 : 0;
  const transitionBoost = /(?:furthermore|moreover|in conclusion|overall|therefore|however|to summarize|in summary)/i.test(lower) ? 18 : 0;
  const sentenceCount = (lower.match(/[.!?]+/g) || []).length;
  const polishedGrammar = /(?:\b(?:it is|this is|that is|these are|therefore|moreover|however)\b.*\b(?:important|essential|crucial|effective|clear|strong|significant)\b)/i.test(lower) ? 12 : 0;
  const score = Math.min(95, 25 + detectedMarkers.length * 10 + aiKeywordBoost + transitionBoost + polishedGrammar + (wordCount > 35 ? 12 : wordCount > 18 ? 8 : 0) + (sentenceCount >= 3 ? 8 : 0));
  const isAi = score >= 60 || /(?:ai-generated|generated by ai|llm|chatgpt)/i.test(lower);
  const details = detectedMarkers.length
    ? detectedMarkers
    : (isAi ? ['AI-like stylistic patterns and structured phrasing were detected.'] : ['No strong AI-generation markers detected in this text.']);

  return {
    ai_score: score,
    is_ai: isAi,
    message: isAi ? 'AI-like writing patterns detected.' : 'The text appears human-written or too short for a definitive AI match.',
    details
  };
}

function parseModelJson(raw) {
  const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI returned an invalid analysis response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function analyzeText(text) {
  if (!GEMINI_API_KEY) return localTextAnalysis(text);
  const prompt = detectionPrompt(`Analyze this text for signs of AI generation. Return only JSON with ai_score (0-100), is_ai (boolean), message, details (array of specific rubric indicators), and prompt (string). Text: ${text.slice(0, 3000)}`);
  try {
    return await gemini(prompt);
  } catch (error) {
    return safeGeminiFallback(error, text);
  }
}

async function analyzeImage(file) {
  if (!GEMINI_API_KEY) {
    return { ai_score: 0, is_ai: false, message: 'Image received. Model-based analysis is unavailable.', details: [`Image size: ${file.data.length} bytes`] };
  }
  try {
    return await gemini(detectionPrompt('Analyze this image for signs of AI generation. Return only JSON with ai_score, is_ai, message, details (array of specific rubric indicators), and prompt.'), file);
  } catch (error) {
    return safeGeminiFallback(error, file.data.toString('utf8').slice(0, 200));
  }
}

async function gemini(prompt, imageData) {
  const parts = [{ text: prompt }];
  if (imageData) parts.push({ inline_data: { mime_type: imageData.contentType, data: imageData.data.toString('base64') } });
  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }] })
  });
  if (!result.ok) throw new Error(`Gemini request failed (${result.status})`);
  const json = await result.json();
  return parseModelJson(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
}

async function geminiText(prompt) {
  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!result.ok) throw new Error(`Gemini request failed (${result.status})`);
  const json = await result.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function openAi(prompt, input, imageFile) {
  if (!OPENAI_API_KEY) return null;
  const content = imageFile
    ? [{ type: 'text', text: input }, { type: 'image_url', image_url: { url: `data:${imageFile.contentType};base64,${imageFile.data.toString('base64')}` } }]
    : input;
  const result = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: prompt }, { role: 'user', content }], temperature: 0 })
  });
  if (!result.ok) throw new Error(`OpenAI request failed (${result.status})`);
  const json = await result.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

function legacyResult(raw, contentType) {
  const fallback = { is_ai_generated: false, confidence: 0, reasoning: 'Local analysis used because OpenAI is unavailable.', indicators_detected: [] };
  let result = fallback;
  if (raw) {
    try { result = { ...fallback, ...parseModelJson(raw) }; } catch { result = { ...fallback, reasoning: raw }; }
  }
  return { ...result, content_type: contentType };
}

function normalizeAnalysis(analysis = {}) {
  const score = Math.max(0, Math.min(100, Number(analysis.ai_score ?? analysis.score ?? 0) || 0));
  const isAi = Boolean(analysis.is_ai ?? analysis.is_ai_generated ?? score >= 70);
  const details = analysis.details ?? analysis.indicators_detected ?? [];
  return {
    ai_score: Math.round(score * 10) / 10,
    is_ai: isAi,
    message: String(analysis.message ?? analysis.reasoning ?? 'No determination provided.'),
    details: (Array.isArray(details) ? details : [details]).filter(Boolean).map(String),
    prompt: isAi ? String(analysis.prompt || '') : ''
  };
}

function resultPayload(contentType, analysis, originalContent = null, executeUrl = '') {
  const result = normalizeAnalysis(analysis);
  return { content_type: contentType, original_content: originalContent, details: result.details, is_ai_built: result.is_ai, ai_message: result.message, prompt: result.prompt, execute_url: executeUrl, score: result.ai_score, is_ai: result.is_ai };
}

function fileText(file) {
  return file.data.toString('utf8').slice(0, 3000);
}

function humanizeTextLocally(text) {
  let cleaned = String(text || '').trim();
  const replacements = [
    [/\bIn conclusion\b/gi, 'Anyway'],
    [/\bIt is important to note\b/gi, 'One important thing'],
    [/\bFurthermore\b/gi, 'Also'],
    [/\bMoreover\b/gi, 'Also'],
    [/\bThis response is polished and clearly structured\b/gi, 'This is fairly straightforward'],
    [/\bThis is clearly structured\b/gi, 'This is straightforward'],
    [/\bThis means\b/gi, 'That means'],
    [/\bIt should be noted that\b/gi, 'Just keep in mind that'],
    [/\bIt is worth noting that\b/gi, 'It is worth noting that'],
    [/\bThe text strongly indicates AI generation\b/gi, 'The wording looks AI-generated'],
    [/\bThe key point\b/gi, 'the main point'],
    [/\bto explain the key point in a concise way\b/gi, 'to explain the main point simply'],
    [/\s+/g, ' ']
  ];

  for (const [pattern, value] of replacements) cleaned = cleaned.replace(pattern, value);

  if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) cleaned += '.';
  return cleaned;
}

function safeName(filename) {
  return path.basename(filename || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function generatedSvg(prompt, animated = false) {
  const text = prompt.slice(0, 100).replace(/[<&>]/g, '');
  const animation = animated ? '<animate attributeName="fill" values="#193f69;#592f70;#193f69" dur="8s" repeatCount="indefinite"/>' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576" viewBox="0 0 1024 576"><rect width="100%" height="100%" fill="#193f69"/>${animation}<circle cx="512" cy="260" r="180" fill="none" stroke="#8dd8ed" stroke-width="12"/><text x="60" y="390" fill="white" font-family="Arial" font-size="42">AI ${animated ? 'VIDEO' : 'IMAGE'}</text><text x="60" y="450" fill="#c9eef6" font-family="Arial" font-size="24">${text}</text></svg>`;
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const requestStarted = Date.now();
  response.once('finish', () => console.log(`${request.method} ${url.pathname} ${response.statusCode} ${Date.now() - requestStarted}ms`));
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    return response.end();
  }
  if (url.pathname.startsWith('/v1/')) {
    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = rateLimitBuckets.get(address);
    if (!bucket || now - bucket.startedAt >= rateLimitWindowMs) rateLimitBuckets.set(address, { startedAt: now, count: 1 });
    else if (++bucket.count > rateLimitMax) return sendError(response, 429, 'Too many requests');
  }
  if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { status: 'healthy', ai_configured: Boolean(GEMINI_API_KEY), database_configured: Boolean(process.env.DATABASE_URL), features: ['chat', 'detection', 'image', 'video', 'voice-recording', 'api-keys'] });
  if (request.method === 'GET' && url.pathname === '/plans') return sendJson(response, 200, { currency: 'USD', plans: PLANS });
  if (request.method === 'GET' && url.pathname === '/revenuecat/config') {
    if (!REVENUECAT_PUBLIC_API_KEY) return sendError(response, 503, 'RevenueCat public API key is not configured');
    return sendJson(response, 200, { apiKey: REVENUECAT_PUBLIC_API_KEY });
  }

  try {
    if (request.method === 'POST' && url.pathname === '/revenuecat/webhook') {
      if (!REVENUECAT_WEBHOOK_AUTH || request.headers.authorization !== `Bearer ${REVENUECAT_WEBHOOK_AUTH}`) return sendError(response, 401, 'Invalid RevenueCat webhook authorization');
      const { fields } = await requestData(request);
      const event = fields.event || {};
      const productId = String(event.product_id || event.product_identifier || '');
      const plan = PLANS.find(item => item.product_id === productId);
      const userId = String(event.app_user_id || '');
      const paymentId = String(event.id || event.transaction_id || '');
      if (!plan || plan.id === 'free' || !userId || !paymentId) return sendJson(response, 200, { received: true, credited: false });
      const database = requireDatabase();
      const client = await database.connect();
      try {
        await client.query('BEGIN');
        const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (!user.rows[0]) {
          await client.query('ROLLBACK');
          return sendJson(response, 200, { received: true, credited: false, reason: 'user_not_found' });
        }
        const inserted = await client.query(
          'INSERT INTO credit_purchases (user_id, plan_id, credits, amount_cents, payment_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (payment_id) DO NOTHING RETURNING id',
          [userId, plan.id, plan.credits, Number(event.price?.amount_micros ? event.price.amount_micros / 10000 : plan.price_cents), paymentId]
        );
        if (inserted.rows[0]) await client.query('UPDATE users SET credits = credits + $1 WHERE id = $2', [plan.credits, userId]);
        await client.query('COMMIT');
        return sendJson(response, 200, { received: true, credited: Boolean(inserted.rows[0]) });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    if (request.method === 'POST' && url.pathname === '/auth/register') {
      const { fields } = await requestData(request);
      return sendJson(response, 201, await register(fields.name, fields.email, fields.password));
    }

    if (request.method === 'POST' && url.pathname === '/auth/login') {
      const { fields } = await requestData(request);
      return sendJson(response, 200, await login(fields.email, fields.password));
    }

    if (request.method === 'GET' && url.pathname === '/auth/me') {
      const user = await authenticateJwt(request);
      if (!user) return sendError(response, 401, 'Missing or invalid JWT');
      const result = await requireDatabase().query('SELECT id, name, email, credits FROM users WHERE id = $1', [user.user_id]);
      if (!result.rows[0]) return sendError(response, 401, 'User account not found');
      return sendJson(response, 200, result.rows[0]);
    }

    if (request.method === 'GET' && url.pathname === '/credits') {
      const user = await authenticateJwt(request);
      if (!user) return sendError(response, 401, 'Missing or invalid JWT');
      const result = await requireDatabase().query('SELECT credits FROM users WHERE id = $1', [user.user_id]);
      if (!result.rows[0]) return sendError(response, 404, 'User not found');
      return sendJson(response, 200, { credits: result.rows[0].credits });
    }

    if (url.pathname.startsWith('/api/keys')) {
      const user = await authenticateJwt(request);
      if (!user) return sendError(response, 401, 'Missing or invalid JWT');
      const userId = user.user_id;
      if (request.method === 'POST' && url.pathname === '/api/keys') return sendJson(response, 201, await createApiKey(userId));
      if (request.method === 'GET' && url.pathname === '/api/keys') {
        const result = await requireDatabase().query('SELECT id, key_prefix, created_at, is_active FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
        return sendJson(response, 200, { keys: result.rows });
      }
      const match = url.pathname.match(/^\/api\/keys\/(\d+)$/);
      if (request.method === 'DELETE' && match) {
        const result = await requireDatabase().query('UPDATE api_keys SET is_active = false WHERE id = $1 AND user_id = $2 RETURNING id', [match[1], userId]);
        if (!result.rows[0]) return sendError(response, 404, 'API key not found');
        return sendJson(response, 200, { id: result.rows[0].id, is_active: false });
      }
    }

    if (url.pathname === '/v1/data') {
      const user = await authenticateApiKey(request);
      if (!user) return sendError(response, 401, 'Missing, invalid, or inactive API key');
      if (request.method === 'GET') return sendJson(response, 200, { user_id: user.user_id, data: [] });
    }

    if (request.method === 'POST' && /^\/detect\/(text|photo|video|audio)$/.test(url.pathname)) {
      const { fields, files } = await requestData(request);
      const contentType = url.pathname.split('/').pop();
      const file = files[0];
      if (contentType === 'text') {
        const text = String(fields.text || fields.content || '').trim();
        if (!text) return sendError(response, 400, 'Text is required');
        const raw = await openAi(detectionPrompt('Analyze the text for AI generation. Return JSON with is_ai_generated, confidence from 0 to 1, reasoning, and indicators_detected.'), text);
        return sendJson(response, 200, legacyResult(raw, 'text'));
      }
      if (!file) return sendError(response, 400, `Upload a ${contentType} file`);
      if (contentType === 'photo') {
        const raw = await openAi(detectionPrompt('Analyze this image for AI generation. Return JSON with is_ai_generated, confidence from 0 to 1, reasoning, and indicators_detected.'), 'Analyze this image for AI generation.', file);
        return sendJson(response, 200, legacyResult(raw, 'photo'));
      }
      const raw = await openAi(detectionPrompt(`Analyze this ${contentType} for AI generation. Return JSON with is_ai_generated, confidence from 0 to 1, reasoning, and indicators_detected.`), fileText(file));
      return sendJson(response, 200, legacyResult(raw, contentType));
    }

    if (request.method === 'POST' && url.pathname === '/humanize/text') {
      await requireAuthenticatedUser(request);
      const { fields } = await requestData(request);
      const text = String(fields.text || fields.content || '').trim();
      if (!text) return sendError(response, 400, 'Text is required');

      const analysis = normalizeAnalysis(await analyzeText(text));
      if (!analysis.is_ai) {
        return sendJson(response, 200, {
          original_text: text,
          humanized_text: text,
          content_type: 'text',
          ai_detected: false,
          message: 'No AI-generated content detected.'
        });
      }

      const humanized = OPENAI_API_KEY
        ? await openAi('Rewrite the provided text to sound natural and human while preserving its meaning. Return only the rewritten text.', text)
        : humanizeTextLocally(text);

      return sendJson(response, 200, {
        original_text: text,
        humanized_text: humanized,
        content_type: 'text',
        ai_detected: true,
        message: 'AI-generated content was rewritten to sound more natural.'
      });
    }

    if (request.method === 'GET' && url.pathname === '/') return serveStatic('/index.html', response);

    if (request.method === 'POST' && url.pathname === '/detect') {
      const user = await requireAuthenticatedUser(request);
      const { fields, files } = await requestData(request);
      const mode = fields.mode;
      if (!mode) return sendError(response, 400, 'Mode is required');
      if (mode === 'text' && !String(fields.content || '').trim()) return sendError(response, 400, 'Text is required');
      if (mode === 'url') {
        let target;
        try { target = new URL(String(fields.content || '').trim()); } catch { return sendError(response, 400, 'A valid URL is required'); }
        if (!['http:', 'https:'].includes(target.protocol)) return sendError(response, 400, 'Only HTTP and HTTPS URLs are supported');
      }
      if (!['text', 'url', 'file', 'photo'].includes(mode)) return sendError(response, 400, 'Unsupported detection mode');
      if (['file', 'photo'].includes(mode) && !files[0]) return sendError(response, 400, `No ${mode === 'photo' ? 'photo' : 'file'} provided`);

      await consumeCredit(user.user_id);
      let creditConsumed = true;
      try {
      if (mode === 'text') {
        const text = String(fields.content || '').trim();
        return sendJson(response, 200, resultPayload('text', await analyzeText(text), text));
      }
      if (mode === 'url') {
        const target = new URL(String(fields.content || '').trim());
        const page = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!page.ok) throw Object.assign(new Error(`Unable to fetch URL (${page.status})`), { statusCode: 502 });
        const text = (await page.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
        return sendJson(response, 200, resultPayload('url', await analyzeText(text), text, target.href));
      }
      const file = files[0];
      if (mode === 'photo') {
        return sendJson(response, 200, resultPayload('photo', await analyzeImage(file)));
      }
      return sendJson(response, 200, resultPayload('file', await analyzeText(fileText(file)), fileText(file)));
      } catch (error) {
        if (creditConsumed) await refundCredit(user.user_id);
        throw error;
      }
    }

    if (request.method === 'POST' && url.pathname === '/free-ai') {
      const user = await requireAuthenticatedUser(request);
      const { fields, files } = await requestData(request);
      const mode = String(fields.mode || 'text');
      const textInput = String(fields.content || '').trim();
      const uploadedFile = files[0];
      if (!['text', 'files', 'photo'].includes(mode)) return sendError(response, 400, 'Unsupported analysis mode');
      if (mode === 'photo' && !files.length) return sendError(response, 400, 'No images uploaded');
      if (mode === 'files' && !textInput && !uploadedFile) return sendError(response, 400, 'No file or text was provided');
      if (mode === 'text' && !textInput) return sendError(response, 400, 'Text is required');

      await consumeCredit(user.user_id);
      let creditConsumed = true;
      try {
      if (mode === 'photo') {
        const details = [];
        for (const file of files) details.push({ ...await analyzeImage(file), file_name: file.filename });
        const normalized = details.map(normalizeAnalysis);
        const average = normalized.reduce((sum, item) => sum + item.ai_score, 0) / normalized.length;
        const summary = normalizeAnalysis({ ai_score: average, is_ai: average > 70, message: 'Multiple images analysed.', details: normalized.flatMap(item => item.details) });
        return sendJson(response, 200, { mode: 'photo', ai_detected: summary.is_ai, summary, details });
      }
      const content = textInput || (uploadedFile ? fileText(uploadedFile) : '');
      const analysis = normalizeAnalysis(await analyzeText(content));
      return sendJson(response, 200, { mode, ai_detected: Boolean(analysis.is_ai), result: analysis });
      } catch (error) {
        if (creditConsumed) await refundCredit(user.user_id);
        throw error;
      }
    }

    if (request.method === 'POST' && /^\/generate\/(image|video)$/.test(url.pathname)) {
      const { fields } = await requestData(request);
      if (!fields.prompt?.trim()) return sendError(response, 400, 'Prompt is required');
      const video = url.pathname.endsWith('video');
      const body = Buffer.from(generatedSvg(fields.prompt.trim(), video));
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Disposition': `attachment; filename=ai-${video ? 'video-3-minutes.svg' : 'image.svg'}` });
      return response.end(body);
    }

    if (request.method === 'POST' && url.pathname === '/recordings') {
      const { files } = await requestData(request);
      const file = files[0];
      if (!file || !file.contentType.startsWith('audio/')) return sendError(response, 400, 'Upload an audio recording');
      const filename = `recording-${crypto.randomUUID()}${path.extname(safeName(file.filename)) || '.webm'}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.data);
      return sendJson(response, 200, { message: 'Voice recording saved', filename, download_url: `/uploads/${filename}` });
    }

    if (request.method === 'POST' && url.pathname === '/chat') {
      const { fields } = await requestData(request);
      const message = String(fields.message || '').trim();
      if (!message) return sendError(response, 400, 'Message is required');
      const reply = GEMINI_API_KEY ? await geminiText(`Reply helpfully to this user. Return plain text only. User: ${message}`) : 'Gemini is not available in this environment. I can still create local image and video artifacts, save voice recordings, and run basic local text/image checks.';
      return sendJson(response, 200, { reply });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const filename = safeName(url.pathname.slice('/uploads/'.length));
      const filePath = path.join(UPLOAD_DIR, filename);
      if (!fs.existsSync(filePath)) return sendError(response, 404, 'File not found');
      response.writeHead(200); return fs.createReadStream(filePath).pipe(response);
    }
    return serveStatic(url.pathname, response);
  } catch (error) {
    return sendError(response, error.statusCode || 500, error.message);
  }
}

function serveStatic(requestPath, response) {
  const requested = requestPath === '/' ? '/index.html' : requestPath;
  const filename = path.join(ROOT, path.normalize(requested).replace(/^([/\\])+/, ''));
  if (!filename.startsWith(ROOT) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return sendError(response, 404, 'Not found');
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' });
  fs.createReadStream(filename).pipe(response);
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, '0.0.0.0', () => console.log(`AI server listening on http://127.0.0.1:${PORT}`));
}

module.exports = {
  analyzeText,
  normalizeAnalysis,
  humanizeTextLocally,
  parseModelJson,
  safeGeminiFallback,
  resultPayload,
  handle
};
