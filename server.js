import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const maxAssistantBodyBytes = 75000;
const assistantWindowMs = 60 * 1000;
const assistantMaxRequests = 12;
const assistantRateLimits = new Map();
const publicFileAllowlist = new Set(['/index.html']);

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
    "connect-src 'self' https://api.zippopotam.us https://davidmegginson.github.io",
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

  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 503, {
      error: 'OPENAI_API_KEY is not configured on this server.'
    });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const { question, context } = sanitizeAssistantInput(body.question, body.context);
    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: 'You are a friendly travel deal analyst inside a flight optimizer. Use only the provided app context. Do not invent live prices. Clearly distinguish verified fares from model estimates. Recommend the next click or saved fare action when useful. Keep answers concise and practical.'
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({ question, context }, null, 2)
              }
            ]
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

    sendJson(response, 200, { answer: extractOutputText(payload) });
  } catch (error) {
    sendJson(response, 400, { error: 'Invalid assistant request' });
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

  if (request.method === 'GET' || request.method === 'HEAD') {
    await serveStatic(request, response);
    return;
  }

  response.writeHead(405, securityHeaders);
  response.end('Method not allowed');
}).listen(port, () => {
  console.log(`Regional Flight Optimizer running at http://localhost:${port}`);
});
