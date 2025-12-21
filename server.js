// server.js (merged: Plan Spec + gateAI + Paddle price mapping + /api/me)
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

// Paddle
const PADDLE_ENV = process.env.PADDLE_ENV || 'sandbox'; // sandbox | live
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_BASIC_PRICE_ID = process.env.PADDLE_BASIC_PRICE_ID; // e.g. pri_xxx
const PADDLE_PRO_PRICE_ID = process.env.PADDLE_PRO_PRICE_ID;     // e.g. pri_yyy
const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL;
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL;

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'models/gemini-2.5-flash').replace(/^models\//, '');

// ---------- BASIC APP SETUP ----------
app.use(cors());
app.use(express.json());

// ---------- SUPABASE CLIENT (Service Role) ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- PLAN SPEC (Single Source of Truth) ----------
const PLAN_RULES = {
  free:  { dailyLimit: 20,  monthlyLimit: null, unlimited: false, priceTHB: 0   },
  basic: { dailyLimit: null, monthlyLimit: 200, unlimited: false, priceTHB: 190 },
  pro:   { dailyLimit: null, monthlyLimit: null, unlimited: true,  priceTHB: 590 }
};

function normalizePlan(plan) {
  const p = String(plan || 'free').toLowerCase();
  return PLAN_RULES[p] ? p : 'free';
}

function mapPaddleToPlan(priceId) {
  if (!priceId) return 'free';
  if (priceId === PADDLE_BASIC_PRICE_ID) return 'basic';
  if (priceId === PADDLE_PRO_PRICE_ID) return 'pro';
  return 'free';
}

// ---------- GEMINI CLIENT ----------
let _genAI = null;
function getGeminiModel() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  if (!_genAI) _genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  return _genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

// ---------- TIME HELPERS ----------
function isoDateUTC(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthRangeUTC(d = new Date()) {
  const dt = new Date(d);
  const start = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1, 0, 0, 0));
  return { startISO: isoDateUTC(start), endISO: isoDateUTC(end) };
}

// ---------- AUTH HELPERS ----------
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, plan: normalizePlan(user.plan) },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized: no token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    console.error('JWT error', err);
    return res.status(401).json({ error: 'unauthorized: invalid token' });
  }
}

// Always read latest plan from DB (so upgrades apply immediately)
async function hydrateUser(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return next();

    const { data, error } = await supabase
      .from('users')
      .select('id, email, plan, paddle_customer_id, paddle_subscription_id, created_at')
      .eq('id', userId)
      .single();

    if (!error && data) {
      req.user = {
        ...req.user,
        id: data.id,
        email: data.email,
        plan: normalizePlan(data.plan),
        paddle_customer_id: data.paddle_customer_id || null,
        paddle_subscription_id: data.paddle_subscription_id || null,
        created_at: data.created_at || null
      };
    } else {
      req.user.plan = normalizePlan(req.user.plan);
    }
  } catch (e) {
    req.user.plan = normalizePlan(req.user?.plan);
  }
  next();
}

// ---------- USAGE (daily table) ----------
async function getUsageDaily(userId, dateISO) {
  const { data, error } = await supabase
    .from('usage_daily')
    .select('id, used')
    .eq('user_id', userId)
    .eq('date', dateISO)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function incrementUsageDaily(userId, dateISO) {
  const existing = await getUsageDaily(userId, dateISO);
  if (!existing) {
    const { error } = await supabase
      .from('usage_daily')
      .insert({ user_id: userId, date: dateISO, used: 1 });
    if (error) throw error;
    return 1;
  }
  const next = (existing.used || 0) + 1;
  const { error } = await supabase
    .from('usage_daily')
    .update({ used: next })
    .eq('id', existing.id);
  if (error) throw error;
  return next;
}

async function getMonthUsed(userId) {
  const { startISO, endISO } = monthRangeUTC(new Date());
  const { data, error } = await supabase
    .from('usage_daily')
    .select('used')
    .eq('user_id', userId)
    .gte('date', startISO)
    .lt('date', endISO);

  if (error) throw error;
  return (data || []).reduce((sum, r) => sum + (r.used || 0), 0);
}

async function getUsageSummary(userId, plan) {
  const p = normalizePlan(plan);
  const rules = PLAN_RULES[p];

  const today = isoDateUTC();
  const todayRec = await getUsageDaily(userId, today);
  const todayUsed = todayRec?.used || 0;

  const monthUsed = await getMonthUsed(userId);

  return {
    plan: p,
    rules,
    today: {
      date: today,
      used: todayUsed,
      limit: rules.dailyLimit,
      remaining: rules.dailyLimit == null ? null : Math.max(rules.dailyLimit - todayUsed, 0)
    },
    month: {
      range: monthRangeUTC(new Date()),
      used: monthUsed,
      limit: rules.monthlyLimit,
      remaining: rules.monthlyLimit == null ? null : Math.max(rules.monthlyLimit - monthUsed, 0)
    }
  };
}

// ---------- gateAI middleware (Feature Gate) ----------
function gateAI() {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const plan = normalizePlan(req.user?.plan);
      const rules = PLAN_RULES[plan];

      if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

      // Pro: unlimited
      if (rules.unlimited) {
        req.usage = await getUsageSummary(userId, plan);
        return next();
      }

      // Daily / Monthly checks
      const usage = await getUsageSummary(userId, plan);

      if (rules.dailyLimit != null && usage.today.used >= rules.dailyLimit) {
        return res.status(402).json({
          ok: false,
          error: 'limit_reached',
          scope: 'daily',
          upgrade_required: true,
          usage
        });
      }

      if (rules.monthlyLimit != null && usage.month.used >= rules.monthlyLimit) {
        return res.status(402).json({
          ok: false,
          error: 'limit_reached',
          scope: 'monthly',
          upgrade_required: true,
          usage
        });
      }

      // Consume 1 usage (store in daily table; monthly is SUM(daily))
      await incrementUsageDaily(userId, isoDateUTC());
      req.usage = await getUsageSummary(userId, plan);
      next();
    } catch (err) {
      console.error('gateAI error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
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
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });

    const normalizedEmail = String(email).trim().toLowerCase();

    // check exist
    const { data: existing, error: existingErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingErr) throw existingErr;
    if (existing) return res.status(409).json({ error: 'email_already_registered' });

    const password_hash = await bcrypt.hash(password, 10);

    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert({ email: normalizedEmail, password_hash, plan: 'free' })
      .select('id, email, plan, created_at, paddle_customer_id, paddle_subscription_id')
      .single();

    if (insertErr) throw insertErr;

    const token = signToken(newUser);

    res.json({
      token,
      user: { id: newUser.id, email: newUser.email, plan: normalizePlan(newUser.plan) }
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
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });

    const normalizedEmail = String(email).trim().toLowerCase();

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizedEmail)
      .single();

    if (error || !user) return res.status(401).json({ error: 'invalid_credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signToken(user);

    res.json({
      token,
      user: { id: user.id, email: user.email, plan: normalizePlan(user.plan) }
    });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---- Current user (/api/me) ----
app.get('/api/me', authRequired, hydrateUser, async (req, res) => {
  try {
    const user = {
      id: req.user.id,
      email: req.user.email,
      plan: normalizePlan(req.user.plan),
      created_at: req.user.created_at,
      paddle_customer_id: req.user.paddle_customer_id || null,
      paddle_subscription_id: req.user.paddle_subscription_id || null
    };

    const usage = await getUsageSummary(user.id, user.plan);

    // Helpful for frontend (show correct price ids)
    const paddle = {
      env: PADDLE_ENV,
      basic_price_id: PADDLE_BASIC_PRICE_ID || null,
      pro_price_id: PADDLE_PRO_PRICE_ID || null
    };

    res.json({ ok: true, user, usage, plans: PLAN_RULES, paddle });
  } catch (err) {
    console.error('/api/me error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ---- GEMINI ENDPOINTS (gated) ----
app.post('/api/generate-script', authRequired, hydrateUser, gateAI(), async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt_required' });

    const model = getGeminiModel();
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ ok: true, text, usage: req.usage });
  } catch (err) {
    console.error('generate-script error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/gemini-text', authRequired, hydrateUser, gateAI(), async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt_required' });

    const model = getGeminiModel();
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ ok: true, text, usage: req.usage });
  } catch (err) {
    console.error('gemini-text error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ---- PADDLE CHECKOUT (ลูกค้าเริ่มจ่ายเงิน) ----
app.post('/api/paddle/create-checkout', authRequired, hydrateUser, async (req, res) => {
  try {
    const { priceId } = req.body || {};
    if (!priceId) return res.status(400).json({ error: 'priceId_required' });

    if (!PADDLE_API_KEY) return res.status(500).json({ error: 'paddle_not_configured' });

    const plan = mapPaddleToPlan(priceId);
    if (plan === 'free') return res.status(400).json({ error: 'unknown_price_id' });

    const apiBase = (PADDLE_ENV === 'live') ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

    const body = {
      items: [{ price_id: priceId, quantity: 1 }],
      customer: { email: req.user.email },
      metadata: { user_id: req.user.id, requested_plan: plan },
      success_url: CHECKOUT_SUCCESS_URL,
      cancel_url: CHECKOUT_CANCEL_URL
    };

    const response = await axios.post(`${apiBase}/checkout/sessions`, body, {
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const session = response.data;
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
// NOTE: template only; signature verification is strongly recommended for production.
app.post('/api/paddle/webhook', async (req, res) => {
  try {
    const event = req.body || {};
    const type = event.event_type || event.type;

    console.log('Paddle webhook:', type);

    // Billing v2: subscription.activated / subscription.updated / subscription.canceled
    const handledTypes = new Set([
      'subscription.activated',
      'subscription.updated',
      'subscription.canceled',
      'subscription.paused',
      'subscription.resumed',
      'subscription.past_due'
    ]);

    if (!handledTypes.has(type)) {
      return res.status(200).send('ok');
    }

    const data = event.data || event;

    const priceId =
      data.items?.[0]?.price?.id ||
      data.items?.[0]?.price_id ||
      data.price_id ||
      data?.subscription?.items?.[0]?.price?.id;

    const email =
      data.customer?.email ||
      data.customer_email ||
      data.user_email ||
      data?.subscription?.customer?.email;

    const customerId =
      data.customer?.id ||
      data.customer_id ||
      data?.subscription?.customer?.id ||
      null;

    const subscriptionId =
      data.id ||
      data.subscription_id ||
      data?.subscription?.id ||
      null;

    // Decide plan: if canceled/past_due -> free, else map from priceId.
    let plan = mapPaddleToPlan(priceId);
    if (type === 'subscription.canceled' || type === 'subscription.past_due') {
      plan = 'free';
    }

    if (email) {
      const { data: user, error } = await supabase
        .from('users')
        .upsert(
          {
            email: String(email).toLowerCase(),
            plan,
            paddle_customer_id: customerId,
            paddle_subscription_id: subscriptionId
          },
          { onConflict: 'email' }
        )
        .select()
        .maybeSingle();

      if (error) console.error('supabase update error from webhook', error);
      else console.log('Updated user from webhook:', user?.email, 'plan:', user?.plan);
    } else {
      console.warn('Webhook email not resolved', { type, priceId, customerId, subscriptionId });
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('webhook error', err);
    res.status(500).send('error');
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});
