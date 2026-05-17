import { createServer } from 'node:http';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const root = fileURLToPath(new URL('.', import.meta.url));

// Load .env file if present (no dotenv package required)
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val && !process.env[key]) process.env[key] = val;
  }
}

const port = Number(process.env.PORT || 3000);
const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// ── User auth storage ──────────────────────────────────────────────────────
const dataDir = join(root, 'data');
const usersFile = join(dataDir, 'users.json');
const sessions = new Map(); // token → { userId, expiresAt }
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function readUsers() {
  try { return JSON.parse(await readFile(usersFile, 'utf8')); } catch { return { users: [] }; }
}

async function writeUsers(data) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(usersFile, JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hashed) {
  const attempt = Buffer.from(hashPassword(password, salt), 'hex');
  const stored = Buffer.from(hashed, 'hex');
  return attempt.length === stored.length && timingSafeEqual(attempt, stored);
}

function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSessionUser(request, users) {
  const auth = request.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || Date.now() > session.expiresAt) { if (session) sessions.delete(token); return null; }
  return users.find(u => u.id === session.userId) || null;
}
const maxAssistantBodyBytes = 75000;
const assistantWindowMs = 60 * 1000;
const assistantMaxRequests = 12;
const assistantRateLimits = new Map();
const publicFileAllowlist = new Set(['/index.html']);
const feedbackFile = join(root, 'feedback-inbox.jsonl');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://images.unsplash.com data:",
    "connect-src 'self' https://nominatim.openstreetmap.org https://davidmegginson.github.io https://api.anthropic.com",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    ...securityHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Expected application/json');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > maxAssistantBodyBytes) {
      throw new Error('Request body is too large');
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function extractOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function getClientIp(request) {
  return request.socket.remoteAddress || 'unknown';
}

function isRateLimited(request) {
  const ip = getClientIp(request);
  const now = Date.now();
  const bucket = assistantRateLimits.get(ip) || { count: 0, resetAt: now + assistantWindowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + assistantWindowMs;
  }

  bucket.count += 1;
  assistantRateLimits.set(ip, bucket);
  return bucket.count > assistantMaxRequests;
}

function isSameOriginAssistantRequest(request) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  const referer = request.headers.referer;

  if (origin) {
    return origin === `http://${host}` || origin === `https://${host}`;
  }

  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch (error) {
      return false;
    }
  }

  return true;
}

function sanitizeAssistantInput(question, context) {
  const cleanQuestion = String(question || '').trim().slice(0, 1000);
  const safeContext = context && typeof context === 'object' ? context : {};

  return {
    question: cleanQuestion || 'What are the best deals in this search?',
    context: {
      settings: safeContext.settings || {},
      counts: safeContext.counts || {},
      topIdeas: Array.isArray(safeContext.topIdeas) ? safeContext.topIdeas.slice(0, 12) : [],
      verifiedDeals: Array.isArray(safeContext.verifiedDeals) ? safeContext.verifiedDeals.slice(0, 8) : []
    }
  };
}

async function handleAssistant(request, response) {
  if (!isSameOriginAssistantRequest(request)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  if (isRateLimited(request)) {
    sendJson(response, 429, { error: 'Too many assistant requests. Please wait a minute and try again.' });
    return;
  }

  const { users } = await readUsers();
  const sessionUser = getSessionUser(request, users);
  const apiKey = sessionUser?.apiKey || null;

  if (!apiKey) {
    sendJson(response, 503, {
      error: 'no_api_key'
    });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const { question, context } = sanitizeAssistantInput(body.question, body.context);
    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: `You are a sharp, direct travel deal advisor inside a Regional Flight Optimizer app. You have the user's nearby airports and estimated fares. Act like a knowledgeable friend who has already looked at the data — be specific and opinionated.

Every response must include:
1. The single best deal right now: name the destination, the departure airport code, and the estimated total cost
2. Exactly where to check it: "Open [Google Flights / Skyscanner / Kayak] and search [ORIGIN] to [DEST CODE]"
3. One alternative or comparison worth mentioning

Rules:
- Use airport codes (MCO not "Orlando"), keep it under 120 words
- Fares in context are estimates — note "(est.)" once and move on, do not repeat the disclaimer
- Never say "consider" or "you might want to" — say "check" or "book" or "open"
- If context has no search results yet, tell the user exactly what to type in the search form to get started (specific location, filter, date range)
- For international routes, recommend Skyscanner; for domestic US, recommend Google Flights; for budget airlines, recommend checking the airline direct`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({ question, context }, null, 2)
          }
        ]
      })
    });

    const payload = await apiResponse.json();
    if (!apiResponse.ok) {
      sendJson(response, apiResponse.status, {
        error: 'Assistant request failed'
      });
      return;
    }

    const answer = (payload.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    sendJson(response, 200, { answer });
  } catch (error) {
    sendJson(response, 400, { error: 'Invalid assistant request' });
  }
}

async function handleIntent(request, response) {
  if (!isSameOriginAssistantRequest(request)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  const { users: intentUsers } = await readUsers();
  const intentSessionUser = getSessionUser(request, intentUsers);
  const intentApiKey = intentSessionUser?.apiKey || null;

  if (!intentApiKey) {
    sendJson(response, 503, { error: 'no_api_key' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const message = String(body.message || '').trim().slice(0, 500);
    const today = new Date().toISOString().slice(0, 10);
    const currentState = body.currentState && typeof body.currentState === 'object' ? body.currentState : {};

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': intentApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        system: `You parse travel search requests into form fields. Return ONLY valid JSON, no markdown.

Today: ${today}. Current form: ${JSON.stringify(currentState)}.

JSON structure (omit fields not clearly implied):
{
  "fields": {
    "homeLocation": "city or address if user mentions where they're flying FROM",
    "destinationTarget": "specific city, country, or airport code if a clear destination is given",
    "destinationFilter": "space-separated theme keywords: europe, beach, island, mountains, city, international, asia, caribbean, etc.",
    "departStart": "YYYY-MM-DD — use first day of the mentioned month if only a month is given",
    "returnEnd": "YYYY-MM-DD — use last day of the mentioned month if only a month is given",
    "tripDays": 5,
    "adults": 2,
    "maxRadius": 2.5
  },
  "response": "One friendly sentence confirming what you'll search for. Mention destination and dates if given."
}`,
        messages: [{ role: 'user', content: message }]
      })
    });

    const payload = await apiResponse.json();
    if (!apiResponse.ok) {
      sendJson(response, apiResponse.status, { error: 'Intent parsing failed' });
      return;
    }

    const text = (payload.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    try {
      const parsed = JSON.parse(text.replace(/^```json\n?|```$/g, ''));
      sendJson(response, 200, { fields: parsed.fields || {}, response: parsed.response || '' });
    } catch {
      sendJson(response, 200, { fields: {}, response: text.slice(0, 200) });
    }
  } catch {
    sendJson(response, 400, { error: 'Invalid intent request' });
  }
}

// ── Auth handlers ──────────────────────────────────────────────────────────

async function handleAuthRegister(request, response) {
  if (!isSameOriginAssistantRequest(request)) { sendJson(response, 403, { error: 'Forbidden' }); return; }
  try {
    const body = await readJsonBody(request);
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    if (!email.includes('@') || email.length > 200) { sendJson(response, 400, { error: 'Enter a valid email address' }); return; }
    if (password.length < 8) { sendJson(response, 400, { error: 'Password must be at least 8 characters' }); return; }

    const data = await readUsers();
    if (data.users.find(u => u.email === email)) { sendJson(response, 409, { error: 'An account with that email already exists' }); return; }

    const salt = randomBytes(16).toString('hex');
    const id = randomBytes(16).toString('hex');
    data.users.push({ id, email, hashedPassword: hashPassword(password, salt), salt, apiKey: null, createdAt: new Date().toISOString() });
    await writeUsers(data);

    const token = createSession(id);
    sendJson(response, 200, { token, email, hasApiKey: false });
  } catch { sendJson(response, 400, { error: 'Registration failed' }); }
}

async function handleAuthLogin(request, response) {
  if (!isSameOriginAssistantRequest(request)) { sendJson(response, 403, { error: 'Forbidden' }); return; }
  try {
    const body = await readJsonBody(request);
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');

    const { users } = await readUsers();
    const user = users.find(u => u.email === email);
    if (!user || !verifyPassword(password, user.salt, user.hashedPassword)) {
      sendJson(response, 401, { error: 'Incorrect email or password' }); return;
    }

    const token = createSession(user.id);
    sendJson(response, 200, { token, email: user.email, hasApiKey: !!user.apiKey });
  } catch { sendJson(response, 400, { error: 'Login failed' }); }
}

async function handleAuthLogout(request, response) {
  const auth = request.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) sessions.delete(token);
  sendJson(response, 200, { ok: true });
}

async function handleAuthMe(request, response) {
  const { users } = await readUsers();
  const user = getSessionUser(request, users);
  if (!user) { sendJson(response, 401, { error: 'Not authenticated' }); return; }
  sendJson(response, 200, { email: user.email, hasApiKey: !!user.apiKey });
}

async function handleAuthUpdateKey(request, response) {
  if (!isSameOriginAssistantRequest(request)) { sendJson(response, 403, { error: 'Forbidden' }); return; }
  try {
    const data = await readUsers();
    const user = getSessionUser(request, data.users);
    if (!user) { sendJson(response, 401, { error: 'Not authenticated' }); return; }

    const body = await readJsonBody(request);
    const apiKey = String(body.apiKey || '').trim();
    if (apiKey && !apiKey.startsWith('sk-ant-')) { sendJson(response, 400, { error: 'That doesn\'t look like an Anthropic API key (should start with sk-ant-)' }); return; }

    const idx = data.users.findIndex(u => u.id === user.id);
    data.users[idx].apiKey = apiKey || null;
    await writeUsers(data);
    sendJson(response, 200, { ok: true });
  } catch { sendJson(response, 400, { error: 'Failed to save API key' }); }
}

async function handleFeedback(request, response) {
  if (!isSameOriginAssistantRequest(request)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const payload = {
      createdAt: new Date().toISOString(),
      feedback: String(body.feedback || '').slice(0, 5000),
      currentSettings: body.currentSettings || {},
      diagnostics: body.diagnostics || null,
      dealRepository: Array.isArray(body.dealRepository) ? body.dealRepository.slice(0, 20) : []
    };
    await appendFile(feedbackFile, `${JSON.stringify(payload)}\n`, 'utf8');
    sendJson(response, 200, { saved: true, file: 'feedback-inbox.jsonl' });
  } catch (error) {
    sendJson(response, 400, { error: 'Invalid feedback request' });
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = normalize(join(root, pathname));
  const publicPath = `/${relative(root, filePath).replace(/\\/g, '/')}`;

  if (!filePath.startsWith(root) || publicPath.includes('/.') || !publicFileAllowlist.has(publicPath)) {
    response.writeHead(403, securityHeaders);
    response.end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream'
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(file);
    }
  } catch (error) {
    response.writeHead(404, securityHeaders);
    response.end('Not found');
  }
}

createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/api/assistant') {
    await handleAssistant(request, response);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/intent') {
    await handleIntent(request, response);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/auth/register') {
    await handleAuthRegister(request, response);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/auth/login') {
    await handleAuthLogin(request, response);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/auth/logout') {
    await handleAuthLogout(request, response);
    return;
  }

  if (request.method === 'GET' && request.url === '/api/auth/me') {
    await handleAuthMe(request, response);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/auth/update-key') {
    await handleAuthUpdateKey(request, response);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/feedback') {
    await handleFeedback(request, response);
    return;
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    await serveStatic(request, response);
    return;
  }

  response.writeHead(405, securityHeaders);
  response.end('Method not allowed');
}).listen(port, () => {
  console.log(`Regional Flight Optimizer running at http://localhost:${port}`);
});
