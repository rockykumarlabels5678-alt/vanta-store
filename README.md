# VANTA — Real Email OTP Authentication

This version uses Node.js + Express + Nodemailer. The OTP is generated on the server, stored only as a hash, expires after 5 minutes, and is sent by email.

## 1. Install Node.js
Use Node.js 18+.

## 2. Install dependencies
Open a terminal in this folder:

```bash
npm install
```

## 3. Configure email
Copy `.env.example` to `.env`.

For Gmail, use:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=yourgmail@gmail.com
SMTP_PASS=your-16-character-app-password
MAIL_FROM=VANTA <yourgmail@gmail.com>
```

A Gmail App Password is free. It is different from your normal Gmail password. Do not put your normal password in `.env`.

## 4. Start the website

```bash
npm start
```

Then open:

http://localhost:3000/login.html

Do NOT open `login.html` by double-clicking the file. The browser needs the Express server for `/api/auth/*`.

## OTP flow

1. User enters email.
2. Browser calls `POST /api/auth/request-otp`.
3. Server creates a random 6-digit OTP.
4. Server hashes the OTP and sends the actual code by email.
5. User enters the code.
6. Browser calls `POST /api/auth/verify-otp`.
7. Express creates a session cookie.
8. Store can call `/api/auth/me` to show the user's email and hide Login.
9. Logout destroys the session.

For a public production deployment, replace the default in-memory session store with Redis or a database, add HTTPS, and add a reverse proxy/rate limiter.
