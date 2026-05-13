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

function validateResponses(responses, stepsData) {
  const missingFields = [];
  const invalidFields = [];

  for (const step of stepsData.steps) {
    for (const field of (step.fields || [])) {
      if (field.conditional && field.conditional.show_if) {
        if (!evaluateCondition(field.conditional.show_if, responses)) {
          continue;
        }
      }

      const value = responses[field.id];
      const isEmpty = value === undefined || value === null || value === '' ||
        (Array.isArray(value) && value.length === 0);

      if (field.required && isEmpty) {
        missingFields.push({ field_id: field.id, label: field.label });
        continue;
      }

      if (value !== undefined && value !== null && value !== '' && field.validation) {
        const errors = [];

        if (field.validation.min !== undefined && Number(value) < field.validation.min) {
          errors.push(`Must be at least ${field.validation.min}`);
        }
        if (field.validation.max !== undefined && Number(value) > field.validation.max) {
          errors.push(`Must be at most ${field.validation.max}`);
        }
        if (field.validation.min_length !== undefined && typeof value === 'string' && value.length < field.validation.min_length) {
          errors.push(`Must be at least ${field.validation.min_length} characters`);
        }
        if (field.validation.max_length !== undefined && typeof value === 'string' && value.length > field.validation.max_length) {
          errors.push(`Must be at most ${field.validation.max_length} characters`);
        }
        if (field.validation.pattern && typeof value === 'string') {
          const regex = new RegExp(field.validation.pattern);
          if (!regex.test(value)) {
            errors.push('Invalid format');
          }
        }
        if (field.validation.min_age) {
          const dob = new Date(value);
          if (!isNaN(dob.getTime())) {
            const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
            if (age < field.validation.min_age) {
              errors.push(`Must be at least ${field.validation.min_age} years old`);
            }
          }
        }

        if (errors.length > 0) {
          invalidFields.push({ field_id: field.id, label: field.label, errors });
        }
      }
    }
  }

  return {
    valid: missingFields.length === 0 && invalidFields.length === 0,
    missingFields,
    invalidFields,
  };
}

function validateSingleField(fieldDef, value, context = {}) {
  const errors = [];

  if (fieldDef.conditional && fieldDef.conditional.show_if) {
    if (!evaluateCondition(fieldDef.conditional.show_if, context)) {
      return { valid: true, applicable: false };
    }
  }

  const isEmpty = value === undefined || value === null || value === '';
  if (fieldDef.required && isEmpty) {
    return { valid: false, errors: ['This field is required'] };
  }

  if (!isEmpty && fieldDef.validation) {
    if (fieldDef.validation.min !== undefined && Number(value) < fieldDef.validation.min) {
      errors.push(`Must be at least ${fieldDef.validation.min}`);
    }
    if (fieldDef.validation.max !== undefined && Number(value) > fieldDef.validation.max) {
      errors.push(`Must be at most ${fieldDef.validation.max}`);
    }
    if (fieldDef.validation.pattern && typeof value === 'string') {
      const regex = new RegExp(fieldDef.validation.pattern);
      if (!regex.test(value)) {
        errors.push('Invalid format');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function evaluateCondition(condition, responses) {
  for (const [fieldId, rule] of Object.entries(condition)) {
    const value = responses[fieldId];

    if (typeof rule === 'object' && rule !== null) {
      if (rule.eq !== undefined && value !== rule.eq) return false;
      if (rule.neq !== undefined && value === rule.neq) return false;
      if (rule.in !== undefined && !rule.in.includes(value)) return false;
      if (rule.not_in !== undefined && rule.not_in.includes(value)) return false;
      if (rule.gt !== undefined && !(value > rule.gt)) return false;
      if (rule.lt !== undefined && !(value < rule.lt)) return false;
    } else {
      if (value !== rule) return false;
    }
  }
  return true;
}

function calculatePersonalLoanPrequal(responses, debtProfile) {
  const annualIncome = Number(responses.annual_income) || 0;
  const monthlyIncome = annualIncome / 12;

  const monthlyDebts = Number(responses.monthly_debts) || debtProfile?.summary?.total_monthly_payments || 0;

  const loanAmount = Number(responses.consolidation_amount) || 0;

  const creditRange = responses.credit_score_range || debtProfile?.credit_score?.range || 'not_sure';

  const rate = PERSONAL_LOAN_RATES[creditRange] ?? 0.1299;
  const termMonths = parseInt(responses.preferred_term || '48', 10);
  const monthlyRate = rate / 12;

  const newMonthlyPayment = loanAmount > 0
    ? loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1)
    : 0;

  const selectedIds = responses.selected_cards || [];
  const selectedCards = (debtProfile?.credit_cards || []).filter(c => selectedIds.includes(c.id));
  const currentCardPayments = selectedCards.reduce((sum, c) => sum + (c.min_payment || 0), 0);

  const monthlyDebtsAfter = monthlyDebts - currentCardPayments + newMonthlyPayment;

  const dtiBefore = monthlyIncome > 0 ? monthlyDebts / monthlyIncome : 1;
  const dtiAfter = monthlyIncome > 0 ? monthlyDebtsAfter / monthlyIncome : 1;

  const avgCardAPR = 0.22;
  const cardInterestCost = selectedCards.reduce((total, card) => {
    const cardRate = (card.apr || avgCardAPR) / 12;
    const cardBalance = card.current_balance || 0;
    const minPay = Math.max(card.min_payment || 25, cardBalance * 0.02);
    if (cardBalance <= 0 || minPay <= cardBalance * cardRate) return total;
    const monthsToPayoff = Math.ceil(Math.log(minPay / (minPay - cardBalance * cardRate)) / Math.log(1 + cardRate));
    const totalPaid = minPay * Math.min(monthsToPayoff, 360);
    return total + (totalPaid - cardBalance);
  }, 0);

  const personalLoanInterest = (newMonthlyPayment * termMonths) - loanAmount;
  const interestSaved = Math.max(0, cardInterestCost - personalLoanInterest);

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

  if (interestSaved > 0) {
    highlights.push(`Estimated interest savings of $${Math.round(interestSaved).toLocaleString()} over the life of the loan`);
  }
  if (newMonthlyPayment < currentCardPayments) {
    highlights.push(`Monthly payment drops from $${Math.round(currentCardPayments).toLocaleString()} to $${Math.round(newMonthlyPayment).toLocaleString()}`);
  }
  if (dtiAfter < dtiBefore) {
    highlights.push(`DTI improves from ${Math.round(dtiBefore * 100)}% to ${Math.round(dtiAfter * 100)}%`);
  }
  if (selectedCards.length > 0) {
    highlights.push(`Consolidate ${selectedCards.length} credit card${selectedCards.length > 1 ? 's' : ''} into one fixed monthly payment`);
  }

  const ratePercent = parseFloat((rate * 100).toFixed(2));

  return {
    qualified,
    loan_amount: loanAmount,
    estimated_rate: ratePercent,
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
    next_steps: qualified
      ? [
          'Complete the full application to lock in your rate',
          'Verify income with recent pay stubs or tax returns',
          'Review the loan agreement before signing',
        ]
      : [
          'Consider paying down existing debts to lower your DTI',
          'Reduce the requested loan amount',
          'Contact us to discuss alternative programs',
        ],
    message: qualified
      ? `Great news, ${responses.full_name?.split(' ')[0] || 'there'}! You're pre-qualified to consolidate $${loanAmount.toLocaleString()} in credit card debt at an estimated ${ratePercent}% APR.`
      : "We weren't able to pre-qualify you right now, but there may be other options available.",
    expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

module.exports = {
  validateResponses,
  validateSingleField,
  evaluateCondition,
  calculatePersonalLoanPrequal,
};
