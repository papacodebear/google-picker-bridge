// The one route public/ can't serve as a static asset.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/exchange-token' && request.method === 'POST') {
      return exchangeToken(request, env);
    }
    return new Response('Not found', { status: 404 });
  }
};

async function exchangeToken(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return json({ error: 'bridge is not configured with GOOGLE_CLIENT_ID' }, 500);
  }
  if (!env.GOOGLE_CLIENT_SECRET) {
    return json({ error: 'bridge is not configured with GOOGLE_CLIENT_SECRET' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid request body' }, 400);
  }

  const { code, clientId, redirectUri } = body || {};
  if (!code || !clientId || !redirectUri) {
    return json({ error: 'missing code, clientId, or redirectUri' }, 400);
  }

  // clientId isn't secret, safe to echo for debugging
  if (clientId !== env.GOOGLE_CLIENT_ID) {
    return json({ error: `clientId ${clientId} does not match this bridge's configured GOOGLE_CLIENT_ID ${env.GOOGLE_CLIENT_ID}` }, 403);
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString()
  });

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    return json({ error: tokenData.error_description || tokenData.error || 'token exchange failed' }, 502);
  }

  return json({ accessToken: tokenData.access_token, expiresIn: tokenData.expires_in });
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
