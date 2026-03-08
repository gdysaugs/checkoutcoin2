# checkoutcoin2

`checkoutcoins2.win` (Cloudflare Pages) project.

This site is configured to share Supabase coins (`public.user_tickets`) with SparkArt.

## 1) Supabase SQL

Run this in the SAME Supabase project used by SparkArt:

- `supabase/shared_coins.sql`

## 2) Cloudflare Pages environment variables

Set these for your Pages project (`checkoutcoin2`):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_TO_COINS_MAP` (optional JSON, e.g. `{"price_xxx":100}`)

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are exposed to frontend via `/api/public-config`.

Stripe webhook endpoint:

- `https://checkoutcoins2.win/api/stripe-webhook`

Stripe checkout session endpoint:

- `https://checkoutcoins2.win/api/stripe-checkout`

Recommended Stripe events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

## 3) Manual deploy

```bash
npx wrangler pages deploy . --project-name checkoutcoin2 --branch main --commit-dirty=true
```
