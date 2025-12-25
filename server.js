// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
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
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
// ---------- SUPABASE CLIENT ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);


// --- Plan hydration: always read latest plan from DB (so upgrades apply immediately) ---
async function hydrateUserPlan(req, res, next) {
  try {
    if (!req.user) req.user = {};
    const email = req.user.email;
    let plan = (req.user.plan || 'free').toLowerCase();
    if (email) {
      const { data, error } = await supabase
        .from('users')
        .select('plan')
        .eq('email', email)
        .maybeSingle();

      if (!error && data?.plan) plan = String(data.plan).toLowerCase();
    }
    req.user.plan = plan;
  } catch (e) {
    if (!req.user) req.user = {};
    req.user.plan = (req.user.plan || 'free').toLowerCase();
  }
  next();
}

function planRank(plan) {
  return plan === 'pro' ? 3 : plan === 'basic' ? 2 : 1; // free=1
}

function requireMinPlan(minPlan) {
  const min = planRank(String(minPlan).toLowerCase());
  return (req, res, next) => {
    const current = planRank(String(req.user?.plan || 'free').toLowerCase());
    if (current < min) {
      return res.status(403).json({
        error: 'upgrade_required',
        message: `This feature requires ${minPlan} plan.`,
        plan: req.user?.plan || 'free',
      });
    }
    next();
  };
}

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
app.post('/api/generate-script', authRequired, hydrateUserPlan, checkDailyLimit(), async (req, res) => {
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

app.post('/api/gemini-text', authRequired, hydrateUserPlan, checkDailyLimit(), async (req, res) => {
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
app.post('/api/paddle/create-checkout', authMiddleware, async (req, res) => {
  try {
    const plan = String(req.body?.plan || '').toLowerCase();
    const email = req.user?.email;

    const PRICE_IDS = {
      basic: process.env.PADDLE_BASIC_PRICE_ID,
      pro: process.env.PADDLE_PRO_PRICE_ID,
    };

    if (!PRICE_IDS.basic || !PRICE_IDS.pro) {
      return res.status(500).json({ error: 'Missing Paddle price IDs on server' });
    }

    if (!['basic', 'pro'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Use: basic | pro' });
    }

    const apiBase = (process.env.PADDLE_ENV || '').toLowerCase() === 'sandbox'
      ? 'https://sandbox-api.paddle.com'
      : 'https://api.paddle.com';

    const price_id = PRICE_IDS[plan];

    // 1) Create a transaction for the selected recurring price
    const createTxResp = await fetch(`${apiBase}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
      },
      body: JSON.stringify({
        items: [{ price_id, quantity: 1 }],
        customer: { email },
        custom_data: {
          app: 'autolife',
          plan_requested: plan,
          app_user_email: email,
        },
      }),
    });

    const createTxJson = await createTxResp.json().catch(() => ({}));
    if (!createTxResp.ok) {
      console.error('Paddle create transaction failed', createTxResp.status, createTxJson);
      return res.status(502).json({ error: 'Paddle create transaction failed', details: createTxJson });
    }

    const transactionId = createTxJson?.data?.id;
    if (!transactionId) {
      console.error('Paddle create transaction: missing id', createTxJson);
      return res.status(502).json({ error: 'Paddle transaction id missing' });
    }

    // 2) Pass the transaction to checkout to get a hosted checkout URL
    const checkoutResp = await fetch(`${apiBase}/transactions/${transactionId}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
      },
      body: JSON.stringify({
        success_url: process.env.CHECKOUT_SUCCESS_URL,
        cancel_url: process.env.CHECKOUT_CANCEL_URL,
      }),
    });

    const checkoutJson = await checkoutResp.json().catch(() => ({}));
    if (!checkoutResp.ok) {
      console.error('Paddle checkout failed', checkoutResp.status, checkoutJson);
      return res.status(502).json({ error: 'Paddle checkout failed', details: checkoutJson });
    }

    const checkoutUrl = checkoutJson?.data?.url || checkoutJson?.data?.checkout?.url;
    if (!checkoutUrl) {
      console.error('Paddle checkout: missing url', checkoutJson);
      return res.status(502).json({ error: 'Paddle checkout url missing' });
    }

    return res.json({ checkout_url: checkoutUrl });
  } catch (err) {
    console.error('create-checkout error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---- PADDLE WEBHOOK ----
// NOTE: โค้ดนี้เป็น template เบื้องต้น ยังไม่ได้ verify signature
// แนะนำเปิด log แล้วดู payload จริงจาก Paddle แล้วปรับ field ให้ตรง
app.post('/api/paddle/webhook', async (req, res) => {
  try {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!secret) return res.status(500).send('Missing PADDLE_WEBHOOK_SECRET');

    const sig = req.get('paddle-signature') || '';
    // Format: ts=...,h1=...
    const parts = Object.fromEntries(sig.split(',').map(p => p.trim().split('=')));
    const ts = parts.ts;
    const h1 = parts.h1;
    if (!ts || !h1) return res.status(400).send('Invalid paddle-signature header');

    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');

    // constant-time compare
    const safeEqual = (a, b) => {
      const ba = Buffer.from(String(a));
      const bb = Buffer.from(String(b));
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    };

    if (!safeEqual(expected, h1)) {
      console.warn('Paddle webhook signature mismatch');
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(raw);
    const eventType = event?.event_type;

    // Map price_id -> plan
    const basicId = process.env.PADDLE_BASIC_PRICE_ID;
    const proId = process.env.PADDLE_PRO_PRICE_ID;

    const inferPlanFromPriceId = (pid) => {
      if (!pid) return null;
      if (pid === proId) return 'pro';
      if (pid === basicId) return 'basic';
      return null;
    };

    // Extract customer email as robustly as possible
    const customerEmail =
      event?.data?.customer?.email ||
      event?.data?.customer_email ||
      event?.data?.billing_details?.email ||
      event?.data?.custom_data?.app_user_email;

    // Subscription items may vary by event type
    const priceId =
      event?.data?.items?.[0]?.price?.id ||
      event?.data?.items?.[0]?.price_id ||
      event?.data?.line_items?.[0]?.price?.id ||
      event?.data?.line_items?.[0]?.price_id;

    const planFromPrice = inferPlanFromPriceId(priceId);

    console.log('[PADDLE WEBHOOK]', { eventType, customerEmail, priceId, planFromPrice });

    // Update user plan in DB when subscription is active/updated/paused/canceled etc.
    if (customerEmail && planFromPrice && ['subscription.created','subscription.updated','subscription.activated','subscription.resumed'].includes(eventType)) {
      await supabase
        .from('users')
        .update({ plan: planFromPrice })
        .eq('email', customerEmail);

      await supabase
        .from('public.users')
        .update({ plan: planFromPrice })
        .eq('email', customerEmail);
    }

    if (customerEmail && ['subscription.canceled','subscription.paused'].includes(eventType)) {
      // Downgrade to free on cancel/pause
      await supabase.from('users').update({ plan: 'free' }).eq('email', customerEmail);
      await supabase.from('public.users').update({ plan: 'free' }).eq('email', customerEmail);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Webhook error');
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});
