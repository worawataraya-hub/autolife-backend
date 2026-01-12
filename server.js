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
// ---------- OBSERVABILITY / UTILITIES (v42) ----------
function makeRequestId() {
  try {
    return (crypto && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
  } catch (_) {
    return (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
  }
}
function truncateLog(str, max = 700) {
  if (str === undefined || str === null) return "";
  const s = String(str);
  return s.length > max ? (s.slice(0, max) + "…(truncated)") : s;
}

// Simple in-memory cache (good enough for Render single instance; swap to Redis later)
const _memCache = new Map(); // key -> { exp:number, value:any }
function cacheGet(key) {
  const v = _memCache.get(key);
  if (!v) return null;
  if (v.exp && Date.now() > v.exp) {
    _memCache.delete(key);
    return null;
  }
  return v.value;
}
function cacheSet(key, value, ttlMs) {
  _memCache.set(key, { exp: ttlMs ? (Date.now() + ttlMs) : 0, value });
}

// Simple per-IP rate limiter (no deps)
const _rateState = new Map(); // ip -> { reset:number, count:number }
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const ipRaw = req.headers["x-forwarded-for"];
    const ip = (typeof ipRaw === "string" && ipRaw.length)
      ? ipRaw.split(",")[0].trim()
      : (req.ip || "unknown");
    const now = Date.now();
    let s = _rateState.get(ip);
    if (!s || now > s.reset) {
      s = { reset: now + windowMs, count: 0 };
      _rateState.set(ip, s);
    }
    s.count += 1;

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - s.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(s.reset / 1000)));

    if (s.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((s.reset - now) / 1000)));
      return res.status(429).json({
        ok: false,
        error: "Rate limit exceeded",
        requestId: req.requestId || null
      });
    }
    return next();
  };
}
const aiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30 });
// ---------- /OBSERVABILITY / UTILITIES ----------


// ---------- ENV ----------
const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET = process.env.JWT_SECRET || "change-me";

const PADDLE_ENV = (process.env.PADDLE_ENV || "sandbox").toLowerCase(); // sandbox | live
const PADDLE_API_KEY = (process.env.PADDLE_API_KEY || "").trim();
const PADDLE_WEBHOOK_SECRET = (process.env.PADDLE_WEBHOOK_SECRET || "").trim();

const PADDLE_BASIC_PRICE_ID = (process.env.PADDLE_BASIC_PRICE_ID || "").trim();
const PADDLE_PRO_PRICE_ID = (process.env.PADDLE_PRO_PRICE_ID || "").trim();

const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL;
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL;
// ---------- Helpers ----------
function cleanHeaderValue(v) {
  // Remove all control characters and whitespace that can break Node's HTTP header validation.
  // (Render env vars sometimes include trailing newlines when pasted.)
  let s = String(v ?? "");
  // Strip "Bearer " if the user pasted a full auth header into the env var.
  s = s.replace(/^Bearer\s+/i, "");
  // Remove ASCII control chars + DEL
  s = s.replace(/[\u0000-\u001F\u007F]/g, "");
  // Remove all whitespace (keys shouldn't contain spaces/tabs/newlines)
  s = s.replace(/\s+/g, "");
  return s;
}

function sanitizeRedirectUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(String(raw));
    u.hash = "";
    return u.toString();
  } catch {
    return String(raw);
  }
}



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

// Trust proxy (Render/Netlify) so req.ip works correctly
app.set("trust proxy", 1);

// RequestId + latency log (one line start/end)
app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || makeRequestId();
  req.requestId = requestId;
  const t0 = Date.now();
  res.setHeader("X-Request-Id", requestId);

  console.log(JSON.stringify({
    t: "start",
    id: requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.headers["x-forwarded-for"] || req.ip || null
  }));

  res.on("finish", () => {
    console.log(JSON.stringify({
      t: "end",
      id: requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - t0
    }));
  });

  next();
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


// ---------- AI FALLBACK ----------
function buildFallbackText(prompt = "") {
  const p = String(prompt || "");
  const lower = p.toLowerCase();

  // Viral Finder style: request 10 trends / JSON
  if (lower.includes("trending") || lower.includes("viral finder") || lower.includes("trends")) {
    // Return a JSON string so the frontend parser can still work.
    const base = [
      "tiktoktrend","viral","fyp","trending","howto","review","unboxing","beforeafter","dayinmylife","storytime"
    ];
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    const trends = Array.from({length: 10}).map((_,i)=> {
      const tag = base[(i + now.getDate()) % base.length];
      return {
        rank: i+1,
        title: `${tag} (${stamp})`,
        hashtag: `#${tag}`,
        tiktok_url: `https://www.tiktok.com/tag/${tag}`,
        hook: `เปิดคลิปด้วยประโยคสั้น ๆ เกี่ยวกับ #${tag} ให้คนหยุดดู`,
        reason: ["สั้น กระชับ เข้าใจง่าย", "ชวนคอมเมนต์/แชร์", "ทำตามได้ทันที"],
        idea: `ทำคลิป 15–25 วิ แบบ before/after หรือสาธิตสั้น ๆ เกี่ยวกับ #${tag}`,
        prompt: `Thai TikTok thumbnail about #${tag}, clean bold typography, high contrast, cinematic lighting, shallow depth of field`
      };
    });
    return JSON.stringify({ source: "fallback", trends }, null, 2);
  }

  // Review Generator / generic text fallback
  return [
    "⚠️ ระบบ AI ตอบกลับไม่ทันในตอนนี้ (ใช้ข้อความสำรอง)",
    "",
    "โครงรีวิวสั้น (ปรับใช้ได้ทันที):",
    "1) เปิดด้วยปัญหาที่คนเจอ",
    "2) บอกผลลัพธ์หลังใช้/จุดเด่น 2–3 ข้อ",
    "3) วิธีใช้/ทริคสั้น ๆ",
    "4) ปิดด้วยคำถาม + CTA",
    "",
    "ถ้าต้องการแบบละเอียด ให้กดสร้างใหม่อีกครั้งนะครับ"
  ].join("\n");
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

// alias (older route code uses requireAuth)
const requireAuth = authRequired;

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
}

function nextThaiMidnightIso() {
  const dt = toBangkokDate(new Date());
  dt.setHours(24, 0, 0, 0); // next midnight in Bangkok "wall clock"
  return dt.toISOString();
}
function nextThaiMonthIso() {
  const dt = toBangkokDate(new Date());
  dt.setDate(1);
  dt.setHours(0, 0, 0, 0);
  dt.setMonth(dt.getMonth() + 1); // first day next month 00:00 Bangkok
  return dt.toISOString();
}
function usageSummary(plan, usage) {
  const p = String(plan || "free").toLowerCase();
  const u = usage || {};
  const usedToday = Number(u.usedToday || 0);
  const usedMonth = Number(u.usedMonth || 0);

  if (p === "pro") {
    return {
      plan: "pro",
      window: "unlimited",
      limit: null,
      used: null,
      remaining: null,
      resetAt: null
    };
  }
  if (p === "basic") {
    const limit = LIMITS.basicMonthly;
    const remaining = Math.max(0, limit - usedMonth);
    return {
      plan: "basic",
      window: "monthly",
      limit,
      used: usedMonth,
      remaining,
      resetAt: nextThaiMonthIso()
    };
  }
  // default FREE
  const limit = LIMITS.freeDaily;
  const remaining = Math.max(0, limit - usedToday);
  return {
    plan: "free",
    window: "daily",
    limit,
    used: usedToday,
    remaining,
    resetAt: nextThaiMidnightIso()
  };
}
;

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
          const usage = { usedToday, usedMonth, dateKey, monthKey };
          return res.status(402).json({
            error: "quota_exceeded",
            message: `ใช้โควตาครบแล้ว (${LIMITS.freeDaily} ครั้ง/วัน) กรุณาอัปเกรดแพ็กเกจ`,
            plan,
            usage,
            usageSummary: usageSummary(plan, usage),
            requestId: req.requestId || null
          });
        }
        req.usage = { usedToday, usedMonth, dateKey, monthKey };
        return next();
      }

      // BASIC: 300/month
      if (plan === "basic") {
        if (usedMonth >= LIMITS.basicMonthly) {
          const usage = { usedToday, usedMonth, dateKey, monthKey };
          return res.status(402).json({
            error: "quota_exceeded",
            message: `ใช้โควตาครบแล้ว (${LIMITS.basicMonthly} ครั้ง/เดือน) กรุณาอัปเกรดแพ็กเกจ`,
            plan,
            usage,
            usageSummary: usageSummary(plan, usage),
            requestId: req.requestId || null
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

// ------------------------
// Backend JSON normalization helpers
// ------------------------

function stripCodeFences(s = "") {
  const t = String(s || "").trim();
  // Remove markdown code fences if the model returns them.
  if (t.startsWith("```")) {
    return t
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }
  return t;
}

function extractFirstJsonBlob(text) {
  const s = stripCodeFences(text);
  // Try to find a JSON object/array in a larger string.
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");
  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  if (start === -1) return null;

  // Walk and balance braces/brackets.
  const opening = s[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === opening) depth++;
    if (ch === closing) depth--;
    if (depth === 0) {
      return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJson(text) {
  const blob = extractFirstJsonBlob(text);
  if (!blob) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(blob) };
  } catch {
    return { ok: false, value: null };
  }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return undefined;
}

function normalizeTrendItem(raw, idx) {
  // Models sometimes return arrays of strings like:
  //   { trends: ["เทรนด์ A", "เทรนด์ B", ...] }
  // Support that by treating string items as the title.
  const isStringItem = typeof raw === "string";
  const r = raw && typeof raw === "object" ? raw : {};
  const title = String(
    (isStringItem ? raw : pickFirst(r, ["title", "trend", "topic", "headline", "name"])) || `Trending #${idx + 1}`
  ).trim();
  const tiktokUrl = String(pickFirst(r, ["tiktokUrl", "url", "link", "tiktok", "openTikTokUrl"]) || "").trim();
  const hook = String(pickFirst(r, ["hook", "theHook", "hook_th", "hook_thai"]) || "").trim();
  const whyViral = String(pickFirst(r, ["why_viral", "whyViral", "analysis", "reason", "why", "whyItsViral"]) || "").trim();
  const contentIdea = String(pickFirst(r, ["contentIdea", "idea", "content", "concept", "howTo", "recommendation"]) || "").trim();
  const imagePrompt = String(pickFirst(r, ["imagePrompt", "prompt", "thumbnailPrompt", "midjourneyPrompt"]) || "").trim();

  return {
    id: idx + 1,
    title,
    tiktokUrl,
    hook,
    why_viral: whyViral,
    contentIdea,
    imagePrompt,
  };
}

function normalizeTrendsPayload(parsed) {
  // Goal: always return { trends: [10 items] } even when the model returns odd JSON shapes.
  // Accept many variants:
  // - {trends:[...]} / {items:[...]} / {results:[...]} / {data:[...]} / {top10:[...]}
  // - {trends:{1:{...},2:{...}}}  (object)
  // - {trend1:{...}, trend2:{...}} or {"1":{...},"2":{...}}
  // - nested containers like {data:{trends:[...]}} or {output:{items:[...]}}
  let list = [];

  const asListFromMaybe = (maybe) => {
    if (!maybe) return null;
    if (Array.isArray(maybe)) return maybe;
    if (typeof maybe === "object") return Object.values(maybe);
    return null;
  };

  const dig = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 2) return null;
    const directKeys = [
      "trends", "items", "results", "data", "top10", "topTrends", "trending", "topics", "trendList", "list",
      // common alternates
      "trend_titles", "trendTitles", "trend_names", "trendNames", "trends_1_10", "trends1to10"
    ];
    for (const k of directKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        const got = asListFromMaybe(obj[k]);
        if (got && got.length) return got;
      }
    }
    // If object has keys trend1..trend10 or 1..10, collect in order
    const keys = Object.keys(obj);
    const numeric = keys.filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
    const trendN = keys.filter(k => /^trend\d+$/i.test(k)).sort((a,b)=>Number(a.replace(/\D/g,''))-Number(b.replace(/\D/g,'')));
    if (numeric.length) return numeric.map(k => obj[k]);
    if (trendN.length) return trendN.map(k => obj[k]);
    // Otherwise try one-level nested objects
    for (const k of keys) {
      const child = obj[k];
      const got = dig(child, depth + 1);
      if (got && got.length) return got;
    }
    return null;
  };

  if (Array.isArray(parsed)) list = parsed;
  else list = dig(parsed) || [];

  const slice = list.slice(0, 10);
  const normalized = slice.map((t, i) => normalizeTrendItem(t, i));
  const extractedCount = normalized.filter((it, i) => it.title && it.title !== `Trending #${i + 1}`).length;

  // If fewer than 10, pad with safe placeholders so UI never breaks.
  while (normalized.length < 10) {
    normalized.push(normalizeTrendItem({}, normalized.length));
  }

  return { trends: normalized, _extractedCount: extractedCount };
}


// ------------------------------
// Review JSON "Lock" helpers (v41 production hardened)
// ------------------------------
function normalizeString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  return String(v).trim();
}

function normalizeStringArray(v) {
  if (Array.isArray(v)) return v.map(normalizeString).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(/\r?\n|•|\u2022|\-|\*|\d+\)|\d+\.|\u25CF/g)
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeReviewPayload(obj) {
  const o = (obj && typeof obj === 'object') ? obj : {};
  let script30s = normalizeString(o.script30s ?? o.script ?? o.script_30s ?? o['30sScript'] ?? o.text ?? o.output ?? '');
  let pov = normalizeString(o.pov ?? o.POV ?? o.concept ?? o['pov_concept'] ?? '');
  let hooks = normalizeStringArray(o.hooks ?? o.Hooks ?? o.hook ?? o.hookList ?? []);
  let values = normalizeStringArray(o.values ?? o.Values ?? o.value ?? o.valueList ?? []);
  let ctas = normalizeStringArray(o.ctas ?? o.CTAs ?? o.cta ?? o.ctaList ?? []);

  // Enforce lengths
  if (hooks.length > 5) hooks = hooks.slice(0, 5);
  if (values.length > 3) values = values.slice(0, 3);
  if (ctas.length > 3) ctas = ctas.slice(0, 3);
  while (hooks.length < 5) hooks.push('');
  while (values.length < 3) values.push('');
  while (ctas.length < 3) ctas.push('');

  // If script is missing but we have other text fields, fallback
  if (!script30s) script30s = normalizeString(o.raw ?? o.result ?? '');

  return { script30s, pov, hooks, values, ctas };
}

function validateReviewPayload(payload) {
  const p = payload || {};
  const errs = [];
  if (!p || typeof p !== 'object') errs.push('payload_not_object');
  if (!normalizeString(p.script30s)) errs.push('missing_script30s');
  if (!Array.isArray(p.hooks) || p.hooks.length !== 5) errs.push('hooks_not_5');
  if (!Array.isArray(p.values) || p.values.length !== 3) errs.push('values_not_3');
  if (!Array.isArray(p.ctas) || p.ctas.length !== 3) errs.push('ctas_not_3');
  return { ok: errs.length === 0, errors: errs };
}

const REVIEW_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    script30s: { type: "string" },
    pov: { type: "string" },
    hooks: { type: "array", items: { type: "string" }, minItems: 5, maxItems: 5 },
    values: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    ctas: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 }
  },
  required: ["script30s", "pov", "hooks", "values", "ctas"]
};

async function generateLockedReviewJson(model, basePrompt, options = {}) {
  // Two-layer hardening:
  // 1) Ask model for strict JSON (application/json + schema)
  // 2) Validate; if invalid, repair with a second call; if still invalid, return normalized best-effort object
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.6;
  const maxOutputTokens = typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : 1200;

  const generationConfig = {
    temperature,
    maxOutputTokens,
    responseMimeType: "application/json",
    responseSchema: REVIEW_RESPONSE_SCHEMA
  };

  const strictPrompt = [
    "OUTPUT MUST BE VALID JSON ONLY.",
    "No markdown fences. No extra keys.",
    "Schema: {script30s:string, pov:string, hooks:[5 strings], values:[3 strings], ctas:[3 strings]}",
    "",
    basePrompt
  ].join("\n");

  let text1 = '';
  try {
    const r1 = await model.generateContent({ contents: [{ role: "user", parts: [{ text: strictPrompt }] }], generationConfig });
    text1 = (r1?.response?.text?.() || '').trim();
  } catch (e) {
    // fall through to repair/normalize
    text1 = '';
  }

  let parsed1 = tryParseJson(text1);
  if (parsed1.ok) {
    const norm = normalizeReviewPayload(parsed1.value);
    const v = validateReviewPayload(norm);
    if (v.ok) return { ok: true, json: norm, rawText: text1, repaired: false };
  }

  // Repair attempt: send original output and ask to fix
  const repairPrompt = [
    "You returned INVALID JSON. Fix it.",
    "Return ONLY valid JSON matching the schema exactly.",
    "No markdown fences. No explanations.",
    "",
    "INVALID_OUTPUT:",
    text1 ? text1.slice(0, 6000) : "(empty)"
  ].join("\n");

  let text2 = '';
  try {
    const r2 = await model.generateContent({ contents: [{ role: "user", parts: [{ text: repairPrompt }] }], generationConfig });
    text2 = (r2?.response?.text?.() || '').trim();
  } catch (e) {
    text2 = '';
  }

  let parsed2 = tryParseJson(text2);
  if (parsed2.ok) {
    const norm = normalizeReviewPayload(parsed2.value);
    const v = validateReviewPayload(norm);
    if (v.ok) return { ok: true, json: norm, rawText: text2, repaired: true };
  }

  // Final fallback: best-effort normalization (never crash the frontend)
  const fallbackObj = normalizeReviewPayload(parsed1.ok ? parsed1.value : {});
  if (!fallbackObj.script30s) fallbackObj.script30s = normalizeString(text1 || text2 || basePrompt);
  const v3 = validateReviewPayload(fallbackObj);
  return { ok: v3.ok, json: fallbackObj, rawText: text1 || text2, repaired: true, fallback: true, errors: v3.errors };
}



// --- TikTok Creative Center trend seed (best-effort, no official API) ---
async function fetchTikTokCreativeCenterHashtags({ countryCode = "TH" } = {}) {
  // Creative Center URLs change; try multiple. We only need hashtag names (top list).
  const urls = [
    `https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?countryCode=${countryCode}`,
    `https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=${countryCode}`,
    `https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?regionCode=${countryCode}`,
    `https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en`,
  ];

  const tryFetch = async (u) => {
    const resp = await fetch(u, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; AutoLifeBot/1.0; +https://autolife-ai.netlify.app/)",
        "accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`creative_center_http_${resp.status}`);
    return await resp.text();
  };

  let html = null;
  let lastErr = null;
  for (const u of urls) {
    try {
      html = await tryFetch(u);
      if (html && html.includes("__NEXT_DATA__")) break;
    } catch (e) { lastErr = e; }
  }
  if (!html) throw lastErr || new Error("creative_center_fetch_failed");

  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error("creative_center_next_data_not_found");
  const nextDataText = m[1].trim();
  const nextData = JSON.parse(nextDataText);

  // Walk the JSON and collect hashtag-like strings.
  const tags = new Map(); // tag -> score (best-effort)
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        const s = v.trim();
        if (!s) continue;
        // Candidate hashtag
        if (s.startsWith("#") && s.length >= 3 && s.length <= 60) {
          const t = s;
          if (!seen.has(t)) { seen.add(t); tags.set(t, 0); }
        }
      } else if (typeof v === "number") {
        // Try to use numbers near hashtag names as a score (views / popularity)
        // We'll handle in the object case below where both name and count exist.
      } else if (v && typeof v === "object") {
        // if object contains name/title and some count field, capture score
        const maybeName = (typeof v.name === "string" && v.name.trim()) ? v.name.trim()
          : (typeof v.hashtagName === "string" && v.hashtagName.trim()) ? v.hashtagName.trim()
          : (typeof v.title === "string" && v.title.trim()) ? v.title.trim()
          : null;

        const maybeCount = (typeof v.viewCount === "number") ? v.viewCount
          : (typeof v.views === "number") ? v.views
          : (typeof v.playCount === "number") ? v.playCount
          : (typeof v.count === "number") ? v.count
          : null;

        if (maybeName && (maybeName.startsWith("#") || k.toLowerCase().includes("hashtag"))) {
          const tag = maybeName.startsWith("#") ? maybeName : `#${maybeName}`;
          const prev = tags.get(tag) || 0;
          const score = (typeof maybeCount === "number" && isFinite(maybeCount)) ? maybeCount : 0;
          if (!seen.has(tag)) seen.add(tag);
          tags.set(tag, Math.max(prev, score));
        }

        walk(v);
      }
    }
  };
  walk(nextData);

  // Sort by score desc then alphabetically (stable).
  const sorted = Array.from(tags.entries())
    .map(([tag, score]) => ({ tag, score: Number(score) || 0 }))
    .sort((a, b) => (b.score - a.score) || a.tag.localeCompare(b.tag));

  // Deduplicate and take top 20 seeds.
  const seeds = [];
  for (const it of sorted) {
    const t = it.tag;
    if (!t || seeds.includes(t)) continue;
    seeds.push(t);
    if (seeds.length >= 20) break;
  }
  return seeds;
}

function buildTikTokHashtagUrl(tag) {
  const clean = String(tag || "").replace(/^#/, "").trim();
  if (!clean) return "";
  return `https://www.tiktok.com/tag/${encodeURIComponent(clean)}`;
}

function buildViralFinderPrompt({ categoryLabel, countryCode, seeds }) {
  const today = new Date().toISOString().slice(0, 10);
  const seedBlock = (Array.isArray(seeds) && seeds.length)
    ? seeds.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "";

  return `You are "AI Viral Finder".
Task: Find REAL TikTok Thailand trends and analyze them in 4 dimensions (Hook, Why Viral, Idea, Prompt).
Date: ${today}
Country: ${countryCode || "TH"}
Category: ${categoryLabel || "Daily Hot"}

If seed hashtags are provided below, they come from TikTok Creative Center and MUST be used as the base of your trends.
If seeds are empty, you must still output plausible, distinct, current Thai TikTok trends (no placeholders like "Trending #1").

Seed Hashtags (use as base topics):
${seedBlock || "(none)"}

Return ONLY valid JSON. No markdown.

Output schema (EXACT):
{
  "trends": [
    {
      "rank": number,
      "title": string,
      "hook": string,
      "why_viral": string,
      "contentIdea": string,
      "imagePrompt": string,
      "tiktokUrl": string
    }
  ]
}

Rules:
- Return EXACTLY 10 items, rank 1..10 (no gaps, no duplicates).
- Titles MUST be unique and specific (Thai language ok).
- Every string field MUST be non-empty EXCEPT "tiktokUrl" (can be empty if unknown).
- "tiktokUrl" should be a direct TikTok tag URL if possible.
- "imagePrompt" should be a short Thai TikTok thumbnail / cover prompt.
`;
}


function looksLikeTrendsPayload(obj) {
  return !!(obj && typeof obj === "object" && Array.isArray(obj.trends));
}


// Compatibility wrapper: older routes call `callGemini(...)`
// but the implementation is `callGeminiGenerateContent(...)`.
async function callGemini(arg, extra = {}) {
  // Supports: callGemini({prompt, ...}) OR callGemini("prompt", {...})
  if (typeof arg === 'string') {
    return await callGeminiGenerateContent({ prompt: arg, ...extra });
  }
  if (arg && typeof arg === 'object') {
    return await callGeminiGenerateContent(arg);
  }
  throw new Error('callGemini: invalid arguments');
}

app.post('/api/gemini-text', async (req, res) => {
  const requestId = crypto.randomUUID();

  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const user = String(meta.user || body.user || 'anonymous');
    const plan = String(meta.plan || body.plan || 'free');

    const wantsTrends = !!(
      body.forceTrends ||
      body.wantsTrends ||
      (meta && (meta.forceTrends || meta.wantsTrends)) ||
      body.viralCategory ||
      body.category ||
      (meta && (meta.viralCategory || meta.category))
    );

    const viralCategory = String(
      body.viralCategory ||
      body.category ||
      (meta && (meta.viralCategory || meta.category)) ||
      'Daily Hot'
    );

    // Cache: trends are cached by category; plain text by (user + prompt prefix)
    const cacheKey = wantsTrends
      ? `gemini:trends:${viralCategory}`
      : `gemini:text:${user}:${String(body.prompt || '').slice(0, 80)}`;

    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.json({
        ...cached,
        requestId,
        cached: true
      });
    }

    // Optional: seed from TikTok Creative Center
    let trendSeedSource = 'none';
    let trendSeedHashtags = [];
    if (wantsTrends) {
      try {
        const ccSeeds = await fetchTikTokCreativeCenterHashtags({ category: viralCategory });
        if (Array.isArray(ccSeeds) && ccSeeds.length) {
          trendSeedSource = 'tiktok_creative_center';
          trendSeedHashtags = ccSeeds.slice(0, 30);
        }
      } catch (e) {
        trendSeedSource = 'seed_error';
        trendSeedHashtags = [];
      }
    }

    // Build prompt
    let promptText = String(body.prompt || '').trim();
    if (wantsTrends) {
      promptText = buildViralFinderPrompt({
        categoryLabel: viralCategory,
        trendSeedHashtags
      });
    }

    if (!promptText) {
      return res.status(400).json({ error: 'Missing prompt', requestId });
    }

    const responseMimeType = body.responseMimeType
      ? String(body.responseMimeType)
      : (wantsTrends ? 'application/json' : 'text/plain');

    const { text, modelUsed } = await callGemini({
      prompt: promptText,
      responseMimeType: wantsTrends ? 'application/json' : responseMimeType,
      useSearch: !!body.useSearch,
      temperature: (typeof body.temperature === 'number') ? body.temperature : undefined,
      maxOutputTokens: (typeof body.maxOutputTokens === 'number') ? body.maxOutputTokens : undefined
    });

    // Usage tracking (best-effort; never fail the request)
    try { await bumpUsage(user); } catch (_) {}

    let payload = {
      requestId,
      modelUsed,
      cached: false,
      text
    };

    if (wantsTrends) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        // Try to salvage a JSON object embedded in text
        const m = String(text || '').match(/\{[\s\S]*\}$/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_) {}
        }
      }

      let trends = [];
      if (parsed && Array.isArray(parsed.trends)) {
        trends = parsed.trends.map(normalizeTrendItem);
      }

      // Fallback: build trends from seed hashtags if model output is missing
      if (!trends.length) {
        const seeds = (trendSeedHashtags && trendSeedHashtags.length)
          ? trendSeedHashtags
          : ['#tiktoktrend', '#viral', '#fyp', '#ทริคดีบอกต่อ', '#รีวิว'];

        trends = seeds.slice(0, 10).map((tag, i) => normalizeTrendItem({
          title: tag.replace(/^#/, '').trim() || `Trend ${i + 1}`,
          hook: `เปิดคลิปด้วยประโยคสั้น ๆ เกี่ยวกับ ${tag}`,
          why_viral: ['สั้น กระชับ เข้าใจง่าย', 'ชวนคอมเมนต์/แชร์', 'ทำตามได้ทันที'],
          contentIdea: `ทำคลิป 15–25 วิ อธิบาย ${tag} แบบ before/after`,
          imagePrompt: `Thai TikTok thumbnail about ${tag}, clean bold typography, high contrast, cinematic lighting, shallow depth of field`,
          tiktokUrl: ''
        }));
        trendSeedSource = trendSeedSource === 'none' ? 'fallback' : trendSeedSource;
      }

      // Ensure exactly 10 items
      while (trends.length < 10) {
        const n = trends.length + 1;
        trends.push(normalizeTrendItem({
          title: `Trend ${n}`,
          hook: `เปิดคลิปด้วยประโยคสั้น ๆ ที่ทำให้หยุดดู`,
          why_viral: ['เข้าใจง่าย', 'ชวนคอมเมนต์', 'ดูจบใน 10 วิ'],
          contentIdea: `สรุปทริค/รีวิว/ก่อน-หลัง ภายใน 20 วิ`,
          imagePrompt: `Thai TikTok thumbnail, clean bold typography, high contrast, cinematic lighting, shallow depth of field`,
          tiktokUrl: ''
        }));
      }
      trends = trends.slice(0, 10);

      payload = {
        ...payload,
        trends,
        trendSeedSource,
        trendSeedHashtags
      };
    }

    cacheSet(cacheKey, payload, wantsTrends ? 60 : 30); // seconds
    return res.json(payload);
  } catch (err) {
    console.error('gemini-text error', err);
    return res.status(500).json({
      error: (err && err.message) ? err.message : 'Internal Server Error',
      requestId
    });
  }
});
app.post("/api/logUsage", async (req, res) => {
  try {
    // Keep compatible with the old Netlify function signature
    const { user, action, meta } = req.body || {};
    console.log("[logUsage]", { user, action, meta });
    return res.json({ ok: true });
  } catch (err) {
    console.error("logUsage error:", err);
    return res.status(500).json({ ok: false });
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

function normalizePaddleApiBase(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw).trim());
    // Disallow dashboard/vendor URLs - the API is api.paddle.com or sandbox-api.paddle.com
    const host = u.hostname.toLowerCase();
    if (host.includes("vendors.paddle.com") || host.includes("paddle.com/notifications")) return null;
    // Keep only origin (no path/query)
    return u.origin.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function paddleApiBase() {
  // Allow explicit override but normalize to an origin (https://api.paddle.com OR https://sandbox-api.paddle.com)
  const explicit = normalizePaddleApiBase(process.env.PADDLE_API_BASE || process.env.PADDLE_API_BASE_URL);

  const envRaw = cleanHeaderValue(process.env.PADDLE_ENV || "").toLowerCase();
  const keyRaw = process.env.PADDLE_API_KEY || process.env.PADDLE_BILLING_API_KEY || "";
  const key = cleanHeaderValue(keyRaw).toLowerCase();

  // Infer sandbox vs live
  const looksLive = key.startsWith("live_") || key.includes("live_") || key.includes("pd_live");
  const wantsSandbox = envRaw.includes("sandbox") || envRaw.includes("test") || key.startsWith("sandbox_") || key.includes("sandbox_");

  const inferred = wantsSandbox || !looksLive
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";

  return explicit || inferred;
}




function normalizeRedirectUrl(url) {
  // Paddle rejects URLs with hash fragments (#...). Convert them to query param `paddle_return`.
  // Example: https://site.app/#pricing?success=1 -> https://site.app/?paddle_return=pricing%3Fsuccess%3D1
  if (!url || typeof url !== "string") return "";
  const raw = url.trim();
  if (!raw) return "";
  if (!raw.includes("#")) return raw;

  const [baseWithQuery, fragRaw = ""] = raw.split("#");
  const [baseNoQuery, baseQuery = ""] = baseWithQuery.split("?");
  const base = baseNoQuery.replace(/\/$/, "");

  const frag = fragRaw.replace(/^\//, ""); // drop leading "/"
  const qp = new URLSearchParams(baseQuery);
  if (frag) qp.set("paddle_return", frag);

  const qs = qp.toString();
  return qs ? `${base}/?${qs}` : `${base}/`;
}

function safeUrl(url, name) {
  try {
    return new URL(url).toString();
  } catch (e) {
    throw new Error(`Invalid ${name}: ${url}`);
  }
}

/**
 * Paddle sometimes rejects URLs with fragments (#...).
 * We keep the intended fragment by moving it into a query param `paddle_hash`,
 * then the frontend can restore location.hash if desired.
 */
function normalizeCheckoutUrlForPaddle(urlStr) {
  // Paddle validates these URLs and often rejects fragments (#...).
  // For hash routers like `/#pricing?success=1`, we:
  //   - move the hash route into `paddle_return`
  //   - merge any hash query (?a=1) into the real querystring
  //   - strip the fragment entirely
  const u = new URL(urlStr);

  if (u.hash && u.hash.length > 1) {
    const fragRaw = u.hash.slice(1); // remove '#'
    const [fragRoute, fragQuery] = fragRaw.split("?", 2);

    if (fragRoute) u.searchParams.set("paddle_return", fragRoute);

    if (fragQuery) {
      const qp = new URLSearchParams(fragQuery);
      for (const [k, v] of qp.entries()) u.searchParams.set(k, v);
    }
    u.hash = "";
  }

  return u.toString();
}


// ---------- USER / USAGE (Soft gate support) ----------
app.get("/api/user", authRequired, hydrateUserPlan, async (req, res) => {
  try {
    const userId = req.user.id;
    const plan = String(req.user.plan || "free").toLowerCase();
    const dateKey = thaiDateKey();
    const monthKey = thaiMonthKey();
    const usedToday = await getDailyCount(userId, dateKey);
    const usedMonth = await getMonthlyCount(userId, monthKey);
    const usage = { usedToday, usedMonth, dateKey, monthKey };
    return res.json({
      ok: true,
      user: { id: userId, email: req.user.email, plan },
      limits: LIMITS,
      usage,
      usageSummary: usageSummary(plan, usage),
      requestId: req.requestId || null
    });
  } catch (err) {
    console.error("GET /api/user error", err);
    return res.status(500).json({ ok: false, error: "internal_error", requestId: req.requestId || null });
  }
});

app.get("/api/usage", authRequired, hydrateUserPlan, async (req, res) => {
  try {
    const userId = req.user.id;
    const plan = String(req.user.plan || "free").toLowerCase();
    const dateKey = thaiDateKey();
    const monthKey = thaiMonthKey();
    const usedToday = await getDailyCount(userId, dateKey);
    const usedMonth = await getMonthlyCount(userId, monthKey);
    const usage = { usedToday, usedMonth, dateKey, monthKey };
    return res.json({
      ok: true,
      plan,
      limits: LIMITS,
      usage,
      usageSummary: usageSummary(plan, usage),
      requestId: req.requestId || null
    });
  } catch (err) {
    console.error("GET /api/usage error", err);
    return res.status(500).json({ ok: false, error: "internal_error", requestId: req.requestId || null });
  }
});
// ---------- /USER / USAGE ----------

app.post("/api/paddle/create-checkout", requireAuth, async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();

  try {
    const { plan } = req.body || {};
    const planKey = String(plan || "").toLowerCase();

    const userEmail = req.user?.email;
    if (!userEmail) return res.status(401).json({ error: "Not authenticated" });

    // -----------------------------
    // Validate plan -> priceId
    // -----------------------------
    const priceId =
      planKey === "basic"
        ? process.env.PADDLE_BASIC_PRICE_ID
        : planKey === "pro"
        ? process.env.PADDLE_PRO_PRICE_ID
        : null;

    if (!priceId) {
      return res.status(400).json({
        error: "Invalid plan",
        requestId,
        sent: { plan: planKey },
      });
    }

    // -----------------------------
    // Paddle config
    // -----------------------------
    const apiKeyRaw = process.env.PADDLE_API_KEY || process.env.PADDLE_BILLING_API_KEY || process.env.PADDLE_SECRET_KEY || "";
    const apiKey = cleanHeaderValue(apiKeyRaw);
    if (!apiKey) {
      return res.status(500).json({ error: "server_misconfigured", message: "Missing PADDLE_API_KEY (Paddle Billing API key) in backend environment." });
    }
    // PADDLE_ENV can be: "sandbox", "production", "live", "prod" etc.
    const envRaw = String(process.env.PADDLE_ENV || "").toLowerCase().trim();
    const isSandbox = envRaw.includes("sand");

    // Official bases:
    // - Live:    https://api.paddle.com
    // - Sandbox: https://sandbox-api.paddle.com
    // Allow override if user sets PADDLE_API_BASE_URL
    const apiBase =
      process.env.PADDLE_API_BASE_URL ||
      (isSandbox ? "https://sandbox-api.paddle.com" : "https://api.paddle.com");

    const successUrl = normalizeCheckoutUrlForPaddle(sanitizeRedirectUrl(process.env.CHECKOUT_SUCCESS_URL || "https://autolife-ai.netlify.app/checkout-success"));
    const cancelUrl  = normalizeCheckoutUrlForPaddle(sanitizeRedirectUrl(process.env.CHECKOUT_CANCEL_URL  || "https://autolife-ai.netlify.app/pricing"));

    // -----------------------------
    // Create transaction (recommended)
    // -----------------------------
    // This returns data.checkout.url for "automatic" collection transactions.
    const payload = {
      items: [{ price_id: priceId, quantity: 1 }],
      customer: { email: userEmail },
      checkout: { success_url: successUrl, cancel_url: cancelUrl },
    };

    const r = await axios.post(`${apiBase}/transactions`, payload, {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    });

    if (!(r.status >= 200 && r.status < 300)) {
      const paddleError = r?.data?.error || r?.data;
      const code = paddleError?.code || paddleError?.type || "paddle_error";

      // Helpful hints for common Paddle setup issues
      let hint = null;
      let actionRequired = null;
      let httpStatus = 502;
      if (code === "transaction_checkout_not_enabled") {
        // This is a Paddle-account setting/permission issue (not a bug in our code).
        // Return 409 so FE can show a clear 'action required' message.
        httpStatus = 409;
        actionRequired = "enable_transaction_checkout";
        hint =
          "Paddle ตอบกลับว่า Transaction Checkout ยังไม่ถูกเปิดใช้งาน (code: transaction_checkout_not_enabled). ให้ไปที่ Paddle Billing/Checkout แล้วเปิดใช้งาน Transaction checkout (หรือ Checkout links) — ถ้าไม่มีเมนูนี้/เปิดไม่ได้ ให้ติดต่อ Paddle Support เพื่อเปิดฟีเจอร์ให้บัญชี.";
      } else if (code === "invalid_url") {
        hint =
          "Paddle rejected the success/cancel URL. Double-check your successUrl/cancelUrl domains and that they are valid HTTPS URLs.";
        httpStatus = 400;
      } else if (r.status === 401 || r.status === 403) {
        hint =
          "Paddle auth failed. Verify PADDLE_API_KEY and that you are using the correct environment (sandbox vs live).";
        httpStatus = r.status;
      } else if (r.status === 404) {
        hint =
          "Paddle endpoint not found. Likely wrong API base URL for the environment. Use https://api.paddle.com (live) or https://sandbox-api.paddle.com (sandbox).";
        httpStatus = 500;
      }

      // If Paddle returned a 4xx and we didn't override, pass it through so FE can show a meaningful error.
      if (httpStatus === 502 && r.status >= 400 && r.status < 500) {
        httpStatus = r.status;
      }

      console.error("create-checkout error", {
        requestId,
        lastError: {
          endpoint: "/transactions",
          status: r.status,
          code,
          response: r?.data,
          message: `Paddle returned HTTP ${r.status}`,
        },
        sent: { plan: planKey, priceId, successUrl, cancelUrl, apiBase },
      });

      return res.status(httpStatus).json({
        error: "paddle_create_checkout_failed",
        requestId,
        status: r.status,
        code,
        hint,
        actionRequired,
        details: paddleError,
        sent: { plan: planKey, priceId, successUrl, cancelUrl },
      });
    }

    const checkoutUrl = r?.data?.data?.checkout?.url;
    if (!checkoutUrl) {
      console.error("create-checkout missing checkout.url", {
        requestId,
        response: r?.data,
        sent: { plan: planKey, priceId, successUrl, cancelUrl, apiBase },
      });
      return res.status(502).json({
        error: "paddle_missing_checkout_url",
        requestId,
        hint:
          "Transaction created but checkout.url is missing. In Paddle, ensure the transaction collection mode is automatic / hosted checkout is enabled.",
        response: r?.data,
      });
    }

    return res.json({
      url: checkoutUrl,
      requestId,
      sent: { plan: planKey, priceId, successUrl, cancelUrl },
    });
  } catch (err) {
    console.error("create-checkout fatal", {
      requestId,
      message: err?.message,
      stack: err?.stack,
    });
    return res.status(500).json({
      error: "create_checkout_unhandled",
      requestId,
      message: err?.message || String(err),
    });
  }
});

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