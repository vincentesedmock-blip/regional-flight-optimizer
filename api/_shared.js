const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const maxBodyBytes = 75000;

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

export function sendJson(response, status, payload) {
  response.status(status);
  Object.entries({
    ...securityHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  }).forEach(([key, value]) => response.setHeader(key, value));
  response.json(payload);
}

export function isSameOriginRequest(request) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  const referer = request.headers.referer;

  if (origin) return origin === `http://${host}` || origin === `https://${host}`;
  if (!referer) return true;

  try {
    return new URL(referer).host === host;
  } catch (error) {
    return false;
  }
}

export function validateJsonRequest(request) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Expected application/json');
  }

  const size = Number(request.headers['content-length'] || 0);
  if (size > maxBodyBytes) {
    throw new Error('Request body is too large');
  }
}

export function sanitizeAssistantInput(question, context) {
  const cleanQuestion = String(question || '').trim().slice(0, 1000);
  const safeContext = context && typeof context === 'object' ? context : {};

  return {
    question: cleanQuestion || 'What are the best deals in this search?',
    context: {
      settings: safeContext.settings || {},
      counts: safeContext.counts || {},
      topIdeas: Array.isArray(safeContext.topIdeas) ? safeContext.topIdeas.slice(0, 12) : [],
      verifiedDeals: Array.isArray(safeContext.verifiedDeals) ? safeContext.verifiedDeals.slice(0, 8) : [],
      dealRepository: Array.isArray(safeContext.dealRepository) ? safeContext.dealRepository.slice(0, 12) : []
    }
  };
}

export function extractOutputText(payload) {
  if (Array.isArray(payload.content)) {
    return payload.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  }
  return '';
}

export function getAssistantModel() {
  return model;
}
