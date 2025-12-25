// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---- Time helpers (Thailand) ----
function thaiDateKey(d = new Date()) {
  const dt = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function thaiMonthKey(d = new Date()) {
  const dt = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

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
app.use(express.json());

// ---------- SUPABASE CLIENT ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// ---- Usage counters (Supabase) ----
// Tables expected:
// 1) usage_daily:   { user_id (uuid/text), date_key (text YYYY-MM-DD), count (int) }
// 2) usage_monthly: { user_id (uuid/text), month_key (text YYYY-MM), count (int) }
//
// Create unique constraints on (user_id, date_key) and (user_id, month_key) for upsert.

async function getDailyUsageCount(userId, dateKey) {
  const { data, error } = await supabase
    .from('usage_daily')
    .select('count')
    .eq('user_id', userId)
    .eq('date_key', dateKey)
    .maybeSingle();
  if (error) throw error;
  return data?.count || 0;
}

async function getMonthlyUsageCount(userId, monthKey) {
  const { data, error } = await supabase
    .from('usage_monthly')
    .select('count')
    .eq('user_id', userId)
    .eq('month_key', monthKey)
    .maybeSingle();
  if (error) throw error;
  return data?.count || 0;
}

async function incrementDailyUsage(userId, dateKey) {
  // Upsert then increment
  const { data: existing, error: selErr } = await supabase
    .from('usage_daily')
    .select('count')
    .eq('user_id', userId)
    .eq('date_key', dateKey)
    .maybeSingle();
  if (selErr) throw selErr;
  const nextCount = (existing?.count || 0) + 1;

  const { error } = await supabase
    .from('usage_daily')
    .upsert({ user_id: userId, date_key: dateKey, count: nextCount }, { onConflict: 'user_id,date_key' });
  if (error) throw error;
  return nextCount;
}

async function incrementMonthlyUsage(userId, monthKey) {
  const { data: existing, error: selErr } = await supabase
    .from('usage_monthly')
    .select('count')
    .eq('user_id', userId)
    .eq('month_key', monthKey)
    .maybeSingle();
  if (selErr) throw selErr;
  const nextCount = (existing?.count || 0) + 1;

  const { error } = await supabase
    .from('usage_monthly')
    .upsert({ user_id: userId, month_key: monthKey, count: nextCount }, { onConflict: 'user_id,month_key' });
  if (error) throw error;
  return nextCount;
}



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
  freeDaily: 20,
  basicMonthly: 300,
  proUnlimited: true,
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

// Backward-compat alias (some older routes used authRequired)
const authRequired = authRequired;

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
  const todayKey = thaiDateKey();
  const monthKey = thaiMonthKey();

  const usedToday = await getDailyUsageCount(userId, todayKey);
  const usedMonth = await getMonthlyUsageCount(userId, monthKey);

  console.log({
    user: userId,
    plan,
    usedToday,
    usedMonth,
    todayKey,
    monthKey
  });

  return { usedToday, usedMonth, todayKey, monthKey };
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
// NOTE: โค้ดนี้เป็น template เบื้องต้น ยังไม่ได้ verify signature
// แนะนำเปิด log แล้วดู payload จริงจาก Paddle แล้วปรับ field ให้ตรง
app.post('/api/paddle/webhook', async (req, res) => {
  try {
    const event = req.body;
    const type = event.event_type || event.type;

    console.log('Paddle webhook:', type);

    // ตัวอย่างสำหรับ Billing v2: subscription.activated / subscription.updated
    if (
      type === 'subscription.activated' ||
      type === 'subscription.updated'
    ) {
      const data = event.data || event;
      const priceId =
        data.items?.[0]?.price?.id ||
        data.items?.[0]?.price_id ||
        data.price_id;

      const plan = PRICE_TO_PLAN[priceId];

      const email =
        data.customer?.email || data.customer_email || data.user_email;

      if (plan && email) {
        const { data: user, error } = await supabase
          .from('users')
          .upsert(
            {
              email: email.toLowerCase(),
              plan,
              paddle_customer_id: customerId || null,
              paddle_subscription_id: subscriptionId || null,
            },
            { onConflict: 'email' }
          )
          .select()
          .maybeSingle();

        if (error) {
          console.error('supabase update error from webhook', error);
        } else {
          console.log('Updated user from webhook:', user.email, 'plan:', user.plan);
        }
      } else {
        console.warn('Webhook plan/email not resolved', { priceId, plan, email });
      }
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('webhook error', err);
    res.status(500).send('error');
  }
});

// ---------- START ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});
