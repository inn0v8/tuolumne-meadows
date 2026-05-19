# Hybrid Manifest + MCP Implementation

## Overview

This adds a hybrid flow where Claude discovers the funnel via web_fetch (manifest),
starts the conversation, and suggests the MCP connector mid-flow when POST capability
is needed. The existing code stays on `main` for comparison. The hybrid version lives
on a `hybrid-mcp` branch.

Read this entire file before writing any code.

---

## Step 1: Create the branch

```bash
git checkout main
git pull origin main
git checkout -b hybrid-mcp
```

All changes below happen on the `hybrid-mcp` branch.

---

## Step 2: Install MCP SDK

```bash
npm install @modelcontextprotocol/sdk zod@3
```

---

## Step 3: Create src/mcp-server.js

Create this file. It defines 9 MCP tools and mounts them on the Express app via SSE
transport at /mcp. The tools call internal modules directly (store, spinwheel-client,
validation) — no HTTP self-requests.

IMPORTANT: Each tool description encodes the flow order and behavioral rules. This is
how the MCP tools replace the skill file — the descriptions ARE the skill.

```javascript
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
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
        const result = await sw.connectSMS(phoneNumber, dobNormalized, extUserId);
        store.createSpinwheelSession(sessionToken, {
          spinwheelUserId: result.userId,
          extUserId,
          phone: phoneNumber,
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
        const userProfile = await sw.getUserProfile(session.spinwheelUserId);
        const userData = userProfile.data || userProfile;
        const identity = {
          first_name: userData.firstName || null,
          last_name: userData.lastName || null,
          full_name: [userData.firstName, userData.lastName].filter(Boolean).join(' '),
          dob: session.dob,
          address: userData.address ? {
            street: userData.address.street || userData.address.addressLine1 || null,
            city: userData.address.city || null,
            state: userData.address.state || null,
            zip: userData.address.zip || userData.address.zipCode || null,
          } : null,
          ssn_last4: userData.ssn ? userData.ssn.slice(-4) : null,
          phone: session.phone,
        };
        store.updateSpinwheelSession(session_token, {
          connectionStatus: 'SUCCESS',
          identity,
          fullSSN: userData.ssn || null,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              verified: true,
              identity,
              next_step: 'Show the user their verified name and address. Ask them to confirm. Then call spinwheel_debt_profile.',
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
        await sw.requestDebtProfile(session.spinwheelUserId, 'equifax');
        await sleep(3000);
        const userProfile = await sw.getUserProfile(session.spinwheelUserId);
        const userData = userProfile.data || userProfile;
        const debts = transformDebtProfile(userData);
        store.updateSpinwheelSession(session_token, { debtProfile: debts });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...debts,
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
    'Optional. Refresh the real-time balance for a specific credit card. ' +
    'Only works for cards where can_refresh_balance=true in the debt profile. ' +
    'Use when the user wants the most current balance before deciding which cards to consolidate.',
    {
      session_token: z.string().describe('session_token from a verified session'),
      liability_id: z.string().describe('The id of the credit card to refresh'),
    },
    async ({ session_token, liability_id }) => {
      try {
        const session = store.getSpinwheelSession(session_token);
        if (!session) {
          return { content: [{ type: 'text', text: 'Session not found.' }], isError: true };
        }
        await sw.refreshLiabilityBalance(session.spinwheelUserId, liability_id);
        let attempts = 0;
        while (attempts < 5) {
          await sleep(2000);
          attempts++;
          const userProfile = await sw.getUserProfile(session.spinwheelUserId);
          const userData = userProfile.data || userProfile;
          const all = [
            ...(userData.creditCards || []),
            ...(userData.autoLoans || []),
            ...(userData.studentLoans || []),
            ...(userData.personalLoans || []),
          ];
          const liability = all.find(l =>
            l.creditCardId === liability_id || l.autoLoanId === liability_id ||
            l.studentLoanId === liability_id || l.personalLoanId === liability_id
          );
          if (liability?.balanceDetails) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'completed',
                  balance: liability.balanceDetails.currentBalance || liability.cardProfile?.currentBalance,
                  available_credit: liability.balanceDetails.availableCredit,
                  min_payment_due: liability.balanceDetails.minimumPaymentDue,
                  updated_at: liability.balanceDetails.updatedOn || new Date().toISOString(),
                }),
              }],
            };
          }
        }
        return { content: [{ type: 'text', text: '{"status":"pending","message":"Still processing. Use cached balance."}' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Refresh error: ${err.message}` }], isError: true };
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
        store.stage(sessionId, {
          responses,
          spinwheel_session_token: session_token,
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


// ── Mount on Express via SSE ──
function mountMcpOnExpress(app) {
  const server = createMcpServer();
  const transports = {};

  app.get('/mcp', async (req, res) => {
    const transport = new SSEServerTransport('/mcp', res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;
    res.on('close', () => { delete transports[sessionId]; });
    await server.connect(transport);
  });

  app.post('/mcp', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (!transport) {
      return res.status(400).json({ error: 'No active SSE session. Connect via GET /mcp first.' });
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  console.log('MCP server mounted at /mcp (SSE transport)');
  return server;
}


// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeDOB(dob) {
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(dob)) return dob;
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

function transformDebtProfile(userData) {
  const creditCards = (userData.creditCards || []).map(card => ({
    id: card.creditCardId, type: 'credit_card',
    display_name: card.displayName || 'Credit Card',
    logo_url: card.logoUrl || null,
    masked_number: card.cardProfile?.creditCardNumberMasked || null,
    current_balance: card.cardProfile?.currentBalance || 0,
    credit_limit: card.cardProfile?.creditLimit || 0,
    credit_utilization: card.cardProfile?.creditUtilization || 0,
    available_credit: card.cardProfile?.availableCreditDerived || 0,
    min_payment: card.cardProfile?.minimumPaymentDue || null,
    apr: card.cardProfile?.interestRate || null,
    status: card.cardProfile?.status || 'UNKNOWN',
    can_refresh_balance: card.capabilities?.data?.realtimeBalance?.availability === 'SUPPORTED',
    selectable: card.cardProfile?.status === 'OPEN' && (card.cardProfile?.currentBalance || 0) > 0,
  }));
  const mapLoan = (arr, idKey, type, label) => (arr || []).map(l => ({
    id: l[idKey], type, display_name: l.displayName || label,
    current_balance: l.loanProfile?.currentBalance || 0,
    monthly_payment: l.loanProfile?.monthlyPaymentAmount || 0,
    status: l.loanProfile?.status || 'UNKNOWN', selectable: false,
  }));
  const autoLoans = mapLoan(userData.autoLoans, 'autoLoanId', 'auto_loan', 'Auto Loan');
  const studentLoans = mapLoan(userData.studentLoans, 'studentLoanId', 'student_loan', 'Student Loan');
  const personalLoans = mapLoan(userData.personalLoans, 'personalLoanId', 'personal_loan', 'Personal Loan');
  const homeLoans = mapLoan(userData.homeLoans, 'homeLoanId', 'home_loan', 'Mortgage');
  const all = [...creditCards, ...autoLoans, ...studentLoans, ...personalLoans, ...homeLoans];
  const selectable = creditCards.filter(c => c.selectable);
  const creditScore = userData.creditScore ? {
    score: userData.creditScore.score, model: userData.creditScore.scoreModel,
    range: categorizeScore(userData.creditScore.score),
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
```

---

## Step 4: Mount MCP in server.js

In server.js, add these lines AFTER `app.use(express.json())` and BEFORE static file
middleware. Find the right location and add:

```javascript
// MCP server (hybrid flow — discovered via manifest, connected mid-conversation)
const { mountMcpOnExpress } = require('./src/mcp-server');
mountMcpOnExpress(app);
```

Make sure this is AFTER:
- `app.use(express.json())`
- `app.use(cors(...))`

And BEFORE:
- `app.use(express.static(...))`

---

## Step 5: Update the manifest for hybrid flow

In public/.well-known/ai-funnel.json, make these changes:

### 5a. Add the mcp section (top level, after base_url):

```json
"mcp": {
  "url": "https://loans.spinwheel.ai/mcp",
  "name": "Spinwheel Personal Loans",
  "description": "Secure identity verification, debt profiling, and loan application tools powered by Spinwheel",
  "connect_at_step": "identity_verification",
  "connect_prompt": "To verify your identity and pull your credit data securely, I need to connect to Spinwheel's tools. This takes one click and lets me send a verification code to your phone, retrieve your verified identity, and pull your credit card balances automatically — so you don't have to enter that information manually.",
  "fallback_if_declined": "If the user declines the MCP connection, offer three options: (1) try the connection again, (2) go to the website at /apply, (3) enter information manually in the conversation. Only proceed with manual entry if the user explicitly chooses option 3."
}
```

### 5b. Update agent_instructions to include the hybrid MCP step

If agent_instructions already has a CRITICAL_FLOW_ORDER array, update STEP 3 to:

```json
"STEP 3: You need POST capability to call Spinwheel APIs. Check if you have MCP tools named spinwheel_connect, spinwheel_verify, etc. If YES, proceed to STEP 4. If NO, suggest the MCP connector to the user. The MCP URL is in the mcp.url field of this manifest. Use the mcp.connect_prompt text. If the user connects, proceed to STEP 4. If the user declines, follow mcp.fallback_if_declined."
```

If agent_instructions does NOT have CRITICAL_FLOW_ORDER yet (i.e., the previous
manifest fix was not applied), replace the entire agent_instructions object with the
full prescriptive version. Here it is:

```json
"agent_instructions": {
  "tone": "friendly, professional, encouraging",
  "pii_handling": "transit_only",
  "never_store": true,
  "CRITICAL_FLOW_ORDER": [
    "STEP 1: Show consent disclosures (from consent.required_disclosures) and Spinwheel consent (from identity_verification.consent_text). Get user agreement before collecting ANY data.",
    "STEP 2: Ask ONLY for phone number and date of birth. Nothing else yet.",
    "STEP 3: You need POST capability to call Spinwheel APIs. Check if you have MCP tools named spinwheel_connect, spinwheel_verify, spinwheel_debt_profile. If YES, proceed to STEP 4. If NO, suggest the MCP connector to the user — the URL is in the mcp.url field of this manifest. Use the mcp.connect_prompt text to explain why. If the user connects, proceed to STEP 4. If the user declines, follow mcp.fallback_if_declined.",
    "STEP 4: Call spinwheel_connect with phone and dob. Tell the user a code was sent.",
    "STEP 5: Ask the user for the 6-digit OTP code they received via SMS.",
    "STEP 6: Call spinwheel_verify with session_token and otp_code. This returns full_name, address, ssn_last4. Show the user their verified identity and ask them to confirm.",
    "STEP 7: Call spinwheel_debt_profile with session_token. This returns ALL debts, balances, monthly payments, and credit score.",
    "STEP 8: Present all credit cards with balances. Ask the user which to consolidate.",
    "STEP 9: Ask ONLY for: email, annual income, employment status, preferred loan term. These are the ONLY remaining manual fields.",
    "STEP 10: Present a complete review summary and get confirmation.",
    "STEP 11: Call funnel_submit (or funnel_stage for review page handoff)."
  ],
  "DO_NOT": [
    "NEVER ask the user for their full name — Spinwheel provides it after verification.",
    "NEVER ask the user for their address — Spinwheel provides it after verification.",
    "NEVER ask the user for their SSN or last 4 — Spinwheel provides it after verification.",
    "NEVER ask the user for their credit score — the debt profile provides it.",
    "NEVER ask the user for their monthly debt payments — the debt profile calculates it.",
    "NEVER ask the user to list their debts — the debt profile pulls them automatically.",
    "NEVER skip Spinwheel and fall back to manual entry unless (1) a Spinwheel API call fails AND (2) the user explicitly chooses manual entry from the three options.",
    "NEVER ask for more than phone and DOB before initiating Spinwheel verification."
  ],
  "ONLY_ASK_MANUALLY": [
    "phone (to initiate Spinwheel)",
    "date of birth (to initiate Spinwheel)",
    "OTP code (from SMS)",
    "email address",
    "annual income",
    "employment status",
    "preferred loan term"
  ],
  "on_spinwheel_failure": {
    "behavior": "If any Spinwheel call fails, tell the user and present three options. Do NOT silently fall back to manual.",
    "options_to_present": [
      "Try again",
      "Go to the website: /apply",
      "Enter information manually"
    ],
    "manual_fallback_rules": [
      "ONLY proceed with manual entry if the user explicitly chooses option 3.",
      "Manual entry requires: full name, email, phone, DOB, address, income, employment, monthly debts (estimated), credit score range (estimated), preferred term.",
      "Note that results will be based on self-reported data."
    ]
  },
  "fallback_url": "/apply",
  "sensitive_field_behavior": "SSN last-4 only from Spinwheel. Never ask for full SSN. Never repeat SSN digits."
}
```

### 5c. Make sure base_url is correct

Verify base_url is: "base_url": "https://loans.spinwheel.ai"

NOT the old Render domain.

---

## Step 6: Update the landing page

In public/index.html, make sure the AI agent instructions block mentions the hybrid
MCP flow. Update or add to the numbered list:

```html
<li>When you reach the identity verification step and need POST capability, suggest the MCP connector at <code>https://loans.spinwheel.ai/mcp</code></li>
```

Also make sure all URLs in the page reference loans.spinwheel.ai, not the old domain.

---

## Step 7: Update robots.txt

If a robots.txt file exists, make sure it allows:

```
Allow: /.well-known/
Allow: /skill/
Allow: /api/
Allow: /mcp
```

---

## Step 8: Test locally

```bash
npm start
```

Test MCP with the inspector:
```bash
npx @modelcontextprotocol/inspector
```
Set transport to SSE, URL to http://localhost:3000/mcp. Verify all 9 tools appear.

Test the manifest:
```bash
curl -s http://localhost:3000/.well-known/ai-funnel.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('base_url:', d.get('base_url'))
print('mcp.url:', d.get('mcp',{}).get('url'))
print('has CRITICAL_FLOW_ORDER:', 'CRITICAL_FLOW_ORDER' in d.get('agent_instructions',{}))
print('has DO_NOT:', 'DO_NOT' in d.get('agent_instructions',{}))
print('has mcp section:', 'mcp' in d)
"
```

Expected output:
```
base_url: https://loans.spinwheel.ai
mcp.url: https://loans.spinwheel.ai/mcp
has CRITICAL_FLOW_ORDER: True
has DO_NOT: True
has mcp section: True
```

Test Spinwheel proxy still works:
```bash
curl -s -X POST http://localhost:3000/api/sw/connect \
  -H "Content-Type: application/json" \
  -d '{"phone":"4155551234","dob":"1990-01-01"}' | python3 -c "
import sys,json; d=json.load(sys.stdin); print('status:', d.get('status')); print('has token:', bool(d.get('session_token')))"
```

---

## Step 9: Commit and push the hybrid branch

```bash
git add -A
git commit -m "Add hybrid manifest + MCP flow

Discovery happens via web_fetch (manifest at /.well-known/ai-funnel.json).
Claude starts the conversation and collects phone + DOB.
When POST capability is needed, Claude suggests the MCP connector mid-flow.
User connects with one click, then the full Spinwheel flow runs natively.

Manifest includes:
- mcp section with URL, connect_prompt, and fallback behavior
- CRITICAL_FLOW_ORDER with hybrid STEP 3 (check for MCP, suggest if missing)
- DO_NOT rules and ONLY_ASK_MANUALLY list
- on_spinwheel_failure with 3-option graceful degradation

MCP server at /mcp (SSE transport) with 9 tools:
- get_funnel_manifest, get_funnel_steps
- spinwheel_connect, spinwheel_verify, spinwheel_debt_profile, spinwheel_refresh_balance
- funnel_stage, funnel_submit, funnel_status

Graceful degradation tiers:
1. Installed skill + MCP = best (proactive, full Spinwheel)
2. Web discovery + mid-flow MCP suggest = good (no pre-setup)
3. MCP declined = manual entry + review page handoff
4. AI opt-out = traditional form at /apply"

git push origin hybrid-mcp
```

---

## Step 10: Deploy the hybrid branch to Render

In Render dashboard:
1. Go to the service settings
2. Change the branch from `main` to `hybrid-mcp`
3. Trigger a manual deploy (or it auto-deploys on push)

To test: open a NEW Claude conversation and say:
"I want to consolidate my credit card debt at https://loans.spinwheel.ai/"

Expected behavior:
1. Claude fetches the landing page
2. Claude fetches the manifest
3. Claude shows disclosures
4. Claude asks for phone + DOB only
5. Claude says it needs to connect to Spinwheel tools
6. Claude suggests the MCP connector
7. User connects
8. Full Spinwheel flow runs

---

## Switching between versions for testing

```bash
# Test the existing version (no MCP):
git checkout main
git push origin main
# In Render: set branch to main, deploy

# Test the hybrid version (with MCP):
git checkout hybrid-mcp
git push origin hybrid-mcp
# In Render: set branch to hybrid-mcp, deploy
```

Or if Render supports branch-based preview deployments, deploy both simultaneously
at different URLs for side-by-side comparison.
