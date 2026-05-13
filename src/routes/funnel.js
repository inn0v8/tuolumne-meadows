const express = require('express');
const { v4: uuidv4 } = require('uuid');
const steps = require('../data/personal-loan-consolidation-steps.json');
const { validateResponses, calculatePersonalLoanPrequal, validateSingleField } = require('../validation');
const store = require('../store');

const router = express.Router();

const FUNNEL_ID = 'personal-loan-consolidation';

router.get('/:funnelId/steps', (req, res) => {
  if (req.params.funnelId !== FUNNEL_ID) {
    return res.status(404).json({ error: 'Funnel not found' });
  }
  res.json(steps);
});

router.post('/:funnelId/stage', (req, res) => {
  if (req.params.funnelId !== FUNNEL_ID) {
    return res.status(404).json({ error: 'Funnel not found' });
  }

  const sessionId = uuidv4();
  const { responses, agent, session_token } = req.body;

  let debtProfile = null;
  let identity = null;
  if (session_token) {
    const swSession = store.getSpinwheelSession(session_token);
    if (swSession) {
      debtProfile = swSession.debtProfile;
      identity = swSession.identity;
    }
  }

  const validation = validateResponses(responses, steps);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Validation failed',
      missing_fields: validation.missingFields,
      invalid_fields: validation.invalidFields,
    });
  }

  store.stage(sessionId, {
    responses,
    agent: agent || { type: 'unknown' },
    session_token: session_token || null,
    debt_profile: debtProfile,
    identity,
    staged_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    session_id: sessionId,
    review_url: `${baseUrl}/review.html?session=${sessionId}`,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
});

router.get('/:funnelId/staged/:sessionId', (req, res) => {
  const data = store.getStaged(req.params.sessionId);
  if (!data) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  res.json(data);
});

router.post('/:funnelId/submit', (req, res) => {
  if (req.params.funnelId !== FUNNEL_ID) {
    return res.status(404).json({ error: 'Funnel not found' });
  }

  const { session_id, agent, consent, responses, session_token } = req.body;

  const sessionId = session_id || uuidv4();

  if (!consent || !consent.user_confirmed_at || !consent.disclosures_shown) {
    return res.status(400).json({
      error: 'Missing consent confirmation',
      required: ['user_confirmed_at', 'disclosures_shown'],
    });
  }

  const validation = validateResponses(responses, steps);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Validation failed',
      missing_fields: validation.missingFields,
      invalid_fields: validation.invalidFields,
    });
  }

  let debtProfile = null;
  if (session_token) {
    const swSession = store.getSpinwheelSession(session_token);
    if (swSession) {
      debtProfile = swSession.debtProfile;
    }
  }
  if (!debtProfile) {
    const staged = store.getStaged(sessionId);
    if (staged) debtProfile = staged.debt_profile;
  }

  const result = calculatePersonalLoanPrequal(responses, debtProfile);

  store.saveApplication(sessionId, {
    responses,
    agent: agent || { type: 'unknown' },
    consent,
    result,
    debt_profile: debtProfile,
    submitted_at: new Date().toISOString(),
  });

  store.clearStaged(sessionId);

  res.json({
    status: result.qualified ? 'prequalified' : 'not_prequalified',
    session_id: sessionId,
    result,
  });
});

router.post('/:funnelId/validate-field', (req, res) => {
  const { field_id, value, context } = req.body;

  let fieldDef = null;
  for (const step of steps.steps) {
    const found = (step.fields || []).find(f => f.id === field_id);
    if (found) { fieldDef = found; break; }
  }

  if (!fieldDef) {
    return res.status(404).json({ error: 'Field not found' });
  }

  const result = validateSingleField(fieldDef, value, context);
  res.json(result);
});

router.get('/:funnelId/status/:sessionId', (req, res) => {
  const app = store.getApplication(req.params.sessionId);
  if (!app) {
    return res.status(404).json({ error: 'Application not found' });
  }

  res.json({
    session_id: req.params.sessionId,
    status: app.result.qualified ? 'prequalified' : 'not_prequalified',
    created_at: app.submitted_at,
    result_summary: {
      qualified: app.result.qualified,
      loan_amount: app.result.loan_amount,
      estimated_rate: app.result.estimated_rate,
      estimated_monthly_payment: app.result.estimated_monthly_payment,
    },
  });
});

module.exports = router;
