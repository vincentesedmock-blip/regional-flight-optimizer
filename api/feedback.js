import { isSameOriginRequest, sendJson, validateJsonRequest } from './_shared.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (!isSameOriginRequest(request)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    validateJsonRequest(request);
    const payload = {
      createdAt: new Date().toISOString(),
      feedback: String(request.body?.feedback || '').slice(0, 5000),
      currentSettings: request.body?.currentSettings || {},
      diagnostics: request.body?.diagnostics || null,
      dealRepository: Array.isArray(request.body?.dealRepository) ? request.body.dealRepository.slice(0, 20) : []
    };

    // Serverless deployments do not have a durable local filesystem.
    // Return the normalized payload so the browser can keep its local copy.
    sendJson(response, 200, {
      saved: true,
      storage: 'browser-local',
      feedback: payload
    });
  } catch (error) {
    sendJson(response, 400, { error: 'Invalid feedback request' });
  }
}
