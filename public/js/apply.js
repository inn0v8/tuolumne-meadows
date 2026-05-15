(() => {
  const form = document.getElementById('apply-form');
  const stepper = document.getElementById('stepper');
  const cardsList = document.getElementById('cards-list');
  const totalEl = document.getElementById('consolidation-total');
  const addCardBtn = document.getElementById('add-card');
  const errorEl = document.getElementById('form-error');

  let cardCount = 0;

  function addCardRow(prefill = {}) {
    cardCount += 1;
    const id = `manual_${cardCount}`;
    const row = document.createElement('div');
    row.className = 'card-row';
    row.dataset.id = id;
    row.innerHTML = `
      <div class="row-3">
        <label>Card issuer / name<input type="text" data-name="display_name" required value="${prefill.display_name || ''}" placeholder="e.g. Chase Sapphire"></label>
        <label>Current balance ($)<input type="number" data-name="current_balance" required min="0" step="1" value="${prefill.current_balance || ''}"></label>
        <label>Min monthly payment ($)<input type="number" data-name="min_payment" min="0" step="1" value="${prefill.min_payment || ''}"></label>
      </div>
      <p><button type="button" class="link-btn" data-remove>Remove</button></p>
    `;
    cardsList.appendChild(row);
    row.querySelectorAll('input[data-name="current_balance"]').forEach(i => i.addEventListener('input', updateTotal));
    row.querySelector('[data-remove]').addEventListener('click', () => { row.remove(); updateTotal(); });
    updateTotal();
  }

  function updateTotal() {
    let total = 0;
    cardsList.querySelectorAll('.card-row').forEach(row => {
      const v = Number(row.querySelector('input[data-name="current_balance"]').value || 0);
      total += v;
    });
    totalEl.textContent = total.toLocaleString();
  }

  function collectCards() {
    const cards = [];
    cardsList.querySelectorAll('.card-row').forEach(row => {
      const get = name => row.querySelector(`input[data-name="${name}"]`).value;
      const bal = Number(get('current_balance') || 0);
      if (!get('display_name').trim() || bal <= 0) return;
      cards.push({
        id: row.dataset.id,
        display_name: get('display_name').trim(),
        current_balance: bal,
        min_payment: Number(get('min_payment') || 0),
      });
    });
    return cards;
  }

  function showStep(n) {
    form.querySelectorAll('.step').forEach(s => s.classList.toggle('active', s.dataset.step === String(n)));
    stepper.querySelectorAll('li').forEach(li => li.classList.toggle('active', li.dataset.step === String(n)));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function validateCurrentStep(n) {
    const step = form.querySelector(`.step[data-step="${n}"]`);
    const inputs = step.querySelectorAll('input, select, textarea');
    for (const el of inputs) {
      if (!el.checkValidity()) {
        el.reportValidity();
        return false;
      }
    }
    if (n === 2 && collectCards().length === 0) {
      errorEl.textContent = 'Add at least one credit card with a balance.';
      return false;
    }
    errorEl.textContent = '';
    return true;
  }

  form.querySelectorAll('[data-next]').forEach(btn => {
    btn.addEventListener('click', () => {
      const current = Number(btn.closest('.step').dataset.step);
      if (!validateCurrentStep(current)) return;
      showStep(Number(btn.dataset.next));
    });
  });
  form.querySelectorAll('[data-prev]').forEach(btn => {
    btn.addEventListener('click', () => showStep(Number(btn.dataset.prev)));
  });

  addCardBtn.addEventListener('click', () => addCardRow());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateCurrentStep(4)) return;

    const data = new FormData(form);
    const cards = collectCards();
    const consolidationAmount = cards.reduce((s, c) => s + c.current_balance, 0);
    if (consolidationAmount < 1000) {
      errorEl.textContent = 'The total consolidation amount must be at least $1,000.';
      showStep(2);
      return;
    }

    const responses = {
      phone: data.get('phone'),
      dob: data.get('dob'),
      full_name: data.get('full_name'),
      address_street: data.get('address_street'),
      address_city: data.get('address_city'),
      address_state: data.get('address_state'),
      address_zip: data.get('address_zip'),
      ssn_last4: data.get('ssn_last4'),
      email: data.get('email'),
      annual_income: Number(data.get('annual_income')),
      employment_status: data.get('employment_status'),
      monthly_debts: Number(data.get('monthly_debts')),
      credit_score_range: data.get('credit_score_range'),
      selected_cards: cards.map(c => c.id),
      consolidation_amount: consolidationAmount,
      preferred_term: data.get('preferred_term'),
      autopay: !!data.get('autopay'),
    };

    const body = {
      responses,
      agent: { type: 'browser', interface: 'apply.html' },
      consent: {
        user_confirmed_at: new Date().toISOString(),
        disclosures_shown: true,
        privacy_acknowledged: true,
        terms_acknowledged: true,
      },
    };

    try {
      const resp = await fetch('/api/funnel/personal-loan-consolidation/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) {
        errorEl.textContent = result.error || 'Submission failed.';
        return;
      }
      window.location.href = `/result.html?session=${result.session_id}`;
    } catch (err) {
      errorEl.textContent = 'Network error: ' + err.message;
    }
  });

  // Seed with one empty card row.
  addCardRow();
})();
