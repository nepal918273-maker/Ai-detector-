# Setup

## 1. Install PostgreSQL

On Windows, installing PostgreSQL requires Administrator permission. When the installer asks for the PostgreSQL `postgres` password, create a strong password and keep it private.

After installation, make sure the PostgreSQL service is running.

## 2. Create the application database

Open PowerShell or SQL Shell as a PostgreSQL administrator and run:

```powershell
psql -U postgres -c "CREATE DATABASE ai_content_workspace;"
psql -U postgres -d ai_content_workspace -f schema.sql
```

The PostgreSQL administrator needs permission to create the database and tables.

## 3. Configure the server

Add these values to `.env`:

```env
DATABASE_URL=postgres://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/ai_content_workspace
JWT_SECRET=GENERATE_A_LONG_RANDOM_SECRET
REVENUECAT_PUBLIC_API_KEY=your_public_revenuecat_web_api_key
REVENUECAT_SECRET_API_KEY=your_revenuecat_secret_api_key
REVENUECAT_WEBHOOK_AUTH=generate_a_private_webhook_secret
```

Do not commit `.env` or share its contents.

## RevenueCat web billing

1. Create a RevenueCat Web Billing configuration and add products for the current offering.
2. Create the `ai_detector_pro` entitlement and attach the products to it.
3. Set the Web Billing public API key in `REVENUECAT_PUBLIC_API_KEY`.
4. Configure a RevenueCat webhook to `https://YOUR_DOMAIN/revenuecat/webhook` with the `Authorization: Bearer YOUR_REVENUECAT_WEBHOOK_AUTH` header.
5. Use product identifiers `three-day`, `monthly`, and `yearly` in the RevenueCat Offering. The browser maps purchased store products to these IDs.
6. Put the RevenueCat `sk_...` secret key in `REVENUECAT_SECRET_API_KEY`. Never expose it to browser code or return it from an endpoint.

The browser identifies purchases with the authenticated application's user ID. The webhook adds credits using the existing `credit_purchases.payment_id` unique constraint, so retries do not double-credit an account.

## 4. Start the application

```powershell
npm start
```

Check the database connection:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

The response should contain:

```json
"database_configured": true
```

## Required application permissions

The PostgreSQL account in `DATABASE_URL` must be able to:

- Connect to `ai_content_workspace`
- Read and insert rows in `users`
- Read, insert, and update rows in `api_keys`
- Use the sequences created for the `BIGSERIAL` columns

For local development, the `postgres` account has these permissions. In production, use a separate restricted application role instead of the administrator account.

## User workflow

1. Open `login.html`.
2. Create an account or sign in.
3. The backend returns a JWT session token.
4. Use the JWT to create an API key through `POST /api/keys`.
5. Save the returned API key; it is shown only once.
6. Send it as `Authorization: Bearer YOUR_API_KEY` to protected `/v1/` endpoints.
