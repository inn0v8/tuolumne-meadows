const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const sw = require('./spinwheel-client');
const fs = require('fs');
const path = require('path');

function createMcpServer() {
  const server = new McpServer({
    name: 'spinwheel-personal-loans',
    version: '1.0.0',
  }, {
    capabilities: { tools: {} },
  });

  // ── Tool 1: get_funnel_manifest ──
  server.tool(
    'get_funnel_manifest',
    'Get the AI Application Funnel Protocol manifest for Spinwheel Personal Loans. ' +
    'Call this FIRST to understand what funnels are available, read the consent disclosures ' +
    '(you MUST show these before collecting any data), and get the full agent instructions. ' +
    'The manifest contains CRITICAL_FLOW_ORDER (the exact steps to follow), DO_NOT rules ' +
    '(hard prohibitions), and ONLY_ASK_MANUALLY (the only fields the user should type).',
    {},
    async () => {
      try {
        const manifestPath = path.join(__dirname, '..', 'public', '.well-known', 'ai-funnel.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return { content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error reading manifest: ${err.message}` }], isError: true };
      }
    }
  );

  // ── Tool 2: get_funnel_steps ──
  server.tool(
    'get_funnel_steps',
    'Get the complete step and field definitions for the personal loan consolidation funnel. ' +
    'Returns all steps with fields, validation rules, conditional logic, and conversational ' +
    'guidance (ask_as, help, if_unsure, grouping, sensitivity). You generally do NOT need ' +
    'this if you follow the CRITICAL_FLOW_ORDER from the manifest — the Spinwheel tools ' +
    'handle most data collection automatically.',
    {},
    async () => {
      try {
        const dataDir = path.join(__dirname, 'data');
        const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
        const stepsFile = files.find(f => f.endsWith('-steps.json') || f.endsWith('steps.json'));
        if (!stepsFile) {
          return { content: [{ type: 'text', text: `No steps file found. Files: ${files.join(', ')}` }], isError: true };
        }
        const steps = JSON.parse(fs.readFileSync(path.join(dataDir, stepsFile), 'utf8'));
        return { content: [{ type: 'text', text: JSON.stringify(steps, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── Tool 3: spinwheel_connect ──
  server.tool(
    'spinwheel_connect',
    'STEP 3 in the flow. Initiate Spinwheel identity verification via SMS. ' +
    'Call this AFTER showing consent disclosures (STEP 1) and collecting phone + DOB (STEP 2). ' +
    'Sends a 6-digit OTP code to the user\'s phone. Returns a session_token for all subsequent calls. ' +
    'IMPORTANT: Before calling this, you must have shown the consent disclosures from the manifest ' +
    'AND the Spinwheel consent text. The user must have agreed to proceed. ' +
    'After this call, ask the user for the 6-digit code they received.',
    {
      phone: z.string().describe('US phone number, e.g. "4155551234" or "(415) 555-1234"'),
      dob: z.string().describe('Date of birth: "1990-03-15", "March 15, 1990", or "3/15/1990"'),
    },
    async ({ phone, dob }) => {
      try {
        const cleanPhone = phone.replace(/\D/g, '');
        const phoneNumber = cleanPhone.length === 11 && cleanPhone.startsWith('1')
          ? cleanPhone.slice(1) : cleanPhone;
        if (phoneNumber.length !== 10) {
          return { content: [{ type: 'text', text: 'Invalid phone number. Provide a 10-digit US number.' }], isError: true };
        }
        const dobNormalized = normalizeDOB(dob);
        if (!dobNormalized) {
          return { content: [{ type: 'text', text: 'Could not parse date of birth. Use YYYY-MM-DD or similar.' }], isError: true };
        }
        const sessionToken = uuidv4();
        const extUserId = `sw-loans-${uuidv4()}`;
        // Spinwheel-client phone arg is the raw 10-digit number; client adds E.164 prefix.
        const e164 = `+1${phoneNumber}`;
        const result = await sw.connectSMS(e164, dobNormalized, extUserId);
        store.createSpinwheelSession(sessionToken, {
          spinwheelUserId: result.userId,
          extUserId,
          phone: e164,
          dob: dobNormalized,
          connectionStatus: result.connectionStatus,
          createdAt: new Date().toISOString(),
          identity: null,
          debtProfile: null,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              session_token: sessionToken,
              status: result.connectionStatus,
              next_step: 'Ask the user for the 6-digit verification code sent to their phone.',
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Spinwheel connect failed: ${err.data?.message || err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool 4: spinwheel_verify ──
  server.tool(
    'spinwheel_verify',
    'STEP 5 in the flow. Verify the OTP code from the user. Call this AFTER spinwheel_connect ' +
    'and AFTER the user provides their 6-digit code (STEP 4). ' +
    'On success, returns verified identity: full_name, address, ssn_last4, phone. ' +
    'CRITICAL: This is why you NEVER ask the user for their name, address, or SSN — ' +
    'this tool provides all of that automatically. ' +
    'After success, present the identity to the user and ask them to confirm it is correct (STEP 6). ' +
    'NEVER repeat the SSN digits — just say "I have your SSN on file from verification."',
    {
      session_token: z.string().describe('session_token from spinwheel_connect'),
      otp_code: z.string().describe('6-digit code the user received via SMS'),
    },
    async ({ session_token, otp_code }) => {
      try {
        const session = store.getSpinwheelSession(session_token);
        if (!session) {
          return { content: [{ type: 'text', text: 'Session not found or expired. Restart verification.' }], isError: true };
        }
        const result = await sw.verifySMS(session.spinwheelUserId, otp_code);
        if (result.connectionStatus !== 'SUCCESS') {
          return {
            content: [{ type: 'text', text: `Verification failed (${result.connectionStatus}). Ask user to check the code.` }],
            isError: true,
          };
        }
        // Identity is only populated after debt profile pulls the credit report; leave null here.
        store.updateSpinwheelSession(session_token, { connectionStatus: 'SUCCESS' });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              verified: true,
              identity: null,
              next_step: 'Verification confirmed. Call spinwheel_debt_profile next — identity (name, address, SSN last-4) is returned from that call along with the debts.',
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Verify error: ${err.data?.message || err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool 5: spinwheel_debt_profile ──
  server.tool(
    'spinwheel_debt_profile',
    'STEP 7 in the flow. Pull the user\'s complete debt profile from their credit report. ' +
    'Call this AFTER spinwheel_verify succeeds and the user confirms their identity (STEP 6). ' +
    'Returns ALL credit cards, auto loans, student loans, personal loans, and home loans ' +
    'with balances, limits, utilization, and monthly payments. Also returns credit score and ' +
    'a summary with totals. ' +
    'CRITICAL: This is why you NEVER ask the user for their credit score, monthly debts, ' +
    'or existing accounts — this tool provides all of that automatically. ' +
    'After this call, present all credit cards with selectable=true and ask the user which ' +
    'ones they want to consolidate (STEP 8).',
    {
      session_token: z.string().describe('session_token from a verified session'),
    },
    async ({ session_token }) => {
      try {
        const session = store.getSpinwheelSession(session_token);
        if (!session) {
          return { content: [{ type: 'text', text: 'Session not found or expired.' }], isError: true };
        }
        if (session.connectionStatus !== 'SUCCESS') {
          return { content: [{ type: 'text', text: 'User not verified. Complete OTP verification first.' }], isError: true };
        }
        await sw.requestDebtProfile(session.spinwheelUserId);
        await sleep(4000);
        const userProfile = await sw.getUserProfile(session.spinwheelUserId);
        const userObj = Array.isArray(userProfile) ? userProfile[0] : userProfile;
        const identity = extractIdentity(userObj, session);
        const debts = transformDebtProfile(userObj);
        const updates = { debtProfile: debts };
        if (identity) {
          updates.identity = identity;
          updates.fullSSN = identity._fullSSN || null;
          delete identity._fullSSN;
        }
        store.updateSpinwheelSession(session_token, updates);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...debts,
              identity,
              next_step: `Found ${debts.summary.account_count} accounts. ` +
                `${debts.summary.selectable_card_count} credit cards eligible for consolidation ` +
                `($${debts.summary.selectable_card_total.toLocaleString()} total). ` +
                'Present the selectable cards and ask the user which to consolidate. ' +
                'Then ask ONLY for: email, annual income, employment status, preferred loan term.',
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Debt profile error: ${err.data?.message || err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool 6: spinwheel_refresh_balance ──
  server.tool(
    'spinwheel_refresh_balance',
    'Optional. Trigger a live balance refresh from the card issuer for a specific credit card. ' +
    'Use when the user wants the most current balance before deciding which cards to consolidate. ' +
    'Real-time refresh is only available for cards where can_refresh_balance=true in the debt profile ' +
    '(typically major issuers like Chase, Citi, Amex, etc. that Spinwheel has direct connections to). ' +
    'For cards without realtime support, this tool returns an explanatory error rather than a number. ' +
    'On any error, report the exact error message to the user verbatim — do not paraphrase as ' +
    '"the backend is broken" or "this is a demo limitation." The error usually explains exactly ' +
    'which card or capability is unavailable.',
    {
      session_token: z.string().describe('session_token from a verified session'),
      liability_id: z.string().describe('The id of the credit card to refresh (creditCardId from spinwheel_debt_profile)'),
    },
    async ({ session_token, liability_id }) => {
      try {
        const session = store.getSpinwheelSession(session_token);
        if (!session) {
          return { content: [{ type: 'text', text: 'Session not found or expired. Restart with spinwheel_connect.' }], isError: true };
        }

        // Step 1: snapshot the card's pre-refresh state so we can detect when fresh data arrives.
        const beforeProfile = await sw.getUserProfile(session.spinwheelUserId);
        const beforeObj = Array.isArray(beforeProfile) ? beforeProfile[0] : beforeProfile;
        const beforeCard = findLiability(beforeObj, liability_id);
        if (!beforeCard) {
          return {
            content: [{ type: 'text', text: `Liability ${liability_id} not found in user profile. List cards via spinwheel_debt_profile first.` }],
            isError: true,
          };
        }
        const beforeUpdatedOn = beforeCard.balanceDetails?.updatedOn || 0;
        const supports = beforeCard.capabilities?.data?.realtimeBalance?.availability === 'SUPPORTED'
          || beforeCard.capabilities?.realtimeBalance?.availability === 'SUPPORTED'
          || beforeCard.capabilities?.data?.realtimeBalance?.supported === true;
        if (!supports) {
          const cap = beforeCard.capabilities?.data?.realtimeBalance
            || beforeCard.capabilities?.realtimeBalance
            || beforeCard.capabilities
            || null;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'not_supported',
                message: `This card does not support real-time balance refresh. Spinwheel only offers realtime refresh for cards from issuers it has direct connections to. The most recent balance from the credit report is $${beforeCard.balanceDetails?.outstandingBalance ?? 'unknown'} (last updated ${beforeCard.balanceDetails?.updatedOn ? new Date(beforeCard.balanceDetails.updatedOn).toISOString() : 'unknown'}).`,
                capabilities_observed: cap,
              }),
            }],
            isError: true,
          };
        }

        // Step 2: trigger the refresh.
        const extRequestId = `refresh-${uuidv4()}`;
        let refreshResp;
        try {
          refreshResp = await sw.refreshLiabilityBalance(session.spinwheelUserId, liability_id, extRequestId);
        } catch (apiErr) {
          return {
            content: [{
              type: 'text',
              text: `Spinwheel rejected the refresh request (HTTP ${apiErr.status}): ${apiErr.data?.status?.messages?.[0]?.desc || apiErr.data?.message || apiErr.message}. Raw response: ${JSON.stringify(apiErr.data)}`,
            }],
            isError: true,
          };
        }

        // Step 3: poll for the card's balanceDetails.updatedOn to advance past beforeUpdatedOn.
        let attempts = 0;
        while (attempts < 8) {
          await sleep(2500);
          attempts++;
          const profile = await sw.getUserProfile(session.spinwheelUserId);
          const obj = Array.isArray(profile) ? profile[0] : profile;
          const card = findLiability(obj, liability_id);
          const updatedOn = card?.balanceDetails?.updatedOn || 0;
          if (updatedOn > beforeUpdatedOn) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'completed',
                  balance: card.balanceDetails.outstandingBalance
                    ?? card.balanceDetails.currentBalance
                    ?? card.cardProfile?.currentBalance,
                  available_credit: card.balanceDetails.availableCredit ?? card.cardProfile?.availableCreditDerived,
                  min_payment_due: card.balanceDetails.minimumPaymentDue,
                  last_payment_amount: card.balanceDetails.lastPaymentAmount,
                  last_payment_date: card.balanceDetails.lastPaymentDate,
                  updated_at: new Date(updatedOn).toISOString(),
                  poll_attempts: attempts,
                }),
              }],
            };
          }
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'timeout',
              message: `Refresh was accepted by Spinwheel but no fresh balance arrived within ${attempts * 2.5}s. The cached balance from the credit report is $${beforeCard.balanceDetails?.outstandingBalance}. Spinwheel POST response: ${JSON.stringify(refreshResp)}`,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected refresh error: ${err.message} (stack: ${err.stack?.split('\n')[0] || 'n/a'})` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool 7: funnel_stage ──
  server.tool(
    'funnel_stage',
    'STEP 10b (alternative to funnel_submit). Stage the completed application and return ' +
    'a review URL the user can open to see all data and click Submit on the website. ' +
    'Use this if you want the user to do a final review on the website before submitting. ' +
    'Call this AFTER the user confirms the review summary (STEP 10).',
    {
      session_token: z.string().describe('Spinwheel session_token'),
      responses: z.record(z.any()).describe('All collected field values keyed by field_id'),
    },
    async ({ session_token, responses }) => {
      try {
        const sessionId = uuidv4();
        const swSession = store.getSpinwheelSession(session_token);
        store.stage(sessionId, {
          responses,
          spinwheel_session_token: session_token,
          identity: swSession?.identity || null,
          debt_profile: swSession?.debtProfile || null,
          agent: { type: 'claude', interface: 'mcp' },
          staged_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
        const baseUrl = process.env.BASE_URL || 'https://loans.spinwheel.ai';
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              session_id: sessionId,
              review_url: `${baseUrl}/review.html?session=${sessionId}`,
              expires_in: '1 hour',
            }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Staging error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── Tool 8: funnel_submit ──
  server.tool(
    'funnel_submit',
    'STEP 11 in the flow. Submit the application directly and get the pre-qualification result. ' +
    'Call this AFTER the user reviews and confirms all data (STEP 10). ' +
    'Returns whether qualified, estimated rate, monthly payment, interest savings, highlights, ' +
    'concerns, and next steps. Present the result conversationally. ' +
    'If qualified, be encouraging. If not, be supportive and share suggestions. ' +
    'CRITICAL: The only fields the user typed manually should be: email, annual_income, ' +
    'employment_status, and preferred_term. Everything else came from Spinwheel.',
    {
      session_token: z.string().describe('Spinwheel session_token'),
      responses: z.record(z.any()).describe('All collected field values keyed by field_id'),
    },
    async ({ session_token, responses }) => {
      try {
        const validation = require('./validation');
        const session = store.getSpinwheelSession(session_token);
        const debtProfile = session?.debtProfile || null;
        const calcFn = validation.calculatePersonalLoanPrequal || validation.calculatePrequalification;
        const result = calcFn(responses, debtProfile);
        const sessionId = uuidv4();
        store.saveApplication(sessionId, {
          responses,
          spinwheel_session_token: session_token,
          agent: { type: 'claude', interface: 'mcp' },
          consent: {
            user_confirmed_at: new Date().toISOString(),
            disclosures_shown: true,
            privacy_acknowledged: true,
            terms_acknowledged: true,
          },
          result,
          submitted_at: new Date().toISOString(),
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: result.qualified ? 'prequalified' : 'not_prequalified',
              session_id: sessionId,
              result,
            }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Submit error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── Tool 9: funnel_status ──
  server.tool(
    'funnel_status',
    'Check the status of a previously submitted application.',
    {
      session_id: z.string().describe('session_id from funnel_submit or funnel_stage'),
    },
    async ({ session_id }) => {
      const app = store.getApplication(session_id);
      if (!app) {
        return { content: [{ type: 'text', text: 'Application not found.' }], isError: true };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            session_id,
            status: app.result?.qualified ? 'prequalified' : 'not_prequalified',
            submitted_at: app.submitted_at,
            result_summary: {
              qualified: app.result?.qualified,
              loan_amount: app.result?.loan_amount,
              estimated_rate: app.result?.estimated_rate,
              monthly_payment: app.result?.estimated_monthly_payment,
            },
          }),
        }],
      };
    }
  );

  return server;
}


// ── Mount on Express ──
// Primary: Streamable HTTP at /mcp (the current MCP spec transport — required by
// Claude.ai's hosted Custom Connectors and the MCP Inspector's "Streamable HTTP" mode).
// Legacy: SSE at /mcp/sse for older MCP Inspector configurations.
function mountMcpOnExpress(app) {
  // ─── Streamable HTTP (stateless) at /mcp ───
  // Stateless: build a fresh server+transport per request. Tool registrations are
  // pure (no I/O), so the per-request cost is negligible. Server-side mutable state
  // (the store module's Maps) is shared across calls.
  app.all('/mcp', async (req, res) => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP /mcp error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message || 'Internal error' },
          id: null,
        });
      }
    }
  });

  // ─── Legacy SSE at /mcp/sse ───
  const sseServer = createMcpServer();
  const sseTransports = {};

  app.get('/mcp/sse', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/sse', res);
    const sessionId = transport.sessionId;
    sseTransports[sessionId] = transport;
    res.on('close', () => { delete sseTransports[sessionId]; });
    await sseServer.connect(transport);
  });

  app.post('/mcp/sse', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = sseTransports[sessionId];
    if (!transport) {
      return res.status(400).json({ error: 'No active SSE session. Connect via GET /mcp/sse first.' });
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  console.log('MCP server mounted: /mcp (Streamable HTTP) + /mcp/sse (legacy SSE)');
  return sseServer;
}


// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findLiability(userObj, liability_id) {
  if (!userObj) return null;
  const all = [
    ...(userObj.creditCards || []),
    ...(userObj.autoLoans || []),
    ...(userObj.studentLoans || []),
    ...(userObj.personalLoans || []),
    ...(userObj.homeLoans || []),
  ];
  return all.find(l =>
    l.creditCardId === liability_id ||
    l.autoLoanId === liability_id ||
    l.studentLoanId === liability_id ||
    l.personalLoanId === liability_id ||
    l.homeLoanId === liability_id
  ) || null;
}

function normalizeDOB(dob) {
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(dob)) {
    const [, y, m, d] = dob.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  const us = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  const months = {january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
    july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'};
  const txt = dob.match(/^(\w+)\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (txt && months[txt[1].toLowerCase()]) {
    return `${txt[3]}-${months[txt[1].toLowerCase()]}-${txt[2].padStart(2,'0')}`;
  }
  return null;
}

function titleCase(s) {
  if (!s) return s;
  return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function extractIdentity(userObj, session) {
  if (!userObj) return null;
  const cr = (userObj.creditReports || [])[0];
  const profile = cr?.profile;
  if (!profile) return null;
  const addresses = profile.addresses || [];
  const current = addresses.find(a => a.residencyType === 'CURRENT') || addresses[0] || null;
  const firstName = profile.firstName ? titleCase(profile.firstName) : null;
  const lastName = profile.lastName ? titleCase(profile.lastName) : null;
  const ssnRaw = profile.ssn ? String(profile.ssn) : null;
  return {
    first_name: firstName,
    last_name: lastName,
    full_name: [firstName, lastName].filter(Boolean).join(' '),
    dob: profile.dateOfBirth || session.dob,
    address: current ? {
      street: titleCase(current.addressLine1 || ''),
      city: titleCase(current.city || ''),
      state: current.state || null,
      zip: current.zip || null,
    } : null,
    ssn_last4: ssnRaw ? ssnRaw.slice(-4) : null,
    phone: session.phone,
    _fullSSN: ssnRaw,
  };
}

function transformDebtProfile(userData) {
  if (!userData) userData = {};
  const cardBal = (c) => c.balanceDetails?.outstandingBalance
      ?? c.balanceDetails?.currentBalance
      ?? c.cardProfile?.currentBalance
      ?? 0;
  const creditCards = (userData.creditCards || []).map(card => {
    const bal = cardBal(card);
    return {
      id: card.creditCardId, type: 'credit_card',
      display_name: card.displayName || card.servicerName || 'Credit Card',
      logo_url: card.logoUrl || null,
      masked_number: card.cardProfile?.creditCardNumberMasked || null,
      current_balance: bal,
      credit_limit: card.cardProfile?.creditLimit || 0,
      credit_utilization: card.cardProfile?.creditUtilization || 0,
      available_credit: card.cardProfile?.availableCreditDerived || 0,
      min_payment: card.cardProfile?.minimumPaymentDue || card.balanceDetails?.minimumPaymentDue || null,
      apr: card.cardProfile?.interestRate || null,
      status: card.cardProfile?.status || 'UNKNOWN',
      can_refresh_balance: card.capabilities?.data?.realtimeBalance?.availability === 'SUPPORTED'
        || card.capabilities?.realtimeBalance?.availability === 'SUPPORTED'
        || card.capabilities?.data?.realtimeBalance?.supported === true,
      selectable: (card.cardProfile?.status === 'OPEN') && bal > 0,
    };
  });
  const loanBal = (l) => l.balanceDetails?.outstandingBalance
      ?? l.balanceDetails?.currentBalance
      ?? l.loanProfile?.currentBalance
      ?? 0;
  const loanMonthly = (l) => l.loanProfile?.monthlyPaymentAmount
      ?? l.loanProfile?.scheduledMonthlyPayment
      ?? l.balanceDetails?.minimumPaymentDue
      ?? 0;
  const mapLoan = (arr, idKey, type, label) => (arr || []).map(l => ({
    id: l[idKey], type,
    display_name: l.displayName || l.servicerName || label,
    current_balance: loanBal(l),
    monthly_payment: loanMonthly(l),
    status: l.loanProfile?.status || 'UNKNOWN',
    selectable: false,
  }));
  const autoLoans = mapLoan(userData.autoLoans, 'autoLoanId', 'auto_loan', 'Auto Loan');
  const studentLoans = mapLoan(userData.studentLoans, 'studentLoanId', 'student_loan', 'Student Loan');
  const personalLoans = mapLoan(userData.personalLoans, 'personalLoanId', 'personal_loan', 'Personal Loan');
  const homeLoans = mapLoan(userData.homeLoans, 'homeLoanId', 'home_loan', 'Mortgage');
  const all = [...creditCards, ...autoLoans, ...studentLoans, ...personalLoans, ...homeLoans];
  const selectable = creditCards.filter(c => c.selectable);
  const cr = (userData.creditReports || [])[0];
  const scoreDetail = (cr?.creditScoreDetails || [])[0];
  const creditScore = scoreDetail ? {
    score: scoreDetail.score,
    model: scoreDetail.modelName || scoreDetail.scoreModel || null,
    range: categorizeScore(scoreDetail.score),
  } : null;
  return {
    credit_cards: creditCards, auto_loans: autoLoans, student_loans: studentLoans,
    personal_loans: personalLoans, home_loans: homeLoans,
    summary: {
      total_debt: all.reduce((s,d) => s + (d.current_balance||0), 0),
      total_monthly_payments: all.reduce((s,d) => s + (d.monthly_payment||d.min_payment||0), 0),
      total_credit_card_debt: creditCards.reduce((s,c) => s + (c.current_balance||0), 0),
      selectable_card_count: selectable.length,
      selectable_card_total: selectable.reduce((s,c) => s + c.current_balance, 0),
      account_count: all.length,
    },
    credit_score: creditScore,
  };
}

function categorizeScore(s) {
  if (!s) return 'not_sure';
  if (s >= 760) return '760_plus'; if (s >= 740) return '740_759';
  if (s >= 720) return '720_739'; if (s >= 700) return '700_719';
  if (s >= 680) return '680_699'; if (s >= 660) return '660_679';
  return 'below_660';
}

module.exports = { mountMcpOnExpress };
