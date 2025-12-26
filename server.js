/**
 * AutoLife backend (Render deploy-ready)
 * Phase 1: Stable quota control + Paddle checkout/webhook
 *
 * SPEC (Thailand time, GMT+7):
 * - FREE  : 20 calls / day  (reset at 00:00 Asia/Bangkok)  -> enforce, return 402 when exceeded
 * - BASIC : 300 calls / month (reset 1st day of month Asia/Bangkok) -> enforce, return 402 when exceeded
 * - PRO   : unlimited -> no quota check
 *
 * UX status:
 * - 401: please login
 * - 402: quota exceeded (upgrade)
 * - 429: system busy / upstream rate limited
 * - 500: server error
 */
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET = process.env.JWT_SECRET || "change-me";

const PADDLE_ENV = (process.env.PADDLE_ENV || "sandbox").toLowerCase(); // sandbox | live
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

const PADDLE_BASIC_PRICE_ID = process.env.PADDLE_BASIC_PRICE_ID;
const PADDLE_PRO_PRICE_ID = process.env.PADDLE_PRO_PRICE_ID;

const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL;
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL;

// ---------- VALIDATION ----------
function must(name, value) {
  if (!value) console.warn(`⚠️ Missing env: ${name}`);
}
must("SUPABASE_URL", SUPABASE_URL);
must("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
must("JWT_SECRET", JWT_SECRET);
must("PADDLE_API_KEY", PADDLE_API_KEY);
must("PADDLE_WEBHOOK_SECRET", PADDLE_WEBHOOK_SECRET);
must("PADDLE_BASIC_PRICE_ID", PADDLE_BASIC_PRICE_ID);
must("PADDLE_PRO_PRICE_ID", PADDLE_PRO_PRICE_ID);
must("CHECKOUT_SUCCESS_URL", CHECKOUT_SUCCESS_URL);
must("CHECKOUT_CANCEL_URL", CHECKOUT_CANCEL_URL);
must("GEMINI_API_KEY", GEMINI_API_KEY);

// ---------- MIDDLEWARE ----------
// CORS: allow Netlify frontend + local dev.
// Set CORS_ORIGINS as comma-separated list (recommended) to be strict in production.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// sensible defaults (your known frontends)
if (!ALLOWED_ORIGINS.length) {
  ALLOWED_ORIGINS.push(
    // Netlify production site (Origin never has a trailing slash, but keep it clean anyway)
    "https://autolife-ai.netlify.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:5500",
  );
}

const corsOptions = {
  origin(origin, cb) {
    // allow server-to-server / curl (no Origin)
    if (!origin) return cb(null, true);

    const o = String(origin).replace(/\/$/, "");
    const allowList = new Set(ALLOWED_ORIGINS.map((x) => String(x).replace(/\/$/, "")));
    if (allowList.has(o)) return cb(null, true);

    // Allow any Netlify site / deploy preview under netlify.app
    // (Netlify preview origins look like: https://<hash>--<site>.netlify.app)
    if (/^https:\/\/[a-z0-9-]+(?:--[a-z0-9-]+)?\.netlify\.app$/i.test(o)) return cb(null, true);

    // Local dev convenience
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return cb(null, true);

    return cb(new Error(`CORS blocked for origin: ${o}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.options("*", cors(corsOptions));
const jsonParser = express.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    // Keep rawBody for debugging / future signature checks on JSON routes
    req.rawBody = buf;
  },
});
app.use((req, res, next) => {
  // IMPORTANT: Paddle webhook uses express.raw() to verify signature.
  // Do not pre-consume body via jsonParser.
  if (req.originalUrl && req.originalUrl.startsWith("/api/paddle/webhook")) return next();
  return jsonParser(req, res, next);
});

// ---------- SUPABASE ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Usage table column compatibility (older DB might use 'date'/'month' instead of 'date_key'/'month_key') ---
let DAILY_KEY_COL = process.env.DAILY_KEY_COL || 'date';
let MONTH_KEY_COL = process.env.MONTH_KEY_COL || 'month';
let DAILY_COUNT_COL = process.env.DAILY_COUNT_COL || 'used';
// NOTE: your Supabase screenshot shows public.usage_monthly uses column `count`
// (while public.usage_daily uses column `used`).
let MONTH_COUNT_COL = process.env.MONTH_COUNT_COL || 'count';
let _usageColsProbed = false;

const COUNT_CANDIDATES = ['count', 'used', 'used_count', 'usage', 'usage_count', 'calls', 'call_count'];

async function probeUsageColumns() {
  if (_usageColsProbed) return;
  _usageColsProbed = true;

  // Probe daily (key column + count column)
  try {
    const probeVal = '1900-01-01';
    const { error } = await supabase
      .from('usage_daily')
      .select(DAILY_COUNT_COL)
      .eq('user_id', 'probe')
      .eq(DAILY_KEY_COL, probeVal)
      .limit(1);

    if (error && (error.code === '42703' || error.code === 'PGRST204') && String(error.message || '').includes('date_key')) {
      DAILY_KEY_COL = 'date';
      console.warn('[probe] usage_daily missing date_key; falling back to column: date');
    }

    // If selected count column is missing, try candidates (ex: `used` vs `count`).
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      for (const cand of COUNT_CANDIDATES) {
        try {
          const { error: e2 } = await supabase
            .from('usage_daily')
            .select(cand)
            .eq('user_id', 'probe')
            .eq(DAILY_KEY_COL, probeVal)
            .limit(1);
          if (!e2) {
            DAILY_COUNT_COL = cand;
            console.warn(`[probe] usage_daily count column not found; falling back to column: ${cand}`);
            break;
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[probe] usage_daily probe exception:', e?.message || e);
  }

  // Probe monthly (key column + count column)
  try {
    const probeVal = '1900-01';
    const { error } = await supabase
      .from('usage_monthly')
      .select(MONTH_COUNT_COL)
      .eq('user_id', 'probe')
      .eq(MONTH_KEY_COL, probeVal)
      .limit(1);

    if (error && (error.code === '42703' || error.code === 'PGRST204') && String(error.message || '').includes('month_key')) {
      MONTH_KEY_COL = 'month';
      console.warn('[probe] usage_monthly missing month_key; falling back to column: month');
    }

    // If the selected count column is wrong/missing, try candidates
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      for (const cand of COUNT_CANDIDATES) {
        try {
          const { error: e2 } = await supabase
            .from('usage_monthly')
            .select(cand)
            .eq('user_id', 'probe')
            .eq(MONTH_KEY_COL, probeVal)
            .limit(1);
          if (!e2) {
            MONTH_COUNT_COL = cand;
            console.warn(`[probe] usage_monthly missing count; falling back to column: ${cand}`);
            break;
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[probe] usage_monthly probe exception:', e?.message || e);
  }
}


// Expected tables (recommended):
// users: { id uuid pk, email text unique, password_hash text, plan text, paddle_customer_id text, paddle_subscription_id text, created_at }
// usage_daily:   { user_id uuid/text, date_key text 'YYYY-MM-DD', count int, updated_at } unique(user_id,date_key)
// usage_monthly: { user_id uuid/text, month_key text 'YYYY-MM',  count int, updated_at } unique(user_id,month_key)

async function getDailyCount(userId, dateKey) {
  await probeUsageColumns();
  const { data, error } = await supabase
    .from('usage_daily')
    .select(DAILY_COUNT_COL)
    .eq('user_id', userId)
    .eq(DAILY_KEY_COL, dateKey)
    .maybeSingle();

  if (error) throw error;
  return (data && data[DAILY_COUNT_COL]) ? Number(data[DAILY_COUNT_COL]) : 0;
}


async function getMonthlyCount(userId, monthKey) {
  await probeUsageColumns();
  const { data, error } = await supabase
    .from('usage_monthly')
    .select(MONTH_COUNT_COL)
    .eq('user_id', userId)
    .eq(MONTH_KEY_COL, monthKey)
    .maybeSingle();

  if (error) throw error;
  return (data && data[MONTH_COUNT_COL]) ? Number(data[MONTH_COUNT_COL]) : 0;
}


async function incDaily(userId, dateKey) {
  await probeUsageColumns();

  const { data: existing, error: selErr } = await supabase
    .from('usage_daily')
    .select(DAILY_COUNT_COL)
    .eq('user_id', userId)
    .eq(DAILY_KEY_COL, dateKey)
    .maybeSingle();

  if (selErr) throw selErr;

  const current = existing ? Number(existing[DAILY_COUNT_COL] ?? 0) : 0;
  const next = current + 1;

  const payload = { user_id: userId, [DAILY_COUNT_COL]: next, [DAILY_KEY_COL]: dateKey };
  const { error: upErr } = await supabase
    .from('usage_daily')
    .upsert(payload, { onConflict: `user_id,${DAILY_KEY_COL}` });

  if (upErr) throw upErr;
  return next;
}


async function incMonthly(userId, monthKey) {
  await probeUsageColumns();

  const { data: existing, error: selErr } = await supabase
    .from('usage_monthly')
    .select(MONTH_COUNT_COL)
    .eq('user_id', userId)
    .eq(MONTH_KEY_COL, monthKey)
    .maybeSingle();

  if (selErr) throw selErr;

  const current = existing ? Number(existing[MONTH_COUNT_COL] ?? 0) : 0;
  const next = current + 1;

  const payload = { user_id: userId, [MONTH_COUNT_COL]: next, [MONTH_KEY_COL]: monthKey };
  const { error: upErr } = await supabase
    .from('usage_monthly')
    .upsert(payload, { onConflict: `user_id,${MONTH_KEY_COL}` });

  if (upErr) throw upErr;
  return next;
}


// ---------- TIME HELPERS (Thailand) ----------
function toBangkokDate(d = new Date()) {
  return new Date(d.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
}
function thaiDateKey(d = new Date()) {
  const dt = toBangkokDate(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function thaiMonthKey(d = new Date()) {
  const dt = toBangkokDate(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------- AUTH ----------
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, plan: user.plan },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized", message: "กรุณา Login" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: "unauthorized", message: "Token ไม่ถูกต้อง/หมดอายุ" });
  }
}

// Always read latest plan from DB so webhook upgrades apply immediately
async function hydrateUserPlan(req, res, next) {
  try {
    const email = String(req.user?.email || "").toLowerCase();
    if (!email) {
      req.user.plan = String(req.user?.plan || "free").toLowerCase();
      return next();
    }
    const { data, error } = await supabase
      .from("users")
      .select("plan")
      .eq("email", email)
      .maybeSingle();
    if (!error && data?.plan) req.user.plan = String(data.plan).toLowerCase();
  } catch (_) {
    // ignore
  }
  req.user.plan = String(req.user?.plan || "free").toLowerCase();
  next();
}

// ---------- QUOTA ----------
const LIMITS = {
  freeDaily: 20,
  basicMonthly: 300,
};

function quotaGuard() {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;
      const plan = String(req.user.plan || "free").toLowerCase();

      const dateKey = thaiDateKey();
      const monthKey = thaiMonthKey();

      const usedToday = await getDailyCount(userId, dateKey);
      const usedMonth = await getMonthlyCount(userId, monthKey);

      console.log({ user: req.user.email, plan, usedToday, usedMonth, dateKey, monthKey });

      // PRO: unlimited
      if (plan === "pro") {
        req.usage = { usedToday, usedMonth, dateKey, monthKey };
        return next();
      }

      // FREE: 20/day
      if (plan === "free") {
        if (usedToday >= LIMITS.freeDaily) {
          return res.status(402).json({
            error: "quota_exceeded",
            message: `ใช้โควตาครบแล้ว (${LIMITS.freeDaily} ครั้ง/วัน) กรุณาอัปเกรดแพ็กเกจ`,
            plan,
            usage: { usedToday, usedMonth, dateKey, monthKey },
          });
        }
        req.usage = { usedToday, usedMonth, dateKey, monthKey };
        return next();
      }

      // BASIC: 300/month
      if (plan === "basic") {
        if (usedMonth >= LIMITS.basicMonthly) {
          return res.status(402).json({
            error: "quota_exceeded",
            message: `ใช้โควตาครบแล้ว (${LIMITS.basicMonthly} ครั้ง/เดือน) กรุณาอัปเกรดแพ็กเกจ`,
            plan,
            usage: { usedToday, usedMonth, dateKey, monthKey },
          });
        }
        req.usage = { usedToday, usedMonth, dateKey, monthKey };
        return next();
      }

      // unknown plan -> treat as free
      if (usedToday >= LIMITS.freeDaily) {
        return res.status(402).json({
          error: "quota_exceeded",
          message: `ใช้โควตาครบแล้ว (${LIMITS.freeDaily} ครั้ง/วัน) กรุณาอัปเกรดแพ็กเกจ`,
          plan: "free",
          usage: { usedToday, usedMonth, dateKey, monthKey },
        });
      }
      req.usage = { usedToday, usedMonth, dateKey, monthKey };
      return next();
    } catch (err) {
      console.error("quotaGuard error", err);
      return res.status(500).json({ error: "internal_error", message: "ระบบขัดข้อง" });
    }
  };
}

async function bumpUsage(userId) {
  const dateKey = thaiDateKey();
  const monthKey = thaiMonthKey();

  await incDaily(userId, dateKey);
  await incMonthly(userId, monthKey);

  const usedToday = await getDailyCount(userId, dateKey);
  const usedMonth = await getMonthlyCount(userId, monthKey);

  return { usedToday, usedMonth, dateKey, monthKey };
}

// ---------- GEMINI ----------
// =============================
// Gemini (Text) - REST client (supports v1 + v1beta) with model fallback
// =============================
function normalizeGeminiModelName(name) {
  if (!name) return "";
  let s = String(name).trim();
  if (s.startsWith("models/")) s = s.slice("models/".length);
  if (s.includes("/")) s = s.split("/").pop();
  return s;
}

function uniqueNonEmpty(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const v = (x || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isUpstreamRateLimited(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 429) return true;
  const msg = String(err?.message || "");
  return /rate limit|too many requests|quota/i.test(msg);
}

function isModelNotFound(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 404) return true;
  const msg = String(err?.message || "");
  return /model.*not found/i.test(msg) || /404\s+not found/i.test(msg);
}

async function callGeminiGenerateContent({ prompt, temperature = 0.6, maxOutputTokens = 1024, responseMimeType }) {
  if (!GEMINI_API_KEY) {
    const err = new Error("Missing GEMINI_API_KEY");
    err.status = 500;
    throw err;
  }

  const envModel = normalizeGeminiModelName(process.env.GEMINI_MODEL || "");
  const modelCandidates = uniqueNonEmpty([
    envModel,
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
  ]);

  const apiVersions = ["v1", "v1beta"];

  let lastError = null;

  for (const apiVersion of apiVersions) {
    for (const model of modelCandidates) {
      const url =
        `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: Object.assign({ temperature, maxOutputTokens }, responseMimeType ? { responseMimeType } : {}),
          }),
        });

        if (resp.status === 429) {
          const err = new Error("Gemini rate limited (429)");
          err.status = 429;
          err.body = await resp.text().catch(() => "");
          throw err;
        }

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          const err = new Error(`Gemini HTTP ${resp.status} (${apiVersion}/${model})`);
          err.status = resp.status;
          err.body = body;
          lastError = err;
          continue;
        }

        const data = await resp.json();

        const textOut =
          data?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join("\n") ||
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          "";

        if (!textOut) {
          const err = new Error(`Gemini empty response (${apiVersion}/${model})`);
          err.status = 502;
          err.body = JSON.stringify(data).slice(0, 2000);
          lastError = err;
          continue;
        }

        return { text: textOut, modelUsed: model, apiVersion };
      } catch (e) {
        lastError = e;
        if (e?.status === 429) throw e;
      }
    }
  }

  const err = lastError || new Error("Gemini request failed");
  err.status = err.status || 502;
  throw err;
}

app.post("/api/gemini-text", authRequired, hydrateUserPlan, quotaGuard(), async (req, res) => {
  try {
    const { prompt, responseMimeType } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt_required" });

    const { text: aiText, modelUsed, apiVersion } = await callGeminiGenerateContent({
      prompt: String(prompt),
      temperature: 0.6,
      maxOutputTokens: 1024,
    });

    const usage = await bumpUsage(req.user.id);
    return res.json({ text: aiText, modelUsed, apiVersion, usage });
  } catch (err) {
    console.error("gemini-text error", err?.body || err);
    if (err?.status === 429 || isUpstreamRateLimited(err)) {
      return res.status(429).json({ error: "rate_limited", message: "ระบบกำลังหนาแน่น กรุณาลองใหม่อีกครั้ง" });
    }
    return res.status(500).json({ error: "gemini_error", message: "ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง" });
  }
});



// ---------- AUTH ROUTES (email+password -> JWT) ----------
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
// ---------- PADDLE CHECKOUT ----------
const PRICE_TO_PLAN = {
  [PADDLE_BASIC_PRICE_ID]: "basic",
  [PADDLE_PRO_PRICE_ID]: "pro",
};

function paddleApiBase() {
  return PADDLE_ENV === "live" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}

app.post("/api/paddle/create-checkout", authRequired, hydrateUserPlan, async (req, res) => {
  try {
    const { priceId } = req.body || {};
    if (!priceId) return res.status(400).json({ error: "priceId_required" });

    const plan = PRICE_TO_PLAN[priceId];
    if (!plan) return res.status(400).json({ error: "unknown_price_id" });

    if (!PADDLE_API_KEY) return res.status(500).json({ error: "paddle_not_configured" });

    const body = {
      items: [{ price_id: priceId, quantity: 1 }],
      customer: { email: req.user.email },
      metadata: { user_id: req.user.id, requested_plan: plan },
      success_url: CHECKOUT_SUCCESS_URL,
      cancel_url: CHECKOUT_CANCEL_URL,
    };

    const resp = await axios.post(`${paddleApiBase()}/checkout/sessions`, body, {
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const session = resp.data?.data || resp.data;
    const checkoutUrl = session?.checkout_url;

    if (!checkoutUrl) {
      console.error("Paddle session missing checkout_url", resp.data);
      return res.status(500).json({ error: "paddle_error", message: "สร้าง checkout ไม่สำเร็จ" });
    }

    return res.json({ sessionId: session?.id, checkoutUrl, plan });
  } catch (err) {
    console.error("create-checkout error", err?.response?.data || err);
    return res.status(500).json({ error: "paddle_error", message: "Paddle error" });
  }
});

// ---------- PADDLE WEBHOOK (raw body + signature verify) ----------
function verifyPaddleSignature(req) {
  try {
    if (!PADDLE_WEBHOOK_SECRET) return true; // allow in dev
    const sig = req.get("paddle-signature") || req.get("Paddle-Signature");
    if (!sig) return false;

    const parts = Object.fromEntries(
      sig.split(",").map((kv) => kv.trim().split("=").map((x) => x.trim()))
    );
    const ts = parts.ts;
    const h1 = parts.h1;
    if (!ts || !h1) return false;

    const raw = req.body; // Buffer
    const payload = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const computed = crypto
      .createHmac("sha256", PADDLE_WEBHOOK_SECRET)
      .update(`${ts}:${payload}`)
      .digest("hex");

    const a = Buffer.from(computed, "utf8");
    const b = Buffer.from(h1, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    console.error("verify signature error", e);
    return false;
  }
}

app.post("/api/paddle/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    if (!verifyPaddleSignature(req)) {
      return res.status(401).send("invalid signature");
    }

    const json = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body));
    const type = json.event_type || json.type;

    console.log("Paddle webhook:", type);

    const data = json.data || {};
    const customerEmail =
      data.customer?.email ||
      data.customer_email ||
      data?.checkout?.customer?.email;

    const email = customerEmail ? String(customerEmail).toLowerCase() : null;

    const subscriptionId = data.id || data.subscription_id || data.subscription?.id || null;
    const customerId = data.customer?.id || data.customer_id || null;

    const priceId =
      data.items?.[0]?.price?.id ||
      data.items?.[0]?.price_id ||
      data?.transaction?.items?.[0]?.price?.id ||
      data?.transaction?.items?.[0]?.price_id ||
      null;

    const plan = priceId ? PRICE_TO_PLAN[priceId] : null;

    const isActive =
      type === "subscription.activated" ||
      type === "subscription.created" ||
      type === "subscription.updated" ||
      type === "transaction.completed";

    const isCanceled =
      type === "subscription.canceled" ||
      type === "subscription.cancelled" ||
      type === "subscription.paused" ||
      type === "subscription.payment_failed";

    if (email && isActive && plan) {
      const { error } = await supabase
        .from("users")
        .upsert(
          {
            email,
            plan,
            paddle_customer_id: customerId,
            paddle_subscription_id: subscriptionId,
          },
          { onConflict: "email" }
        );
      if (error) console.error("supabase webhook upsert error", error);
      else console.log("✅ User upgraded:", email, "->", plan);
    }

    if (email && isCanceled) {
      const { error } = await supabase
        .from("users")
        .upsert(
          {
            email,
            plan: "free",
            paddle_customer_id: customerId,
            paddle_subscription_id: subscriptionId,
          },
          { onConflict: "email" }
        );
      if (error) console.error("supabase webhook cancel error", error);
      else console.log("↩️ User downgraded:", email, "-> free");
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("webhook error", err);
    return res.status(500).send("error");
  }
});

// ---------- START ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});