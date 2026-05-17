import { isSameOriginRequest, sendJson, validateJsonRequest, getAssistantModel } from './_shared.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed' }); return; }
  if (!isSameOriginRequest(request)) { sendJson(response, 403, { error: 'Forbidden' }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { sendJson(response, 503, { error: 'ANTHROPIC_API_KEY not configured' }); return; }

  try {
    validateJsonRequest(request);
    const message = String(request.body?.message || '').trim().slice(0, 500);
    const today = new Date().toISOString().slice(0, 10);
    const currentState = request.body?.currentState && typeof request.body.currentState === 'object'
      ? request.body.currentState : {};

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getAssistantModel(),
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
  "response": "One friendly sentence confirming what you'll search for."
}`,
        messages: [{ role: 'user', content: message }]
      })
    });

    const payload = await apiResponse.json();
    if (!apiResponse.ok) { sendJson(response, apiResponse.status, { error: 'Intent parsing failed' }); return; }

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
