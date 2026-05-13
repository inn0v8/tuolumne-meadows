# Spinwheel Integration — Implementation Guide

## Addendum to AAFP Implementation Guide

This document extends the AI Application Funnel Protocol demo ("Horizon Home Loans") with Spinwheel Connect, Debt Profile, and Real-Time Balances. It transforms the demo from a personal loan pre-qualification with manual data entry into one where identity verification, PII, and all existing debts are pulled automatically via Spinwheel — the user provides only a phone number, date of birth, and an OTP code.

Give this document to Claude Code or Codex alongside the base AAFP implementation guide.

---

## Table of contents

1. Architecture change: the Spinwheel proxy
2. Updated project structure
3. New dependencies
4. Proxy service implementation
5. Spinwheel API call sequence
6. Updated manifest (ai-funnel.json)
7. Updated funnel steps
8. Updated skill file (SKILL.md)
9. Updated pre-qualification engine
10. Updated review page
11. Environment variables
12. Sandbox testing
13. Complete proxy route code
14. Security considerations

---

## 1. Architecture change: the Spinwheel proxy

### The problem

Spinwheel APIs require a secret API key passed as a header (`x-api-key`). This key must never be exposed to Claude, to browser JavaScript, or to the funnel manifest. If Claude called Spinwheel directly, the API key would need to be in the conversation context — which is unacceptable.

### The solution

A **Spinwheel proxy service** runs as part of the Horizon Home Loans server (same Express app, separate route module). It:

1. Holds the Spinwheel API key as a server-side environment variable
2. Exposes safe, scoped endpoints that Claude and the website can call
3. Issues short-lived **session tokens** (UUIDs) that map internally to Spinwheel user IDs
4. Returns only the data the funnel needs — never raw Spinwheel responses
5. Strips sensitive fields (full SSN, raw credit report) from responses sent to Claude

### Data flow

```
Claude/Website                    Proxy (Horizon server)              Spinwheel API
─────────────                    ──────────────────────              ─────────────
                                                                    
POST /api/sw/connect              ──→ POST /v1/users/connect/sms     
  { phone, dob }                      { phoneNumber, dateOfBirth,   
                                        extUserId }                  
  ←── { session_token }           ←── { userId, connectionStatus }   
                                                                    
POST /api/sw/verify               ──→ POST /v1/users/connect/sms/verify
  { session_token, otp_code }          { code }                      
  ←── { verified: true,           ←── { connectionStatus: SUCCESS,   
        identity: {                      identity: { firstName,      
          first_name, last_name,           lastName, ssn, address } } 
          address, ssn_last4 } }                                     
                                  (strips full SSN, returns last4)   
                                                                    
POST /api/sw/debt-profile         ──→ POST /v1/users/{userId}/debtProfile
  { session_token }                    { creditReport: { bureau } }   
                                  ──→ GET /v1/users?userId={userId}   
  ←── { debts: { credit_cards,    ←── { data: { creditCards,         
        auto_loans, student_loans,       autoLoans, studentLoans,    
        personal_loans, ... } }          personalLoans, ... } }      
                                                                    
POST /api/sw/refresh-balance      ──→ POST /v1/users/{userId}/liabilities/{id}/refresh
  { session_token, liability_id }                                    
  ←── { balance, available_credit } ←── { balanceDetails }           
```

### What Claude sees vs. what it doesn't

| Data | Claude sees | Claude does NOT see |
|------|------------|-------------------|
| Full name | Yes (from Spinwheel identity) | — |
| Address | Yes (street, city, state, ZIP) | — |
| SSN | Last 4 only | Full SSN (stays in proxy) |
| Phone number | Yes (user provided it) | — |
| Credit cards | Display name, masked number, balance, credit limit, utilization, min payment | Full card number, raw credit report XML |
| Spinwheel userId | No | Yes (mapped to session token) |
| Spinwheel API key | No | Yes (env var on server only) |

---

## 2. Updated project structure

Add these files to the base project:

```
horizon-home-loans/
├── ... (all existing files) ...
├── src/
│   ├── routes/
│   │   ├── funnel.js              # (existing, updated)
│   │   ├── pages.js               # (existing)
│   │   └── spinwheel-proxy.js     # NEW — Spinwheel proxy routes
│   ├── data/
│   │   └── mortgage-prequal-steps.json  # (updated with Spinwheel steps)
│   ├── store.js                   # (updated — add session storage)
│   ├── validation.js              # (updated — use real debt data)
│   └── spinwheel-client.js        # NEW — Spinwheel API client wrapper
└── skill/
    └── SKILL.md                   # (updated)
```

---

## 3. New dependencies

Add to package.json:

```json
{
  "dependencies": {
    "express": "^4.21.0",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "uuid": "^10.0.0",
    "compression": "^1.7.4"
  }
}
```

No new dependencies needed — the proxy uses Node's built-in `fetch` (Node 20+) to call Spinwheel's REST API.

---

## 4. Proxy service implementation

### src/spinwheel-client.js — Low-level Spinwheel API client

This module makes authenticated calls to Spinwheel. It is the ONLY place the API key is used.

```javascript
const SPINWHEEL_API_KEY = process.env.SPINWHEEL_API_KEY;
const SPINWHEEL_BASE_URL = process.env.SPINWHEEL_BASE_URL || 'https://secure-sandbox-api.spinwheel.io/v1/users';

if (!SPINWHEEL_API_KEY) {
  console.warn('WARNING: SPINWHEEL_API_KEY not set. Spinwheel features will not work.');
}

async function spinwheelFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${SPINWHEEL_BASE_URL}${path}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SPINWHEEL_API_KEY,
      ...options.headers,
    },
  });

  const data = await response.json();
  
  if (!response.ok) {
    const error = new Error(`Spinwheel API error: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// Connect via SMS — Step 1: send OTP
async function connectSMS(phoneNumber, dateOfBirth, extUserId) {
  return spinwheelFetch('/connect/sms/', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber, dateOfBirth, extUserId }),
  });
}

// Connect via SMS — Step 2: verify OTP
async function verifySMS(userId, code) {
  return spinwheelFetch(`/${userId}/connect/sms/verify`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

// Request debt profile (triggers credit report pull)
async function requestDebtProfile(userId, bureau = 'equifax') {
  return spinwheelFetch(`/${userId}/debtProfile`, {
    method: 'POST',
    body: JSON.stringify({
      creditReport: {
        bureau: bureau,
      },
      creditScore: {
        scoreModel: 'EquifaxVantageScore3.0',
      },
    }),
  });
}

// Get user profile (includes all liabilities after debt profile is pulled)
async function getUserProfile(userId) {
  return spinwheelFetch(`?userId=${userId}`, {
    method: 'GET',
  });
}

// Refresh a single liability's real-time balance
async function refreshLiabilityBalance(userId, liabilityId) {
  return spinwheelFetch(`/${userId}/liabilities/${liabilityId}/refresh`, {
    method: 'POST',
  });
}

// Check refresh status
async function getRefreshStatus(userId, liabilityId, refreshId) {
  return spinwheelFetch(`/${userId}/liabilities/${liabilityId}/refresh/${refreshId}`, {
    method: 'GET',
  });
}

module.exports = {
  connectSMS,
  verifySMS,
  requestDebtProfile,
  getUserProfile,
  refreshLiabilityBalance,
  getRefreshStatus,
};
```

### src/routes/spinwheel-proxy.js — Proxy routes

These are the endpoints Claude and the website call. They handle session management, data filtering, and error handling.

```javascript
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const sw = require('../spinwheel-client');
const store = require('../store');

const router = express.Router();

// ──────────────────────────────────────────────
// POST /api/sw/connect
// Initiates Spinwheel Connect via SMS.
// Input: { phone, dob }
// Output: { session_token, status }
// ──────────────────────────────────────────────
router.post('/connect', async (req, res) => {
  try {
    const { phone, dob } = req.body;

    if (!phone || !dob) {
      return res.status(400).json({ error: 'Phone number and date of birth are required.' });
    }

    // Normalize phone: strip non-digits, ensure 10 digits
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 11) {
      return res.status(400).json({ error: 'Please provide a valid US phone number.' });
    }
    const phoneNumber = cleanPhone.length === 11 && cleanPhone.startsWith('1')
      ? cleanPhone.slice(1)
      : cleanPhone;

    // Normalize DOB to YYYY-MM-DD
    const dobNormalized = normalizeDateOfBirth(dob);
    if (!dobNormalized) {
      return res.status(400).json({ error: 'Please provide date of birth in a recognizable format (e.g., 1990-03-15 or March 15, 1990).' });
    }

    // Generate a session token and extUserId
    const sessionToken = uuidv4();
    const extUserId = `horizon-${uuidv4()}`;

    // Call Spinwheel Connect SMS
    const result = await sw.connectSMS(phoneNumber, dobNormalized, extUserId);

    // Store the session mapping
    store.createSpinwheelSession(sessionToken, {
      spinwheelUserId: result.userId,
      extUserId,
      phone: phoneNumber,
      dob: dobNormalized,
      connectionStatus: result.connectionStatus,
      createdAt: new Date().toISOString(),
      identity: null,        // populated after verify
      debtProfile: null,     // populated after debt profile pull
    });

    res.json({
      session_token: sessionToken,
      status: result.connectionStatus,
      message: 'A verification code has been sent to your phone. It expires in 5 minutes.',
    });
  } catch (err) {
    console.error('Spinwheel connect error:', err);
    const status = err.status || 500;
    const message = err.data?.message || 'Failed to initiate verification. Please try again.';
    res.status(status).json({ error: message });
  }
});

// ──────────────────────────────────────────────
// POST /api/sw/verify
// Verifies the OTP code and retrieves identity.
// Input: { session_token, otp_code }
// Output: { verified, identity: { first_name, last_name, address, ssn_last4, dob } }
// ──────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  try {
    const { session_token, otp_code } = req.body;

    if (!session_token || !otp_code) {
      return res.status(400).json({ error: 'Session token and OTP code are required.' });
    }

    const session = store.getSpinwheelSession(session_token);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired.' });
    }

    // Verify OTP with Spinwheel
    const result = await sw.verifySMS(session.spinwheelUserId, otp_code);

    if (result.connectionStatus !== 'SUCCESS') {
      return res.status(400).json({
        verified: false,
        error: 'Verification failed. Please check the code and try again.',
        status: result.connectionStatus,
      });
    }

    // Extract identity data from the verification response
    // The identity comes back in the user profile after successful verification
    const userProfile = await sw.getUserProfile(session.spinwheelUserId);
    const userData = userProfile.data || userProfile;

    // Build safe identity object (SSN last 4 only)
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

    // Store full SSN server-side (never sent to Claude), identity safe version in session
    store.updateSpinwheelSession(session_token, {
      connectionStatus: 'SUCCESS',
      identity,
      fullSSN: userData.ssn || null,  // stored server-side only, for submission
    });

    res.json({
      verified: true,
      identity,
    });
  } catch (err) {
    console.error('Spinwheel verify error:', err);
    const status = err.status || 500;
    res.status(status).json({
      verified: false,
      error: err.data?.message || 'Verification failed. Please try again.',
    });
  }
});

// ──────────────────────────────────────────────
// POST /api/sw/debt-profile
// Pulls the user's full debt profile from Spinwheel.
// Input: { session_token }
// Output: { debts: { credit_cards: [...], auto_loans: [...], ... }, credit_score, total_debt }
// ──────────────────────────────────────────────
router.post('/debt-profile', async (req, res) => {
  try {
    const { session_token } = req.body;

    const session = store.getSpinwheelSession(session_token);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired.' });
    }
    if (session.connectionStatus !== 'SUCCESS') {
      return res.status(400).json({ error: 'User not verified. Complete OTP verification first.' });
    }

    // Request debt profile from Spinwheel
    await sw.requestDebtProfile(session.spinwheelUserId, 'equifax');

    // Poll/wait briefly for the profile to be ready, then fetch user data
    // In production, use webhooks. For demo, we poll with a short delay.
    await sleep(3000); // Wait 3 seconds for credit report to process

    const userProfile = await sw.getUserProfile(session.spinwheelUserId);
    const userData = userProfile.data || userProfile;

    // Transform Spinwheel's debt data into our funnel format
    const debts = transformDebtProfile(userData);

    // Store for later use in pre-qualification
    store.updateSpinwheelSession(session_token, { debtProfile: debts });

    res.json(debts);
  } catch (err) {
    console.error('Spinwheel debt profile error:', err);
    const status = err.status || 500;
    res.status(status).json({
      error: err.data?.message || 'Failed to retrieve debt profile. Please try again.',
    });
  }
});

// ──────────────────────────────────────────────
// POST /api/sw/refresh-balance
// Refreshes real-time balance for a specific liability.
// Input: { session_token, liability_id }
// Output: { balance, available_credit, last_payment, min_payment_due, updated_at }
// ──────────────────────────────────────────────
router.post('/refresh-balance', async (req, res) => {
  try {
    const { session_token, liability_id } = req.body;

    const session = store.getSpinwheelSession(session_token);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired.' });
    }

    // Refresh the specific liability
    const refreshResult = await sw.refreshLiabilityBalance(
      session.spinwheelUserId,
      liability_id
    );

    // Poll for completion (in production, use webhooks)
    let attempts = 0;
    let status = 'IN_PROGRESS';
    let balanceData = null;

    while (status === 'IN_PROGRESS' && attempts < 10) {
      await sleep(2000);
      attempts++;
      
      const userProfile = await sw.getUserProfile(session.spinwheelUserId);
      const userData = userProfile.data || userProfile;
      
      // Find the specific liability in the updated profile
      const allLiabilities = [
        ...(userData.creditCards || []),
        ...(userData.autoLoans || []),
        ...(userData.studentLoans || []),
        ...(userData.personalLoans || []),
      ];
      
      const liability = allLiabilities.find(l => 
        l.creditCardId === liability_id || 
        l.autoLoanId === liability_id ||
        l.studentLoanId === liability_id ||
        l.personalLoanId === liability_id
      );

      if (liability && liability.balanceDetails) {
        status = 'COMPLETED';
        balanceData = {
          balance: liability.balanceDetails.currentBalance || liability.cardProfile?.currentBalance,
          available_credit: liability.balanceDetails.availableCredit || liability.cardProfile?.availableCreditDerived,
          min_payment_due: liability.balanceDetails.minimumPaymentDue,
          last_payment_amount: liability.balanceDetails.lastPaymentAmount,
          last_payment_date: liability.balanceDetails.lastPaymentDate,
          updated_at: liability.balanceDetails.updatedOn || new Date().toISOString(),
        };
      }
    }

    if (status !== 'COMPLETED') {
      return res.json({
        status: 'pending',
        message: 'Balance refresh is still processing. The most recent cached balance is being used.',
      });
    }

    res.json({ status: 'completed', ...balanceData });
  } catch (err) {
    console.error('Spinwheel refresh error:', err);
    res.status(err.status || 500).json({
      error: 'Failed to refresh balance. Using cached balance.',
    });
  }
});

// ──────────────────────────────────────────────
// GET /api/sw/session/:sessionToken
// Returns the current session state (identity + debts).
// Used by the review page to display Spinwheel-sourced data.
// ──────────────────────────────────────────────
router.get('/session/:sessionToken', (req, res) => {
  const session = store.getSpinwheelSession(req.params.sessionToken);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired.' });
  }

  // Return safe data only (no full SSN, no Spinwheel internals)
  res.json({
    status: session.connectionStatus,
    identity: session.identity,
    debt_profile: session.debtProfile,
  });
});


// ──────────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeDateOfBirth(dob) {
  // Try ISO format first
  const isoMatch = dob.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) return dob;

  // Try MM/DD/YYYY or M/D/YYYY
  const usMatch = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Try "March 15, 1990" or "March 15 1990"
  const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
                   july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  const textMatch = dob.match(/^(\w+)\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (textMatch) {
    const month = months[textMatch[1].toLowerCase()];
    if (month) return `${textMatch[3]}-${month}-${textMatch[2].padStart(2, '0')}`;
  }

  return null;
}

function transformDebtProfile(userData) {
  const creditCards = (userData.creditCards || []).map(card => ({
    id: card.creditCardId,
    type: 'credit_card',
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
    account_type: card.cardProfile?.accountType || null,
    payment_status: card.cardProfile?.accountRating || null,
    can_refresh_balance: card.capabilities?.data?.realtimeBalance?.availability === 'SUPPORTED',
    // For debt consolidation selection
    selectable: card.cardProfile?.status === 'OPEN' && (card.cardProfile?.currentBalance || 0) > 0,
  }));

  const autoLoans = (userData.autoLoans || []).map(loan => ({
    id: loan.autoLoanId,
    type: 'auto_loan',
    display_name: loan.displayName || 'Auto Loan',
    logo_url: loan.logoUrl || null,
    current_balance: loan.loanProfile?.currentBalance || 0,
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loan.loanProfile?.monthlyPaymentAmount || 0,
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,  // Auto loans typically not consolidatable via personal loan
  }));

  const studentLoans = (userData.studentLoans || []).map(loan => ({
    id: loan.studentLoanId,
    type: 'student_loan',
    display_name: loan.displayName || 'Student Loan',
    logo_url: loan.logoUrl || null,
    current_balance: loan.loanProfile?.currentBalance || 0,
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loan.loanProfile?.monthlyPaymentAmount || 0,
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,  // Student loans typically not ideal for personal loan consolidation
  }));

  const personalLoans = (userData.personalLoans || []).map(loan => ({
    id: loan.personalLoanId,
    type: 'personal_loan',
    display_name: loan.displayName || 'Personal Loan',
    logo_url: loan.logoUrl || null,
    current_balance: loan.loanProfile?.currentBalance || 0,
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loan.loanProfile?.monthlyPaymentAmount || 0,
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,
  }));

  const homeLoans = (userData.homeLoans || []).map(loan => ({
    id: loan.homeLoanId,
    type: 'home_loan',
    display_name: loan.displayName || 'Mortgage',
    logo_url: loan.logoUrl || null,
    current_balance: loan.loanProfile?.currentBalance || 0,
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loan.loanProfile?.monthlyPaymentAmount || 0,
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,
  }));

  // Calculate totals
  const allDebts = [...creditCards, ...autoLoans, ...studentLoans, ...personalLoans, ...homeLoans];
  const totalDebt = allDebts.reduce((sum, d) => sum + (d.current_balance || 0), 0);
  const totalMonthlyPayments = allDebts.reduce((sum, d) => sum + (d.monthly_payment || d.min_payment || 0), 0);
  const totalCreditCardDebt = creditCards.reduce((sum, c) => sum + (c.current_balance || 0), 0);
  const selectableCards = creditCards.filter(c => c.selectable);

  // Credit score if available
  const creditScore = userData.creditScore ? {
    score: userData.creditScore.score,
    model: userData.creditScore.scoreModel,
    range: categorizeScore(userData.creditScore.score),
  } : null;

  return {
    credit_cards: creditCards,
    auto_loans: autoLoans,
    student_loans: studentLoans,
    personal_loans: personalLoans,
    home_loans: homeLoans,
    summary: {
      total_debt: totalDebt,
      total_monthly_payments: totalMonthlyPayments,
      total_credit_card_debt: totalCreditCardDebt,
      selectable_card_count: selectableCards.length,
      selectable_card_total: selectableCards.reduce((sum, c) => sum + c.current_balance, 0),
      account_count: allDebts.length,
    },
    credit_score: creditScore,
  };
}

function categorizeScore(score) {
  if (!score) return 'not_sure';
  if (score >= 760) return '760_plus';
  if (score >= 740) return '740_759';
  if (score >= 720) return '720_739';
  if (score >= 700) return '700_719';
  if (score >= 680) return '680_699';
  if (score >= 660) return '660_679';
  return 'below_660';
}

module.exports = router;
```

---

## 5. Spinwheel API call sequence

### Exact API calls in order

```
Step 1: Connect
  POST https://secure-sandbox-api.spinwheel.io/v1/users/connect/sms/
  Headers: { "x-api-key": "YOUR_KEY", "Content-Type": "application/json" }
  Body: { "phoneNumber": "4155550123", "dateOfBirth": "1990-01-01", "extUserId": "horizon-uuid" }
  Response: { "userId": "sw-user-uuid", "connectionStatus": "OTP_SENT" }

Step 2: Verify OTP
  POST https://secure-sandbox-api.spinwheel.io/v1/users/{userId}/connect/sms/verify
  Headers: { "x-api-key": "YOUR_KEY", "Content-Type": "application/json" }
  Body: { "code": "123456" }
  Response: { "connectionStatus": "SUCCESS", "identity": { ... } }

Step 3: Request Debt Profile
  POST https://secure-sandbox-api.spinwheel.io/v1/users/{userId}/debtProfile
  Headers: { "x-api-key": "YOUR_KEY", "Content-Type": "application/json" }
  Body: {
    "creditReport": { "bureau": "equifax" },
    "creditScore": { "scoreModel": "EquifaxVantageScore3.0" }
  }
  Response: 200 (triggers async credit report pull)

Step 4: Retrieve User Profile (after short delay or webhook)
  GET https://secure-sandbox-api.spinwheel.io/v1/users?userId={userId}
  Headers: { "x-api-key": "YOUR_KEY" }
  Response: Full user object with creditCards, autoLoans, studentLoans, etc.

Step 5 (optional): Refresh real-time balance for a specific credit card
  POST https://secure-sandbox-api.spinwheel.io/v1/users/{userId}/liabilities/{creditCardId}/refresh
  Headers: { "x-api-key": "YOUR_KEY" }
  Response: { "refreshId": "..." }
  Then poll or wait for webhook, then GET user profile again for updated balanceDetails.
```

### Sandbox test configuration

For sandbox testing, use Spinwheel's test users. The OTP code in sandbox is always `000000` (six zeros) for any valid US phone number.

Default test user: DOB `1967-06-08` → Christy Jenoval (has credit cards, student loans, auto loans, home loans).

To get specific test profiles, use the specific DOBs from Spinwheel's sandbox test user table:

| DOB | Name | Total Debt | Description |
|-----|------|-----------|-------------|
| 1990-01-01 | Aldo Cherry | $5k | CA user, auto/home/student loans + 2 credit cards |
| 1990-03-01 | Melissa Singh | $20k | TX user, auto/home/student/personal + 2 credit cards |
| 1990-04-10 | Janice Meyers | $25k | CO user, similar spread + personal loan |
| 1990-10-08 | Terrance Dactyl | $880k | CT user, $150k across 5 cards + $730k mortgage |
| 1990-06-10 | Sal Monella | $64k | CA user, $50k across 3 cards + auto lease |

---

## 6. Updated manifest (ai-funnel.json)

Add the Spinwheel integration section to the manifest:

```json
{
  "protocol": "ai-funnel",
  "version": "1.1",
  "provider": {
    "name": "Horizon Home Loans",
    "tagline": "Your path to homeownership",
    "logo": "/images/logo.svg",
    "legal_entity": "Horizon Financial Services Inc.",
    "regulatory_ids": { "nmls": "9999999" },
    "support_email": "support@horizonloans.demo"
  },
  "identity_verification": {
    "provider": "Spinwheel",
    "method": "sms_otp",
    "endpoints": {
      "connect": "/api/sw/connect",
      "verify": "/api/sw/verify",
      "debt_profile": "/api/sw/debt-profile",
      "refresh_balance": "/api/sw/refresh-balance",
      "session": "/api/sw/session/{session_token}"
    },
    "capabilities": {
      "identity_autofill": true,
      "debt_profile": true,
      "real_time_balances": true,
      "credit_score": true
    },
    "consent_text": "By continuing you agree to the Spinwheel End User Agreement. Further, you are providing 'written instructions' to Spinwheel Solutions, Inc. authorizing it to obtain your credit profile from any consumer reporting agency.",
    "consent_url": "https://spinwheel.io/end-user-agreement/"
  },
  "funnels": [
    {
      "id": "personal-loan-consolidation",
      "name": "Personal Loan for Credit Card Consolidation",
      "description": "Consolidate your credit card debt with a personal loan. Just your phone number and a quick text code to get started — we'll pull your info and show you exactly what you could save.",
      "estimated_time_minutes": 3,
      "category": "personal_loan",
      "steps_url": "/api/funnel/personal-loan-consolidation/steps",
      "submit_url": "/api/funnel/personal-loan-consolidation/submit",
      "stage_url": "/api/funnel/personal-loan-consolidation/stage",
      "status_url": "/api/funnel/personal-loan-consolidation/status/{session_id}",
      "review_page_url": "/review.html?session={session_id}",
      "capabilities": {
        "conversational_completion": true,
        "identity_autofill": true,
        "debt_selection": true,
        "save_and_resume": false,
        "document_upload": false
      }
    }
  ],
  "consent": {
    "privacy_url": "/privacy",
    "terms_url": "/terms",
    "required_disclosures": [
      "This is a demonstration application. No real loans are being offered.",
      "This is not a commitment to lend. In a real scenario, all loans would be subject to credit approval.",
      "Equal Housing Lender. NMLS #9999999 (demo).",
      "Credit data provided by Spinwheel via Equifax."
    ],
    "data_handling": "Identity verification is performed by Spinwheel. Credit data is pulled from Equifax via Spinwheel. All data is stored in-memory only for this demo."
  },
  "agent_instructions": {
    "tone": "friendly, professional, encouraging",
    "pii_handling": "transit_only",
    "never_store": true,
    "sensitive_field_behavior": "SSN is returned as last-4 only. Never ask the user for their full SSN — Spinwheel handles that securely.",
    "on_completion": "Present a clear summary of all collected information plus the debt consolidation breakdown. Ask the user to confirm. Then POST to the stage_url and give the user the review page link.",
    "fallback_url": "/apply"
  }
}
```

---

## 7. Updated funnel steps

The funnel now has 5 steps instead of 4. The first two use Spinwheel, the rest are manual but heavily pre-populated.

### Step 1: Identity verification (via Spinwheel Connect SMS)

```json
{
  "id": "identity_verification",
  "order": 1,
  "label": "Verify your identity",
  "instructions": "Use the Spinwheel proxy to verify the user's identity via phone + DOB + OTP. After verification, the user's name, address, and SSN last-4 are auto-populated. DO NOT ask for name, address, or SSN manually — Spinwheel provides them.",
  "spinwheel_flow": true,
  "fields": [
    {
      "id": "phone",
      "type": "phone",
      "label": "Phone number",
      "required": true,
      "ask_as": "Let's get started. What's your mobile phone number? We'll send you a quick verification code.",
      "help": "We use your phone number to verify your identity securely via Spinwheel. A text message with a one-time code will be sent.",
      "validation": { "pattern": "^[\\d\\s\\-\\(\\)\\+]{10,15}$" },
      "grouping": "ask_alone",
      "sensitivity": "personal"
    },
    {
      "id": "dob",
      "type": "date",
      "label": "Date of birth",
      "required": true,
      "ask_as": "And what's your date of birth?",
      "validation": { "min_age": 18, "format": "YYYY-MM-DD" },
      "grouping": "ask_with_previous",
      "sensitivity": "personal"
    }
  ],
  "after_fields_collected": {
    "action": "call_api",
    "endpoint": "/api/sw/connect",
    "method": "POST",
    "body_mapping": { "phone": "phone", "dob": "dob" },
    "on_success": "Tell the user a verification code was sent to their phone. Ask them to share the code.",
    "on_failure": "Tell the user verification couldn't be initiated. Offer to try again or use the website instead."
  },
  "otp_field": {
    "id": "otp_code",
    "type": "text",
    "label": "Verification code",
    "required": true,
    "ask_as": "I just sent a 6-digit code to your phone. What's the code?",
    "validation": { "pattern": "^[0-9]{6}$" },
    "after_collected": {
      "action": "call_api",
      "endpoint": "/api/sw/verify",
      "method": "POST",
      "body_mapping": { "session_token": "$session_token", "otp_code": "otp_code" },
      "on_success": "Show the user their verified identity (name, address). Ask them to confirm it's correct. Then proceed to pull their debt profile.",
      "on_failure": "Tell the user the code didn't work. Offer to resend."
    }
  }
}
```

### Step 2: Debt profile (via Spinwheel Debt Profile)

```json
{
  "id": "debt_profile",
  "order": 2,
  "label": "Your current debts",
  "instructions": "Call the debt profile endpoint to pull all the user's liabilities from their credit report. Present the credit cards with balances and let the user select which ones they want to consolidate into a personal loan. For eligible cards, offer to refresh real-time balances.",
  "spinwheel_flow": true,
  "auto_populate": {
    "action": "call_api",
    "endpoint": "/api/sw/debt-profile",
    "method": "POST",
    "body_mapping": { "session_token": "$session_token" },
    "on_success": "Present the debt profile to the user. Show all credit cards with their balances, credit limits, and utilization. Then ask the user to select which credit cards they want to pay off with the personal loan.",
    "on_failure": "Tell the user we couldn't pull their debt profile. Fall back to asking them to manually enter their monthly debt payments."
  },
  "fields": [
    {
      "id": "selected_cards",
      "type": "multi_select_dynamic",
      "label": "Credit cards to consolidate",
      "required": true,
      "ask_as": "Here are your credit cards. Which ones would you like to consolidate into a personal loan? You can select all of them or just some.",
      "options_source": "debt_profile.credit_cards",
      "option_display": "{display_name} — {masked_number} — Balance: ${current_balance}",
      "filter": { "selectable": true },
      "help": "Consolidating high-interest credit card debt into a lower-rate personal loan can save you money on interest and simplify your payments into one monthly bill.",
      "grouping": "ask_alone",
      "sensitivity": "financial"
    },
    {
      "id": "consolidation_amount",
      "type": "currency",
      "label": "Total consolidation amount",
      "required": true,
      "auto_calculate": "sum of selected_cards current_balance",
      "ask_as": "Based on your selections, the total you'd be consolidating is ${calculated_amount}. Does that look right, or would you like to adjust?",
      "validation": { "min": 1000, "max": 250000 },
      "format": { "currency": "USD", "precision": 0 },
      "grouping": "ask_with_previous",
      "sensitivity": "financial"
    }
  ]
}
```

### Step 3: Confirm personal info (auto-populated from Spinwheel)

```json
{
  "id": "personal_info",
  "order": 3,
  "label": "Confirm your information",
  "instructions": "These fields are PRE-POPULATED from Spinwheel identity verification. Present them to the user for confirmation. Only ask for fields that weren't returned by Spinwheel (like email, which Spinwheel doesn't provide).",
  "fields": [
    {
      "id": "full_name",
      "type": "text",
      "label": "Full legal name",
      "required": true,
      "auto_populated_from": "identity.full_name",
      "ask_as": "I have your name as {identity.full_name}. Is that correct?",
      "grouping": "batch_ok",
      "sensitivity": "personal"
    },
    {
      "id": "address_street",
      "type": "text",
      "label": "Street address",
      "required": true,
      "auto_populated_from": "identity.address.street",
      "grouping": "batch_ok",
      "sensitivity": "personal"
    },
    {
      "id": "address_city",
      "type": "text",
      "label": "City",
      "required": true,
      "auto_populated_from": "identity.address.city",
      "grouping": "batch_ok",
      "sensitivity": "personal"
    },
    {
      "id": "address_state",
      "type": "text",
      "label": "State",
      "required": true,
      "auto_populated_from": "identity.address.state",
      "grouping": "batch_ok",
      "sensitivity": "personal"
    },
    {
      "id": "address_zip",
      "type": "text",
      "label": "ZIP code",
      "required": true,
      "auto_populated_from": "identity.address.zip",
      "grouping": "batch_ok",
      "sensitivity": "personal"
    },
    {
      "id": "ssn_last4",
      "type": "text",
      "label": "SSN (last 4)",
      "required": true,
      "auto_populated_from": "identity.ssn_last4",
      "ask_as": "I have your SSN ending in {identity.ssn_last4}. The full number is held securely by Spinwheel and was never shared with me.",
      "sensitivity": "sensitive",
      "grouping": "ask_alone"
    },
    {
      "id": "email",
      "type": "email",
      "label": "Email address",
      "required": true,
      "ask_as": "What's the best email to reach you at?",
      "validation": { "pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
      "grouping": "ask_alone",
      "sensitivity": "personal"
    }
  ]
}
```

### Step 4: Financial details (partially auto-populated)

```json
{
  "id": "financial_details",
  "order": 4,
  "label": "Financial details",
  "instructions": "Monthly debt payments are AUTO-CALCULATED from the Spinwheel debt profile. Annual income and employment are still manual. Credit score may be auto-populated from the credit report.",
  "fields": [
    {
      "id": "annual_income",
      "type": "currency",
      "label": "Annual gross income",
      "required": true,
      "ask_as": "What's your approximate annual income before taxes?",
      "help": "Include salary, bonuses, and regular side income. An estimate is fine.",
      "validation": { "min": 0, "max": 99999999 },
      "format": { "currency": "USD", "precision": 0 },
      "grouping": "ask_alone",
      "sensitivity": "financial"
    },
    {
      "id": "employment_status",
      "type": "select",
      "label": "Employment status",
      "required": true,
      "ask_as": "What's your current employment situation?",
      "options": [
        { "value": "employed_w2", "label": "Employed (W-2)" },
        { "value": "self_employed", "label": "Self-employed" },
        { "value": "retired", "label": "Retired" },
        { "value": "other", "label": "Other" }
      ],
      "grouping": "ask_with_previous",
      "sensitivity": "low"
    },
    {
      "id": "monthly_debts",
      "type": "currency",
      "label": "Total monthly debt payments",
      "required": true,
      "auto_calculated_from": "debt_profile.summary.total_monthly_payments",
      "ask_as": "Based on your credit report, your total monthly debt payments are approximately ${calculated}. Does that sound right?",
      "help": "This was calculated from your credit report. It includes minimums on credit cards, loan payments, etc. Adjust if you know a different number.",
      "validation": { "min": 0, "max": 999999 },
      "format": { "currency": "USD", "precision": 0 },
      "grouping": "ask_alone",
      "sensitivity": "financial"
    },
    {
      "id": "credit_score_range",
      "type": "select",
      "label": "Credit score range",
      "required": true,
      "auto_populated_from": "debt_profile.credit_score.range",
      "ask_as": "Your credit score from the report is {credit_score.score} ({credit_score.range}). We'll use that for the pre-qualification.",
      "options": [
        { "value": "760_plus", "label": "Excellent (760+)" },
        { "value": "740_759", "label": "Very good (740-759)" },
        { "value": "720_739", "label": "Good (720-739)" },
        { "value": "700_719", "label": "Above average (700-719)" },
        { "value": "680_699", "label": "Fair (680-699)" },
        { "value": "660_679", "label": "Below average (660-679)" },
        { "value": "below_660", "label": "Below 660" }
      ],
      "grouping": "ask_alone",
      "sensitivity": "financial"
    }
  ]
}
```

### Step 5: Loan preferences

```json
{
  "id": "loan_preferences",
  "order": 5,
  "label": "Loan preferences",
  "instructions": "Final preferences for the personal loan. The loan amount is already known from the selected credit cards.",
  "fields": [
    {
      "id": "preferred_term",
      "type": "select",
      "label": "Preferred loan term",
      "required": true,
      "ask_as": "How quickly would you like to pay off the loan?",
      "help": "Shorter terms mean higher monthly payments but less total interest. Longer terms lower your monthly payment but cost more over time.",
      "options": [
        { "value": "36", "label": "3 years (36 months)" },
        { "value": "48", "label": "4 years (48 months)" },
        { "value": "60", "label": "5 years (60 months)" },
        { "value": "72", "label": "6 years (72 months)" }
      ],
      "grouping": "ask_alone",
      "sensitivity": "none"
    },
    {
      "id": "autopay",
      "type": "boolean",
      "label": "Interested in autopay",
      "required": false,
      "ask_as": "Would you like to set up autopay? Many lenders offer a rate discount (usually 0.25%) for automatic payments.",
      "grouping": "ask_with_previous",
      "sensitivity": "none"
    }
  ]
}
```

---

## 8. Updated SKILL.md

The skill file needs to be updated to include the Spinwheel Connect flow. The key changes:

### Add to the discovery section:

```markdown
## Spinwheel integration

This funnel uses Spinwheel for identity verification and debt profiling.
The Spinwheel API key is held securely by the Horizon server. You interact
with Spinwheel through proxy endpoints — you never need an API key.

### Identity verification flow

1. Ask the user for their phone number and date of birth
2. POST to {BASE_URL}/api/sw/connect with { phone, dob }
   - You'll get back a { session_token }
   - An SMS with a 6-digit code is sent to the user
3. Ask the user for the 6-digit code they received
4. POST to {BASE_URL}/api/sw/verify with { session_token, otp_code }
   - On success, you get { identity: { full_name, address, ssn_last4 } }
   - The full SSN is held server-side. You only see the last 4 digits.
5. Present the verified identity to the user and ask them to confirm

### Debt profile flow

After identity is verified:

1. POST to {BASE_URL}/api/sw/debt-profile with { session_token }
   - Returns all credit cards, auto loans, student loans, etc. with balances
2. Present the credit cards to the user
3. Ask which cards they want to consolidate into a personal loan
4. For cards with real-time balance support, optionally call:
   POST to {BASE_URL}/api/sw/refresh-balance with { session_token, liability_id }

### Consent requirements

Before calling /api/sw/connect, show this Spinwheel consent text:
"By continuing you agree to the Spinwheel End User Agreement. Further,
you are providing 'written instructions' to Spinwheel Solutions, Inc.
authorizing it to obtain your credit profile from any consumer reporting
agency."

This is in ADDITION to the Horizon funnel disclosures.
```

### Updated conversation flow:

```markdown
### Phase 2: Data collection (Spinwheel-enhanced)

The flow is now:

1. **Phone + DOB** → Call /api/sw/connect → OTP sent
2. **OTP code** → Call /api/sw/verify → Identity returned
3. **Confirm identity** → Show name, address, SSN last-4; user confirms
4. **Debt profile** → Call /api/sw/debt-profile → All debts shown
5. **Select cards** → User picks credit cards to consolidate
6. **Income + employment** → Only manual fields remaining
7. **Loan preferences** → Term length, autopay
8. **Review + submit** → Summary with real numbers

Fields that used to be manual are now auto-populated:
- full_name → from Spinwheel identity
- address → from Spinwheel identity
- ssn_last4 → from Spinwheel identity (full SSN held server-side)
- monthly_debts → calculated from debt profile
- credit_score_range → from credit report
- consolidation_amount → sum of selected card balances

The only fields the user types manually are:
- phone, dob (to initiate verification)
- otp_code (from their text message)
- email (Spinwheel doesn't provide this)
- annual_income, employment_status
- preferred_term, autopay preference
```

---

## 9. Updated pre-qualification engine

The pre-qualification engine in `validation.js` now uses real debt data:

```javascript
function calculatePersonalLoanPrequal(responses, debtProfile) {
  const annualIncome = responses.annual_income || 0;
  const monthlyIncome = annualIncome / 12;
  
  // Real monthly debt payments from Spinwheel
  const monthlyDebts = responses.monthly_debts || debtProfile?.summary?.total_monthly_payments || 0;
  
  // Consolidation amount from selected cards
  const loanAmount = responses.consolidation_amount || 0;
  
  // Credit score from actual credit report
  const creditRange = responses.credit_score_range || debtProfile?.credit_score?.range || 'not_sure';
  
  // Rate table for personal loans (different from mortgage rates)
  const PERSONAL_LOAN_RATES = {
    '760_plus':   0.0699,
    '740_759':    0.0899,
    '720_739':    0.1099,
    '700_719':    0.1299,
    '680_699':    0.1599,
    '660_679':    0.1999,
    'below_660':  0.2499,
    'not_sure':   0.1299,
  };
  
  const rate = PERSONAL_LOAN_RATES[creditRange];
  const termMonths = parseInt(responses.preferred_term || '48');
  const monthlyRate = rate / 12;
  
  // Monthly payment for the new personal loan
  const newMonthlyPayment = loanAmount > 0
    ? loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1)
    : 0;
  
  // Current monthly payment on selected cards
  const selectedCards = debtProfile?.credit_cards?.filter(c => 
    responses.selected_cards?.includes(c.id)
  ) || [];
  const currentCardPayments = selectedCards.reduce((sum, c) => sum + (c.min_payment || 0), 0);
  
  // After consolidation: remove selected card payments, add new loan payment
  const monthlyDebtsAfter = monthlyDebts - currentCardPayments + newMonthlyPayment;
  
  // DTI calculations
  const dtiBefore = monthlyIncome > 0 ? monthlyDebts / monthlyIncome : 1;
  const dtiAfter = monthlyIncome > 0 ? monthlyDebtsAfter / monthlyIncome : 1;
  
  // Total interest saved calculation
  // Assume average credit card APR of 22% if we don't have actual APRs
  const avgCardAPR = 0.22;
  const cardInterestCost = selectedCards.reduce((total, card) => {
    const cardRate = (card.apr || avgCardAPR) / 12;
    const cardBalance = card.current_balance || 0;
    // Minimum payment payoff timeline (rough estimate)
    const minPay = Math.max(card.min_payment || 25, cardBalance * 0.02);
    const monthsToPayoff = cardBalance > 0 ? Math.ceil(Math.log(minPay / (minPay - cardBalance * cardRate)) / Math.log(1 + cardRate)) : 0;
    const totalPaid = minPay * Math.min(monthsToPayoff, 360);
    return total + (totalPaid - cardBalance);
  }, 0);
  
  const personalLoanInterest = (newMonthlyPayment * termMonths) - loanAmount;
  const interestSaved = Math.max(0, cardInterestCost - personalLoanInterest);
  
  // Qualification
  const maxDTI = 0.43;
  let qualified = true;
  const concerns = [];
  const highlights = [];
  
  if (dtiAfter > maxDTI) {
    qualified = false;
    concerns.push(`Projected debt-to-income ratio of ${Math.round(dtiAfter * 100)}% exceeds the ${Math.round(maxDTI * 100)}% guideline`);
  }
  
  if (loanAmount < 1000) {
    qualified = false;
    concerns.push('Minimum personal loan amount is $1,000');
  }
  
  if (loanAmount > 100000) {
    qualified = false;
    concerns.push('Maximum personal loan amount is $100,000');
  }
  
  if (creditRange === 'below_660') {
    qualified = false;
    concerns.push('Credit score below minimum threshold for unsecured personal loans');
  }
  
  // Highlights
  if (interestSaved > 0) {
    highlights.push(`Estimated interest savings of $${Math.round(interestSaved).toLocaleString()} over the life of the loan`);
  }
  if (newMonthlyPayment < currentCardPayments) {
    highlights.push(`Monthly payment drops from $${Math.round(currentCardPayments).toLocaleString()} to $${Math.round(newMonthlyPayment).toLocaleString()}`);
  }
  if (dtiAfter < dtiBefore) {
    highlights.push(`DTI improves from ${Math.round(dtiBefore * 100)}% to ${Math.round(dtiAfter * 100)}%`);
  }
  highlights.push(`Consolidate ${selectedCards.length} credit card${selectedCards.length > 1 ? 's' : ''} into one fixed monthly payment`);
  
  const ratePercent = (rate * 100).toFixed(2);
  
  return {
    qualified,
    loan_amount: loanAmount,
    estimated_rate: parseFloat(ratePercent),
    term_months: termMonths,
    estimated_monthly_payment: Math.round(newMonthlyPayment),
    current_card_payments: Math.round(currentCardPayments),
    monthly_savings: Math.round(Math.max(0, currentCardPayments - newMonthlyPayment)),
    estimated_interest_saved: Math.round(interestSaved),
    total_cost_of_loan: Math.round(newMonthlyPayment * termMonths),
    dti_before: Math.round(dtiBefore * 100) / 100,
    dti_after: Math.round(dtiAfter * 100) / 100,
    cards_consolidated: selectedCards.map(c => ({
      name: c.display_name,
      balance: c.current_balance,
      masked_number: c.masked_number,
    })),
    highlights,
    concerns,
    message: qualified
      ? `Great news, ${responses.full_name?.split(' ')[0]}! You're pre-qualified to consolidate $${loanAmount.toLocaleString()} in credit card debt at an estimated ${ratePercent}% APR.`
      : `We weren't able to pre-qualify you right now, but there may be other options available.`,
  };
}
```

---

## 10. Register the proxy routes in server.js

Add to server.js:

```javascript
const spinwheelProxy = require('./src/routes/spinwheel-proxy');

// Spinwheel proxy routes (must be before static files)
app.use('/api/sw', spinwheelProxy);
```

---

## 11. Update store.js for Spinwheel sessions

Add to the existing store.js:

```javascript
const spinwheelSessions = new Map();  // session_token -> Spinwheel session data

// Clean expired sessions every 10 minutes (sessions live 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of spinwheelSessions) {
    const created = new Date(session.createdAt).getTime();
    if (now - created > 3600000) { // 1 hour expiry
      spinwheelSessions.delete(token);
    }
  }
}, 10 * 60 * 1000);

module.exports = {
  // ... existing exports ...

  createSpinwheelSession(token, data) {
    spinwheelSessions.set(token, data);
  },

  getSpinwheelSession(token) {
    const session = spinwheelSessions.get(token);
    if (!session) return null;
    const created = new Date(session.createdAt).getTime();
    if (Date.now() - created > 3600000) {
      spinwheelSessions.delete(token);
      return null;
    }
    return session;
  },

  updateSpinwheelSession(token, updates) {
    const session = spinwheelSessions.get(token);
    if (session) {
      Object.assign(session, updates);
    }
  },

  // Get full SSN for submission (never exposed to Claude)
  getFullSSN(token) {
    const session = spinwheelSessions.get(token);
    return session?.fullSSN || null;
  },
};
```

---

## 12. Environment variables

Add to `.env.example`:

```bash
PORT=3000
BASE_URL=http://localhost:3000
NODE_ENV=development

# Spinwheel API Configuration
SPINWHEEL_API_KEY=your_spinwheel_api_key_here
SPINWHEEL_BASE_URL=https://secure-sandbox-api.spinwheel.io/v1/users
```

For production, change `SPINWHEEL_BASE_URL` to `https://secure-api.spinwheel.io/v1/users`.

---

## 13. Sandbox testing

### Test sequence with curl

```bash
BASE=http://localhost:3000

# Step 1: Connect (use any valid US phone + sandbox DOB)
curl -s -X POST $BASE/api/sw/connect \
  -H "Content-Type: application/json" \
  -d '{"phone": "4155551234", "dob": "1990-01-01"}' | jq .
# Returns: { session_token: "...", status: "OTP_SENT" }
# Save the session_token

# Step 2: Verify (sandbox OTP is always 000000)
curl -s -X POST $BASE/api/sw/verify \
  -H "Content-Type: application/json" \
  -d '{"session_token": "YOUR_TOKEN", "otp_code": "000000"}' | jq .
# Returns: { verified: true, identity: { full_name, address, ssn_last4 } }

# Step 3: Pull debt profile
curl -s -X POST $BASE/api/sw/debt-profile \
  -H "Content-Type: application/json" \
  -d '{"session_token": "YOUR_TOKEN"}' | jq .
# Returns: { credit_cards: [...], auto_loans: [...], summary: { total_debt: ... } }

# Step 4: Refresh a credit card balance (optional)
curl -s -X POST $BASE/api/sw/refresh-balance \
  -H "Content-Type: application/json" \
  -d '{"session_token": "YOUR_TOKEN", "liability_id": "CARD_ID_FROM_STEP_3"}' | jq .
```

### Testing with Claude

Tell Claude:

> "I want to consolidate my credit card debt with a personal loan at [YOUR_DEPLOYED_URL]"

Expected flow:
1. Claude fetches the manifest, discovers Spinwheel integration
2. Claude asks for phone number and DOB
3. Claude calls /api/sw/connect, tells user to check their phone
4. Claude asks for the 6-digit code
5. Claude calls /api/sw/verify, shows the user their verified identity
6. Claude calls /api/sw/debt-profile, presents all credit cards with balances
7. Claude asks which cards to consolidate
8. Claude asks for income and employment (only manual fields)
9. Claude asks about loan term preference
10. Claude presents review with real numbers: consolidation amount, estimated rate, monthly payment, interest savings
11. Claude provides the review link for final submission

### Sandbox test users for interesting scenarios

| DOB to use | Person | Scenario | Cards |
|-----------|--------|----------|-------|
| 1990-01-01 | Aldo Cherry | Light debt ($5k total) | 2 credit cards |
| 1990-06-10 | Sal Monella | Heavy card debt ($50k across 3 cards) | Good consolidation candidate |
| 1990-10-08 | Terrance Dactyl | Very high debt ($150k cards + $730k mortgage) | Stress test |
| 1990-03-01 | Melissa Singh | Mixed debt ($20k) | 2 cards + personal loan |

---

## 14. Security considerations

### API key isolation

The Spinwheel API key exists in exactly ONE place: the `SPINWHEEL_API_KEY` environment variable on the server. It is used in exactly ONE file: `src/spinwheel-client.js`. It is never:
- Sent in any API response
- Included in the manifest
- Visible to Claude
- Logged to console (add middleware to redact if it appears in error messages)
- Stored in the browser

### Session token security

Session tokens are UUIDs that map to Spinwheel user IDs server-side. They:
- Expire after 1 hour
- Are single-use per flow (connect → verify → debt profile → submit)
- Cannot be used to access other users' data
- Don't contain any encoded PII (they're opaque random UUIDs)

### PII handling

| Data | Where it lives | Who can see it |
|------|---------------|---------------|
| Full SSN | Server memory only (`store.fullSSN`) | Only the submission endpoint |
| SSN last 4 | Returned to Claude/user | Claude presents it for confirmation |
| Full name + address | Returned to Claude/user | Auto-populates funnel fields |
| Credit card numbers | Masked in proxy transform | Only masked version leaves the server |
| Raw credit report | Never leaves the server | Spinwheel returns it; proxy transforms it |
| Spinwheel userId | Server memory only | Only the proxy routes use it |

### Rate limiting (add in production)

The proxy should rate-limit:
- `/api/sw/connect`: 3 requests per phone per 10 minutes
- `/api/sw/verify`: 5 attempts per session token
- `/api/sw/debt-profile`: 1 request per session token per 5 minutes
- `/api/sw/refresh-balance`: 1 request per liability per 10 minutes

For the demo, these are not implemented but should be noted as TODO.

---

## Summary of new/changed files

| # | File | Status | Purpose |
|---|------|--------|---------|
| 1 | `src/spinwheel-client.js` | NEW | Low-level Spinwheel API client (holds API key) |
| 2 | `src/routes/spinwheel-proxy.js` | NEW | Proxy routes for Claude/website |
| 3 | `server.js` | MODIFIED | Register spinwheel proxy routes |
| 4 | `src/store.js` | MODIFIED | Add Spinwheel session storage |
| 5 | `src/validation.js` | MODIFIED | Personal loan pre-qual engine using real debt data |
| 6 | `src/data/mortgage-prequal-steps.json` | REPLACED | Now personal-loan-consolidation-steps.json with 5 steps |
| 7 | `public/.well-known/ai-funnel.json` | MODIFIED | Add identity_verification section, update funnel |
| 8 | `skill/SKILL.md` | MODIFIED | Add Spinwheel Connect flow instructions |
| 9 | `public/review.html` | MODIFIED | Show consolidated card details on review |
| 10 | `.env.example` | MODIFIED | Add SPINWHEEL_API_KEY and SPINWHEEL_BASE_URL |
