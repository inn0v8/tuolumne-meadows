# AI Application Funnel Protocol — Implementation Guide

## Purpose

This document is a complete build specification for a functioning demo of the AI Application Funnel Protocol (AAFP). It includes a demo lending website ("Horizon Home Loans"), a backend API, a discoverable manifest, and a Claude skill file. When deployed, a user should be able to tell Claude "I want to get pre-qualified for a mortgage at [deployed URL]" and Claude will discover the manifest, conduct the application conversationally, and submit the completed application.

Give this document to Claude Code or Codex. Every file, endpoint, schema, and deployment step is specified below.

---

## Table of contents

1. Architecture overview
2. Project structure
3. Tech stack and dependencies
4. The manifest file (discovery layer)
5. Steps API (funnel definition)
6. Full field definitions (mortgage pre-qualification)
7. Submit API (application submission)
8. Status API (check application)
9. Demo website (Horizon Home Loans)
10. Claude skill file (SKILL.md)
11. Server implementation
12. CORS and security
13. Deployment (Render, Railway, or Fly.io)
14. Testing with Claude
15. Environment variables
16. Complete file contents

---

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Claude (claude.ai or Claude app)                           │
│                                                             │
│  1. User says "apply at horizonloans.demo"                  │
│  2. Claude web_fetches /.well-known/ai-funnel.json          │
│  3. Claude web_fetches /api/funnel/mortgage-prequal/steps   │
│  4. Claude conducts conversational Q&A with user            │
│  5. Claude shows review summary, gets consent               │
│  6. Claude presents completed data + submit link            │
└──────────┬──────────────────────────────────────┬───────────┘
           │ GET (discovery + steps)              │ User clicks submit link
           ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Horizon Home Loans (Node.js server)                        │
│                                                             │
│  Static files:                                              │
│    / ..................... Landing page                      │
│    /apply ............... Traditional funnel (comparison)    │
│    /.well-known/ai-funnel.json ... Manifest                 │
│                                                             │
│  API endpoints:                                             │
│    GET  /api/funnel/:funnelId/steps ... Step definitions     │
│    POST /api/funnel/:funnelId/submit .. Submit application   │
│    GET  /api/funnel/:funnelId/status/:sessionId .. Status    │
│    POST /api/funnel/:funnelId/validate-field .. Live check   │
│                                                             │
│  Data store: In-memory Map (demo only)                      │
└─────────────────────────────────────────────────────────────┘
```

### Key design decision: submission flow

Claude's web_fetch tool can GET but cannot POST with arbitrary bodies from within a conversation. For the demo, submission works via two paths:

**Path A (primary for demo):** After Claude collects all data and the user confirms, Claude generates a pre-filled URL with a session token. The user clicks the link, which opens a review page on the Horizon website showing all the data Claude collected. The user clicks "Submit" on that page. This keeps the user in control and mirrors real-world consent flows.

**Path B (MCP connector):** If the Horizon site is registered as an MCP connector, Claude can POST directly via the MCP tool. The implementation includes MCP-compatible tool definitions for this future path.

**Path C (Claude Code / agentic):** If running in Claude Code or an agentic context with bash access, Claude can curl the submit endpoint directly.

---

## 2. Project structure

```
horizon-home-loans/
├── README.md
├── package.json
├── .env.example
├── .gitignore
├── render.yaml                          # Render deployment config
├── server.js                            # Express entry point
├── src/
│   ├── routes/
│   │   ├── funnel.js                    # Funnel API routes
│   │   └── pages.js                     # HTML page routes
│   ├── data/
│   │   └── mortgage-prequal-steps.json  # Full step definitions
│   ├── store.js                         # In-memory application store
│   └── validation.js                    # Field validation logic
├── public/
│   ├── .well-known/
│   │   └── ai-funnel.json               # THE MANIFEST
│   ├── index.html                       # Landing page
│   ├── apply.html                       # Traditional form funnel
│   ├── review.html                      # Pre-filled review page (Path A)
│   ├── result.html                      # Post-submission result page
│   ├── css/
│   │   └── style.css                    # Site styles
│   ├── js/
│   │   ├── apply.js                     # Traditional funnel logic
│   │   └── review.js                    # Review page logic
│   └── images/
│       ├── logo.svg                     # Horizon logo
│       └── og-image.png                 # Social sharing image
└── skill/
    └── SKILL.md                         # Claude skill definition
```

---

## 3. Tech stack and dependencies

### package.json

```json
{
  "name": "horizon-home-loans",
  "version": "1.0.0",
  "description": "Demo lending site implementing the AI Application Funnel Protocol",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "uuid": "^10.0.0",
    "compression": "^1.7.4"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

No database. No build step. No framework. Deliberately minimal so it's easy to deploy and understand.

---

## 4. The manifest file

**Path:** `public/.well-known/ai-funnel.json`

This is the file Claude discovers. It must be served with `Content-Type: application/json` and appropriate CORS headers so Claude's web_fetch can read it.

```json
{
  "protocol": "ai-funnel",
  "version": "1.0",
  "provider": {
    "name": "Horizon Home Loans",
    "tagline": "Your path to homeownership",
    "logo": "/images/logo.svg",
    "legal_entity": "Horizon Financial Services Inc.",
    "regulatory_ids": {
      "nmls": "9999999"
    },
    "support_email": "support@horizonloans.demo",
    "support_phone": "1-800-555-0199"
  },
  "funnels": [
    {
      "id": "mortgage-prequal",
      "name": "Mortgage Pre-Qualification",
      "description": "Find out how much home you can afford. No credit check required. Takes about 5 minutes.",
      "estimated_time_minutes": 5,
      "category": "mortgage",
      "steps_url": "/api/funnel/mortgage-prequal/steps",
      "submit_url": "/api/funnel/mortgage-prequal/submit",
      "status_url": "/api/funnel/mortgage-prequal/status/{session_id}",
      "validate_field_url": "/api/funnel/mortgage-prequal/validate-field",
      "review_page_url": "/review.html?session={session_id}",
      "capabilities": {
        "conversational_completion": true,
        "save_and_resume": false,
        "partial_submit": false,
        "document_upload": false,
        "real_time_validation": true
      }
    }
  ],
  "consent": {
    "privacy_url": "/privacy",
    "terms_url": "/terms",
    "required_disclosures": [
      "This is a demonstration application. No real loans are being offered.",
      "This is not a commitment to lend. In a real scenario, all loans would be subject to credit approval, verification of information, and applicable regulations.",
      "Equal Housing Lender. NMLS #9999999 (demo)."
    ],
    "data_handling": "All data submitted through this demo is stored in-memory only and deleted when the server restarts. No data is persisted to disk or shared with third parties."
  },
  "agent_instructions": {
    "tone": "friendly, professional, encouraging",
    "pii_handling": "transit_only",
    "never_store": true,
    "sensitive_field_behavior": "Do not repeat SSN digits back. Confirm only the last digit or say 'ending in X'.",
    "on_user_confusion": "Offer to explain the concept simply. Mention the user can always complete the application at the website instead.",
    "on_completion": "Present a clear summary card of all collected information. Ask the user to confirm. Then provide the review page link.",
    "fallback_url": "/apply"
  }
}
```

### Serving the manifest

The Express server must serve `/.well-known/ai-funnel.json` with these headers:

```
Content-Type: application/json
Access-Control-Allow-Origin: *
Cache-Control: public, max-age=3600
```

Also add an HTML meta tag to the landing page:

```html
<meta name="ai-funnel" content="/.well-known/ai-funnel.json">
```

And a Link header on all HTML responses:

```
Link: </.well-known/ai-funnel.json>; rel="ai-funnel"
```

---

## 5. Steps API

**Endpoint:** `GET /api/funnel/mortgage-prequal/steps`

**Response:** The complete funnel definition with all steps, fields, validation rules, conditional logic, and conversational guidance.

**Headers:**
```
Content-Type: application/json
Access-Control-Allow-Origin: *
```

**Response structure:**

```json
{
  "funnel_id": "mortgage-prequal",
  "funnel_name": "Mortgage Pre-Qualification",
  "total_steps": 4,
  "steps": [ ... ]
}
```

---

## 6. Full field definitions

This is the core data structure. Each step has an array of fields. Below is every step and every field for the mortgage pre-qualification funnel.

### Step 1: Loan purpose

```json
{
  "id": "loan_purpose",
  "order": 1,
  "label": "What are you looking for?",
  "instructions": "Determine the type of loan the user needs. This shapes the rest of the funnel.",
  "fields": [
    {
      "id": "loan_type",
      "type": "select",
      "label": "Loan purpose",
      "required": true,
      "ask_as": "First off — are you looking to buy a new home, or refinance one you already own?",
      "options": [
        {
          "value": "purchase",
          "label": "Purchase a home",
          "description": "Buying a new primary residence, second home, or investment property"
        },
        {
          "value": "refinance",
          "label": "Refinance",
          "description": "Replace your current mortgage with a new one"
        },
        {
          "value": "cash_out_refi",
          "label": "Cash-out refinance",
          "description": "Refinance and take out extra cash from your home equity"
        }
      ],
      "grouping": "ask_alone",
      "sensitivity": "none"
    },
    {
      "id": "property_use",
      "type": "select",
      "label": "Property use",
      "required": true,
      "ask_as": "Will this be your primary home, a second home, or an investment property?",
      "options": [
        { "value": "primary", "label": "Primary residence" },
        { "value": "secondary", "label": "Second / vacation home" },
        { "value": "investment", "label": "Investment / rental property" }
      ],
      "grouping": "ask_with_previous",
      "sensitivity": "none"
    },
    {
      "id": "first_time_buyer",
      "type": "boolean",
      "label": "First-time homebuyer",
      "required": true,
      "ask_as": "Is this your first time buying a home?",
      "help": "A first-time buyer is someone who hasn't owned a home in the past 3 years. There are often special programs available for first-time buyers.",
      "conditional": {
        "show_if": { "loan_type": { "eq": "purchase" } }
      },
      "grouping": "ask_with_previous",
      "sensitivity": "none"
    }
  ]
}
```

### Step 2: Personal information

```json
{
  "id": "personal_info",
  "order": 2,
  "label": "About you",
  "instructions": "Collect basic identity information. Be warm and conversational. These fields can be batched — if the user volunteers multiple pieces of info in one message, parse them all.",
  "fields": [
    {
      "id": "full_name",
      "type": "text",
      "label": "Full legal name",
      "required": true,
      "ask_as": "What's your full legal name?",
      "help": "This should match what's on your government-issued ID.",
      "validation": {
        "min_length": 2,
        "max_length": 100,
        "pattern": "^[a-zA-Z\\s\\-'.]+$"
      },
      "grouping": "batch_ok",
      "sensitivity": "personal",
      "pii_level": "personal"
    },
    {
      "id": "email",
      "type": "email",
      "label": "Email address",
      "required": true,
      "ask_as": "What's the best email to reach you at?",
      "validation": {
        "pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
      },
      "grouping": "batch_ok",
      "sensitivity": "personal",
      "pii_level": "personal"
    },
    {
      "id": "phone",
      "type": "phone",
      "label": "Phone number",
      "required": true,
      "ask_as": "And a phone number?",
      "validation": {
        "pattern": "^[\\d\\s\\-\\(\\)\\+]{10,15}$"
      },
      "grouping": "batch_ok",
      "sensitivity": "personal",
      "pii_level": "personal"
    },
    {
      "id": "dob",
      "type": "date",
      "label": "Date of birth",
      "required": true,
      "ask_as": "What's your date of birth?",
      "validation": {
        "min_age": 18,
        "max_age": 120,
        "format": "YYYY-MM-DD"
      },
      "help": "You must be at least 18 years old to apply.",
      "grouping": "batch_ok",
      "sensitivity": "personal",
      "pii_level": "personal"
    },
    {
      "id": "citizenship_status",
      "type": "select",
      "label": "Citizenship status",
      "required": true,
      "ask_as": "What's your citizenship status?",
      "options": [
        { "value": "us_citizen", "label": "U.S. Citizen" },
        { "value": "permanent_resident", "label": "Permanent Resident" },
        { "value": "non_permanent_resident", "label": "Non-Permanent Resident Alien" },
        { "value": "other", "label": "Other" }
      ],
      "grouping": "ask_alone",
      "sensitivity": "medium"
    }
  ]
}
```

### Step 3: Financial information

```json
{
  "id": "financial_info",
  "order": 3,
  "label": "Your finances",
  "instructions": "This is the most sensitive section. Be especially warm and non-judgmental. Normalize that everyone's financial situation is different. If the user seems uncomfortable, remind them this is a no-obligation pre-qualification and their information is handled securely.",
  "fields": [
    {
      "id": "annual_income",
      "type": "currency",
      "label": "Annual gross income",
      "required": true,
      "ask_as": "What's your approximate annual income before taxes? Include salary, bonuses, and any regular side income.",
      "help": "This is your total gross income from all sources — W-2 jobs, 1099 freelance work, rental income, etc. An estimate is fine at this stage.",
      "if_unsure": "A rough estimate is perfectly fine here — we're just getting a ballpark for pre-qualification. You can be more precise later in the full application.",
      "validation": {
        "min": 0,
        "max": 99999999
      },
      "format": {
        "currency": "USD",
        "precision": 0
      },
      "grouping": "ask_alone",
      "sensitivity": "financial",
      "pii_level": "financial"
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
      "id": "employer_name",
      "type": "text",
      "label": "Employer name",
      "required": true,
      "ask_as": "Who do you work for?",
      "conditional": {
        "show_if": { "employment_status": { "eq": "employed_w2" } }
      },
      "validation": {
        "min_length": 1,
        "max_length": 100
      },
      "grouping": "ask_with_previous",
      "sensitivity": "low"
    },
    {
      "id": "years_at_job",
      "type": "number",
      "label": "Years at current job",
      "required": true,
      "ask_as": "How long have you been there?",
      "help": "Lenders like to see at least 2 years of stable employment, but it's not a hard requirement.",
      "validation": {
        "min": 0,
        "max": 60,
        "precision": 1
      },
      "grouping": "ask_with_previous",
      "sensitivity": "low"
    },
    {
      "id": "monthly_debts",
      "type": "currency",
      "label": "Total monthly debt payments",
      "required": true,
      "ask_as": "Roughly how much do you pay each month toward debts? This includes car loans, student loans, credit card minimums, and any other recurring debt payments — but not rent or utilities.",
      "help": "Add up your monthly minimums for: car payments, student loans, credit card minimum payments, personal loans, child support or alimony. Don't include rent, groceries, utilities, or subscriptions.",
      "if_unsure": "Try adding up: car payment + student loan payment + credit card minimums. Even a rough number helps. If you truly have no debt payments, zero is a valid answer!",
      "validation": {
        "min": 0,
        "max": 999999
      },
      "format": {
        "currency": "USD",
        "precision": 0
      },
      "grouping": "ask_alone",
      "sensitivity": "financial",
      "pii_level": "financial"
    },
    {
      "id": "credit_score_range",
      "type": "select",
      "label": "Estimated credit score",
      "required": true,
      "ask_as": "Do you know roughly where your credit score falls?",
      "help": "If you're not sure, you can check for free at annualcreditreport.com, Credit Karma, or your bank's app. Most people's scores fall between 650 and 750.",
      "if_unsure": "No worries if you don't know exactly. Pick your best guess — this is just for a preliminary estimate. The full application would do an actual credit pull later.",
      "options": [
        { "value": "760_plus", "label": "Excellent (760+)", "description": "Best rates available" },
        { "value": "740_759", "label": "Very good (740-759)", "description": "Great rates" },
        { "value": "720_739", "label": "Good (720-739)", "description": "Competitive rates" },
        { "value": "700_719", "label": "Above average (700-719)", "description": "Good options available" },
        { "value": "680_699", "label": "Fair (680-699)", "description": "Some options available" },
        { "value": "660_679", "label": "Below average (660-679)", "description": "Limited options" },
        { "value": "below_660", "label": "Below 660", "description": "May need to explore special programs" },
        { "value": "not_sure", "label": "I'm not sure", "description": "That's okay — we'll work with estimates" }
      ],
      "grouping": "ask_alone",
      "sensitivity": "financial",
      "pii_level": "financial"
    },
    {
      "id": "bankruptcy_history",
      "type": "boolean",
      "label": "Bankruptcy in last 7 years",
      "required": true,
      "ask_as": "Have you had a bankruptcy in the last 7 years?",
      "sensitivity": "high",
      "grouping": "ask_alone",
      "pii_level": "financial"
    }
  ]
}
```

### Step 4: Property and loan details

```json
{
  "id": "property_details",
  "order": 4,
  "label": "The property",
  "instructions": "Collect information about the property they're buying or refinancing. For purchases, they might not have a specific property yet — that's fine, estimates work.",
  "fields": [
    {
      "id": "property_state",
      "type": "select",
      "label": "Property state",
      "required": true,
      "ask_as": "What state is the property in (or where are you looking to buy)?",
      "options": [
        { "value": "AL", "label": "Alabama" },
        { "value": "AK", "label": "Alaska" },
        { "value": "AZ", "label": "Arizona" },
        { "value": "AR", "label": "Arkansas" },
        { "value": "CA", "label": "California" },
        { "value": "CO", "label": "Colorado" },
        { "value": "CT", "label": "Connecticut" },
        { "value": "DE", "label": "Delaware" },
        { "value": "FL", "label": "Florida" },
        { "value": "GA", "label": "Georgia" },
        { "value": "HI", "label": "Hawaii" },
        { "value": "ID", "label": "Idaho" },
        { "value": "IL", "label": "Illinois" },
        { "value": "IN", "label": "Indiana" },
        { "value": "IA", "label": "Iowa" },
        { "value": "KS", "label": "Kansas" },
        { "value": "KY", "label": "Kentucky" },
        { "value": "LA", "label": "Louisiana" },
        { "value": "ME", "label": "Maine" },
        { "value": "MD", "label": "Maryland" },
        { "value": "MA", "label": "Massachusetts" },
        { "value": "MI", "label": "Michigan" },
        { "value": "MN", "label": "Minnesota" },
        { "value": "MS", "label": "Mississippi" },
        { "value": "MO", "label": "Missouri" },
        { "value": "MT", "label": "Montana" },
        { "value": "NE", "label": "Nebraska" },
        { "value": "NV", "label": "Nevada" },
        { "value": "NH", "label": "New Hampshire" },
        { "value": "NJ", "label": "New Jersey" },
        { "value": "NM", "label": "New Mexico" },
        { "value": "NY", "label": "New York" },
        { "value": "NC", "label": "North Carolina" },
        { "value": "ND", "label": "North Dakota" },
        { "value": "OH", "label": "Ohio" },
        { "value": "OK", "label": "Oklahoma" },
        { "value": "OR", "label": "Oregon" },
        { "value": "PA", "label": "Pennsylvania" },
        { "value": "RI", "label": "Rhode Island" },
        { "value": "SC", "label": "South Carolina" },
        { "value": "SD", "label": "South Dakota" },
        { "value": "TN", "label": "Tennessee" },
        { "value": "TX", "label": "Texas" },
        { "value": "UT", "label": "Utah" },
        { "value": "VT", "label": "Vermont" },
        { "value": "VA", "label": "Virginia" },
        { "value": "WA", "label": "Washington" },
        { "value": "WV", "label": "West Virginia" },
        { "value": "WI", "label": "Wisconsin" },
        { "value": "WY", "label": "Wyoming" },
        { "value": "DC", "label": "District of Columbia" }
      ],
      "grouping": "batch_ok",
      "sensitivity": "none"
    },
    {
      "id": "property_zip",
      "type": "text",
      "label": "Property ZIP code",
      "required": false,
      "ask_as": "Do you know the ZIP code? If not, no worries — the state is enough for now.",
      "validation": {
        "pattern": "^[0-9]{5}(-[0-9]{4})?$"
      },
      "grouping": "ask_with_previous",
      "sensitivity": "none"
    },
    {
      "id": "property_type",
      "type": "select",
      "label": "Property type",
      "required": true,
      "ask_as": "What type of property?",
      "options": [
        { "value": "single_family", "label": "Single-family home" },
        { "value": "condo", "label": "Condo" },
        { "value": "townhouse", "label": "Townhouse" },
        { "value": "multi_family", "label": "Multi-family (2-4 units)" },
        { "value": "manufactured", "label": "Manufactured / mobile home" }
      ],
      "grouping": "ask_with_previous",
      "sensitivity": "none"
    },
    {
      "id": "purchase_price",
      "type": "currency",
      "label": "Estimated purchase price",
      "required": true,
      "ask_as": "What's the estimated purchase price — or the price range you're considering?",
      "help": "If you haven't found a property yet, think about the price range you're shopping in. An estimate is perfectly fine.",
      "conditional": {
        "show_if": { "loan_type": { "eq": "purchase" } }
      },
      "validation": {
        "min": 50000,
        "max": 25000000
      },
      "format": {
        "currency": "USD",
        "precision": 0
      },
      "grouping": "ask_alone",
      "sensitivity": "none"
    },
    {
      "id": "down_payment",
      "type": "currency",
      "label": "Planned down payment",
      "required": true,
      "ask_as": "How much are you planning to put down?",
      "help": "The typical down payment is 3-20% of the purchase price. Putting down less than 20% usually means you'll pay Private Mortgage Insurance (PMI), which adds to your monthly payment. There are also zero-down programs like VA loans for veterans.",
      "conditional": {
        "show_if": { "loan_type": { "eq": "purchase" } }
      },
      "validation": {
        "min": 0,
        "max_field_ref": "purchase_price"
      },
      "format": {
        "currency": "USD",
        "precision": 0
      },
      "grouping": "ask_with_previous",
      "sensitivity": "none"
    },
    {
      "id": "current_home_value",
      "type": "currency",
      "label": "Estimated current home value",
      "required": true,
      "ask_as": "What do you estimate your home is worth right now?",
      "conditional": {
        "show_if": { "loan_type": { "in": ["refinance", "cash_out_refi"] } }
      },
      "validation": {
        "min": 50000,
        "max": 25000000
      },
      "format": {
        "currency": "USD",
        "precision": 0
      },
      "grouping": "ask_alone",
      "sensitivity": "none"
    },
    {
      "id": "current_mortgage_balance",
      "type": "currency",
      "label": "Current mortgage balance",
      "required": true,
      "ask_as": "What's the remaining balance on your current mortgage?",
      "conditional": {
        "show_if": { "loan_type": { "in": ["refinance", "cash_out_refi"] } }
      },
      "validation": {
        "min": 0,
        "max": 25000000
      },
      "format": {
        "currency": "USD",
        "precision": 0
      },
      "grouping": "ask_with_previous",
      "sensitivity": "financial"
    },
    {
      "id": "cash_out_amount",
      "type": "currency",
      "label": "Desired cash-out amount",
      "required": true,
      "ask_as": "How much cash would you like to take out?",
      "conditional": {
        "show_if": { "loan_type": { "eq": "cash_out_refi" } }
      },
      "validation": {
        "min": 1000,
        "max": 25000000
      },
      "format": {
        "currency": "USD",
        "precision": 0
      },
      "grouping": "ask_with_previous",
      "sensitivity": "financial"
    },
    {
      "id": "military_service",
      "type": "boolean",
      "label": "Military service",
      "required": true,
      "ask_as": "Have you or your spouse served in the U.S. military?",
      "help": "Veterans and active-duty service members may qualify for VA loans with no down payment and competitive rates.",
      "grouping": "ask_alone",
      "sensitivity": "low"
    }
  ]
}
```

---

## 7. Submit API

**Endpoint:** `POST /api/funnel/mortgage-prequal/submit`

**Request body:**

```json
{
  "session_id": "string (UUID, generated by server during review page load or by agent)",
  "agent": {
    "type": "claude | browser | other",
    "model": "claude-opus-4-6",
    "interface": "claude.ai | claude-code | api"
  },
  "consent": {
    "user_confirmed_at": "ISO 8601 datetime",
    "disclosures_shown": true,
    "privacy_acknowledged": true,
    "terms_acknowledged": true
  },
  "responses": {
    "loan_type": "purchase",
    "property_use": "primary",
    "first_time_buyer": true,
    "full_name": "Jordan Mitchell",
    "email": "jordan@example.com",
    "phone": "415-555-0123",
    "dob": "1990-03-15",
    "citizenship_status": "us_citizen",
    "annual_income": 95000,
    "employment_status": "employed_w2",
    "employer_name": "Acme Corp",
    "years_at_job": 3.5,
    "monthly_debts": 800,
    "credit_score_range": "740_759",
    "bankruptcy_history": false,
    "property_state": "CA",
    "property_zip": "95134",
    "property_type": "single_family",
    "purchase_price": 650000,
    "down_payment": 130000,
    "military_service": false
  }
}
```

**Response (success):**

```json
{
  "status": "prequalified",
  "session_id": "uuid-here",
  "result": {
    "qualified": true,
    "max_loan_amount": 520000,
    "loan_to_value_ratio": 0.8,
    "debt_to_income_ratio": 0.28,
    "estimated_rate_range": {
      "low": 6.25,
      "high": 6.75,
      "as_of": "2026-05-12"
    },
    "estimated_monthly_payment": {
      "principal_and_interest": {
        "low": 3200,
        "high": 3400
      },
      "estimated_taxes": 540,
      "estimated_insurance": 150,
      "pmi": 0,
      "total_estimated": {
        "low": 3890,
        "high": 4090
      }
    },
    "highlights": [
      "Great credit score — you'll qualify for competitive rates",
      "20% down payment means no PMI",
      "Healthy debt-to-income ratio at 28%"
    ],
    "concerns": [],
    "next_steps": [
      "Complete the full application to lock in your rate",
      "Gather income verification documents (recent pay stubs, W-2s)",
      "Get pre-approved for a stronger offer when house hunting"
    ],
    "full_application_url": "/apply?prefill=true&session={session_id}",
    "expiration": "2026-06-12T00:00:00Z",
    "message": "Great news, Jordan! Based on what you've shared, you're pre-qualified for up to $520,000 in financing."
  }
}
```

**Response (not qualified):**

```json
{
  "status": "not_prequalified",
  "session_id": "uuid-here",
  "result": {
    "qualified": false,
    "reason_summary": "The debt-to-income ratio exceeds our current guidelines.",
    "suggestions": [
      "Consider paying down existing debts to lower your DTI ratio",
      "A larger down payment could improve your qualification",
      "Contact us to discuss alternative programs that may be available"
    ],
    "contact_url": "/contact",
    "message": "We weren't able to pre-qualify you right now, but that doesn't mean homeownership is out of reach. Here are some steps that could help."
  }
}
```

### Pre-qualification logic (server-side)

The server runs a simplified qualification engine:

```
INPUT: annual_income, monthly_debts, purchase_price, down_payment, credit_score_range
  
loan_amount = purchase_price - down_payment
ltv = loan_amount / purchase_price
monthly_income = annual_income / 12
  
# Estimate monthly payment (30yr fixed, simplified)
rate = lookup_rate(credit_score_range)  # from a static rate table
monthly_pi = loan_amount * (rate/12 * (1+rate/12)^360) / ((1+rate/12)^360 - 1)
monthly_taxes = purchase_price * 0.01 / 12   # ~1% annual property tax
monthly_insurance = 150                        # simplified flat estimate
monthly_pmi = ltv > 0.80 ? loan_amount * 0.005 / 12 : 0
  
total_monthly = monthly_pi + monthly_taxes + monthly_insurance + monthly_pmi
total_debts = monthly_debts + total_monthly
dti = total_debts / monthly_income
  
QUALIFIED if:
  - dti <= 0.43 (standard conventional max)
  - ltv <= 0.97 (max 97% LTV)
  - credit_score_range not "below_660" (simplified)
  - bankruptcy_history == false OR credit_score_range above 700
  
MAX_LOAN: solve for loan_amount where dti = 0.43
```

Static rate table (demo values):

```json
{
  "760_plus":     0.0625,
  "740_759":      0.0650,
  "720_739":      0.0675,
  "700_719":      0.0700,
  "680_699":      0.0750,
  "660_679":      0.0800,
  "below_660":    0.0875,
  "not_sure":     0.0700
}
```

---

## 8. Status API

**Endpoint:** `GET /api/funnel/mortgage-prequal/status/:sessionId`

**Response:**

```json
{
  "session_id": "uuid-here",
  "status": "prequalified",
  "created_at": "2026-05-12T14:30:00Z",
  "result_summary": {
    "qualified": true,
    "max_loan_amount": 520000,
    "estimated_rate_range": "6.25% - 6.75%"
  }
}
```

---

## 9. Demo website

### Landing page (index.html)

A clean, professional lending website homepage with:

- Hero section with headline "Your path to homeownership starts here"
- "Get Pre-Qualified" CTA button (links to /apply)
- A callout section: "New: Apply through your AI assistant" with brief explanation and a code snippet showing the manifest URL
- Trust indicators (NMLS number, Equal Housing Lender logo, security badges)
- Footer with legal disclosures

**Design direction:** Clean, modern fintech aesthetic. Navy (#1a2b4a) and white with gold (#c9a84c) accents. System fonts for performance. Mobile-responsive.

### Traditional funnel page (apply.html)

A standard multi-step form implementing the same fields as the AI funnel. This serves as a comparison point and as a fallback. 4 pages/tabs matching the 4 steps. Standard form validation. Submits to the same POST endpoint.

### Review page (review.html)

This is the critical handoff page for Path A (link-based submission). When Claude completes the conversational collection, it generates a URL like:

```
https://horizonloans.demo/review.html?session={session_id}
```

But first, Claude POSTs the collected data to a "stage" endpoint that stores it temporarily:

**Endpoint:** `POST /api/funnel/mortgage-prequal/stage`

```json
{
  "responses": { ... all collected fields ... },
  "agent": { "type": "claude", "model": "claude-opus-4-6" }
}
```

**Response:**

```json
{
  "session_id": "generated-uuid",
  "review_url": "/review.html?session=generated-uuid",
  "expires_at": "2026-05-12T15:30:00Z"
}
```

The review page loads, fetches the staged data via `GET /api/funnel/mortgage-prequal/staged/:sessionId`, displays all the fields in a clean editable form, shows the required disclosures, and has a "Submit Application" button that POSTs to the submit endpoint.

If staged data has expired or doesn't exist, the page shows a message: "This session has expired. You can start a new application or use the traditional form."

### Result page (result.html)

After submission, redirects here with session_id. Fetches status and displays the pre-qualification result with a celebratory design (if qualified) or supportive messaging (if not).

---

## 10. Claude skill file

**File:** `skill/SKILL.md`

```markdown
---
name: horizon-home-loans-prequal
description: Guide users through mortgage pre-qualification with Horizon Home Loans. Trigger when user mentions Horizon Home Loans, horizonloans, or asks to apply for a mortgage at the Horizon website. Also trigger when Claude discovers an ai-funnel.json manifest at a URL the user provides.
---

# Horizon Home Loans — Mortgage Pre-Qualification

## Overview

This skill enables Claude to conduct a mortgage pre-qualification
application for Horizon Home Loans through natural conversation,
instead of sending the user to fill out a web form.

## Discovery

When triggered, fetch the funnel manifest from:

```
{BASE_URL}/.well-known/ai-funnel.json
```

Parse the manifest to get the `steps_url`, then fetch the step
definitions. The steps contain all fields, validation rules,
conditional logic, and conversational guidance.

## Conversation flow

### Phase 1: Consent

Before collecting ANY data, show the user:

1. The provider name, legal entity, and NMLS number
2. A brief description of what you'll be collecting
3. The required disclosures from the manifest
4. Links to the privacy policy and terms
5. Clear option to proceed or go to the website instead

Do NOT collect any personal information until the user explicitly
agrees to proceed.

### Phase 2: Data collection

Walk through each step in order. For each field:

1. Use the `ask_as` text as inspiration, but phrase naturally
2. Respect `grouping` hints — batch fields marked `batch_ok`
3. Evaluate `conditional.show_if` — skip fields whose conditions aren't met
4. Parse fuzzy answers: "about 95k" → 95000, "March 15 1990" → "1990-03-15"
5. Validate against the field's rules
6. If validation fails, explain why conversationally and re-ask
7. Use `help` text when the user seems confused
8. Use `if_unsure` text when the user doesn't know an answer
9. For `sensitivity: high` fields, be extra gentle and reassuring

**Batching intelligence:** If the user volunteers multiple pieces of
info in one message ("I'm Jordan, born March 15 1990, making about
95k"), parse ALL of them. Don't ask for info you already have.

**Natural conversation:** Don't read fields like a form. Instead of
"Annual gross income: ____", say "Now for the financial picture —
what's your approximate annual income before taxes?"

### Phase 3: Review and submit

After collecting all fields:

1. Present a clean summary of ALL collected data organized by step
2. Ask the user to confirm everything looks correct
3. Offer to change any field
4. Show the required disclosures one more time
5. On confirmation, do ONE of:
   a. POST to the stage endpoint and give the user the review URL
   b. If you have bash access, POST directly to submit endpoint
   c. Present the data as a formatted JSON block the user can submit

After submission (or staging), present the result conversationally:
- If qualified: share the good news, the estimated amount, rate,
  monthly payment, and next steps
- If not qualified: be supportive, share the suggestions, offer
  the contact URL

### Important guardrails

- NEVER store or memorize PII from this funnel
- NEVER repeat SSN digits back in full
- NEVER fabricate or assume financial information
- ALWAYS show disclosures before collecting data
- ALWAYS let the user review before submitting
- If the user wants to stop, provide the fallback URL to the website
- This is a DEMO — remind the user no real loan is being processed
```

---

## 11. Server implementation

### server.js — Entry point

```javascript
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const funnelRoutes = require('./src/routes/funnel');
const pageRoutes = require('./src/routes/pages');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Middleware
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,  // Allow inline scripts for demo pages
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: '*',  // Allow Claude's web_fetch from any origin
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

// Add Link header to all HTML responses for manifest discovery
app.use((req, res, next) => {
  if (req.accepts('html')) {
    res.setHeader('Link', '</.well-known/ai-funnel.json>; rel="ai-funnel"');
  }
  next();
});

// Serve .well-known with correct content-type and CORS
app.use('/.well-known', express.static(
  path.join(__dirname, 'public', '.well-known'),
  {
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/funnel', funnelRoutes);

// Page routes (privacy, terms, etc.)
app.use('/', pageRoutes);

app.listen(PORT, () => {
  console.log(`Horizon Home Loans running at ${BASE_URL}`);
  console.log(`Manifest: ${BASE_URL}/.well-known/ai-funnel.json`);
});
```

### src/routes/funnel.js — API routes

```javascript
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const steps = require('../data/mortgage-prequal-steps.json');
const { validateResponses, calculatePrequalification } = require('../validation');
const store = require('../store');

const router = express.Router();

// GET /api/funnel/mortgage-prequal/steps
router.get('/:funnelId/steps', (req, res) => {
  if (req.params.funnelId !== 'mortgage-prequal') {
    return res.status(404).json({ error: 'Funnel not found' });
  }
  res.json(steps);
});

// POST /api/funnel/mortgage-prequal/stage
// Claude posts collected data here, gets back a session URL
router.post('/:funnelId/stage', (req, res) => {
  if (req.params.funnelId !== 'mortgage-prequal') {
    return res.status(404).json({ error: 'Funnel not found' });
  }

  const sessionId = uuidv4();
  const { responses, agent } = req.body;

  // Validate required fields are present
  const validation = validateResponses(responses, steps);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Validation failed',
      missing_fields: validation.missingFields,
      invalid_fields: validation.invalidFields
    });
  }

  // Store staged data (expires in 1 hour)
  store.stage(sessionId, {
    responses,
    agent: agent || { type: 'unknown' },
    staged_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString()
  });

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    session_id: sessionId,
    review_url: `${baseUrl}/review.html?session=${sessionId}`,
    expires_at: new Date(Date.now() + 3600000).toISOString()
  });
});

// GET /api/funnel/mortgage-prequal/staged/:sessionId
// Review page fetches staged data
router.get('/:funnelId/staged/:sessionId', (req, res) => {
  const data = store.getStaged(req.params.sessionId);
  if (!data) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  res.json(data);
});

// POST /api/funnel/mortgage-prequal/submit
router.post('/:funnelId/submit', (req, res) => {
  if (req.params.funnelId !== 'mortgage-prequal') {
    return res.status(404).json({ error: 'Funnel not found' });
  }

  const { session_id, agent, consent, responses } = req.body;

  // Use provided session_id or generate one
  const sessionId = session_id || uuidv4();

  // Validate consent
  if (!consent || !consent.user_confirmed_at || !consent.disclosures_shown) {
    return res.status(400).json({
      error: 'Missing consent confirmation',
      required: ['user_confirmed_at', 'disclosures_shown']
    });
  }

  // Validate responses
  const validation = validateResponses(responses, steps);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Validation failed',
      missing_fields: validation.missingFields,
      invalid_fields: validation.invalidFields
    });
  }

  // Calculate pre-qualification result
  const result = calculatePrequalification(responses);

  // Store the application
  store.saveApplication(sessionId, {
    responses,
    agent: agent || { type: 'unknown' },
    consent,
    result,
    submitted_at: new Date().toISOString()
  });

  // Clean up staged data if it exists
  store.clearStaged(sessionId);

  res.json({
    status: result.qualified ? 'prequalified' : 'not_prequalified',
    session_id: sessionId,
    result
  });
});

// POST /api/funnel/mortgage-prequal/validate-field
// Real-time single-field validation
router.post('/:funnelId/validate-field', (req, res) => {
  const { field_id, value, context } = req.body;
  // context contains other field values for cross-field validation

  // Find the field definition
  let fieldDef = null;
  for (const step of steps.steps) {
    const found = step.fields.find(f => f.id === field_id);
    if (found) { fieldDef = found; break; }
  }

  if (!fieldDef) {
    return res.status(404).json({ error: 'Field not found' });
  }

  const result = validateSingleField(fieldDef, value, context);
  res.json(result);
});

// GET /api/funnel/mortgage-prequal/status/:sessionId
router.get('/:funnelId/status/:sessionId', (req, res) => {
  const app = store.getApplication(req.params.sessionId);
  if (!app) {
    return res.status(404).json({ error: 'Application not found' });
  }

  res.json({
    session_id: req.params.sessionId,
    status: app.result.qualified ? 'prequalified' : 'not_prequalified',
    created_at: app.submitted_at,
    result_summary: {
      qualified: app.result.qualified,
      max_loan_amount: app.result.max_loan_amount,
      estimated_rate_range: app.result.estimated_rate_range
    }
  });
});

module.exports = router;
```

### src/store.js — In-memory data store

```javascript
// Simple in-memory store. In production, use a real database.

const staged = new Map();    // session_id -> staged application data
const applications = new Map(); // session_id -> submitted application data

// Clean expired staged data every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of staged) {
    if (new Date(data.expires_at).getTime() < now) {
      staged.delete(id);
    }
  }
}, 5 * 60 * 1000);

module.exports = {
  stage(sessionId, data) {
    staged.set(sessionId, data);
  },

  getStaged(sessionId) {
    const data = staged.get(sessionId);
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) {
      staged.delete(sessionId);
      return null;
    }
    return data;
  },

  clearStaged(sessionId) {
    staged.delete(sessionId);
  },

  saveApplication(sessionId, data) {
    applications.set(sessionId, data);
  },

  getApplication(sessionId) {
    return applications.get(sessionId) || null;
  },

  // For debug: list all applications
  listApplications() {
    return Array.from(applications.entries()).map(([id, app]) => ({
      session_id: id,
      name: app.responses.full_name,
      status: app.result.qualified ? 'prequalified' : 'not_prequalified',
      submitted_at: app.submitted_at
    }));
  }
};
```

### src/validation.js — Validation and pre-qualification logic

```javascript
const RATE_TABLE = {
  '760_plus':     0.0625,
  '740_759':      0.0650,
  '720_739':      0.0675,
  '700_719':      0.0700,
  '680_699':      0.0750,
  '660_679':      0.0800,
  'below_660':    0.0875,
  'not_sure':     0.0700
};

function validateResponses(responses, stepsData) {
  const missingFields = [];
  const invalidFields = [];

  for (const step of stepsData.steps) {
    for (const field of step.fields) {
      // Check conditional — skip if condition not met
      if (field.conditional && field.conditional.show_if) {
        if (!evaluateCondition(field.conditional.show_if, responses)) {
          continue; // Field not applicable
        }
      }

      // Check required
      if (field.required && (responses[field.id] === undefined || responses[field.id] === null || responses[field.id] === '')) {
        missingFields.push({ field_id: field.id, label: field.label });
      }

      // Check validation rules
      if (responses[field.id] !== undefined && field.validation) {
        const value = responses[field.id];
        const errors = [];

        if (field.validation.min !== undefined && value < field.validation.min) {
          errors.push(`Must be at least ${field.validation.min}`);
        }
        if (field.validation.max !== undefined && value > field.validation.max) {
          errors.push(`Must be at most ${field.validation.max}`);
        }
        if (field.validation.min_length !== undefined && typeof value === 'string' && value.length < field.validation.min_length) {
          errors.push(`Must be at least ${field.validation.min_length} characters`);
        }
        if (field.validation.max_length !== undefined && typeof value === 'string' && value.length > field.validation.max_length) {
          errors.push(`Must be at most ${field.validation.max_length} characters`);
        }
        if (field.validation.pattern) {
          const regex = new RegExp(field.validation.pattern);
          if (typeof value === 'string' && !regex.test(value)) {
            errors.push(`Invalid format`);
          }
        }
        if (field.validation.min_age) {
          const dob = new Date(value);
          const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
          if (age < field.validation.min_age) {
            errors.push(`Must be at least ${field.validation.min_age} years old`);
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
    invalidFields
  };
}

function evaluateCondition(condition, responses) {
  for (const [fieldId, rule] of Object.entries(condition)) {
    const value = responses[fieldId];

    if (typeof rule === 'object') {
      if (rule.eq !== undefined && value !== rule.eq) return false;
      if (rule.neq !== undefined && value === rule.neq) return false;
      if (rule.in !== undefined && !rule.in.includes(value)) return false;
      if (rule.not_in !== undefined && rule.not_in.includes(value)) return false;
      if (rule.gt !== undefined && !(value > rule.gt)) return false;
      if (rule.lt !== undefined && !(value < rule.lt)) return false;
    } else {
      // Simple equality: { "field": "value" }
      if (value !== rule) return false;
    }
  }
  return true;
}

function calculatePrequalification(responses) {
  const annualIncome = responses.annual_income || 0;
  const monthlyIncome = annualIncome / 12;
  const monthlyDebts = responses.monthly_debts || 0;
  const creditRange = responses.credit_score_range || 'not_sure';
  const bankruptcyHistory = responses.bankruptcy_history || false;
  const militaryService = responses.military_service || false;

  const rate = RATE_TABLE[creditRange] || 0.0700;
  const monthlyRate = rate / 12;
  const termMonths = 360; // 30 years

  let purchasePrice, downPayment, loanAmount, ltv;

  if (responses.loan_type === 'purchase') {
    purchasePrice = responses.purchase_price || 0;
    downPayment = responses.down_payment || 0;
    loanAmount = purchasePrice - downPayment;
    ltv = purchasePrice > 0 ? loanAmount / purchasePrice : 0;
  } else {
    // Refinance
    const homeValue = responses.current_home_value || 0;
    const mortgageBalance = responses.current_mortgage_balance || 0;
    const cashOut = responses.cash_out_amount || 0;
    loanAmount = mortgageBalance + cashOut;
    ltv = homeValue > 0 ? loanAmount / homeValue : 0;
    purchasePrice = homeValue;
    downPayment = homeValue - loanAmount;
  }

  // Monthly P&I calculation
  const monthlyPI = loanAmount > 0
    ? loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1)
    : 0;

  // Estimates
  const monthlyTaxes = Math.round(purchasePrice * 0.01 / 12);
  const monthlyInsurance = 150;
  const monthlyPMI = ltv > 0.80 ? Math.round(loanAmount * 0.005 / 12) : 0;

  const totalMonthlyHousing = monthlyPI + monthlyTaxes + monthlyInsurance + monthlyPMI;
  const totalMonthlyObligations = monthlyDebts + totalMonthlyHousing;
  const dti = monthlyIncome > 0 ? totalMonthlyObligations / monthlyIncome : 1;

  // Qualification logic
  const maxDTI = 0.43;
  const maxLTV = militaryService ? 1.0 : 0.97; // VA loans allow 100% LTV

  let qualified = true;
  const concerns = [];
  const highlights = [];

  if (dti > maxDTI) {
    qualified = false;
    concerns.push(`Debt-to-income ratio of ${Math.round(dti * 100)}% exceeds the ${Math.round(maxDTI * 100)}% guideline`);
  } else if (dti < 0.30) {
    highlights.push(`Healthy debt-to-income ratio at ${Math.round(dti * 100)}%`);
  }

  if (ltv > maxLTV) {
    qualified = false;
    concerns.push(`Loan-to-value ratio of ${Math.round(ltv * 100)}% exceeds maximum`);
  }

  if (creditRange === 'below_660') {
    qualified = false;
    concerns.push('Credit score below our minimum threshold');
  }

  if (bankruptcyHistory && ['below_660', '660_679', '680_699'].includes(creditRange)) {
    qualified = false;
    concerns.push('Recent bankruptcy combined with credit score requires further review');
  }

  if (['760_plus', '740_759'].includes(creditRange)) {
    highlights.push("Great credit score — you'll qualify for competitive rates");
  }

  if (ltv <= 0.80 && responses.loan_type === 'purchase') {
    highlights.push('20% or more down payment means no PMI');
  }

  if (militaryService) {
    highlights.push('Military service may qualify you for VA loan benefits');
  }

  // Calculate max loan amount (solve for DTI = 0.43)
  const availableForHousing = (monthlyIncome * maxDTI) - monthlyDebts;
  const availableForPI = availableForHousing - monthlyTaxes - monthlyInsurance;
  const maxLoan = availableForPI > 0
    ? Math.round(availableForPI * (Math.pow(1 + monthlyRate, termMonths) - 1) / (monthlyRate * Math.pow(1 + monthlyRate, termMonths)))
    : 0;

  const ratePercent = (rate * 100).toFixed(2);
  const rateHighPercent = ((rate + 0.005) * 100).toFixed(2);

  return {
    qualified,
    max_loan_amount: qualified ? maxLoan : null,
    loan_amount_requested: loanAmount,
    loan_to_value_ratio: Math.round(ltv * 100) / 100,
    debt_to_income_ratio: Math.round(dti * 100) / 100,
    estimated_rate_range: {
      low: parseFloat(ratePercent),
      high: parseFloat(rateHighPercent),
      as_of: new Date().toISOString().split('T')[0]
    },
    estimated_monthly_payment: {
      principal_and_interest: Math.round(monthlyPI),
      estimated_taxes: monthlyTaxes,
      estimated_insurance: monthlyInsurance,
      pmi: monthlyPMI,
      total_estimated: Math.round(totalMonthlyHousing)
    },
    highlights,
    concerns,
    next_steps: qualified
      ? [
          'Complete the full application to lock in your rate',
          'Gather income verification documents (recent pay stubs, W-2s)',
          'Get pre-approved for a stronger offer when house hunting'
        ]
      : [
          'Consider paying down existing debts to lower your DTI ratio',
          'A larger down payment could improve your qualification',
          'Contact us to discuss alternative programs that may be available'
        ],
    message: qualified
      ? `Great news, ${responses.full_name?.split(' ')[0] || 'there'}! Based on what you've shared, you're pre-qualified for up to $${maxLoan.toLocaleString()} in financing.`
      : `We weren't able to pre-qualify you right now based on the information provided, but that doesn't mean homeownership is out of reach.`,
    expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
}

module.exports = { validateResponses, evaluateCondition, calculatePrequalification };
```

### src/routes/pages.js — Simple page routes

```javascript
const express = require('express');
const router = express.Router();

// Privacy policy (simple HTML)
router.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Privacy Policy - Horizon Home Loans</title>
<meta name="ai-funnel" content="/.well-known/ai-funnel.json">
<style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a2b4a}</style>
</head><body>
<h1>Privacy Policy</h1>
<p><strong>Horizon Home Loans (Demo)</strong></p>
<p>This is a demonstration application. No real personal data is collected or stored permanently.</p>
<p>In this demo, all data submitted through the AI funnel or the traditional application form is stored in server memory only and is deleted when the server restarts. No data is written to disk, shared with third parties, or used for any purpose beyond demonstrating the AI Application Funnel Protocol.</p>
<p>In a production implementation, this page would contain a comprehensive privacy policy covering data collection, use, sharing, retention, and user rights under applicable regulations (CCPA, GDPR, GLBA, etc.).</p>
</body></html>`);
});

// Terms of service
router.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Terms of Service - Horizon Home Loans</title>
<meta name="ai-funnel" content="/.well-known/ai-funnel.json">
<style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a2b4a}</style>
</head><body>
<h1>Terms of Service</h1>
<p><strong>Horizon Home Loans (Demo)</strong></p>
<p>This is a demonstration application. No real loans are being offered, processed, or committed to.</p>
<p>The pre-qualification results shown are calculated using simplified formulas for demonstration purposes only and do not constitute actual lending decisions or commitments.</p>
<p>This demo is designed to illustrate the AI Application Funnel Protocol (AAFP) and how AI assistants can help users complete structured application workflows conversationally.</p>
</body></html>`);
});

// Debug endpoint: list all submitted applications
router.get('/api/debug/applications', (req, res) => {
  const store = require('../store');
  res.json(store.listApplications());
});

module.exports = router;
```

---

## 12. CORS and security

The manifest and API endpoints must be accessible to Claude's web_fetch tool, which makes requests from Anthropic's servers. Required headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

The Express `cors` middleware handles this. The `helmet` middleware adds standard security headers but with CSP relaxed for the demo pages.

For production, you would restrict CORS to known AI agent origins and use OAuth for the submit endpoint. The demo uses open CORS and no auth for simplicity.

---

## 13. Deployment

### Option A: Render (recommended for simplicity)

**render.yaml:**

```yaml
services:
  - type: web
    name: horizon-home-loans
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: PORT
        value: 10000
      - key: BASE_URL
        sync: false
      - key: NODE_ENV
        value: production
    healthCheckPath: /.well-known/ai-funnel.json
```

Deploy steps:
1. Push to GitHub
2. Connect repo to Render
3. Set `BASE_URL` to the assigned Render URL (e.g., `https://horizon-home-loans.onrender.com`)
4. Deploy

### Option B: Railway

```json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/.well-known/ai-funnel.json"
  }
}
```

### Option C: Fly.io

**fly.toml:**

```toml
app = "horizon-home-loans"

[build]
  builder = "heroku/buildpacks:20"

[env]
  PORT = "8080"
  NODE_ENV = "production"

[http_service]
  internal_port = 8080
  force_https = true

[[http_service.checks]]
  path = "/.well-known/ai-funnel.json"
```

### Verification after deployment

Run these checks to confirm the demo is working:

```bash
# 1. Manifest is discoverable
curl -s https://YOUR_URL/.well-known/ai-funnel.json | jq .protocol
# Expected: "ai-funnel"

# 2. Steps endpoint works
curl -s https://YOUR_URL/api/funnel/mortgage-prequal/steps | jq .total_steps
# Expected: 4

# 3. Submit endpoint works (test submission)
curl -s -X POST https://YOUR_URL/api/funnel/mortgage-prequal/submit \
  -H "Content-Type: application/json" \
  -d '{
    "consent": {
      "user_confirmed_at": "2026-05-12T14:30:00Z",
      "disclosures_shown": true,
      "privacy_acknowledged": true,
      "terms_acknowledged": true
    },
    "agent": {"type": "test"},
    "responses": {
      "loan_type": "purchase",
      "property_use": "primary",
      "first_time_buyer": true,
      "full_name": "Test User",
      "email": "test@example.com",
      "phone": "415-555-0123",
      "dob": "1990-01-01",
      "citizenship_status": "us_citizen",
      "annual_income": 100000,
      "employment_status": "employed_w2",
      "employer_name": "Test Corp",
      "years_at_job": 5,
      "monthly_debts": 500,
      "credit_score_range": "740_759",
      "bankruptcy_history": false,
      "property_state": "CA",
      "property_zip": "95134",
      "property_type": "single_family",
      "purchase_price": 600000,
      "down_payment": 120000,
      "military_service": false
    }
  }' | jq .status
# Expected: "prequalified"

# 4. CORS headers present
curl -s -I https://YOUR_URL/.well-known/ai-funnel.json | grep -i access-control
# Expected: access-control-allow-origin: *
```

---

## 14. Testing with Claude

Once deployed, test the full flow:

### Test 1: Discovery

Tell Claude:
> "I want to get pre-qualified for a mortgage at https://YOUR_URL"

Expected: Claude should web_fetch the URL, discover the manifest (either from the HTML meta tag on the landing page, or by checking `/.well-known/ai-funnel.json`), and offer to walk you through the application.

### Test 2: Full conversational flow

After Claude discovers the manifest:
1. Claude should show the consent/disclosure information
2. On consent, Claude should ask about loan purpose
3. Claude should proceed through personal info, financial info, and property details
4. Claude should present a review summary
5. Claude should provide the review URL or submit directly

### Test 3: Fuzzy input handling

During the conversation, give Claude fuzzy inputs:
- "about 95 thousand" (should parse to 95000)
- "I was born March 15 1990" (should parse to 1990-03-15)
- "I make around 95k and my wife makes 60k" (should ask to clarify total)
- "probably 700-ish credit score" (should map to 700_719 range)

### Test 4: Conditional logic

- Say you want to refinance → Claude should ask about current home value and mortgage balance, not purchase price
- Say cash-out refi → Claude should also ask about cash-out amount
- Say you're not a W-2 employee → Claude should skip the employer name question

### Test 5: Validation

- Give an age under 18 → Claude should explain you must be 18+
- Give a down payment larger than the purchase price → Claude should catch this
- Give an invalid ZIP code (e.g., "123") → Claude should ask for a valid 5-digit ZIP

---

## 15. Environment variables

```bash
# .env.example
PORT=3000
BASE_URL=http://localhost:3000
NODE_ENV=development
```

In production, `BASE_URL` must be set to the public URL (e.g., `https://horizon-home-loans.onrender.com`) so the manifest's relative URLs resolve correctly and the review page links work.

---

## 16. Additional implementation notes

### The manifest must use relative URLs

All URLs in the manifest (`steps_url`, `submit_url`, etc.) are relative to the site root. When Claude fetches the manifest via web_fetch, it gets the full URL from the page it fetched. Claude must resolve relative URLs against the manifest's origin.

However, also include a `base_url` hint in the manifest for agents that fetch the JSON directly:

Add to the top level of ai-funnel.json:
```json
"base_url": "https://horizon-home-loans.onrender.com"
```

The agent should prefer the origin of the fetched URL but can fall back to `base_url`.

### The landing page HTML structure

The landing page (index.html) should include:

1. Meta tag for discovery: `<meta name="ai-funnel" content="/.well-known/ai-funnel.json">`
2. A visible section explaining AI-assisted applications
3. The traditional "Get Pre-Qualified" button linking to /apply
4. A clean, professional lending website appearance

This serves dual purposes: it looks like a real lending site (for the demo) and it's discoverable by Claude when fetched.

### The review page (review.html)

This page:
1. Reads `session` from the URL query parameter
2. Fetches staged data from `/api/funnel/mortgage-prequal/staged/{session}`
3. Displays all collected fields in a clean, editable form
4. Shows required disclosures with checkboxes
5. On "Submit", POSTs to the submit endpoint with consent timestamps
6. Redirects to result.html with the session_id

### File that must be created: src/data/mortgage-prequal-steps.json

This JSON file contains the complete steps array exactly as defined in section 6, wrapped in:

```json
{
  "funnel_id": "mortgage-prequal",
  "funnel_name": "Mortgage Pre-Qualification",
  "total_steps": 4,
  "estimated_time_minutes": 5,
  "steps": [
    // All four steps from section 6 go here
  ]
}
```

### .gitignore

```
node_modules/
.env
*.log
```

### README.md

Should explain:
1. What this project demonstrates
2. How to run locally (`npm install && npm start`)
3. How to deploy
4. How to test with Claude
5. Link to the AAFP design spec
6. Note that this is a demo and no real loans are processed

---

## Summary of files to create

| # | File | Purpose |
|---|------|---------|
| 1 | `package.json` | Dependencies and scripts |
| 2 | `server.js` | Express entry point |
| 3 | `src/routes/funnel.js` | All funnel API endpoints |
| 4 | `src/routes/pages.js` | Privacy, terms, debug pages |
| 5 | `src/store.js` | In-memory data store |
| 6 | `src/validation.js` | Field validation + prequal engine |
| 7 | `src/data/mortgage-prequal-steps.json` | Complete step/field definitions |
| 8 | `public/.well-known/ai-funnel.json` | The manifest (discovery) |
| 9 | `public/index.html` | Landing page |
| 10 | `public/apply.html` | Traditional form funnel |
| 11 | `public/review.html` | Review page (Path A handoff) |
| 12 | `public/result.html` | Post-submission result page |
| 13 | `public/css/style.css` | Site styles |
| 14 | `public/js/apply.js` | Traditional funnel JS |
| 15 | `public/js/review.js` | Review page JS |
| 16 | `public/images/logo.svg` | Horizon logo (simple SVG) |
| 17 | `skill/SKILL.md` | Claude skill definition |
| 18 | `render.yaml` | Render deployment config |
| 19 | `.env.example` | Environment variable template |
| 20 | `.gitignore` | Git ignore rules |
| 21 | `README.md` | Project documentation |

Every file's content is specified in this document. The HTML pages (9-12) should be built as clean, professional pages using the CSS in file 13. The JS files (14-15) implement the client-side logic described in their respective sections.

This document contains everything needed to build and deploy a functioning demo of the AI Application Funnel Protocol.
