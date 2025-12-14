// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 4000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const PADDLE_ENV = process.env.PADDLE_ENV || 'sandbox'; // sandbox | live
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_BASIC_PRICE_ID = process.env.PADDLE_BASIC_PRICE_ID;
const PADDLE_PRO_PRICE_ID = process.env.PADDLE_PRO_PRICE_ID;
const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL;
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL;

// ---------- BASIC APP SETUP ----------
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    // Keep raw body for Paddle webhook signature verification
    if (req.originalUrl && req.originalUrl.includes('/paddle/webhook')) {
      req.rawBody = buf;
    }
  }
}));

// ---------- SUPABASE CLIENT ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- GEMINI CLIENT ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ---------- PLAN & LIMIT CONFIG ----------
const PLAN_LIMITS = {
  free: 20,   // Free tier: 20 ครั้ง/วัน
  basic: 20,  // เริ่มที่ 20 เหมือนกัน ปรับทีหลังง่าย
  pro: null   // null = ไม่จำกัด
};

const PRICE_TO_PLAN = {
  [PADDLE_BASIC_PRICE_ID]: 'basic',
  [PADDLE_PRO_PRICE_ID]: 'pro'
};

// ---------- HELPER ----------
function todayISODate() {
  // ใช้วันที่แบบ UTC ง่าย ๆ
  return new Date().toISOString().slice(0, 10);
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      plan: user.plan
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'unauthorized: no token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    console.error('JWT error', err);
    res.status(401).json({ error: 'unauthorized: invalid token' });
  }
}

async function getUsageRecord(userId, date) {
  const { data, error } = await supabase
    .from('usage_daily')
    .select('*')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function incrementUsage(userId, date) {
  const existing = await getUsageRecord(userId, date);
  if (!existing) {
    const { error } = await supabase
      .from('usage_daily')
      .insert({ user_id: userId, date, used: 1 });
    if (error) throw error;
    return 1;
  } else {
    const { data, error } = await supabase
      .from('usage_daily')
      .update({ used: existing.used + 1 })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data.used;
  }
}

async function getUsageInfo(userId, plan) {
  const limit = PLAN_LIMITS[plan] ?? null; // null = no limit
  const date = todayISODate();

  const rec = await getUsageRecord(userId, date);
  const used = rec ? rec.used : 0;

  return {
    date,
    used,
    limit,
    remaining: limit == null ? null : Math.max(limit - used, 0)
  };
}

function checkDailyLimit() {
  return async (req, res, next) => {
    try {
      const { id: userId, plan } = req.user;

      const info = await getUsageInfo(userId, plan);

      // ถ้า plan ไม่จำกัดก็ผ่านเลย
      if (info.limit == null) {
        req.usageInfo = info;
        return next();
      }

      if (info.used >= info.limit) {
        return res.status(429).json({
          error: 'daily_limit_reached',
          message: `คุณใช้ครบ ${info.limit} ครั้ง/วันแล้ว โปรดรอวันถัดไป หรืออัปเกรดแพ็กเกจ`,
          usage: info
        });
      }

      req.usageInfo = info;
      next();
    } catch (err) {
      console.error('checkDailyLimit error', err);
      res.status(500).json({ error: 'internal_error' });
    }
  };
}

// ---------- ROUTES ----------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'AutoLife backend with Supabase & Paddle' });
});

// ---- AUTH ----

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // check exist
    const { data: existing, error: existingErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingErr) throw existingErr;
    if (existing) {
      return res.status(409).json({ error: 'email_already_registered' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert({
        email: normalizedEmail,
        password_hash,
        plan: 'free'
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    const token = signToken(newUser);

    res.json({
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        plan: newUser.plan
      }
    });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizedEmail)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan
      }
    });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Current user
app.get('/api/me', authRequired, async (req, res) => {
  try {
    const { id } = req.user;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, plan, created_at, paddle_customer_id, paddle_subscription_id')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const usage = await getUsageInfo(user.id, user.plan);

    res.json({ user, usage });
  } catch (err) {
    console.error('/api/me error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Usage info
app.get('/api/usage', authRequired, async (req, res) => {
  try {
    const info = await getUsageInfo(req.user.id, req.user.plan);
    res.json(info);
  } catch (err) {
    console.error('/api/usage error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---- GEMINI SCRIPT GENERATION ----
// ตัวอย่าง endpoint ใช้ limit 20 ครั้ง/วัน
app.post('/api/generate-script', authRequired, checkDailyLimit(), async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: 'prompt_required' });
    }

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // นับ usage ครั้งนี้
    const used = await incrementUsage(req.user.id, todayISODate());
    const usageInfo = await getUsageInfo(req.user.id, req.user.plan);

    res.json({
      text,
      usage: usageInfo
    });
  } catch (err) {
    console.error('generate-script error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---- PADDLE CHECKOUT (ลูกค้าเริ่มจ่ายเงิน) ----
app.post('/api/paddle/create-checkout', authRequired, async (req, res) => {
  try {
    const { priceId } = req.body || {};
    if (!priceId) {
      return res.status(400).json({ error: 'priceId_required' });
    }

    if (!PADDLE_API_KEY) {
      return res.status(500).json({ error: 'paddle_not_configured' });
    }

    const plan = PRICE_TO_PLAN[priceId];
    if (!plan) {
      return res.status(400).json({ error: 'unknown_price_id' });
    }

    const apiBase =
      PADDLE_ENV === 'live'
        ? 'https://api.paddle.com'
        : 'https://sandbox-api.paddle.com';

    const body = {
      items: [{ price_id: priceId, quantity: 1 }],
      customer: {
        email: req.user.email
      },
      metadata: {
        user_id: req.user.id
      },
      success_url: CHECKOUT_SUCCESS_URL,
      cancel_url: CHECKOUT_CANCEL_URL
    };

    const response = await axios.post(
      `${apiBase}/checkout/sessions`,
      body,
      {
        headers: {
          Authorization: `Bearer ${PADDLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const session = response.data;

    // Paddle Billing v2 จะส่ง checkout_url / id กลับมา
    const checkoutUrl = session?.data?.checkout_url || session?.checkout_url;

    res.json({
      sessionId: session?.data?.id || session?.id,
      checkoutUrl
    });
  } catch (err) {
    console.error('create-checkout error', err.response?.data || err);
    res.status(500).json({ error: 'paddle_error' });
  }
});

// ---- PADDLE WEBHOOK ----
// NOTE: Paddle destination URL in your dashboard can be either:
//   https://autolife-backend.onrender.com/api/paddle/webhook   (recommended)
// ============================================================
// Paddle Webhook (Billing / Notifications v2)
// Endpoints:
//   POST /paddle/webhook
//   POST /api/paddle/webhook
// ============================================================

const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

// Verify Paddle signature (Billing / Notifications v2).
// Header: "Paddle-Signature" => "ts=...,h1=..."
// Signed payload: `${ts}:${rawBody}`
// HMAC: sha256 with webhook secret, hex digest
function verifyPaddleSignature(req) {
  const sigHeader = req.get('Paddle-Signature') || req.get('paddle-signature');
  if (!PADDLE_WEBHOOK_SECRET) return { ok: false, reason: 'Missing PADDLE_WEBHOOK_SECRET' };
  if (!sigHeader) return { ok: false, reason: 'Missing Paddle-Signature header' };

  const parts = Object.fromEntries(
    sigHeader.split(';').map((kv) => {
      const [k, ...rest] = kv.split('=');
      return [k.trim(), rest.join('=').trim()];
    })
  );

  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return { ok: false, reason: 'Invalid Paddle-Signature format' };

  const raw = req.rawBody
    ? Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody)
    : Buffer.from(JSON.stringify(req.body || {}));

  const signedPayload = `${ts}:${raw.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // timing-safe compare
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(h1, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'Signature length mismatch' };
    const ok = crypto.timingSafeEqual(a, b);
    return ok ? { ok: true } : { ok: false, reason: 'Signature mismatch' };
  } catch (e) {
    return { ok: false, reason: 'Signature compare error' };
  }
}

async function paddleWebhookHandler(req, res) {
  try {
    const ver = verifyPaddleSignature(req);
    if (!ver.ok) {
      console.warn('[PADDLE_WEBHOOK] signature failed:', ver.reason);
      return res.status(401).send('invalid signature');
    }

    const event = req.body || {};
    const type = event.event_type || event.type;

    console.log('[PADDLE_WEBHOOK] event:', type);

    // Billing v2 usually includes data in event.data
    const data = event.data || event;

    // --- Update user plan on subscription events ---
    if (type === 'subscription.activated' || type === 'subscription.updated') {
      const priceId =
        data.items?.[0]?.price?.id ||
        data.items?.[0]?.price_id ||
        data.price_id;

      const plan = PRICE_TO_PLAN[priceId];

      const email =
        data.customer?.email ||
        data.customer_email ||
        data.user_email;

      if (plan && email) {
        const { data: user, error } = await supabase
          .from('users')
          .update({
            plan,
            paddle_customer_id: data.customer?.id || data.customer_id || null,
            paddle_subscription_id: data.id || data.subscription_id || null
          })
          .eq('email', String(email).toLowerCase())
          .select()
          .single();

        if (error) {
          console.error('[PADDLE_WEBHOOK] supabase update error', error);
        } else {
          console.log('[PADDLE_WEBHOOK] updated user:', user.email, 'plan:', user.plan);
        }
      } else {
        console.warn('[PADDLE_WEBHOOK] plan/email not resolved', { priceId, plan, email });
      }
    }

    // --- Optional: handle transaction.completed as well (some flows rely on this) ---
    if (type === 'transaction.completed') {
      const email =
        data.customer?.email ||
        data.customer_email ||
        data.user_email;

      const priceId =
        data.items?.[0]?.price?.id ||
        data.items?.[0]?.price_id ||
        data.price_id;

      const plan = PRICE_TO_PLAN[priceId];

      if (plan && email) {
        const { error } = await supabase
          .from('users')
          .update({
            plan,
            paddle_customer_id: data.customer?.id || data.customer_id || null
          })
          .eq('email', String(email).toLowerCase());

        if (error) console.error('[PADDLE_WEBHOOK] transaction update error', error);
      }
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('[PADDLE_WEBHOOK] error', err);
    return res.status(500).send('error');
  }
}

// Webhook endpoints (both paths supported)
app.post('/api/paddle/webhook', paddleWebhookHandler);
app.post('/paddle/webhook', paddleWebhookHandler);

// Quick sanity checks (open in browser)
app.get('/api/paddle/webhook', (req, res) => res.status(200).send('ok'));
app.get('/paddle/webhook', (req, res) => res.status(200).send('ok'));
// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});
