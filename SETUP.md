# LuggageTracker — Setup Guide

## Quick Start (Demo Mode)

```bash
npm install
npm run dev
```

Open http://localhost:3000. In demo mode (no env vars), the app runs with mock data and any password works on login.

---

## Production Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** → paste and run `supabase/migrations/001_initial_schema.sql`
3. Go to **Settings → API** and copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY`
4. Go to **Authentication → Users** → create your admin user (email + password)

### 2. SerpAPI

1. Sign up at [serpapi.com](https://serpapi.com) (free: 100 searches/month)
2. Copy your API key → `SERPAPI_KEY`

### 3. Resend (email reports)

1. Sign up at [resend.com](https://resend.com) (free: 100 emails/day)
2. Add and verify your domain (or use the sandbox `onboarding@resend.dev` for testing)
3. Copy your API key → `RESEND_API_KEY`
4. Set `REPORT_FROM_EMAIL` and `REPORT_TO_EMAIL`

### 4. Environment Variables

Copy `.env.example` to `.env.local` and fill in all values:

```bash
cp .env.example .env.local
```

Generate a cron secret:

```bash
openssl rand -hex 32
```

### 5. Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Add all env vars in the Vercel dashboard under **Settings → Environment Variables**.

Vercel Cron runs the price checker every 6 hours and the daily report at 9 AM MT. Note: Vercel Cron requires the Pro plan ($20/month). For the free tier, use the GitHub Actions workflows instead.

### 6. GitHub Actions (alternative to Vercel Cron)

Add these secrets to your GitHub repo (**Settings → Secrets → Actions**):

- `APP_URL` — your Vercel deployment URL (e.g., `https://luggage-tracker.vercel.app`)
- `CRON_SECRET` — same value as your `CRON_SECRET` env var

The workflows in `.github/workflows/` will trigger automatically.

---

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── cron/
│   │   │   ├── fetch-prices/   ← SerpAPI price fetcher (called by cron)
│   │   │   └── daily-report/   ← Email report sender (called by cron)
│   │   ├── products/           ← Product CRUD
│   │   ├── search/             ← SerpAPI search endpoint
│   │   ├── settings/           ← User settings
│   │   └── track/              ← Track/untrack products
│   ├── dashboard/              ← Main dashboard
│   ├── products/[productId]/   ← Product detail with price comparison
│   ├── search/                 ← Product search
│   ├── settings/               ← Settings page
│   └── page.tsx                ← Login (Supabase Auth or demo)
├── lib/
│   ├── supabase/               ← Supabase clients + types
│   ├── data.ts                 ← Retailer config + mock data (demo mode)
│   ├── email.ts                ← Resend email templates
│   ├── serpapi.ts              ← SerpAPI Google Shopping integration
│   └── store.tsx               ← React context store (localStorage + Supabase)
└── middleware.ts               ← Auth middleware (bypassed in demo mode)
```

## Data Flow

1. **Cron** (every 6h) → `/api/cron/fetch-prices` → SerpAPI Google Shopping → Supabase
2. **Cron** (daily 9 AM MT) → `/api/cron/daily-report` → compare prices → Resend email
3. **Frontend** → reads from Supabase (live) or mock data (demo)
