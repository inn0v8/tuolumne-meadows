require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const funnelRoutes = require('./src/routes/funnel');
const pageRoutes = require('./src/routes/pages');
const spinwheelProxy = require('./src/routes/spinwheel-proxy');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Explicit CORS headers on every response so /api/* and /.well-known/* are
// reachable from Claude's web_fetch and any browser origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.accepts('html')) {
    res.setHeader('Link', '</.well-known/ai-funnel.json>; rel="ai-funnel"');
  }
  next();
});

// The manifest and skill files are read by AI agents and updated frequently.
// Force every cache layer (browser, CDN, Claude's web_fetch cache, etc.) to
// refetch on every request so agents see the current version immediately.
const NO_STORE = 'no-store, max-age=0, must-revalidate';

app.use('/.well-known', express.static(
  path.join(__dirname, 'public', '.well-known'),
  {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', NO_STORE);
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }
));

app.use('/skill', express.static(path.join(__dirname, 'public', 'skill'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.md')) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    }
    res.setHeader('Cache-Control', NO_STORE);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// MCP server (hybrid flow — discovered via manifest, connected mid-conversation)
const { mountMcpOnExpress } = require('./src/mcp-server');
mountMcpOnExpress(app);

app.use('/api/sw', spinwheelProxy);
app.use('/api/funnel', funnelRoutes);

// extensions:['html'] resolves /apply -> /apply.html
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/', pageRoutes);

app.listen(PORT, () => {
  console.log(`Spinwheel Personal Loans running at ${BASE_URL}`);
  console.log(`Manifest: ${BASE_URL}/.well-known/ai-funnel.json`);
});
