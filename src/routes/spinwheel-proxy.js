const express = require('express');
const { v4: uuidv4 } = require('uuid');
const sw = require('../spinwheel-client');
const store = require('../store');

const router = express.Router();

router.post('/connect', async (req, res) => {
  try {
    const { phone, dob } = req.body;

    if (!phone || !dob) {
      return res.status(400).json({ error: 'Phone number and date of birth are required.' });
    }

    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 11) {
      return res.status(400).json({ error: 'Please provide a valid US phone number.' });
    }
    // Spinwheel requires E.164 format (+1XXXXXXXXXX).
    const tenDigit = cleanPhone.length === 11 && cleanPhone.startsWith('1')
      ? cleanPhone.slice(1)
      : cleanPhone;
    const phoneNumber = `+1${tenDigit}`;

    const dobNormalized = normalizeDateOfBirth(dob);
    if (!dobNormalized) {
      return res.status(400).json({ error: 'Please provide date of birth in a recognizable format (e.g., 1990-03-15 or March 15, 1990).' });
    }

    const sessionToken = uuidv4();
    const extUserId = `spl-${uuidv4()}`;

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

    res.json({
      session_token: sessionToken,
      status: result.connectionStatus,
      message: 'A verification code has been sent to your phone. It expires in 5 minutes.',
    });
  } catch (err) {
    console.error('Spinwheel connect error:', err.status, err.data || err.message);
    const status = err.status || 500;
    const message = err.data?.message || err.data?.error || 'Failed to initiate verification. Please try again.';
    res.status(status).json({ error: message, details: err.data });
  }
});

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

    const result = await sw.verifySMS(session.spinwheelUserId, otp_code);

    if (result.connectionStatus !== 'SUCCESS') {
      return res.status(400).json({
        verified: false,
        error: 'Verification failed. Please check the code and try again.',
        status: result.connectionStatus,
      });
    }

    // Identity isn't available yet — it comes from the credit report, which is pulled in /debt-profile.
    // Leave identity null here; /debt-profile will populate it.
    store.updateSpinwheelSession(session_token, {
      connectionStatus: 'SUCCESS',
      identity: null,
    });

    res.json({
      verified: true,
      message: 'OTP verified. Identity and debts will be available after pulling the debt profile.',
      identity: null,
    });
  } catch (err) {
    console.error('Spinwheel verify error:', err.status, err.data || err.message);
    const status = err.status || 500;
    res.status(status).json({
      verified: false,
      error: err.data?.message || err.data?.error || 'Verification failed. Please try again.',
      details: err.data,
    });
  }
});

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

    res.json({ ...debts, identity });
  } catch (err) {
    console.error('Spinwheel debt profile error:', err.status, err.data || err.message);
    const status = err.status || 500;
    res.status(status).json({
      error: err.data?.message || err.data?.error || 'Failed to retrieve debt profile. Please try again.',
      details: err.data,
    });
  }
});

router.post('/refresh-balance', async (req, res) => {
  try {
    const { session_token, liability_id } = req.body;

    const session = store.getSpinwheelSession(session_token);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired.' });
    }

    await sw.refreshLiabilityBalance(session.spinwheelUserId, liability_id);

    let attempts = 0;
    let status = 'IN_PROGRESS';
    let balanceData = null;

    while (status === 'IN_PROGRESS' && attempts < 10) {
      await sleep(2000);
      attempts++;

      const userProfile = await sw.getUserProfile(session.spinwheelUserId);
      const userObj = Array.isArray(userProfile) ? userProfile[0] : userProfile;

      const allLiabilities = [
        ...(userObj.creditCards || []),
        ...(userObj.autoLoans || []),
        ...(userObj.studentLoans || []),
        ...(userObj.personalLoans || []),
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
    console.error('Spinwheel refresh error:', err.status, err.data || err.message);
    res.status(err.status || 500).json({
      error: 'Failed to refresh balance. Using cached balance.',
      details: err.data,
    });
  }
});

router.get('/session/:sessionToken', (req, res) => {
  const session = store.getSpinwheelSession(req.params.sessionToken);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired.' });
  }

  res.json({
    status: session.connectionStatus,
    identity: session.identity,
    debt_profile: session.debtProfile,
  });
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeDateOfBirth(dob) {
  const s = String(dob).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
                   july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  const textMatch = s.match(/^(\w+)\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (textMatch) {
    const month = months[textMatch[1].toLowerCase()];
    if (month) return `${textMatch[3]}-${month}-${textMatch[2].padStart(2, '0')}`;
  }

  return null;
}

function cardBalance(card) {
  return card.balanceDetails?.outstandingBalance
      ?? card.balanceDetails?.currentBalance
      ?? card.cardProfile?.currentBalance
      ?? 0;
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
  const ssnLast4 = ssnRaw ? ssnRaw.slice(-4) : null;

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
    ssn_last4: ssnLast4,
    phone: session.phone,
    _fullSSN: ssnRaw,
  };
}

function titleCase(s) {
  if (!s) return s;
  return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function transformDebtProfile(userData) {
  if (!userData) userData = {};
  const creditCards = (userData.creditCards || []).map(card => {
    const balance = cardBalance(card);
    return {
      id: card.creditCardId,
      type: 'credit_card',
      display_name: card.displayName || card.servicerName || 'Credit Card',
      logo_url: card.logoUrl || null,
      masked_number: card.cardProfile?.creditCardNumberMasked || null,
      current_balance: balance,
      credit_limit: card.cardProfile?.creditLimit || 0,
      credit_utilization: card.cardProfile?.creditUtilization || 0,
      available_credit: card.cardProfile?.availableCreditDerived || 0,
      min_payment: card.cardProfile?.minimumPaymentDue || card.balanceDetails?.minimumPaymentDue || null,
      apr: card.cardProfile?.interestRate || null,
      status: card.cardProfile?.status || 'UNKNOWN',
      account_type: card.cardProfile?.accountType || null,
      payment_status: card.cardProfile?.accountRating || null,
      can_refresh_balance: card.capabilities?.data?.realtimeBalance?.availability === 'SUPPORTED',
      selectable: (card.cardProfile?.status === 'OPEN') && balance > 0,
    };
  });

  const loanBalance = (loan) =>
    loan.balanceDetails?.outstandingBalance
    ?? loan.balanceDetails?.currentBalance
    ?? loan.loanProfile?.currentBalance
    ?? 0;

  const loanMonthly = (loan) =>
    loan.loanProfile?.monthlyPaymentAmount
    ?? loan.loanProfile?.scheduledMonthlyPayment
    ?? loan.balanceDetails?.minimumPaymentDue
    ?? 0;

  const autoLoans = (userData.autoLoans || []).map(loan => ({
    id: loan.autoLoanId,
    type: 'auto_loan',
    display_name: loan.displayName || loan.servicerName || 'Auto Loan',
    logo_url: loan.logoUrl || null,
    current_balance: loanBalance(loan),
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loanMonthly(loan),
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,
  }));

  const studentLoans = (userData.studentLoans || []).map(loan => ({
    id: loan.studentLoanId,
    type: 'student_loan',
    display_name: loan.displayName || loan.servicerName || 'Student Loan',
    logo_url: loan.logoUrl || null,
    current_balance: loanBalance(loan),
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loanMonthly(loan),
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,
  }));

  const personalLoans = (userData.personalLoans || []).map(loan => ({
    id: loan.personalLoanId,
    type: 'personal_loan',
    display_name: loan.displayName || loan.servicerName || 'Personal Loan',
    logo_url: loan.logoUrl || null,
    current_balance: loanBalance(loan),
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loanMonthly(loan),
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,
  }));

  const homeLoans = (userData.homeLoans || []).map(loan => ({
    id: loan.homeLoanId,
    type: 'home_loan',
    display_name: loan.displayName || loan.servicerName || 'Mortgage',
    logo_url: loan.logoUrl || null,
    current_balance: loanBalance(loan),
    original_amount: loan.loanProfile?.originalLoanAmount || 0,
    monthly_payment: loanMonthly(loan),
    status: loan.loanProfile?.status || 'UNKNOWN',
    selectable: false,
  }));

  const allDebts = [...creditCards, ...autoLoans, ...studentLoans, ...personalLoans, ...homeLoans];
  const totalDebt = allDebts.reduce((sum, d) => sum + (d.current_balance || 0), 0);
  const totalMonthlyPayments = allDebts.reduce((sum, d) => sum + (d.monthly_payment || d.min_payment || 0), 0);
  const totalCreditCardDebt = creditCards.reduce((sum, c) => sum + (c.current_balance || 0), 0);
  const selectableCards = creditCards.filter(c => c.selectable);

  // Credit score lives in creditReports[0].creditScoreDetails (may be empty for this account tier)
  const cr = (userData.creditReports || [])[0];
  const scoreDetail = (cr?.creditScoreDetails || [])[0];
  const creditScore = scoreDetail ? {
    score: scoreDetail.score,
    model: scoreDetail.modelName || scoreDetail.scoreModel || null,
    range: categorizeScore(scoreDetail.score),
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
