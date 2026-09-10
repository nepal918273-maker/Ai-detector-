# AI Detection

AI Detection is a full-stack JavaScript application for detecting and transforming AI-generated content. It includes a browser-based interface, authentication, credit-based usage, AI chat, text humanization, and optional premium plans handled through RevenueCat.

## Features

- AI-content detection for text, images, video, and audio
- Text humanization
- AI chat workspace
- Image and video generation
- Voice recording support
- User registration and JWT login
- Credit tracking and protected API access
- API key creation for `/v1/` endpoints
- Free and premium credit plans
- RevenueCat web billing and webhook support
- PostgreSQL persistence
- Installable mobile web app (PWA)

## Technology

- Node.js 18 or newer
- Vanilla HTML, CSS, and JavaScript
- PostgreSQL
- Gemini and OpenAI APIs
- RevenueCat Web Billing

## Project Structure

```text
.
├── about.html
├── chat.html
├── detection.html
├── free.html
├── history.html
├── index.html
├── login.html
├── plans.html
├── schema.sql
├── SETUP.md
├── package.json
└── js/
    ├── server.js
    ├── auth.js
    ├── auth-guard.js
    ├── db.js
    ├── app.js
    └── notifications.js
```

## Requirements

Install the following before running the application:

- Node.js 18 or newer
- npm
- PostgreSQL
- A Gemini API key for AI analysis
- An OpenAI API key if OpenAI-backed features are enabled
- RevenueCat Web Billing credentials for premium purchases

## Installation

```powershell
npm install
```

Create a PostgreSQL database and apply the schema:

```powershell
psql -U postgres -c "CREATE DATABASE ai_content_workspace;"
psql -U postgres -d ai_content_workspace -f schema.sql
```

## Environment Variables

Create a local `.env` file in the project root. Never commit this file or share its values.

```env
DATABASE_URL=postgres://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/ai_content_workspace
JWT_SECRET=GENERATE_A_LONG_RANDOM_SECRET
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.6-flash
OPENAI_API_KEY=your_openai_api_key
REVENUECAT_PUBLIC_API_KEY=your_revenuecat_public_api_key
REVENUECAT_SECRET_API_KEY=your_revenuecat_secret_api_key
REVENUECAT_WEBHOOK_AUTH=your_private_webhook_secret
PORT=8000
```

Only the RevenueCat public key is exposed to the browser. Keep the secret key and webhook authorization value on the server.

## Run the Application

```powershell
npm start
```

Open `http://127.0.0.1:8000` in a browser. Check the server and database configuration with:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

## Install on Mobile

AI Detection is installable on Android and iPhone as a mobile web app. Deploy the server over HTTPS, open the site in a mobile browser, and choose **Add to Home Screen** or **Install App** from the browser menu. The app manifest and service worker are included in the repository.

The mobile app still uses the server backend, PostgreSQL database, AI providers, and RevenueCat billing configured in the environment variables above.

## RevenueCat Premium Billing

Premium purchases are processed by RevenueCat. Configure a RevenueCat Web Billing offering with these product identifiers:

- `three-day`
- `monthly`
- `yearly`

Create the `ai_detector_pro` entitlement and attach the products to it. Configure the RevenueCat webhook to call:

```text
https://YOUR_DOMAIN/revenuecat/webhook
```

The webhook must include:

```text
Authorization: Bearer YOUR_REVENUECAT_WEBHOOK_AUTH
```

After a successful purchase, the webhook adds the purchased credits to the authenticated user. Duplicate webhook events are protected by the payment ID constraint in the database.

## Authentication and API Keys

1. Register or sign in through `login.html`.
2. Use the authenticated session to create an API key with `POST /api/keys`.
3. Store the returned API key securely; it is shown only once.
4. Send the key as a bearer token to protected `/v1/` endpoints.

Example:

```http
Authorization: Bearer YOUR_API_KEY
```

## Main Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Server and configuration health check |
| `GET` | `/plans` | List available credit plans |
| `POST` | `/auth/register` | Create an account |
| `POST` | `/auth/login` | Sign in and receive a JWT |
| `GET` | `/auth/me` | Get the current user |
| `GET` | `/credits` | Get the current credit balance |
| `POST` | `/api/keys` | Create an API key |
| `POST` | `/revenuecat/webhook` | Receive RevenueCat purchase events |
| `POST` | `/detect` | Detect AI-generated text |
| `POST` | `/humanize/text` | Humanize text |
| `POST` | `/chat` | Send a chat request |

## Security Notes

- Do not commit `.env`, API keys, database passwords, or JWT secrets.
- Do not expose `REVENUECAT_SECRET_API_KEY` to browser code.
- Use HTTPS in production.
- Use a restricted PostgreSQL application role in production instead of the administrator account.
- Keep uploaded files and generated content protected in production.

## Additional Setup

See [SETUP.md](SETUP.md) for detailed PostgreSQL permissions, RevenueCat configuration, and the complete user workflow.

## License

See [LICENSE](LICENSE) for license information.