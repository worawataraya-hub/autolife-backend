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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
app.use(cors());
app.use(express.json({ limit: "2mb" })); // for normal JSON routes

// ---------- SUPABASE ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Usage table column compatibility (older DB might use 'date'/'month' instead of 'date_key'/'month_key') ---
let DAILY_KEY_COL = process.env.DAILY_KEY_COL || 'date_key';
let MONTH_KEY_COL = process.env.MONTH_KEY_COL || 'month_key';
let _usageColsProbed = false;

async function probeUsageColumns() {
  if (_usageColsProbed) return;
  _usageColsProbed = true;

  // Probe daily
  try {
    const probeVal = '1900-01-01';
    const { error } = await supabase
      .from('usage_daily')
      .select('count')
      .eq('user_id', 'probe')
      .eq(DAILY_KEY_COL, probeVal)
      .limit(1);

    if (error && error.code === '42703' && String(error.message || '').includes('date_key')) {
      DAILY_KEY_COL = 'date';
      console.warn('[probe] usage_daily missing date_key; falling back to column: date');
    } else if (error && error.code === '42703') {
      // generic missing column
      console.warn('[probe] usage_daily column probe error:', error);
    }
  } catch (e) {
    console.warn('[probe] usage_daily probe exception:', e?.message || e);
  }

  // Probe monthly
  try {
    const probeVal = '1900-01';
    const { error } = await supabase
      .from('usage_monthly')
      .select('count')
      .eq('user_id', 'probe')
      .eq(MONTH_KEY_COL, probeVal)
      .limit(1);

    if (error && error.code === '42703' && String(error.message || '').includes('month_key')) {
      MONTH_KEY_COL = 'month';
      console.warn('[probe] usage_monthly missing month_key; falling back to column: month');
    } else if (error && error.code === '42703') {
      console.warn('[probe] usage_monthly column probe error:', error);
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
    .select('count')
    .eq('user_id', userId)
    .eq(DAILY_KEY_COL, dateKey)
    .maybeSingle();

  if (error) throw error;
  return data?.count ?? 0;
}


async function getMonthlyCount(userId, monthKey) {
  await probeUsageColumns();
  const { data, error } = await supabase
    .from('usage_monthly')
    .select('count')
    .eq('user_id', userId)
    .eq(MONTH_KEY_COL, monthKey)
    .maybeSingle();

  if (error) throw error;
  return data?.count ?? 0;
}


async function incDaily(userId, dateKey) {
  await probeUsageColumns();

  const { data: existing, error: selErr } = await supabase
    .from('usage_daily')
    .select('count')
    .eq('user_id', userId)
    .eq(DAILY_KEY_COL, dateKey)
    .maybeSingle();

  if (selErr) throw selErr;

  const next = (existing?.count ?? 0) + 1;

  const payload = { user_id: userId, count: next, [DAILY_KEY_COL]: dateKey };
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
    .select('count')
    .eq('user_id', userId)
    .eq(MONTH_KEY_COL, monthKey)
    .maybeSingle();

  if (selErr) throw selErr;

  const next = (existing?.count ?? 0) + 1;

  const payload = { user_id: userId, count: next, [MONTH_KEY_COL]: monthKey };
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
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

function isUpstreamRateLimited(err) {
  const status = err?.response?.status;
  if (status === 429 || status === 503) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("429") || msg.includes("rate") || msg.includes("quota") || msg.includes("resource has been exhausted");
}

// ---------- ROUTES ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "AutoLife backend", env: PADDLE_ENV });
});

// --- AUTH ---
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });

    const normalizedEmail = String(email).trim().toLowerCase();

    const { data: existing, error: exErr } = await supabase
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();
    if (exErr) throw exErr;
    if (existing) return res.status(409).json({ error: "email_already_registered" });

    const password_hash = await bcrypt.hash(password, 10);
    const { data: newUser, error: insErr } = await supabase
      .from("users")
      .insert({ email: normalizedEmail, password_hash, plan: "free" })
      .select()
      .single();
    if (insErr) throw insErr;

    const token = signToken(newUser);
    return res.json({ token, user: { id: newUser.id, email: newUser.email, plan: newUser.plan } });
  } catch (err) {
    console.error("register error", err);
    return res.status(500).json({ error: "internal_error", message: "ระบบขัดข้อง" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });

    const normalizedEmail = String(email).trim().toLowerCase();
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", normalizedEmail)
      .single();

    if (error || !user) return res.status(401).json({ error: "invalid_credentials", message: "อีเมล/รหัสผ่านไม่ถูกต้อง" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "invalid_credentials", message: "อีเมล/รหัสผ่านไม่ถูกต้อง" });

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error("login error", err);
    return res.status(500).json({ error: "internal_error", message: "ระบบขัดข้อง" });
  }
});

app.get("/api/me", authRequired, hydrateUserPlan, async (req, res) => {
  try {
    const { id } = req.user;
    const { data: user, error } = await supabase
      .from("users")
      .select("id,email,plan,created_at,paddle_customer_id,paddle_subscription_id")
      .eq("id", id)
      .single();
    if (error || !user) return res.status(404).json({ error: "user_not_found" });

    const usage = await (async () => {
      const dateKey = thaiDateKey();
      const monthKey = thaiMonthKey();
      const usedToday = await getDailyCount(user.id, dateKey);
      const usedMonth = await getMonthlyCount(user.id, monthKey);
      return { usedToday, usedMonth, dateKey, monthKey };
    })();

    return res.json({ user, usage });
  } catch (err) {
    console.error("/api/me error", err);
    return res.status(500).json({ error: "internal_error", message: "ระบบขัดข้อง" });
  }
});

// --- GEMINI TEXT ---
app.post("/api/gemini-text", authRequired, hydrateUserPlan, quotaGuard(), async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt_required" });

    const result = await geminiModel.generateContent(String(prompt));
    const response = await result.response;
    const text = response.text();

    const usage = await bumpUsage(req.user.id);
    return res.json({ text, usage });
  } catch (err) {
    console.error("gemini-text error", err?.response?.data || err);
    if (isUpstreamRateLimited(err)) {
      return res.status(429).json({ error: "busy", message: "ระบบกำลังหนาแน่น (429) กรุณาลองใหม่อีกครั้ง" });
    }
    return res.status(500).json({ error: "internal_error", message: "ระบบขัดข้อง" });
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
