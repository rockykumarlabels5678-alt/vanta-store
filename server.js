require('dotenv').config();

const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const app = express();
const OTP_EXPIRES_MS = Number(process.env.OTP_EXPIRES_MINUTES || 5) * 60 * 1000;
const OTP_RESEND_MS = Number(process.env.OTP_RESEND_SECONDS || 60) * 1000;

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'vanta-college-project-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const otpStore = new Map();
const requestStore = new Map();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashOtp(email, otp) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'vanta-project-secret')
    .update(`${email}:${otp}`)
    .digest('hex');
}

function makeOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

function mailerReady() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

const transporter = mailerReady()
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  : null;

function cleanupStores() {
  const now = Date.now();
  for (const [email, record] of otpStore) {
    if (record.expiresAt <= now) otpStore.delete(email);
  }
  for (const [email, timestamp] of requestStore) {
    if (now - timestamp > OTP_RESEND_MS) requestStore.delete(email);
  }
}
setInterval(cleanupStores, 60 * 1000).unref();

app.post('/api/auth/request-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!validEmail(email)) {
      return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
    }

    const lastSent = requestStore.get(email) || 0;
    const remaining = OTP_RESEND_MS - (Date.now() - lastSent);
    if (remaining > 0) {
      return res.status(429).json({
        ok: false,
        message: `Please wait ${Math.ceil(remaining / 1000)} seconds before requesting another code.`,
        retryAfter: Math.ceil(remaining / 1000)
      });
    }

    if (!mailerReady()) {
      return res.status(500).json({
        ok: false,
        message: 'Email service is not configured. Add SMTP settings to your .env file.'
      });
    }

    const otp = makeOtp();
    const record = {
      hash: hashOtp(email, otp),
      expiresAt: Date.now() + OTP_EXPIRES_MS,
      attempts: 0
    };
    otpStore.set(email, record);
    requestStore.set(email, Date.now());

    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Your VANTA verification code',
      text: `Your VANTA verification code is ${otp}. It expires in ${process.env.OTP_EXPIRES_MINUTES || 5} minutes. If you did not request this, you can ignore this email.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px;border:1px solid #ddd">
          <div style="font-size:24px;font-weight:800;letter-spacing:.08em">VANTA</div>
          <p style="color:#555">Use the verification code below to continue signing in.</p>
          <div style="font-size:34px;font-weight:800;letter-spacing:.28em;margin:24px 0">${otp}</div>
          <p style="color:#777">This code expires in ${process.env.OTP_EXPIRES_MINUTES || 5} minutes.</p>
          <p style="color:#999;font-size:12px">If you did not request this code, you can safely ignore this email.</p>
        </div>`
    });

    return res.json({
      ok: true,
      message: `Verification code sent to ${email}.`,
      expiresIn: Number(process.env.OTP_EXPIRES_MINUTES || 5) * 60
    });
  } catch (error) {
    console.error('OTP email error:', error.message);
    return res.status(500).json({ ok: false, message: 'Unable to send the verification email right now.' });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  if (!validEmail(email) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, message: 'Enter the 6-digit verification code.' });
  }

  const record = otpStore.get(email);
  if (!record) {
    return res.status(400).json({ ok: false, message: 'This code has expired. Please request a new one.' });
  }

  if (record.expiresAt <= Date.now()) {
    otpStore.delete(email);
    return res.status(400).json({ ok: false, message: 'This code has expired. Please request a new one.' });
  }

  record.attempts += 1;
  if (record.attempts > 5) {
    otpStore.delete(email);
    return res.status(429).json({ ok: false, message: 'Too many incorrect attempts. Please request a new code.' });
  }

  if (hashOtp(email, otp) !== record.hash) {
    return res.status(401).json({ ok: false, message: 'Incorrect verification code.' });
  }

  otpStore.delete(email);
  requestStore.delete(email);
  req.session.user = { email, verified: true };

  return res.json({ ok: true, user: req.session.user });
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    ok: true,
    authenticated: Boolean(req.session.user?.verified),
    user: req.session.user || null
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, emailConfigured: mailerReady() });
});

app.use(express.static(path.join(__dirname, 'public')));


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VANTA server running on port ${PORT}`);
  console.log(`SMTP configured: ${mailerReady() ? 'yes' : 'no — add .env settings'}`);
});
