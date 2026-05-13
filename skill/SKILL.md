---
name: horizon-person-loans-prequal
description: Guide users through a personal-loan credit-card consolidation pre-qualification with Horizon Home Loans. Trigger when the user mentions Horizon Home Loans, horizonloans, asks to consolidate credit card debt, or asks to apply for a personal loan at a Horizon URL. Also trigger when Claude discovers an ai-funnel.json manifest at a URL the user provides.
---

# Horizon Home Loans — Personal Loan Consolidation (Spinwheel-enabled)

## Overview

This skill enables Claude to conduct a personal-loan-for-credit-card-consolidation
pre-qualification with Horizon Home Loans through natural conversation, instead
of sending the user to fill out a web form. Identity verification, address,
SSN-last-4, debts, and credit score are pulled automatically through Spinwheel
via a secure server-side proxy.

## Discovery

When triggered, fetch the funnel manifest from:

```
{BASE_URL}/.well-known/ai-funnel.json
```

Parse the manifest to get the `steps_url`, then fetch the step
definitions. The steps contain all fields, validation rules,
conditional logic, and conversational guidance.

The manifest also contains an `identity_verification` block describing the
Spinwheel proxy endpoints.

## Spinwheel integration

This funnel uses Spinwheel for identity verification and debt profiling.
The Spinwheel API key is held securely by the Horizon server. You interact
with Spinwheel through proxy endpoints — you never need an API key.

### Identity verification flow

1. Ask the user for their phone number and date of birth.
2. POST to `{BASE_URL}/api/sw/connect` with `{ phone, dob }`.
   - You receive `{ session_token }`.
   - An SMS with a 6-digit code is sent.
3. Ask the user for the 6-digit code they received.
4. POST to `{BASE_URL}/api/sw/verify` with `{ session_token, otp_code }`.
   - On success you receive `{ identity: { full_name, address, ssn_last4 } }`.
   - The full SSN stays server-side; you only see the last 4 digits.
5. Present the verified identity to the user and ask them to confirm.

### Debt profile flow

After identity is verified:

1. POST to `{BASE_URL}/api/sw/debt-profile` with `{ session_token }`.
   - Returns all credit cards, auto loans, student loans, etc. with balances.
2. Present the credit cards to the user.
3. Ask which cards they want to consolidate into a personal loan.
4. For cards with `can_refresh_balance: true`, optionally call
   `POST {BASE_URL}/api/sw/refresh-balance` with `{ session_token, liability_id }`.

### Consent requirements

Before calling `/api/sw/connect`, show this Spinwheel consent text:

> "By continuing you agree to the Spinwheel End User Agreement. Further,
> you are providing 'written instructions' to Spinwheel Solutions, Inc.
> authorizing it to obtain your credit profile from any consumer reporting
> agency."

This is in **addition** to the Horizon funnel disclosures from the manifest.

## Conversation flow

### Phase 1: Consent

Before collecting ANY data, show the user:

1. The provider name, legal entity, and NMLS number
2. A brief description of what you'll be collecting
3. The required disclosures from the manifest
4. The Spinwheel consent text above
5. Links to the privacy policy and terms
6. Clear option to proceed or go to the website instead

Do NOT collect any personal information until the user explicitly agrees.

### Phase 2: Data collection (Spinwheel-enhanced)

The flow is:

1. **Phone + DOB** → POST `/api/sw/connect` → OTP sent
2. **OTP code** → POST `/api/sw/verify` → identity returned
3. **Confirm identity** → show name, address, SSN last-4; user confirms
4. **Debt profile** → POST `/api/sw/debt-profile` → all debts shown
5. **Select cards** → user picks which credit cards to consolidate
6. **Income + employment + email** → only manual fields
7. **Loan term + autopay** → preferences
8. **Review + submit** → summary with real numbers

Fields auto-populated from Spinwheel:
- `full_name` ← identity
- `address_street`, `address_city`, `address_state`, `address_zip` ← identity
- `ssn_last4` ← identity (full SSN held server-side)
- `monthly_debts` ← debt profile summary
- `credit_score_range` ← credit report
- `consolidation_amount` ← sum of selected card balances

Fields the user types manually:
- `phone`, `dob`, `otp_code`
- `email`
- `annual_income`, `employment_status`
- `selected_cards` (selection from presented list)
- `preferred_term`, `autopay`

### Phase 3: Review and submit

After collecting all fields:

1. Present a clean summary of ALL collected data organized by step.
2. Show: the cards being consolidated, total amount, estimated monthly payment,
   estimated rate, term, and projected interest savings.
3. Ask the user to confirm everything looks correct.
4. Offer to change any field.
5. Show the required disclosures one more time.
6. On confirmation, POST to the stage endpoint
   `{BASE_URL}/api/funnel/personal-loan-consolidation/stage` with
   `{ responses, session_token, agent }`. You receive a `review_url`.
7. Give the user the review URL so they can submit from the website (Path A).
   - Alternative: if you have direct submit access (Claude Code), POST to
     `{BASE_URL}/api/funnel/personal-loan-consolidation/submit` with the consent
     object filled in.

After submission, present the result conversationally:
- If qualified: share estimated loan amount, rate, monthly payment, savings,
  and next steps.
- If not qualified: be supportive, share the suggestions, offer fallback URL.

### Important guardrails

- NEVER store or memorize PII from this funnel.
- NEVER ask the user for their full SSN — Spinwheel handles it; you only see last 4.
- NEVER fabricate or assume financial information.
- ALWAYS show disclosures and Spinwheel consent before calling `/api/sw/connect`.
- ALWAYS let the user review before submitting.
- If the user wants to stop, provide the fallback URL `/apply`.
- This is a DEMO — remind the user no real loan is being processed.
