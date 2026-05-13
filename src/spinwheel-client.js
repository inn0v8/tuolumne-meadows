const SPINWHEEL_API_KEY = process.env.SPINWHEEL_API_KEY;
const SPINWHEEL_BASE_URL = process.env.SPINWHEEL_BASE_URL || 'https://sandbox-api.spinwheel.io/v1/users';

if (!SPINWHEEL_API_KEY) {
  console.warn('WARNING: SPINWHEEL_API_KEY not set. Spinwheel features will not work.');
}

async function spinwheelFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${SPINWHEEL_BASE_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SPINWHEEL_API_KEY}`,
      ...options.headers,
    },
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`Spinwheel API error: ${response.status}`);
    error.status = response.status;
    error.data = parsed;
    throw error;
  }

  // Spinwheel wraps successful responses in { status, data }. Unwrap data when present.
  return parsed && parsed.data !== undefined ? parsed.data : parsed;
}

async function connectSMS(phoneNumber, dateOfBirth, extUserId) {
  return spinwheelFetch('/connect/sms/', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber, dateOfBirth, extUserId }),
  });
}

async function verifySMS(userId, code) {
  return spinwheelFetch(`/${userId}/connect/sms/verify`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

async function requestDebtProfile(userId, opts = {}) {
  // Spinwheel rejects creditScore.model="Vantage 3.0" even though the error message lists it as
  // supported. The creditScore object appears to be feature-gated for this account, so we omit
  // it and request only the credit report. Pass opts.body to override.
  const body = opts.body || {
    creditReport: { type: 'equifax' },
  };
  return spinwheelFetch(`/${userId}/debtProfile`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function getUserProfile(userId) {
  return spinwheelFetch(`?userId=${userId}`, { method: 'GET' });
}

async function refreshLiabilityBalance(userId, liabilityId) {
  return spinwheelFetch(`/${userId}/liabilities/${liabilityId}/refresh`, {
    method: 'POST',
  });
}

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
