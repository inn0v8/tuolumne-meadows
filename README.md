# Spinwheel Personal Loans (AAFP + Spinwheel demo)

Demo lending site implementing the **AI Application Funnel Protocol (AAFP)** with
**Spinwheel Connect SMS** for identity verification and debt profile retrieval.
A user (or an AI agent like Claude) can pre-qualify for a credit-card-consolidation
personal loan conversationally — phone + DOB + OTP triggers Spinwheel to return
identity and all outstanding debts, eliminating manual form entry.

## Architecture

- **Manifest:** `/.well-known/ai-funnel.json` — discoverable by Claude or other agents.
- **Funnel API:** `/api/funnel/personal-loan-consolidation/{steps,stage,submit,status}`.
- **Spinwheel proxy:** `/api/sw/{connect,verify,debt-profile,refresh-balance,session}`.
  The Spinwheel API key stays server-side; clients see opaque session tokens.
- **Skill:** `skill/SKILL.md` — instructions for Claude on how to drive the funnel.

## Local development

```bash
npm install
cp .env.example .env   # then fill in SPINWHEEL_API_KEY
npm start
# open http://localhost:3000
```

## Deploy on Render

This repo includes `render.yaml`. Deploy via Render Blueprint:

1. Push this repo to GitHub.
2. In Render → New → Blueprint → connect the GitHub repo.
3. After the service is created, set these env vars in the Render dashboard:
   - `SPINWHEEL_API_KEY` — your Spinwheel sandbox key
   - `BASE_URL` — the assigned Render URL (e.g. `https://horizon-personal-loans.onrender.com`)
4. Trigger a redeploy after setting env vars.

## Testing with curl

```bash
BASE=http://localhost:3000

curl -X POST $BASE/api/sw/connect \
  -H "Content-Type: application/json" \
  -d '{"phone":"9258727028","dob":"1990-01-01"}'
# returns { session_token, status: "IN_PROGRESS" } and texts a 6-digit code

curl -X POST $BASE/api/sw/verify \
  -H "Content-Type: application/json" \
  -d '{"session_token":"...","otp_code":"123456"}'

curl -X POST $BASE/api/sw/debt-profile \
  -H "Content-Type: application/json" \
  -d '{"session_token":"..."}'
# returns identity (from credit report) + credit cards + summary
```

## Notes

- This is a demo. The in-memory store resets when the server restarts.
- Sandbox uses real SMS via Spinwheel — codes are sent to the actual phone provided.
- Pre-qualification math is simplified — not a real lending decision.
