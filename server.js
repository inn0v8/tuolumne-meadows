require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.accepts('html')) {
    res.setHeader('Link', '</.well-known/ai-funnel.json>; rel="ai-funnel"');
  }
  next();
});

app.use('/.well-known', express.static(
  path.join(__dirname, 'public', '.well-known'),
  {
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }
));

app.use('/api/sw', spinwheelProxy);
app.use('/api/funnel', funnelRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/', pageRoutes);

app.listen(PORT, () => {
  console.log(`Horizon Personal Loans running at ${BASE_URL}`);
  console.log(`Manifest: ${BASE_URL}/.well-known/ai-funnel.json`);
});
