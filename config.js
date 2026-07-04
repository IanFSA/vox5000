// ════════════════════════════════════════════════════════
//  VOX5000 deployment configuration (optional)
//
//  This file lets you point VOX5000 at your own infrastructure
//  without touching room.js. Safe to deploy as-is: with everything
//  commented out, VOX5000 uses the free public PeerJS cloud for
//  signalling and the /api/turn-credentials endpoint for TURN.
//
//  RECOMMENDED FOR PRODUCTION: run your own PeerServer.
//  The free PeerJS cloud has no SLA and idle connections get dropped,
//  which is the main cause of "guest stuck on Connecting to host".
//
//  10-minute setup on Railway or Fly.io:
//    1. Deploy the official server:  npx peer --port 9000 --path /vox5000
//       (or use the peerjs/peerjs-server Docker image)
//    2. Put it behind HTTPS (Railway/Fly do this automatically)
//    3. Uncomment and fill in the block below
//    4. Commit + push — Vercel redeploys, rooms now use your server
// ════════════════════════════════════════════════════════

// window.VOX5000_PEER_CONFIG = {
//   host: 'your-peerserver.up.railway.app',
//   port: 443,
//   path: '/vox5000',
//   secure: true,
//   // key: 'peerjs', // only if your server uses a custom key
// };

// Optional: override the TURN credentials endpoint (defaults to /api/turn-credentials)
// window.VOX5000_TURN_CREDENTIALS_URL = '/api/turn-credentials';
