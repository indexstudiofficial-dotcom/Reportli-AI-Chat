// ============================================================
// REPORTLI AI — AI CO-FOUNDER CHAT WORKER (v4, with credits)
// ============================================================
//
// TWO WAYS TO CALL IT:
//
// 1) Free-typed question (classifier picks the data):
//    { id, user_id, application_id, question }
//
// 2) One-tap task button (skips the classifier, 1 AI call):
//    { id, user_id, application_id, task }
//
//    task = generate_weekly_report | analyze_user_behavior
//           | check_lead_status | find_reddit_opportunities
//
// 3) GET (any path) returns the task list: [{ id, label, description }]
//
// CREDITS:
//   Each processed message costs 0.01 credits from users.balance.
//   If balance < 0.01 the message is NOT processed and the
//   "You're out of credits" reply is saved and returned.
//   If processing fails after charging, the credit is refunded.
//
// REQUIRED WORKER SECRETS:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SARVAM_API_KEY
//
// SECURITY:
//   Every query selects explicit columns. api_key, connected_account_id,
//   lead emails and email bodies are never sent to the AI.
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

const DEBUG = true; // set false once stable

// Privacy flags
const INCLUDE_LEAD_EMAILS = false;
const INCLUDE_EMAIL_SNIPPETS = false;

// Time windows
const ACTIVITY_DAYS = 7;
const RECENT_DAYS = 30;

// Set true only if you have a separate `errors` table.
// Error events are already counted from user_activity either way.
const ENABLE_ERRORS_TABLE = false;

// ---------- Credits ----------
const CREDIT_COST = 0.01;
const USERS_TABLE = "users";
const USERS_ID_COLUMN = "id"; // column in `users` that matches user_id
const USERS_BALANCE_COLUMN = "balance";
// Returned HTTP status when out of credits. Use 200 if your frontend
// treats any non-200 response as a hard error.
const OUT_OF_CREDITS_STATUS = 200;

function usableSources(sources) {
  return sources.filter((s) => s !== "errors" || ENABLE_ERRORS_TABLE);
}

// Row limits per source
const LIMITS = {
  activity: 5000,
  errors: 1000,
  leads: 2000,
  emails: 500,
  reddit: 300,
  niches: 200,
  planner: 100,
};

const VALID_SOURCES = [
  "activity",
  "errors",
  "leads",
  "emails",
  "reddit",
  "niches",
  "planner",
];


// ============================================================
// BUILT-IN TASKS (one-tap buttons)
// ============================================================

const TASKS = {
  generate_weekly_report: {
    label: "Generate weekly report",
    description: "Sessions, top actions and errors from the last 7 days.",
    aliases: ["weekly_report"],
    sources: ["activity", "errors"],
    question: "Generate my weekly report.",
    instructions:
      "Write a weekly report for the last 7 days: total sessions, the busiest day, the most common user actions, and any errors. " +
      "Point out the single biggest change or concern, then give one next step. Max 120 words.",
  },

  analyze_user_behavior: {
    label: "Analyze user behavior",
    description: "What users click, how long sessions last, and where they drop off.",
    aliases: ["user_behavior"],
    sources: ["activity"],
    question: "Analyze what my users are doing in my product.",
    instructions:
      "Explain how users behave in their sessions: which buttons or features they click most, how many actions a typical session has, " +
      "how long sessions last, what share of sessions hit an error, and how many sessions end after a single action. " +
      "End with one product improvement to try. Max 120 words.",
  },

  check_lead_status: {
    label: "Check lead status",
    description: "Lead pipeline, reply status, and inbox emails that need attention.",
    aliases: ["lead_status"],
    sources: ["leads", "emails"],
    question: "Check the status of my leads.",
    instructions:
      "Summarize the lead pipeline: how many leads, how many have valid emails, the reply_status breakdown, and which job titles or companies dominate. " +
      "Note that a lead's message is the outreach email we wrote, not a reply from the lead. " +
      "If inbox emails need a reply and have no draft, mention it. End with who or what to follow up on first. Max 120 words.",
  },

  find_reddit_opportunities: {
    label: "Find Reddit opportunities",
    description: "The best Reddit posts to reply to and the hottest customer niche.",
    aliases: ["reddit_opportunities"],
    sources: ["reddit", "niches"],
    question: "Find my best Reddit opportunities.",
    instructions:
      "Name the 3 best Reddit posts to reply to, with subreddit, why each is a fit (use the post snippet), and its relevance score. " +
      "Then say which customer niche looks hottest using buying intention and post counts. Max 140 words.",
  },
};


// Accepts the task id or an old alias, returns the task id (or null).
function resolveTask(name) {
  const key = String(name || "").trim().toLowerCase();
  if (TASKS[key]) return key;
  return (
    Object.keys(TASKS).find((k) => (TASKS[k].aliases || []).includes(key)) || null
  );
}


// ============================================================
// HELPERS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(),
  });
}

function truncate(value, max = 200) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function daysAgoISO(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function countBy(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = String(fn(row) ?? "unknown") || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topList(counts, keyName, n = 10) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ [keyName]: truncate(label, 120), count }));
}

function dailyCounts(rows, field, days) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const counts = {};
  for (const row of rows) {
    const t = row[field] ? new Date(row[field]).getTime() : NaN;
    if (isNaN(t) || t < since) continue;
    const date = new Date(t).toISOString().slice(0, 10);
    counts[date] = (counts[date] || 0) + 1;
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
}


// ============================================================
// SUPABASE
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret.");
  }

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status} on ${path.split("?")[0]}: ${truncate(data, 300)}`
    );
  }

  return data;
}

// A failed table never kills the whole request. It becomes a warning.
async function safeFetch(env, label, path, warnings) {
  try {
    const rows = await supabaseRequest(env, path);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error(`FETCH ERROR (${label}):`, error);
    warnings.push(`${label} data could not be loaded.`);
    return [];
  }
}

// chat_messages uses `id` (text)
async function saveReply(env, messageId, reply) {
  if (!messageId) return false;

  try {
    await supabaseRequest(
      env,
      `chat_messages?id=eq.${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ reply: String(reply || "") }),
      }
    );
    return true;
  } catch (error) {
    console.error("SAVE REPLY ERROR:", error);
    return false;
  }
}

// application_id + user_id must match. api_key stays server-side only.
//
// If there is no usable `applications` table (missing table, different
// column names, uuid vs text ids), we fall back to checking that the
// chat_messages row itself belongs to this user and application. That row
// is created by your app before the Worker is called.
async function verifyApplication(env, applicationId, userId, messageId) {
  try {
    const applications = await supabaseRequest(
      env,
      `applications?id=eq.${encodeURIComponent(applicationId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`
    );

    if (Array.isArray(applications) && applications.length > 0) {
      return { ...applications[0], user_id: userId };
    }
  } catch (error) {
    console.error("APPLICATIONS LOOKUP FAILED, using chat message check:", error);
  }

  const rows = await supabaseRequest(
    env,
    `chat_messages?id=eq.${encodeURIComponent(messageId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&application_id=eq.${encodeURIComponent(applicationId)}&select=id&limit=1`
  );

  if (Array.isArray(rows) && rows.length > 0) {
    return { id: applicationId, name: null, api_key: null, user_id: userId };
  }

  return null;
}


// ============================================================
// CREDITS
// ============================================================

const round4 = (n) => Math.round(n * 10000) / 10000;

function outOfCreditsMessage(balance) {
  return (
    "You're out of credits\n\n" +
    "You've used all your available credits. Upgrade your plan to continue using Reportli AI and keep your workflow running.\n\n" +
    `Your balance: ${round4(Number(balance) || 0)} credits`
  );
}

// Reads the balance. Returns null if the user row doesn't exist.
async function readBalance(env, userId) {
  const rows = await supabaseRequest(
    env,
    `${USERS_TABLE}?${USERS_ID_COLUMN}=eq.${encodeURIComponent(userId)}` +
      `&select=${USERS_BALANCE_COLUMN}&limit=1`
  );

  if (!Array.isArray(rows) || rows.length === 0) return null;
  return Number(rows[0][USERS_BALANCE_COLUMN]) || 0;
}

// Compare-and-swap: the PATCH only applies if the balance is still the
// value we just read, so two simultaneous messages can't spend the same
// credit. Returns the new balance, or null if the row changed.
async function setBalanceIfUnchanged(env, userId, oldBalance, newBalance) {
  const updated = await supabaseRequest(
    env,
    `${USERS_TABLE}?${USERS_ID_COLUMN}=eq.${encodeURIComponent(userId)}` +
      `&${USERS_BALANCE_COLUMN}=eq.${oldBalance}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ [USERS_BALANCE_COLUMN]: newBalance }),
    }
  );

  return Array.isArray(updated) && updated.length > 0 ? newBalance : null;
}

// Checks the balance and deducts CREDIT_COST.
// Returns { ok: true, balance } or { ok: false, balance }.
async function chargeCredits(env, userId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const balance = await readBalance(env, userId);

    if (balance === null) {
      console.error("CREDITS: user row not found for", userId);
      return { ok: false, balance: 0 };
    }

    if (balance < CREDIT_COST - 1e-9) {
      return { ok: false, balance };
    }

    const newBalance = round4(balance - CREDIT_COST);
    const result = await setBalanceIfUnchanged(env, userId, balance, newBalance);

    if (result !== null) return { ok: true, balance: result };
    // Balance changed under us, retry with the fresh value.
  }

  throw new Error("Could not update credits. Please retry.");
}

// Gives the credit back if the request failed after we charged.
async function refundCredits(env, userId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const balance = await readBalance(env, userId);
      if (balance === null) return;

      const result = await setBalanceIfUnchanged(
        env,
        userId,
        balance,
        round4(balance + CREDIT_COST)
      );
      if (result !== null) return;
    } catch (error) {
      console.error("REFUND ERROR:", error);
    }
  }
  console.error("REFUND FAILED after retries for user", userId);
}


// ============================================================
// CHAT HISTORY (so follow-up questions work)
// ============================================================

async function getChatHistory(env, messageId, applicationId) {
  try {
    const current = await supabaseRequest(
      env,
      `chat_messages?id=eq.${encodeURIComponent(messageId)}&select=conversation_id&limit=1`
    );

    const conversationId = current?.[0]?.conversation_id;
    if (!conversationId) return [];

    const rows = await supabaseRequest(
      env,
      `chat_messages?conversation_id=eq.${encodeURIComponent(conversationId)}` +
        `&application_id=eq.${encodeURIComponent(applicationId)}` +
        `&id=neq.${encodeURIComponent(messageId)}` +
        `&reply=not.is.null&select=question,reply,created_at` +
        `&order=created_at.desc&limit=6`
    );

    return (Array.isArray(rows) ? rows : [])
      .reverse()
      .filter((r) => r.question && r.reply)
      .map((r) => ({
        founder: truncate(r.question, 300),
        assistant: truncate(r.reply, 400),
      }));
  } catch (error) {
    console.error("HISTORY ERROR:", error);
    return [];
  }
}


// ============================================================
// PROMPTS
// ============================================================

const CLASSIFIER_SYSTEM_PROMPT = `
You are Reportli AI's classifier.

Decide if the founder's question needs data from their SaaS workspace.

NO_WORK = greetings, casual talk, thanks, or general help that needs no data.
NEED_WORK = anything about their numbers, user activity, leads, emails, Reddit research, niches, errors, or automation runs.

Available data sources:
- activity: product sessions and user actions such as clicks (last 7 days)
- errors: application errors (last 7 days)
- leads: outbound leads, job titles, companies, email status, reply status
- emails: Gmail inbox processing, categories, AI draft replies, failures
- reddit: Reddit research posts found for customer niches
- niches: customer niches, buying intention, Reddit/Apollo status
- planner: automation/planner runs, their status and failures

For NEED_WORK, list ONLY the sources needed. Use the recent conversation to resolve follow-up questions like "what about last week?".
For broad questions ("how is my business doing?") include all sources.

For NO_WORK, write a short natural reply. For NEED_WORK, reply is null.
Never invent data, customers, revenue, or percentages.

Return ONLY valid JSON, no markdown, no explanation:

{"classification":"NO_WORK","reply":"...","sources":[]}
{"classification":"NEED_WORK","reply":null,"sources":["leads","emails"]}
`;

const ANALYST_SYSTEM_PROMPT = `
You are Reportli AI, an AI co-founder for SaaS founders.

Answer the founder's question using ONLY the supplied data.

Rules:
- Never invent numbers, customers, revenue, percentages, or data.
- Sessions are NOT unique customers.
- Only sources listed in sources_loaded were fetched. For anything else, say you didn't check it.
- Product activity and errors cover the last 7 days. Other sources cover the most recent rows; if a section says truncated=true, say the figures are for the latest rows only.
- A lead's outreach message is the email we wrote to them, not a reply from them. reply_status shows the outcome.
- If data is empty or insufficient, say so plainly. If data_warnings lists a problem, mention it briefly.
- If task_instructions is present, follow it exactly, including the word limit.
- Use recent_conversation to understand follow-up questions.
- Give concise, founder-level insights: what the numbers mean and why it matters.
- Give one practical next step when useful.
- Never mention Sarvam, Cloudflare, SQL, Supabase, the Worker, or table names.
- Keep answers short and natural. Do not output your reasoning, only the final answer.
`;


// ============================================================
// SARVAM
// ============================================================

function stripThinking(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

async function sarvamFetch(env, payload) {
  const response = await fetch(SARVAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": env.SARVAM_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  let result = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }

  return { response, text, result };
}

async function callSarvam(env, systemPrompt, userContent, maxTokens = 1500) {
  if (!env.SARVAM_API_KEY) {
    throw new Error("Missing SARVAM_API_KEY secret.");
  }

  // sarvam-105b is a reasoning model. Hidden "thinking" tokens count toward
  // max_tokens, so with reasoning on, a long prompt can use the whole budget
  // and return content: null (finish_reason: "length"). Our prompts are
  // already-summarized data, so reasoning is switched off (null) for speed
  // and reliability.
  const payload = {
    model: SARVAM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    reasoning_effort: null,
    temperature: 0.2,
    max_tokens: maxTokens,
  };

  let { response, text, result } = await sarvamFetch(env, payload);

  // If the API rejects reasoning_effort: null, use "low" with a bigger budget.
  if (
    (response.status === 400 || response.status === 422) &&
    /reasoning/i.test(text)
  ) {
    payload.reasoning_effort = "low";
    payload.max_tokens = maxTokens * 3;
    ({ response, text, result } = await sarvamFetch(env, payload));
  }

  if (!response.ok) {
    throw new Error(`Sarvam ${response.status}: ${truncate(text, 300)}`);
  }

  let choice = result?.choices?.[0];
  let content = stripThinking(choice?.message?.content || "");

  // Cut off before any answer text: retry once with a much larger budget.
  if (!content && choice?.finish_reason === "length") {
    payload.max_tokens = maxTokens * 3;
    ({ response, text, result } = await sarvamFetch(env, payload));

    if (!response.ok) {
      throw new Error(`Sarvam ${response.status}: ${truncate(text, 300)}`);
    }

    choice = result?.choices?.[0];
    content = stripThinking(choice?.message?.content || "");
  }

  if (!content) {
    throw new Error(
      `AI returned an empty response (finish_reason: ${
        choice?.finish_reason || "unknown"
      }). Raw: ${truncate(text, 300)}`
    );
  }

  return content;
}


// ============================================================
// CLASSIFIER
// ============================================================
//
// Never throws on bad model output. Unclear -> NEED_WORK with all
// sources, so the founder still gets a real answer.
// ============================================================

async function classifyQuestion(env, question, history) {
  const raw = await callSarvam(
    env,
    CLASSIFIER_SYSTEM_PROMPT,
    JSON.stringify({ recent_conversation: history, question }),
    1500
  );

  const fallback = { classification: "NEED_WORK", reply: null, sources: VALID_SOURCES };

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("CLASSIFIER NON-JSON:", truncate(raw, 300));
    return fallback;
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.error("CLASSIFIER BAD JSON:", truncate(raw, 300));
    return fallback;
  }

  const classification = String(parsed?.classification || "").trim().toUpperCase();

  if (classification === "NO_WORK") {
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      return { classification: "NO_WORK", reply: parsed.reply.trim(), sources: [] };
    }
    return fallback;
  }

  let sources = Array.isArray(parsed.sources)
    ? parsed.sources
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => VALID_SOURCES.includes(s))
    : [];

  if (sources.length === 0) sources = VALID_SOURCES;

  return { classification: "NEED_WORK", reply: null, sources: [...new Set(sources)] };
}


// ============================================================
// DATA LOADERS (explicit columns, no secrets)
// ============================================================

async function loadData(env, application, sources) {
  const warnings = [];
  const appId = encodeURIComponent(application.id);
  const apiKey = application.api_key ? encodeURIComponent(application.api_key) : null;

  // Prefer the app's api_key. Without it, fall back to the owner's user_id.
  const ownerFilter = apiKey
    ? `api_key=eq.${apiKey}`
    : `user_id=eq.${encodeURIComponent(application.user_id || "")}`;

  const since7 = encodeURIComponent(daysAgoISO(ACTIVITY_DAYS));
  const since30 = encodeURIComponent(daysAgoISO(RECENT_DAYS));
  const until = encodeURIComponent(new Date().toISOString());

  const jobs = {};

  // ---------- Product analytics (keyed by api_key) ----------
  if (sources.includes("activity")) {
    jobs.activity = safeFetch(
      env,
      "Product activity",
      `user_activity?${ownerFilter}&time=gte.${since7}&time=lte.${until}` +
        `&select=id,user_id,session_id,time,event&order=time.desc&limit=${LIMITS.activity}`,
      warnings
    );
  }

  if (sources.includes("errors")) {
    jobs.errors = safeFetch(
      env,
      "Errors",
      `errors?${ownerFilter}&timestamp=gte.${since7}&timestamp=lte.${until}` +
        `&select=id,error_message,timestamp,user_id,ai_analysis&order=timestamp.desc&limit=${LIMITS.errors}`,
      warnings
    );
  }

  // ---------- Growth data (keyed by application_id) ----------
  if (sources.includes("leads")) {
    jobs.leads = safeFetch(
      env,
      "Leads",
      `leads?application_id=eq.${appId}` +
        `&select=id,task_id,full_name,job_title,company_name,company_domain,email_status,reply_status,message,created_at` +
        (INCLUDE_LEAD_EMAILS ? ",email" : "") +
        `&order=created_at.desc&limit=${LIMITS.leads}`,
      warnings
    );
  }

  if (sources.includes("emails")) {
    jobs.emails = safeFetch(
      env,
      "Email processing",
      `gmail_processed_messages?application_id=eq.${appId}&created_at=gte.${since30}` +
        `&select=id,sender_name,email_category,should_reply,ai_draft_reply,gmail_draft_id,status,error_message,email_received_at,processed_at,created_at` +
        (INCLUDE_EMAIL_SNIPPETS ? ",email_content" : "") +
        `&order=created_at.desc&limit=${LIMITS.emails}`,
      warnings
    );
  }

  if (sources.includes("reddit")) {
    jobs.reddit = safeFetch(
      env,
      "Reddit research",
      `reddit_research_results?application_id=eq.${appId}&created_at=gte.${since30}` +
        `&select=id,subreddit,title,post_text,post_url,author_username,created_utc,score,num_comments,customer_niche,matched_query,relevance_score,created_at` +
        `&order=created_at.desc&limit=${LIMITS.reddit}`,
      warnings
    );
  }

  if (sources.includes("niches")) {
    jobs.niches = safeFetch(
      env,
      "Customer niches",
      `customer_niches?application_id=eq.${appId}` +
        `&select=niche_name,buying_intention,reddit_status,apollo_status,created_at` +
        `&order=buying_intention.desc.nullslast&limit=${LIMITS.niches}`,
      warnings
    );
  }

  if (sources.includes("planner")) {
    jobs.planner = safeFetch(
      env,
      "Planner runs",
      `planner_runs?application_id=eq.${appId}` +
        `&select=worker_type,source,task,status,pending_count,error,niche,created_at,started_at` +
        `&order=created_at.desc&limit=${LIMITS.planner}`,
      warnings
    );
  }

  // Company profile is small and gives the AI business context.
  jobs.company = safeFetch(
    env,
    "Company profile",
    `company_data?application_id=eq.${appId}&select=field,data,updated_at&limit=100`,
    warnings
  );

  // Run everything in parallel.
  const keys = Object.keys(jobs);
  const results = await Promise.all(keys.map((k) => jobs[k]));

  const data = { warnings };
  keys.forEach((k, i) => (data[k] = results[i]));
  return data;
}


// ============================================================
// EVENT PARSER
// ============================================================
//
// user_activity.event arrives in several shapes:
//   "\"09:52 pm   Clicked \\\"Reports Center\\\"\""   (string wrapped in quotes)
//   "\"12:15 pm   Error occurred\""
//   {"message":"10:37 pm   Session started","event_name":"SESSION_STARTED"}
//
// This turns every shape into { type, target, message }.
// ============================================================

function parseEvent(raw) {
  let ev = raw;

  // Unwrap JSON-encoded strings / objects (up to 2 layers).
  for (let i = 0; i < 2; i++) {
    if (typeof ev !== "string") break;
    const t = ev.trim();
    if (t.startsWith("{") || t.startsWith('"')) {
      try {
        ev = JSON.parse(t);
        continue;
      } catch {
        // fall through
      }
    }
    break;
  }

  let message = "";
  let name = "";

  if (ev && typeof ev === "object") {
    message = String(ev.message || "");
    name = String(ev.event_name || ev.name || ev.event || ev.type || "");
  } else {
    message = String(ev ?? "");
  }

  // Remove leading clock time like "09:52 pm   "
  message = message
    .replace(/^\s*\d{1,2}:\d{2}\s*(am|pm)?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const probe = `${name} ${message}`;

  if (/session[_ ]?start/i.test(probe)) {
    return { type: "SESSION_STARTED", target: null, message };
  }

  if (/click/i.test(probe)) {
    const m = message.match(/^clicked\s+(.*)$/i);
    const target = (m ? m[1] : message).replace(/^["'\\]+|["'\\]+$/g, "").trim();
    return { type: "CLICK", target: truncate(target, 80) || "unknown", message };
  }

  if (/error/i.test(probe)) {
    return { type: "ERROR", target: null, message };
  }

  if (name) {
    return { type: name.toUpperCase().replace(/\s+/g, "_"), target: null, message };
  }

  return { type: "OTHER", target: null, message };
}


// ============================================================
// SUMMARIES (compact, so the prompt stays small)
// ============================================================

function summarizeActivity(activity) {
  const sessions = new Map(); // id -> { events, errors, first, last }
  const typeCounts = {};
  const clickCounts = {};
  const otherCounts = {};
  const daily = {};

  for (const row of activity) {
    const ev = parseEvent(row.event);

    typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
    if (ev.type === "CLICK") clickCounts[ev.target] = (clickCounts[ev.target] || 0) + 1;
    if (ev.type === "OTHER" && ev.message) {
      const k = truncate(ev.message, 60);
      otherCounts[k] = (otherCounts[k] || 0) + 1;
    }

    const t = row.time ? new Date(row.time).getTime() : NaN;

    if (row.session_id) {
      const id = String(row.session_id);
      if (!sessions.has(id)) sessions.set(id, { events: 0, errors: 0, clicks: 0, first: Infinity, last: -Infinity });
      const s = sessions.get(id);
      s.events++;
      if (ev.type === "ERROR") s.errors++;
      if (ev.type === "CLICK") s.clicks++;
      if (!isNaN(t)) {
        s.first = Math.min(s.first, t);
        s.last = Math.max(s.last, t);
      }

      if (!isNaN(t)) {
        const date = new Date(t).toISOString().slice(0, 10);
        if (!daily[date]) daily[date] = new Set();
        daily[date].add(id);
      }
    }
  }

  const list = [...sessions.values()];
  const total = list.length;

  const multi = list.filter((s) => s.events > 1 && isFinite(s.first) && isFinite(s.last));
  const avgMinutes = multi.length
    ? Math.round((multi.reduce((sum, s) => sum + (s.last - s.first), 0) / multi.length / 60000) * 10) / 10
    : null;

  const dailySessions = Object.entries(daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, set]) => ({ date, sessions: set.size }));

  const busiest = [...dailySessions].sort((a, b) => b.sessions - a.sessions)[0] || null;

  return {
    period: `last ${ACTIVITY_DAYS} days`,
    truncated: activity.length >= LIMITS.activity,
    total_activity_rows: activity.length,
    total_sessions: total,
    avg_actions_per_session: total ? Math.round((activity.length / total) * 10) / 10 : null,
    avg_session_minutes: avgMinutes,
    single_action_sessions: list.filter((s) => s.events === 1).length,
    sessions_with_clicks: list.filter((s) => s.clicks > 0).length,
    sessions_with_errors: list.filter((s) => s.errors > 0).length,
    busiest_day: busiest,
    daily_sessions: dailySessions,
    action_types: typeCounts,
    top_clicked_elements: topList(clickCounts, "element", 12),
    other_actions: topList(otherCounts, "action", 8),
  };
}

function summarizeErrors(errors) {
  return {
    period: `last ${ACTIVITY_DAYS} days`,
    truncated: errors.length >= LIMITS.errors,
    total_errors: errors.length,
    top_errors: topList(countBy(errors, (e) => e.error_message || "Unknown error"), "error", 15),
    recent_errors: errors.slice(0, 10).map((e) => ({
      time: e.timestamp,
      error_message: truncate(e.error_message, 200),
      ai_analysis: truncate(e.ai_analysis, 200),
    })),
  };
}

function summarizeLeads(leads) {
  const pending = leads.filter((l) => String(l.reply_status || "").toLowerCase() === "pending").length;

  return {
    scope: "all time, latest rows",
    truncated: leads.length >= LIMITS.leads,
    total_leads: leads.length,
    by_email_status: countBy(leads, (l) => String(l.email_status || "unknown").toLowerCase()),
    by_reply_status: countBy(leads, (l) => String(l.reply_status || "no_status").toLowerCase()),
    awaiting_reply: pending,
    outreach_messages_written: leads.filter((l) => l.message).length,
    top_companies: topList(countBy(leads, (l) => l.company_name || "unknown"), "company", 10),
    top_job_titles: topList(countBy(leads, (l) => l.job_title || "unknown"), "job_title", 10),
    leads_added_per_day_last_14d: dailyCounts(leads, "created_at", 14),
    recent_leads: leads.slice(0, 10).map((l) => ({
      name: l.full_name || null,
      job_title: l.job_title || null,
      company: l.company_name || null,
      email_status: l.email_status || null,
      reply_status: l.reply_status || null,
      added: l.created_at,
      ...(INCLUDE_LEAD_EMAILS ? { email: l.email } : {}),
    })),
  };
}

function summarizeEmails(emails) {
  const failed = emails.filter((e) => e.error_message);

  return {
    period: `last ${RECENT_DAYS} days`,
    truncated: emails.length >= LIMITS.emails,
    total_emails_processed: emails.length,
    by_status: countBy(emails, (e) => String(e.status || "unknown").toLowerCase()),
    by_category: countBy(emails, (e) => e.email_category || "uncategorized"),
    should_reply_count: emails.filter((e) => e.should_reply === true).length,
    ai_drafts_written: emails.filter((e) => e.ai_draft_reply).length,
    drafts_saved_to_gmail: emails.filter((e) => e.gmail_draft_id).length,
    need_reply_but_no_draft: emails.filter((e) => e.should_reply === true && !e.ai_draft_reply).length,
    failed_count: failed.length,
    top_failure_reasons: topList(countBy(failed, (e) => e.error_message), "error", 5),
    emails_per_day_last_14d: dailyCounts(emails, "created_at", 14),
    recent_emails: emails.slice(0, 10).map((e) => ({
      sender: e.sender_name || null,
      category: e.email_category || null,
      should_reply: e.should_reply,
      status: String(e.status || "").toLowerCase(),
      draft_written: Boolean(e.ai_draft_reply),
      received: e.email_received_at || null,
      ...(INCLUDE_EMAIL_SNIPPETS ? { snippet: truncate(e.email_content, 120) } : {}),
    })),
  };
}

function summarizeReddit(posts) {
  const scored = posts.filter((p) => typeof p.relevance_score === "number");
  const avg = scored.length
    ? Math.round((scored.reduce((s, p) => s + p.relevance_score, 0) / scored.length) * 10) / 10
    : null;

  return {
    period: `last ${RECENT_DAYS} days`,
    truncated: posts.length >= LIMITS.reddit,
    total_posts_found: posts.length,
    average_relevance_score: avg,
    by_subreddit: topList(countBy(posts, (p) => p.subreddit || "unknown"), "subreddit", 10),
    by_niche: topList(countBy(posts, (p) => p.customer_niche || "unknown"), "niche", 10),
    top_queries: topList(countBy(posts, (p) => p.matched_query || "unknown"), "query", 10),
    top_posts_by_relevance: [...scored]
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 6)
      .map((p) => ({
        title: truncate(p.title, 150),
        snippet: truncate(p.post_text, 220),
        subreddit: p.subreddit,
        author: p.author_username || null,
        relevance_score: p.relevance_score,
        reddit_score: p.score ?? null,
        comments: p.num_comments ?? null,
        niche: p.customer_niche || null,
        url: p.post_url,
      })),
  };
}

function summarizeNiches(niches) {
  return {
    total_niches: niches.length,
    niches: niches.map((n) => ({
      niche: truncate(n.niche_name, 100),
      buying_intention: n.buying_intention ?? null,
      reddit_status: n.reddit_status,
      apollo_status: n.apollo_status,
    })),
  };
}

function summarizePlanner(runs) {
  return {
    scope: "latest 100 runs",
    total_runs: runs.length,
    by_status: countBy(runs, (r) => r.status || "unknown"),
    by_worker_type: countBy(runs, (r) => r.worker_type || "unknown"),
    runs_with_errors: runs.filter((r) => r.error).length,
    recent_runs: runs.slice(0, 10).map((r) => ({
      worker_type: r.worker_type,
      source: r.source,
      task: truncate(r.task, 150),
      status: r.status || null,
      pending_count: r.pending_count,
      niche: r.niche || null,
      error: r.error ? truncate(r.error, 200) : null,
      created: r.created_at,
    })),
  };
}

// Company profile: skip anything that looks like a credential.
function summarizeCompany(rows) {
  const SECRET_FIELD = /key|secret|token|password|credential|private/i;

  return rows
    .filter((r) => r.field && !SECRET_FIELD.test(r.field))
    .map((r) => ({ field: r.field, data: truncate(r.data, 500) }));
}

function buildSummary(data, sources) {
  const summary = {};

  if (sources.includes("activity")) summary.product_activity = summarizeActivity(data.activity || []);
  if (sources.includes("errors")) summary.errors = summarizeErrors(data.errors || []);
  if (sources.includes("leads")) summary.leads = summarizeLeads(data.leads || []);
  if (sources.includes("emails")) summary.emails = summarizeEmails(data.emails || []);
  if (sources.includes("reddit")) summary.reddit_research = summarizeReddit(data.reddit || []);
  if (sources.includes("niches")) summary.customer_niches = summarizeNiches(data.niches || []);
  if (sources.includes("planner")) summary.automation_runs = summarizePlanner(data.planner || []);

  summary.company_profile = summarizeCompany(data.company || []);

  return summary;
}


// ============================================================
// ANALYST
// ============================================================

async function analyzeQuestion(env, question, application, history, sources, data, instructions = null) {
  const prompt = JSON.stringify({
    founder_question: question,
    ...(instructions ? { task_instructions: instructions } : {}),
    recent_conversation: history,
    application: { name: application.name || null },
    sources_loaded: sources,
    data_warnings: data.warnings,
    summary: buildSummary(data, sources),
  });

  return callSarvam(env, ANALYST_SYSTEM_PROMPT, prompt, 2000);
}


// ============================================================
// REQUEST VALIDATION
// ============================================================

function validateRequest(body) {
  if (!body || typeof body !== "object") return "Invalid request body.";
  if (!body.id) return "Missing id.";
  if (!body.user_id) return "Missing user_id.";
  if (!body.application_id) return "Missing application_id.";

  // A task button doesn't need a question.
  if (body.task) {
    if (!resolveTask(body.task)) {
      return `Unknown task. Use one of: ${Object.keys(TASKS).join(", ")}.`;
    }
    return null;
  }

  if (!body.question) return "Missing question.";
  if (typeof body.question !== "string") return "Question must be a string.";
  if (body.question.trim().length === 0) return "Question cannot be empty.";
  return null;
}


// ============================================================
// MAIN HANDLER
// ============================================================

async function handleRequest(request, env) {
  // GET returns the button list, so the app can build buttons from the Worker.
  if (request.method === "GET") {
    return json({
      tasks: Object.entries(TASKS).map(([id, t]) => ({
        id,
        label: t.label,
        description: t.description,
      })),
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const validationError = validateRequest(body);
  if (validationError) {
    return json({ error: validationError }, 400);
  }

  const messageId = String(body.id);
  const userId = String(body.user_id);
  const applicationId = String(body.application_id);
  const taskName = body.task ? resolveTask(body.task) : null;
  const question = taskName ? TASKS[taskName].question : String(body.question).trim();

  // True once 0.01 credits have been deducted for this request.
  let charged = false;

  try {
    // 1. Verify application ownership
    const application = await verifyApplication(env, applicationId, userId, messageId);

    if (!application) {
      const reply = "I couldn't verify this SaaS application.";
      await saveReply(env, messageId, reply);
      return json({ success: false, reply, classification: "ERROR" }, 403);
    }

    // 1b. Credit check + deduct (before any AI work)
    const credit = await chargeCredits(env, userId);

    if (!credit.ok) {
      const reply = outOfCreditsMessage(credit.balance);
      await saveReply(env, messageId, reply);
      return json(
        {
          success: false,
          reply,
          classification: "NO_CREDITS",
          balance: credit.balance,
        },
        OUT_OF_CREDITS_STATUS
      );
    }
    charged = true;

    // ========================================================
    // TASK BUTTON PATH: no classifier, 1 AI call
    // ========================================================
    if (taskName) {
      const task = TASKS[taskName];
      const taskSources = usableSources(task.sources);
      const data = await loadData(env, application, taskSources);

      const reply = await analyzeQuestion(
        env,
        question,
        application,
        [],
        taskSources,
        data,
        task.instructions
      );

      await saveReply(env, messageId, reply);

      return json({
        success: true,
        reply,
        classification: "TASK",
        task: taskName,
        label: task.label,
        sources: taskSources,
        ai_calls: 1,
        balance: credit.balance,
      });
    }

    // ========================================================
    // FREE-TYPED QUESTION PATH
    // ========================================================

    // 2. Conversation memory
    const history = await getChatHistory(env, messageId, applicationId);

    // 3. Classifier (decides NO_WORK / NEED_WORK + sources)
    const classification = await classifyQuestion(env, question, history);

    // 4. NO_WORK -> 1 AI call
    if (classification.classification === "NO_WORK") {
      await saveReply(env, messageId, classification.reply);
      return json({
        success: true,
        reply: classification.reply,
        classification: "NO_WORK",
        ai_calls: 1,
        balance: credit.balance,
      });
    }

    // 5. NEED_WORK -> fetch only the needed tables
    const sources = usableSources(classification.sources);
    const data = await loadData(env, application, sources);

    // 6. Analyst -> 2 AI calls total
    const reply = await analyzeQuestion(env, question, application, history, sources, data);

    await saveReply(env, messageId, reply);

    return json({
      success: true,
      reply,
      classification: "NEED_WORK",
      sources,
      ai_calls: 2,
      balance: credit.balance,
    });
  } catch (error) {
    console.error("WORKER ERROR:", error);

    // The request failed after we charged, so give the credit back.
    if (charged) await refundCredits(env, userId);

    const errorReply =
      "Sorry, I couldn't process your request right now. Please try again.";

    await saveReply(env, messageId, errorReply);

    return json(
      {
        success: false,
        reply: errorReply,
        ...(DEBUG ? { debug: String(error?.message || error) } : {}),
      },
      500
    );
  }
}


// ============================================================
// ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return handleRequest(request, env);
  },
};
