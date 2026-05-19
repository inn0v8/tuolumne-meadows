const express = require('express');
const router = express.Router();

router.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Privacy Policy - Happen Bank</title>
<meta name="ai-funnel" content="/.well-known/ai-funnel.json">
<style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a2b4a}</style>
</head><body>
<h1>Privacy Policy</h1>
<p><strong>Happen Bank (Demo)</strong></p>
<p>This is a demonstration application. No real personal data is collected or stored permanently.</p>
<p>In this demo, all data submitted through the AI funnel or the traditional application form is stored in server memory only and is deleted when the server restarts. No data is written to disk, shared with third parties, or used for any purpose beyond demonstrating the AI Application Funnel Protocol.</p>
<p>Identity verification and credit data are performed via Spinwheel Solutions, Inc. using their sandbox environment. No real consumer data is processed.</p>
<p>In a production implementation, this page would contain a comprehensive privacy policy covering data collection, use, sharing, retention, and user rights under applicable regulations (CCPA, GDPR, GLBA, etc.).</p>
</body></html>`);
});

router.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Terms of Service - Happen Bank</title>
<meta name="ai-funnel" content="/.well-known/ai-funnel.json">
<style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a2b4a}</style>
</head><body>
<h1>Terms of Service</h1>
<p><strong>Happen Bank (Demo)</strong></p>
<p>This is a demonstration application. No real loans are being offered, processed, or committed to.</p>
<p>The pre-qualification results shown are calculated using simplified formulas for demonstration purposes only and do not constitute actual lending decisions or commitments.</p>
<p>This demo is designed to illustrate the AI Application Funnel Protocol (AAFP) and how AI assistants can help users complete structured application workflows conversationally.</p>
</body></html>`);
});

router.get('/api/debug/applications', (req, res) => {
  const store = require('../store');
  res.json(store.listApplications());
});

module.exports = router;
