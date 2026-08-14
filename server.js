require('dotenv').config();

const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const app = express();

const PORT = Number(process.env.PORT || 3000);

const OTP_EXPIRES_MINUTES = Number(
  process.env.OTP_EXPIRES_MINUTES || 5
);

const OTP_RESEND_SECONDS = Number(
  process.env.OTP_RESEND_SECONDS || 60
);

const OTP_EXPIRES_MS = OTP_EXPIRES_MINUTES * 60 * 1000;
const OTP_RESEND_MS = OTP_RESEND_SECONDS * 1000;


// =====================================================
// BASIC CONFIGURATION
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
      'vanta-college-project-change-this',

    resave: false,

    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: 'lax',

      // Render uses HTTPS in production
      secure: process.env.NODE_ENV === 'production',

      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);


// =====================================================
// OTP STORAGE
// =====================================================

// email -> OTP information
const otpStore = new Map();

// email -> last successful email send time
const requestStore = new Map();


// =====================================================
// EMAIL HELPERS
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
  const secret =
    process.env.SESSION_SECRET ||
    'vanta-project-secret';

  return crypto
    .createHmac('sha256', secret)
    .update(`${email}:${otp}`)
    .digest('hex');
}


function mailerReady() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}


// =====================================================
// SMTP TRANSPORTER
// =====================================================

const transporter = mailerReady()
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,

      port: Number(
        process.env.SMTP_PORT || 465
      ),

      secure:
        String(
          process.env.SMTP_SECURE || 'true'
        ).toLowerCase() === 'true',

      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  : null;


// =====================================================
// CLEAN OLD OTP DATA
// =====================================================

function cleanupStores() {
  const now = Date.now();

  // Remove expired OTPs
  for (const [email, record] of otpStore.entries()) {
    if (record.expiresAt <= now) {
      otpStore.delete(email);
    }
  }

  // Remove old resend timers
  for (const [email, timestamp] of requestStore.entries()) {
    if (now - timestamp > OTP_RESEND_MS) {
      requestStore.delete(email);
    }
  }
}

setInterval(cleanupStores, 60 * 1000).unref();


// =====================================================
// REQUEST OTP
// =====================================================

app.post('/api/auth/request-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);

  try {
    // -----------------------------------------------
    // Validate email
    // -----------------------------------------------

    if (!validEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Please enter a valid email address.'
      });
    }


    // -----------------------------------------------
    // Check resend timer
    // -----------------------------------------------

    const lastSent =
      requestStore.get(email) || 0;

    const elapsed =
      Date.now() - lastSent;

    const remaining =
      OTP_RESEND_MS - elapsed;

    if (remaining > 0) {
      return res.status(429).json({
        ok: false,

        message:
          `Please wait ${Math.ceil(
            remaining / 1000
          )} seconds before requesting another code.`,

        retryAfter:
          Math.ceil(remaining / 1000)
      });
    }


    // -----------------------------------------------
    // Check SMTP
    // -----------------------------------------------

    if (!mailerReady() || !transporter) {
      console.error(
        'SMTP is not configured.'
      );

      return res.status(500).json({
        ok: false,
        message:
          'Email service is not configured on the server.'
      });
    }


    // -----------------------------------------------
    // Generate OTP
    // -----------------------------------------------

    const otp = makeOtp();

    const record = {
      hash: hashOtp(email, otp),

      expiresAt:
        Date.now() + OTP_EXPIRES_MS,

      attempts: 0
    };


    // -----------------------------------------------
    // SEND EMAIL
    // IMPORTANT:
    // Do NOT save OTP/cooldown until this succeeds.
    // -----------------------------------------------

    const info =
      await transporter.sendMail({
        from:
          process.env.MAIL_FROM ||
          process.env.SMTP_USER,

        to: email,

        subject:
          'Your VANTA verification code',

        text:
          `Your VANTA verification code is ${otp}.\n\n` +
          `This code expires in ${OTP_EXPIRES_MINUTES} minutes.\n\n` +
          `If you did not request this code, you can ignore this email.`,

        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>VANTA Verification</title>
</head>

<body style="
  margin:0;
  padding:30px;
  background:#f4f2ed;
  font-family:Arial,sans-serif;
">

  <div style="
    max-width:520px;
    margin:auto;
    background:#ffffff;
    padding:35px;
    border:1px solid #dddddd;
  ">

    <div style="
      font-size:26px;
      font-weight:800;
      letter-spacing:4px;
      margin-bottom:25px;
    ">
      VANTA
    </div>

    <h2 style="
      margin:0 0 12px 0;
      color:#111111;
    ">
      Verify your email
    </h2>

    <p style="
      color:#555555;
      font-size:15px;
      line-height:1.6;
    ">
      Use the verification code below to
      continue signing in to VANTA.
    </p>

    <div style="
      margin:30px 0;
      padding:20px;
      text-align:center;
      background:#f4f4f4;
      font-size:36px;
      font-weight:bold;
      letter-spacing:10px;
    ">
      ${otp}
    </div>

    <p style="
      color:#666666;
      font-size:14px;
    ">
      This code expires in
      ${OTP_EXPIRES_MINUTES} minutes.
    </p>

    <p style="
      color:#999999;
      font-size:12px;
      margin-top:25px;
    ">
      If you did not request this verification code,
      you can safely ignore this email.
    </p>

  </div>

</body>
</html>
        `
      });


    // -----------------------------------------------
    // EMAIL SUCCESSFUL
    // NOW save OTP and cooldown
    // -----------------------------------------------

    otpStore.set(email, record);

    requestStore.set(
      email,
      Date.now()
    );


    console.log(
      `OTP sent successfully to ${email}`
    );

    console.log(
      `Message ID: ${info.messageId}`
    );


    return res.json({
      ok: true,

      message:
        `Verification code sent to ${email}.`,

      expiresIn:
        OTP_EXPIRES_MINUTES * 60,

      email
    });


  } catch (error) {

    // -----------------------------------------------
    // EMAIL FAILED
    // Remove anything that may have been stored.
    // -----------------------------------------------

    otpStore.delete(email);
    requestStore.delete(email);


    console.error(
      '======================================'
    );

    console.error(
      'OTP EMAIL ERROR'
    );

    console.error(
      error
    );

    console.error(
      '======================================'
    );


    return res.status(500).json({
      ok: false,

      message:
        'Unable to send the verification email right now.',

      // Helpful during development/college project
      error:
        process.env.NODE_ENV === 'production'
          ? error.message
          : error.message
    });
  }
});


// =====================================================
// VERIFY OTP
// =====================================================

app.post('/api/auth/verify-otp', (req, res) => {
  const email =
    normalizeEmail(req.body.email);

  const otp =
    String(req.body.otp || '').trim();


  // -----------------------------------------------
  // Validate input
  // -----------------------------------------------

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


  // -----------------------------------------------
  // Find OTP
  // -----------------------------------------------

  const record =
    otpStore.get(email);

  if (!record) {
    return res.status(400).json({
      ok: false,

      message:
        'No active verification code found. Please request a new one.'
    });
  }


  // -----------------------------------------------
  // Check expiration
  // -----------------------------------------------

  if (
    record.expiresAt <= Date.now()
  ) {
    otpStore.delete(email);

    return res.status(400).json({
      ok: false,

      message:
        'This code has expired. Please request a new one.'
    });
  }


  // -----------------------------------------------
  // Check attempts
  // -----------------------------------------------

  record.attempts += 1;

  if (record.attempts > 5) {
    otpStore.delete(email);

    return res.status(429).json({
      ok: false,

      message:
        'Too many incorrect attempts. Please request a new code.'
    });
  }


  // -----------------------------------------------
  // Compare OTP
  // -----------------------------------------------

  const submittedHash =
    hashOtp(email, otp);

  if (
    submittedHash !== record.hash
  ) {
    return res.status(401).json({
      ok: false,

      message:
        'Incorrect verification code.'
    });
  }


  // -----------------------------------------------
  // SUCCESS
  // -----------------------------------------------

  otpStore.delete(email);
  requestStore.delete(email);


  req.session.user = {
    email: email,
    verified: true
  };


  console.log(
    `User verified successfully: ${email}`
  );


  return res.json({
    ok: true,

    message:
      'Email verified successfully.',

    user: req.session.user
  });
});


// =====================================================
// CHECK CURRENT LOGIN
// =====================================================

app.get('/api/auth/me', (req, res) => {
  const authenticated =
    Boolean(
      req.session.user &&
      req.session.user.verified
    );


  return res.json({
    ok: true,

    authenticated,

    user:
      req.session.user || null
  });
});


// =====================================================
// LOGOUT
// =====================================================

app.post('/api/auth/logout', (req, res) => {

  req.session.destroy((error) => {

    if (error) {
      console.error(
        'Logout error:',
        error
      );

      return res.status(500).json({
        ok: false,
        message: 'Unable to logout.'
      });
    }


    res.clearCookie(
      'connect.sid'
    );


    return res.json({
      ok: true,
      message: 'Logged out successfully.'
    });
  });
});


// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', (req, res) => {

  return res.json({
    ok: true,

    emailConfigured:
      mailerReady(),

    smtpHost:
      process.env.SMTP_HOST || null
  });
});


// =====================================================
// SERVE FRONTEND
// =====================================================

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


app.get('/', (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      'public',
      'index.html'
    )
  );
});


// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '======================================'
    );

    console.log(
      `VANTA server running on port ${PORT}`
    );

    console.log(
      `SMTP configured: ${
        mailerReady()
          ? 'yes'
          : 'NO'
      }`
    );

    console.log(
      `OTP expiry: ${OTP_EXPIRES_MINUTES} minutes`
    );

    console.log(
      `OTP resend delay: ${OTP_RESEND_SECONDS} seconds`
    );

    console.log(
      '======================================'
    );
  }
);