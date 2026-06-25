// Vercel Serverless Function for optional WebRTC TURN credentials.
//
// Configure one of these in Vercel Project Settings > Environment Variables:
//
// 1. TURN_CREDENTIALS_JSON
//    A JSON array of RTCIceServer objects, for example:
//    [{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]
//
// 2. TURN_CREDENTIALS_URL
//    A provider endpoint that returns the same JSON array. If your provider
//    requires authorization, also set TURN_CREDENTIALS_BEARER_TOKEN.
//
// Do not commit TURN usernames, passwords, API keys, or provider tokens.

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    if (process.env.TURN_CREDENTIALS_JSON) {
      const parsed = JSON.parse(process.env.TURN_CREDENTIALS_JSON);
      res.statusCode = 200;
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed : []));
      return;
    }

    if (process.env.TURN_CREDENTIALS_URL) {
      const headers = {};
      if (process.env.TURN_CREDENTIALS_BEARER_TOKEN) {
        headers.Authorization = `Bearer ${process.env.TURN_CREDENTIALS_BEARER_TOKEN}`;
      }

      const upstream = await fetch(process.env.TURN_CREDENTIALS_URL, { headers });
      if (!upstream.ok) throw new Error(`TURN provider returned ${upstream.status}`);

      const data = await upstream.json();
      res.statusCode = 200;
      res.end(JSON.stringify(Array.isArray(data) ? data : []));
      return;
    }

    res.statusCode = 204;
    res.end();
  } catch (err) {
    console.error('TURN credentials error:', err);
    res.statusCode = 200;
    res.end(JSON.stringify([]));
  }
};
