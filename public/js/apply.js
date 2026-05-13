// Minimal browser-side traditional flow: phone + DOB -> OTP -> debt profile -> form
(() => {
  const root = document.getElementById('app');
  const state = {
    phase: 'consent',
    sessionToken: null,
    identity: null,
    debtProfile: null,
    selectedCards: new Set(),
    responses: {},
  };

  function render() {
    root.innerHTML = '';
    if (state.phase === 'consent') return renderConsent();
    if (state.phase === 'connect') return renderConnect();
    if (state.phase === 'verify') return renderVerify();
    if (state.phase === 'debts') return renderDebts();
    if (state.phase === 'financial') return renderFinancial();
    if (state.phase === 'review') return renderReview();
    if (state.phase === 'result') return renderResult();
  }

  function renderConsent() {
    root.innerHTML = `
      <div class="card">
        <h2>Before we begin</h2>
        <div class="disclosure">
          By continuing you agree to the Spinwheel End User Agreement and provide written instructions
          to Spinwheel Solutions, Inc. authorizing it to obtain your credit profile from any consumer
          reporting agency.
        </div>
        <div class="disclosure">
          This is a demonstration application. No real loans are being offered. Credit data is pulled
          via Spinwheel sandbox.
        </div>
        <button class="btn btn-primary" id="agree">I agree, continue</button>
      </div>
    `;
    document.getElementById('agree').addEventListener('click', () => { state.phase = 'connect'; render(); });
  }

  function renderConnect() {
    root.innerHTML = `
      <div class="card">
        <h2>Verify your identity</h2>
        <label>Mobile phone number</label>
        <input id="phone" type="tel" placeholder="(415) 555-0123" />
        <label>Date of birth</label>
        <input id="dob" type="date" />
        <p><button class="btn btn-primary" id="send">Send verification code</button></p>
        <p id="err" class="warn"></p>
      </div>
    `;
    document.getElementById('send').addEventListener('click', async () => {
      const phone = document.getElementById('phone').value;
      const dob = document.getElementById('dob').value;
      try {
        const resp = await fetch('/api/sw/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, dob }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed');
        state.sessionToken = data.session_token;
        state.phase = 'verify';
        render();
      } catch (e) {
        document.getElementById('err').textContent = e.message;
      }
    });
  }

  function renderVerify() {
    root.innerHTML = `
      <div class="card">
        <h2>Enter the code</h2>
        <p>We sent a 6-digit code to your phone (sandbox: 000000).</p>
        <input id="otp" type="text" maxlength="6" placeholder="000000" />
        <p><button class="btn btn-primary" id="verify">Verify</button></p>
        <p id="err" class="warn"></p>
      </div>
    `;
    document.getElementById('verify').addEventListener('click', async () => {
      const otp = document.getElementById('otp').value;
      try {
        const resp = await fetch('/api/sw/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_token: state.sessionToken, otp_code: otp }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.verified) throw new Error(data.error || 'Verification failed');
        state.identity = data.identity;
        state.phase = 'debts';
        render();
        loadDebts();
      } catch (e) {
        document.getElementById('err').textContent = e.message;
      }
    });
  }

  async function loadDebts() {
    try {
      const resp = await fetch('/api/sw/debt-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: state.sessionToken }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to pull debt profile');
      state.debtProfile = data;
      render();
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="warn">Failed to load debts: ${e.message}</p></div>`;
    }
  }

  function renderDebts() {
    if (!state.debtProfile) {
      root.innerHTML = `<div class="card"><p>Pulling your debt profile…</p></div>`;
      return;
    }
    const cards = (state.debtProfile.credit_cards || []).filter(c => c.selectable);
    root.innerHTML = `
      <div class="card">
        <h2>Hello, ${state.identity?.first_name || 'there'}</h2>
        <p>SSN ending in ${state.identity?.ssn_last4 || '----'}</p>
        ${state.identity?.address ? `<p>${state.identity.address.street || ''}, ${state.identity.address.city || ''} ${state.identity.address.state || ''} ${state.identity.address.zip || ''}</p>` : ''}
        ${state.debtProfile.credit_score ? `<p>Credit score: <strong>${state.debtProfile.credit_score.score}</strong> (${state.debtProfile.credit_score.range})</p>` : ''}
        <h3>Which cards do you want to consolidate?</h3>
        ${cards.length === 0 ? '<p>No eligible cards found.</p>' : cards.map(c => `
          <label class="checkbox-row">
            <input type="checkbox" data-id="${c.id}" />
            <span><strong>${c.display_name}</strong> ${c.masked_number || ''}<br>
            <small>Balance $${(c.current_balance || 0).toLocaleString()} · Limit $${(c.credit_limit || 0).toLocaleString()} · Min $${(c.min_payment || 0).toLocaleString()}/mo</small></span>
          </label>
        `).join('')}
        <p><button class="btn btn-primary" id="next">Continue</button></p>
      </div>
    `;
    root.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedCards.add(cb.dataset.id);
        else state.selectedCards.delete(cb.dataset.id);
      });
    });
    document.getElementById('next').addEventListener('click', () => {
      state.phase = 'financial';
      render();
    });
  }

  function renderFinancial() {
    const total = (state.debtProfile?.credit_cards || [])
      .filter(c => state.selectedCards.has(c.id))
      .reduce((s, c) => s + (c.current_balance || 0), 0);
    root.innerHTML = `
      <div class="card">
        <h2>Financial details</h2>
        <p>Selected balance: <strong>$${total.toLocaleString()}</strong></p>
        <label>Annual income (gross)</label>
        <input id="income" type="number" min="0" />
        <label>Employment status</label>
        <select id="emp">
          <option value="employed_w2">Employed (W-2)</option>
          <option value="self_employed">Self-employed</option>
          <option value="retired">Retired</option>
          <option value="other">Other</option>
        </select>
        <label>Email</label>
        <input id="email" type="email" />
        <label>Preferred term</label>
        <select id="term">
          <option value="36">3 years</option>
          <option value="48" selected>4 years</option>
          <option value="60">5 years</option>
          <option value="72">6 years</option>
        </select>
        <p><button class="btn btn-primary" id="stage">Continue to review</button></p>
      </div>
    `;
    document.getElementById('stage').addEventListener('click', async () => {
      const responses = {
        phone: state.identity?.phone,
        dob: state.identity?.dob,
        full_name: state.identity?.full_name,
        address_street: state.identity?.address?.street,
        address_city: state.identity?.address?.city,
        address_state: state.identity?.address?.state,
        address_zip: state.identity?.address?.zip,
        ssn_last4: state.identity?.ssn_last4,
        email: document.getElementById('email').value,
        annual_income: Number(document.getElementById('income').value),
        employment_status: document.getElementById('emp').value,
        monthly_debts: state.debtProfile?.summary?.total_monthly_payments || 0,
        credit_score_range: state.debtProfile?.credit_score?.range || 'not_sure',
        selected_cards: Array.from(state.selectedCards),
        consolidation_amount: total,
        preferred_term: document.getElementById('term').value,
        autopay: false,
      };
      state.responses = responses;
      try {
        const resp = await fetch('/api/funnel/personal-loan-consolidation/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ responses, session_token: state.sessionToken, agent: { type: 'browser' } }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Validation failed');
        window.location.href = data.review_url;
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });
  }

  render();
})();
