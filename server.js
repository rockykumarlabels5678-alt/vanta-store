require('dotenv').config();

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { Resend } = require('resend');

const app = express();

const PORT = Number(process.env.PORT || 3000);

const OTP_EXPIRES_MINUTES = Number(
  process.env.OTP_EXPIRES_MINUTES || 5
);

const OTP_RESEND_SECONDS = Number(
  process.env.OTP_RESEND_SECONDS || 60
);

const OTP_EXPIRES_MS =
  OTP_EXPIRES_MINUTES * 60 * 1000;

const OTP_RESEND_MS =
  OTP_RESEND_SECONDS * 1000;

// =====================================================
// APP CONFIG
// =====================================================

app.disable('x-powered-by');

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// SESSION
// =====================================================

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      'vanta-change-this-secret',

    resave: false,

    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

// =====================================================
// RESEND
// =====================================================

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

function resendReady() {
  return Boolean(
    process.env.RESEND_API_KEY &&
    process.env.MAIL_FROM
  );
}

// =====================================================
// OTP STORAGE
// =====================================================

const otpStore = new Map();
const requestStore = new Map();

// =====================================================
// HELPERS
// =====================================================

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeOtp() {
  return crypto
    .randomInt(100000, 1000000)
    .toString();
}

function hashOtp(email, otp) {
  return crypto
    .createHmac(
      'sha256',
      process.env.SESSION_SECRET ||
        'vanta-project-secret'
    )
    .update(`${email}:${otp}`)
    .digest('hex');
}

// =====================================================
// CLEAN EXPIRED OTPs
// =====================================================

function cleanupStores() {
  const now = Date.now();

  for (const [email, record] of otpStore) {
    if (record.expiresAt <= now) {
      otpStore.delete(email);
    }
  }

  for (const [email, timestamp] of requestStore) {
    if (
      now - timestamp >
      OTP_RESEND_MS
    ) {
      requestStore.delete(email);
    }
  }
}

setInterval(
  cleanupStores,
  60 * 1000
).unref();

// =====================================================
// REQUEST OTP
// =====================================================

app.post(
  '/api/auth/request-otp',
  async (req, res) => {
    try {
      const email = normalizeEmail(
        req.body.email
      );

      console.log(
        '--------------------------------'
      );

      console.log(
        'OTP REQUEST:',
        email
      );

      // Validate email
      if (!validEmail(email)) {
        return res.status(400).json({
          ok: false,
          message:
            'Please enter a valid email address.'
        });
      }

      // Check Resend configuration
      if (!resendReady()) {
        console.error(
          'RESEND IS NOT CONFIGURED'
        );

        console.error(
          'RESEND_API_KEY:',
          process.env.RESEND_API_KEY
            ? 'present'
            : 'missing'
        );

        console.error(
          'MAIL_FROM:',
          process.env.MAIL_FROM
            ? 'present'
            : 'missing'
        );

        return res.status(500).json({
          ok: false,
          message:
            'Email service is not configured. Check RESEND_API_KEY and MAIL_FROM in Render.'
        });
      }

      // Check resend cooldown
      const lastSent =
        requestStore.get(email) || 0;

      const elapsed =
        Date.now() - lastSent;

      const remaining =
        OTP_RESEND_MS - elapsed;

      if (remaining > 0) {
        const seconds = Math.ceil(
          remaining / 1000
        );

        return res.status(429).json({
          ok: false,
          message:
            `Please wait ${seconds} seconds before requesting another code.`,

          retryAfter: seconds
        });
      }

      // Generate OTP
      const otp = makeOtp();

      console.log(
        'OTP GENERATED'
      );

      // Store hashed OTP
      otpStore.set(email, {
        hash: hashOtp(email, otp),

        expiresAt:
          Date.now() +
          OTP_EXPIRES_MS,

        attempts: 0
      });

      // Start resend timer
      requestStore.set(
        email,
        Date.now()
      );

      // =================================================
      // SEND THROUGH RESEND
      // =================================================

      console.log(
        'SENDING OTP THROUGH RESEND...'
      );

      const result =
        await resend.emails.send({
          from: process.env.MAIL_FROM,

          to: [email],

          subject:
            'Your VANTA verification code',

          text: `
Your VANTA verification code is ${otp}.

This code expires in ${OTP_EXPIRES_MINUTES} minutes.

If you did not request this code, you can safely ignore this email.
          `.trim(),

          html: `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>VANTA Verification</title>
</head>

<body style="
margin:0;
padding:0;
background:#f4f2ed;
font-family:Arial,Helvetica,sans-serif;
">

<div style="
max-width:520px;
margin:40px auto;
background:#ffffff;
border:1px solid #dddddd;
padding:35px;
">

<div style="
font-size:28px;
font-weight:800;
letter-spacing:5px;
color:#111111;
">
VANTA
</div>

<p style="
font-size:16px;
color:#555555;
margin-top:30px;
">
Use the verification code below to continue signing in.
</p>

<div style="
margin:30px 0;
padding:20px;
background:#f3f3f3;
text-align:center;
font-size:36px;
font-weight:800;
letter-spacing:10px;
color:#111111;
">
${otp}
</div>

<p style="
font-size:14px;
color:#666666;
">
This code expires in ${OTP_EXPIRES_MINUTES} minutes.
</p>

<p style="
font-size:12px;
color:#999999;
">
If you did not request this code, you can safely ignore this email.
</p>

</div>

</body>
</html>
          `
        });

      // =================================================
      // RESEND ERROR
      // =================================================

      if (result.error) {
        console.error(
          'RESEND EMAIL ERROR:'
        );

        console.error(
          JSON.stringify(
            result.error,
            null,
            2
          )
        );

        // Remove invalid OTP
        otpStore.delete(email);

        requestStore.delete(email);

        return res.status(500).json({
          ok: false,
          message:
            'Unable to send verification email.'
        });
      }

      // =================================================
      // SUCCESS
      // =================================================

      console.log(
        'OTP EMAIL SENT SUCCESSFULLY'
      );

      console.log(
        'RESEND EMAIL ID:',
        result.data?.id || 'unknown'
      );

      console.log(
        '--------------------------------'
      );

      return res.json({
        ok: true,

        message:
          'Verification code sent successfully.',

        expiresIn:
          OTP_EXPIRES_MINUTES * 60
      });

    } catch (error) {
      console.error(
        'OTP EMAIL ERROR:'
      );

      console.error(error);

      return res.status(500).json({
        ok: false,
        message:
          'Unable to send the verification email right now.'
      });
    }
  }
);

// =====================================================
// VERIFY OTP
// =====================================================

app.post(
  '/api/auth/verify-otp',
  (req, res) => {

    const email =
      normalizeEmail(
        req.body.email
      );

    const otp =
      String(
        req.body.otp || ''
      ).trim();

    // Validate input
    if (
      !validEmail(email) ||
      !/^\d{6}$/.test(otp)
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Enter the 6-digit verification code.'
      });
    }

    // Find OTP
    const record =
      otpStore.get(email);

    if (!record) {
      return res.status(400).json({
        ok: false,
        message:
          'No active verification code. Please request a new code.'
      });
    }

    // Check expiration
    if (
      record.expiresAt <=
      Date.now()
    ) {
      otpStore.delete(email);

      return res.status(400).json({
        ok: false,
        message:
          'This code has expired. Please request a new one.'
      });
    }

    // Count attempts
    record.attempts += 1;

    if (record.attempts > 5) {
      otpStore.delete(email);

      return res.status(429).json({
        ok: false,
        message:
          'Too many incorrect attempts. Please request a new code.'
      });
    }

    // Verify
    const submittedHash =
      hashOtp(
        email,
        otp
      );

    if (
      submittedHash !==
      record.hash
    ) {
      return res.status(401).json({
        ok: false,
        message:
          'Incorrect verification code.'
      });
    }

    // Success
    otpStore.delete(email);

    requestStore.delete(email);

    req.session.user = {
      email: email,
      verified: true
    };

    console.log(
      'USER VERIFIED:',
      email
    );

    return res.json({
      ok: true,

      user:
        req.session.user
    });
  }
);

// =====================================================
// CHECK LOGIN
// =====================================================

app.get(
  '/api/auth/me',
  (req, res) => {

    res.json({
      ok: true,

      authenticated:
        Boolean(
          req.session.user?.verified
        ),

      user:
        req.session.user ||
        null
    });
  }
);

// =====================================================
// LOGOUT
// =====================================================

app.post(
  '/api/auth/logout',
  (req, res) => {

    req.session.destroy(
      (error) => {

        if (error) {
          console.error(
            'LOGOUT ERROR:',
            error
          );

          return res.status(500).json({
            ok: false,
            message:
              'Unable to logout.'
          });
        }

        res.clearCookie(
          'connect.sid'
        );

        return res.json({
          ok: true
        });
      }
    );
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  '/api/health',
  (req, res) => {

    res.json({
      ok: true,

      emailProvider:
        'Resend',

      emailConfigured:
        resendReady()
    });
  }
);

// =====================================================
// STATIC FRONTEND
// =====================================================

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

// =====================================================
// HOME
// =====================================================

app.get(
  '/',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '================================'
    );

    console.log(
      `VANTA server running on port ${PORT}`
    );

    console.log(
      'Email provider: Resend'
    );

    console.log(
      `Resend configured: ${
        resendReady()
          ? 'YES'
          : 'NO'
      }`
    );

    console.log(
      '================================'
    );
  }
);