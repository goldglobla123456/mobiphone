# PhoneStore Ecommerce Website

A complete ecommerce website for selling phones and related devices/accessories.

## Features

- Customer registration/login/logout
- Product catalog (phones + accessories)
- Search and category filter
- Product detail page
- Shopping cart (add/update/remove)
- Checkout flow with shipping info
- Order placement and history
- Stock management during checkout
- Admin product management (create/edit/delete)

## Tech Stack

- Node.js + Express
- EJS templates
- Firebase Firestore (firebase-admin)
- Session auth (express-session)

## Run locally

1. Create Firebase project and Firestore database

   - Open Firebase Console
   - Create project
   - Enable Firestore (Production or Test mode)
   - Create Service Account key (JSON)

2. Set environment variables

   - `SESSION_SECRET=your_secret`
   - `FIREBASE_SERVICE_ACCOUNT_JSON={...full service account json...}`

   Or (recommended on Railway) set 3 variables instead of JSON:

   - `FIREBASE_PROJECT_ID=your-project-id`
   - `FIREBASE_CLIENT_EMAIL=service-account-email`
   - `FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n`

   PowerShell example:

   `$env:SESSION_SECRET="your_secret"`
   `$env:FIREBASE_SERVICE_ACCOUNT_JSON=Get-Content .\serviceAccount.json -Raw`

   For social login (optional):

   - `BASE_URL=http://localhost:3000`
   - `GOOGLE_CLIENT_ID=...`
   - `GOOGLE_CLIENT_SECRET=...`
   - `FACEBOOK_APP_ID=...`
   - `FACEBOOK_APP_SECRET=...`

   OAuth callback URLs:

   - Google: `http://localhost:3000/auth/google/callback`
   - Facebook: `http://localhost:3000/auth/facebook/callback`

3. Install dependencies

   npm install

4. Start server

   npm start

5. Open browser

   http://localhost:3000

## Default Admin Account

- Email: admin@phonestore.com
- Password: admin123

You can login with this account to manage products at `/admin/products`.
