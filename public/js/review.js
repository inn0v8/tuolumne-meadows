(async () => {
  const root = document.getElementById('review-root');
  const sessionId = new URLSearchParams(location.search).get('session');
  if (!sessionId) {
    root.innerHTML = '<p>Missing session id.</p>';
    return;
  }

  try {
    const resp = await fetch(`/api/funnel/personal-loan-consolidation/staged/${sessionId}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      root.innerHTML = `<p>This session has expired or doesn't exist. <a href="/apply">Start a new application</a>.</p>`;
      return;
    }
    const data = await resp.json();
    const r = data.responses || {};
    const cards = (data.debt_profile?.credit_cards || []).filter(c => (r.selected_cards || []).includes(c.id));

    root.innerHTML = `
      <div class="card">
        <h2>Personal information</h2>
        <p><strong>${r.full_name || ''}</strong></p>
        <p>${[r.address_street, r.address_city, r.address_state, r.address_zip].filter(Boolean).join(', ')}</p>
        <p>SSN ending in ${r.ssn_last4 || '----'} · ${r.email || ''}</p>
      </div>

      <div class="card">
        <h2>Cards to consolidate</h2>
        ${cards.length === 0 ? '<p>No cards selected.</p>' : `<ul>${cards.map(c => `<li>${c.display_name} ${c.masked_number || ''} — $${(c.current_balance || 0).toLocaleString()}</li>`).join('')}</ul>`}
        <p><strong>Total consolidation:</strong> $${(r.consolidation_amount || 0).toLocaleString()}</p>
      </div>

      <div class="card">
        <h2>Financial</h2>
        <p>Annual income: $${(r.annual_income || 0).toLocaleString()}</p>
        <p>Employment: ${r.employment_status || ''}</p>
        <p>Monthly debts: $${Math.round(r.monthly_debts || 0).toLocaleString()}</p>
        <p>Credit score range: ${r.credit_score_range || 'not_sure'}</p>
        <p>Preferred term: ${r.preferred_term || ''} months</p>
      </div>

      <div class="card">
        <h2>Disclosures</h2>
        <div class="disclosure">This is a demonstration application. No real loans are being offered.</div>
        <div class="disclosure">This is not a commitment to lend.</div>
        <div class="disclosure">Equal Housing Lender. NMLS #9999999 (demo). Credit data provided by Spinwheel via Equifax.</div>
        <label class="checkbox-row"><input type="checkbox" id="ack-disc" /> I have read the disclosures.</label>
        <label class="checkbox-row"><input type="checkbox" id="ack-priv" /> I agree to the <a href="/privacy" target="_blank">Privacy Policy</a>.</label>
        <label class="checkbox-row"><input type="checkbox" id="ack-terms" /> I agree to the <a href="/terms" target="_blank">Terms of Service</a>.</label>
        <p><button class="btn btn-primary" id="submit">Submit application</button></p>
        <p id="err" class="warn"></p>
      </div>
    `;

    document.getElementById('submit').addEventListener('click', async () => {
      const disc = document.getElementById('ack-disc').checked;
      const priv = document.getElementById('ack-priv').checked;
      const tos = document.getElementById('ack-terms').checked;
      const err = document.getElementById('err');
      if (!disc || !priv || !tos) {
        err.textContent = 'Please confirm all disclosures.';
        return;
      }
      err.textContent = '';
      try {
        const resp = await fetch('/api/funnel/personal-loan-consolidation/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            session_token: data.session_token,
            agent: data.agent,
            responses: r,
            consent: {
              user_confirmed_at: new Date().toISOString(),
              disclosures_shown: true,
              privacy_acknowledged: true,
              terms_acknowledged: true,
            },
          }),
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || 'Submission failed');
        window.location.href = `/result.html?session=${result.session_id}`;
      } catch (e) {
        err.textContent = e.message;
      }
    });
  } catch (e) {
    root.innerHTML = `<p>Error loading review: ${e.message}</p>`;
  }
})();
