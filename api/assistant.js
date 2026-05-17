import {
  extractOutputText,
  getAssistantModel,
  isSameOriginRequest,
  sanitizeAssistantInput,
  sendJson,
  validateJsonRequest
} from './_shared.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (!isSameOriginRequest(request)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    sendJson(response, 503, { error: 'ANTHROPIC_API_KEY is not configured on this deployment.' });
    return;
  }

  try {
    validateJsonRequest(request);
    const { question, context } = sanitizeAssistantInput(request.body?.question, request.body?.context);
    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: getAssistantModel(),
        max_tokens: 1024,
        system: `You are a sharp, direct travel deal advisor inside a Regional Flight Optimizer app. You have the user's nearby airports and estimated fares. Act like a knowledgeable friend who has already looked at the data — be specific and opinionated.\n\nEvery response must include:\n1. The single best deal right now: name the destination, the departure airport code, and the estimated total cost\n2. Exactly where to check it: "Open [Google Flights / Skyscanner / Kayak] and search [ORIGIN] to [DEST CODE]"\n3. One alternative or comparison worth mentioning\n\nRules:\n- Use airport codes (MCO not "Orlando"), keep it under 120 words\n- Fares in context are estimates — note "(est.)" once and move on, do not repeat the disclaimer\n- Never say "consider" or "you might want to" — say "check" or "book" or "open"\n- If context has no search results yet, tell the user exactly what to type in the search form to get started\n- For international routes, recommend Skyscanner; for domestic US, recommend Google Flights; for budget airlines, recommend checking the airline direct`,
        messages: [{ role: 'user', content: JSON.stringify({ question, context }, null, 2) }]
      })
    });

    const payload = await apiResponse.json();
    if (!apiResponse.ok) {
      sendJson(response, apiResponse.status, { error: 'Assistant request failed' });
      return;
    }

    sendJson(response, 200, { answer: extractOutputText(payload) });
  } catch (error) {
    sendJson(response, 400, { error: 'Invalid assistant request' });
  }
}
