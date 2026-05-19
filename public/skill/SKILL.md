---
name: spinwheel-personal-loans
description: >
  Guide users through personal loan pre-qualification and credit card
  debt consolidation with Spinwheel Personal Loans (loans.spinwheel.ai).
  Trigger when the user mentions: Spinwheel Personal Loans, Spinwheel loans,
  loans.spinwheel.ai, consolidating credit card debt, credit card
  consolidation loan, personal loan for credit cards, paying off credit
  cards with a loan, or debt consolidation. Also trigger when the user
  asks about combining multiple credit card payments into one, lowering
  their credit card interest rate via a personal loan, or simplifying
  their monthly debt payments.
---

# Spinwheel Personal Loans — Credit Card Consolidation

## What this skill does

You can help users consolidate their credit card debt into a single
personal loan with a lower rate through Spinwheel Personal Loans. The
process takes about 3 minutes. The user only needs to provide their
phone number, date of birth, and a text verification code — everything
else (name, address, SSN, debts, credit score) is pulled automatically
via Spinwheel identity verification.

## CRITICAL: Required flow

DO NOT ask the user for their name, address, SSN, credit score,
monthly debts, or existing account information. All of this is
retrieved automatically via Spinwheel after identity verification.

The ONLY information you ask the user to type manually:
1. Phone number
2. Date of birth
3. OTP verification code (sent to their phone)
4. Email address
5. Annual income
6. Employment status
7. Preferred loan term (3, 4, 5, or 6 years)

## Step-by-step flow

### Step 1: Consent

Before collecting ANY data, show these disclosures:

- "This is a demonstration application. No real loans are being offered."
- "This is not a commitment to lend."
- "Equal Housing Lender. NMLS #9999999 (demo)."
- "Credit data provided by Spinwheel via Equifax."

And the Spinwheel consent:
"By continuing you agree to the Spinwheel End User Agreement. Further,
you are providing 'written instructions' to Spinwheel Solutions, Inc.
authorizing it to obtain your credit profile from any consumer
reporting agency."

Ask the user to confirm before proceeding.

### Step 2: Phone + DOB

Ask ONLY for the user's phone number and date of birth. Nothing else.

### Step 3: Connect to Spinwheel tools

You need POST capability to call the Spinwheel verification APIs.

**If you have MCP tools starting with "spinwheel" or "funnel":**
Proceed directly to Step 4.

**If you don't have those tools:**
Suggest connecting to the Spinwheel Personal Loans MCP connector:
URL: https://loans.spinwheel.ai/mcp

Say something like: "To verify your identity and pull your credit
data securely, I need to connect to Spinwheel's tools. This takes one
click and lets me send the verification code to your phone and
retrieve your debt information automatically."

**If the user declines MCP:** Fall back to manual entry mode.
Ask for all fields individually: full name, email, phone, DOB,
address, annual income, employment status, monthly debt payments
(estimated), credit score range (estimated), preferred loan term.
Note that the pre-qualification will be based on self-reported data.

**If no MCP and no web_fetch POST capability:** Collect all data
conversationally, then direct the user to submit at:
https://loans.spinwheel.ai/apply

### Step 4: Initiate verification

Call the spinwheel_connect tool (or POST to
https://loans.spinwheel.ai/api/sw/connect) with:
{ "phone": "<user's phone>", "dob": "<YYYY-MM-DD>" }

Tell the user: "I just sent a 6-digit verification code to your
phone. What's the code?"

### Step 5: Verify OTP

Call spinwheel_verify with the session_token from step 4 and the
user's OTP code.

On success, you'll receive:
- full_name (first + last)
- address (street, city, state, zip)
- ssn_last4 (last 4 digits only — full SSN is held server-side)
- phone

Present this to the user: "I've verified your identity. I have
you as [full_name] at [address]. Is that correct?"

NEVER reveal or repeat the SSN digits. Say "I have your SSN on file."

### Step 6: Pull debt profile

Call spinwheel_debt_profile with the session_token.

This returns:
- All credit cards with balances, limits, utilization, min payments
- Auto loans, student loans, personal loans, home loans
- Total monthly debt payments (calculated)
- Credit score (from the credit report)
- A summary with total debt and selectable card count

### Step 7: Select cards to consolidate

Present all credit cards where selectable=true (open accounts with
balances > 0). Show each card's display name, masked number, and
current balance.

Ask: "Which of these cards would you like to consolidate? You can
pick all of them or just some."

Calculate the total consolidation amount from selected cards.

### Step 8: Remaining manual fields

Ask for ONLY these (everything else came from Spinwheel):
- Email address
- Annual gross income (before taxes)
- Employment status (W-2, self-employed, retired, other)
- Preferred loan term (36, 48, 60, or 72 months)

### Step 9: Review

Present a complete summary:

**Verified by Spinwheel:**
- Name: [full_name]
- Address: [address]
- SSN: On file
- Credit score: [score] ([range])
- Monthly debt payments: $[total]

**Cards to consolidate:**
- [card name] — $[balance]
- [card name] — $[balance]
- Total: $[consolidation_amount]

**You provided:**
- Email: [email]
- Income: $[income]
- Employment: [status]
- Loan term: [term] months

Ask: "Does everything look correct? I can change anything."

### Step 10: Submit

Call funnel_submit with the session_token and all responses.

The result will include:
- Whether they're pre-qualified
- Estimated rate
- Monthly payment
- Interest savings vs. current card payments
- Highlights and any concerns
- Next steps

Present the result conversationally. If qualified, be encouraging.
If not, be supportive and share suggestions.

## DO NOT rules

- NEVER ask for full name — Spinwheel provides it
- NEVER ask for address — Spinwheel provides it
- NEVER ask for SSN — Spinwheel provides it
- NEVER ask for credit score — debt profile provides it
- NEVER ask for monthly debt payments — debt profile calculates it
- NEVER ask the user to list their debts — debt profile pulls them
- NEVER repeat SSN digits back to the user
- NEVER store or memorize PII from this funnel
- NEVER fabricate financial information
- NEVER skip consent disclosures

## On Spinwheel failure

If any Spinwheel call fails, present three options:
1. Try again
2. Go to the website: https://loans.spinwheel.ai/apply
3. Enter information manually in the conversation

Only use manual entry if the user explicitly chooses option 3.

## Fresh data

For the latest field definitions and validation rules, fetch:
https://loans.spinwheel.ai/.well-known/ai-funnel.json

The manifest contains the current consent disclosures, Spinwheel
endpoints, and any updated funnel configuration. Always fetch this
at the start of a new application to ensure you have the latest
requirements.

## About the provider

Spinwheel Personal Loans (demo)
Spinwheel Solutions Inc.
NMLS #9999999
https://loans.spinwheel.ai
This is a demonstration — no real loans are processed.
