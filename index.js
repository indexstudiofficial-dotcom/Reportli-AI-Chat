// ============================================================
// REPORTLI AI - CHAT WORKER
// ============================================================
// Purpose:
// - Receives founder questions
// - Reads SaaS activity + errors from Supabase
// - Analyzes the last 7 days
// - Uses Sarvam-105B
// - Saves the AI reply into chat_messages
//
// Current MVP scope:
// ✅ Sessions
// ✅ Events
// ✅ Errors
// ✅ Last 7 days
// ❌ Gmail
// ❌ Threads
// ❌ Stripe
// ❌ GitHub
// ❌ Customer identity
// ❌ Revenue
//
// Required Cloudflare Worker secrets:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";


// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: corsHeaders(),
    }
  );
}


// ============================================================
// NORMALIZE EVENT
// ============================================================

function normalizeEvent(event) {
  if (event === null || event === undefined) {
    return "unknown";
  }

  // If event is already a string
  if (typeof event === "string") {
    return event;
  }

  // If event is an object
  if (typeof event === "object") {
    if (typeof event.name === "string") {
      return event.name;
    }

    if (typeof event.event === "string") {
      return event.event;
    }

    if (typeof event.type === "string") {
      return event.type;
    }

    // Fallback
    try {
      return JSON.stringify(event);
    } catch {
      return "unknown";
    }
  }

  return String(event);
}


// ============================================================
// DATE HELPERS
// ============================================================

function getSevenDaysAgo() {
  const date = new Date();

  date.setUTCDate(date.getUTCDate() - 7);

  return date.toISOString();
}


function getDayKey(dateValue) {
  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toISOString().slice(0, 10);
}


// ============================================================
// SUPABASE REQUEST HELPER
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const url =
    `${env.SUPABASE_URL}${path}`;

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(
    url,
    {
      ...options,
      headers,
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}


// ============================================================
// FIND APPLICATION
// ============================================================

async function getApplication(
  env,
  userId,
  applicationId
) {
  const path =
    `/rest/v1/applications` +
    `?id=eq.${encodeURIComponent(applicationId)}` +
    `&user_id=eq.${encodeURIComponent(userId)}` +
    `&select=id,name,api_key,user_id,status,domain` +
    `&limit=1`;

  const applications =
    await supabaseRequest(env, path);

  if (!applications || applications.length === 0) {
    return null;
  }

  return applications[0];
}


// ============================================================
// FETCH ACTIVITY
// ============================================================

async function getActivity(
  env,
  apiKey,
  sevenDaysAgo
) {
  const path =
    `/rest/v1/user_activity` +
    `?api_key=eq.${encodeURIComponent(apiKey)}` +
    `&time=gte.${encodeURIComponent(sevenDaysAgo)}` +
    `&select=id,user_id,session_id,time,event,api_key` +
    `&order=time.desc` +
    `&limit=5000`;

  return await supabaseRequest(
    env,
    path
  );
}


// ============================================================
// FETCH ERRORS
// ============================================================

async function getErrors(
  env,
  apiKey,
  sevenDaysAgo
) {
  const path =
    `/rest/v1/errors` +
    `?api_key=eq.${encodeURIComponent(apiKey)}` +
    `&timestamp=gte.${encodeURIComponent(sevenDaysAgo)}` +
    `&select=id,api_key,error_message,timestamp,ai_analysis,user_id` +
    `&order=timestamp.desc` +
    `&limit=5000`;

  return await supabaseRequest(
    env,
    path
  );
}


// ============================================================
// ACTIVITY ANALYSIS
// ============================================================

function analyzeActivity(activity) {

  const sessions = new Set();

  const eventCounts = {};

  const dailySessions = {};

  for (const row of activity) {

    // ----------------------------------------
    // Session
    // ----------------------------------------

    if (row.session_id) {
      sessions.add(row.session_id);

      const day =
        getDayKey(row.time);

      if (!dailySessions[day]) {
        dailySessions[day] = new Set();
      }

      dailySessions[day].add(
        row.session_id
      );
    }

    // ----------------------------------------
    // Event
    // ----------------------------------------

    const eventName =
      normalizeEvent(row.event);

    eventCounts[eventName] =
      (eventCounts[eventName] || 0) + 1;
  }


  // Convert daily session Sets
  // into numbers

  const sessionsByDay = {};

  for (
    const [day, sessionSet]
    of Object.entries(dailySessions)
  ) {
    sessionsByDay[day] =
      sessionSet.size;
  }


  // ----------------------------------------
  // Top events
  // ----------------------------------------

  const topEvents =
    Object.entries(eventCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([event, count]) => ({
        event,
        count,
      }));


  // ----------------------------------------
  // Most active day
  // ----------------------------------------

  let mostActiveDay = null;

  for (
    const [day, count]
    of Object.entries(sessionsByDay)
  ) {

    if (
      !mostActiveDay ||
      count > mostActiveDay.sessions
    ) {
      mostActiveDay = {
        day,
        sessions: count,
      };
    }
  }


  return {
    totalActivityRows: activity.length,

    uniqueSessions: sessions.size,

    sessionsByDay,

    mostActiveDay,

    topEvents,
  };
}


// ============================================================
// ERROR ANALYSIS
// ============================================================

function analyzeErrors(errors) {

  const errorCounts = {};

  const errorsByDay = {};

  for (const error of errors) {

    // ----------------------------------------
    // Error name
    // ----------------------------------------

    const message =
      typeof error.error_message === "string"
        ? error.error_message.trim()
        : "Unknown error";


    errorCounts[message] =
      (errorCounts[message] || 0) + 1;


    // ----------------------------------------
    // Day
    // ----------------------------------------

    const day =
      getDayKey(error.timestamp);

    errorsByDay[day] =
      (errorsByDay[day] || 0) + 1;
  }


  // ----------------------------------------
  // Top errors
  // ----------------------------------------

  const topErrors =
    Object.entries(errorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([error, count]) => ({
        error,
        count,
      }));


  // ----------------------------------------
  // Worst day
  // ----------------------------------------

  let worstErrorDay = null;

  for (
    const [day, count]
    of Object.entries(errorsByDay)
  ) {

    if (
      !worstErrorDay ||
      count > worstErrorDay.errors
    ) {
      worstErrorDay = {
        day,
        errors: count,
      };
    }
  }


  return {
    totalErrors: errors.length,

    errorsByDay,

    worstErrorDay,

    topErrors,
  };
}


// ============================================================
// INTENT DETECTION
// ============================================================

function detectIntent(question) {

  const q =
    question.toLowerCase();


  const activityWords = [
    "session",
    "sessions",
    "event",
    "events",
    "activity",
    "active",
    "doing",
    "used",
    "usage",
    "most used",
    "popular",
    "day",
    "days",
    "7 day",
    "7 days",
    "week",
    "weekly",
    "happened",
  ];


  const errorWords = [
    "error",
    "errors",
    "bug",
    "bugs",
    "failure",
    "failed",
    "crash",
    "crashes",
    "problem",
    "problems",
    "issue",
    "issues",
    "broken",
    "fix",
    "technical",
  ];


  const hasActivity =
    activityWords.some(
      word => q.includes(word)
    );


  const hasErrors =
    errorWords.some(
      word => q.includes(word)
    );


  // Both
  if (
    hasActivity &&
    hasErrors
  ) {
    return "combined";
  }


  // Errors
  if (hasErrors) {
    return "errors";
  }


  // Activity
  if (hasActivity) {
    return "activity";
  }


  // General SaaS question
  const generalWords = [
    "what happened",
    "summary",
    "summarize",
    "overview",
    "insight",
    "insights",
    "what should",
    "attention",
    "important",
    "biggest",
  ];


  if (
    generalWords.some(
      word => q.includes(word)
    )
  ) {
    return "combined";
  }


  return "unsupported";
}


// ============================================================
// SARVAM AI
// ============================================================

async function askSarvam(
  env,
  question,
  context
) {

  if (!env.SARVAM_API_KEY) {
    throw new Error(
      "SARVAM_API_KEY is not configured in Cloudflare Worker secrets."
    );
  }


  // ----------------------------------------
  // System prompt
  // ----------------------------------------

  const systemPrompt = `
You are Reportli AI.

You are an AI co-founder for SaaS founders.

Your job is to analyze the founder's SaaS activity data from the last 7 days and give useful, direct business and product insights.

IMPORTANT DATA LIMITATIONS:

- The data contains sessions, events and errors.
- It does NOT contain reliable customer identity.
- Do NOT claim how many unique customers/users there are.
- Do NOT identify individual customers.
- Do NOT invent revenue.
- Do NOT invent conversions.
- Do NOT invent retention.
- Do NOT invent churn.
- Do NOT invent data that is not provided.

A session is NOT necessarily a unique user.

When talking about activity, use:
- sessions
- events
- activity

When talking about technical problems, use:
- errors
- error frequency
- error trends

Your answer should be useful to a SaaS founder.

Do not simply dump raw data.

Find patterns.

Prioritize important problems.

If there is a clear issue, explain:
1. What happened
2. Evidence
3. Why it matters
4. What the founder should investigate or fix

Be concise.

Use simple formatting.

Do not mention internal implementation details unless useful.

The current data window is the last 7 days.
`;


  // ----------------------------------------
  // User prompt
  // ----------------------------------------

  const userPrompt = `
Founder question:

${question}

Here is the Reportli data from the last 7 days:

${JSON.stringify(
  context,
  null,
  2
)}

Answer the founder's question using ONLY the supplied data.

If the data is insufficient to answer something, say that clearly.

Do not make up data.
`;


  // ----------------------------------------
  // Sarvam request
  // ----------------------------------------

  const body = {
    model: SARVAM_MODEL,

    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],

    temperature: 0.2,

    max_tokens: 1200,

    reasoning_effort: "medium",

    stream: false,

    n: 1,
  };


  const response =
    await fetch(
      SARVAM_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "api-subscription-key":
            env.SARVAM_API_KEY,

          // Also send Bearer auth.
          // Sarvam supports Bearer authentication
          // for this endpoint.
          "Authorization":
            `Bearer ${env.SARVAM_API_KEY}`,
        },

        body: JSON.stringify(body),
      }
    );


  const responseText =
    await response.text();


  // ----------------------------------------
  // IMPORTANT:
  // Don't hide Sarvam's real error.
  // ----------------------------------------

  if (!response.ok) {

    let errorData;

    try {
      errorData =
        JSON.parse(responseText);
    } catch {
      errorData =
        responseText;
    }


    console.error(
      "SARVAM API ERROR:",
      JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        error: errorData,
      })
    );


    throw new Error(
      `Sarvam API HTTP ${response.status}: ${
        typeof errorData === "string"
          ? errorData
          : JSON.stringify(errorData)
      }`
    );
  }


  // ----------------------------------------
  // Parse response
  // ----------------------------------------

  let data;

  try {
    data =
      JSON.parse(responseText);
  } catch {
    throw new Error(
      "Sarvam returned invalid JSON."
    );
  }


  const reply =
    data?.choices?.[0]?.message?.content;


  if (
    !reply ||
    typeof reply !== "string"
  ) {
    throw new Error(
      `Sarvam returned no assistant content: ${JSON.stringify(data)}`
    );
  }


  return reply.trim();
}


// ============================================================
// SAVE REPLY TO CHAT MESSAGE
// ============================================================

async function saveReply(
  env,
  {
    userId,
    applicationId,
    conversationId,
    question,
    reply,
  }
) {

  // Find the question row that the frontend
  // created before calling the Worker.

  const searchPath =
    `/rest/v1/chat_messages` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&application_id=eq.${encodeURIComponent(applicationId)}` +
    `&conversation_id=eq.${encodeURIComponent(conversationId)}` +
    `&question=eq.${encodeURIComponent(question)}` +
    `&reply=is.null` +
    `&select=id` +
    `&order=created_at.desc` +
    `&limit=1`;


  const rows =
    await supabaseRequest(
      env,
      searchPath
    );


  if (
    !rows ||
    rows.length === 0
  ) {
    console.warn(
      "No matching chat_messages row found."
    );

    return null;
  }


  const messageId =
    rows[0].id;


  const updatePath =
    `/rest/v1/chat_messages` +
    `?id=eq.${encodeURIComponent(messageId)}`;


  await supabaseRequest(
    env,
    updatePath,
    {
      method: "PATCH",

      headers: {
        "Prefer": "return=minimal",
      },

      body: JSON.stringify({
        reply,
      }),
    }
  );


  return messageId;
}


// ============================================================
// BUILD CONTEXT
// ============================================================

function buildContext(
  activity,
  errors
) {

  const activityAnalysis =
    analyzeActivity(activity);


  const errorAnalysis =
    analyzeErrors(errors);


  return {

    period:
      "last 7 days",

    activity: {
      rows:
        activityAnalysis.totalActivityRows,

      uniqueSessions:
        activityAnalysis.uniqueSessions,

      sessionsByDay:
        activityAnalysis.sessionsByDay,

      mostActiveDay:
        activityAnalysis.mostActiveDay,

      topEvents:
        activityAnalysis.topEvents,
    },

    errors: {
      total:
        errorAnalysis.totalErrors,

      errorsByDay:
        errorAnalysis.errorsByDay,

      worstErrorDay:
        errorAnalysis.worstErrorDay,

      topErrors:
        errorAnalysis.topErrors,
    },
  };
}


// ============================================================
// MAIN CHAT HANDLER
// ============================================================

async function handleChat(
  request,
  env
) {

  // ----------------------------------------
  // Parse request
  // ----------------------------------------

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        error:
          "Invalid JSON request body.",
      },
      400
    );
  }


  const {
    user_id,
    application_id,
    conversation_id,
    question,
  } = body;


  // ----------------------------------------
  // Validate
  // ----------------------------------------

  if (
    !user_id ||
    !application_id ||
    !conversation_id ||
    !question
  ) {

    return json(
      {
        error:
          "Missing user_id, application_id, conversation_id or question.",
      },
      400
    );
  }


  if (
    typeof question !== "string" ||
    !question.trim()
  ) {

    return json(
      {
        error:
          "Question must be a non-empty string.",
      },
      400
    );
  }


  // ----------------------------------------
  // Find application
  // ----------------------------------------

  const application =
    await getApplication(
      env,
      user_id,
      application_id
    );


  if (!application) {

    return json(
      {
        error:
          "Application not found or does not belong to this user.",
      },
      404
    );
  }


  if (
    !application.api_key
  ) {

    return json(
      {
        error:
          "Application does not have an API key.",
      },
      400
    );
  }


  // ----------------------------------------
  // Detect intent
  // ----------------------------------------

  const intent =
    detectIntent(
      question
    );


  if (
    intent === "unsupported"
  ) {

    const reply =
      `I can currently analyze your SaaS sessions, events, and errors from the last 7 days.\n\nTry asking:\n\n• How many sessions did I have?\n• What are people doing in my app?\n• Which events are most common?\n• Which day had the most activity?\n• How many errors happened?\n• What is my most common error?\n• What are the biggest problems right now?\n• Give me a 7-day summary.`;


    await saveReply(
      env,
      {
        userId: user_id,
        applicationId: application_id,
        conversationId: conversation_id,
        question,
        reply,
      }
    );


    return json({
      success: true,
      reply,
    });
  }


  // ----------------------------------------
  // Last 7 days
  // ----------------------------------------

  const sevenDaysAgo =
    getSevenDaysAgo();


  // ----------------------------------------
  // Fetch data
  // ----------------------------------------

  let activity = [];

  let errors = [];


  if (
    intent === "activity" ||
    intent === "combined"
  ) {

    activity =
      await getActivity(
        env,
        application.api_key,
        sevenDaysAgo
      );
  }


  if (
    intent === "errors" ||
    intent === "combined"
  ) {

    errors =
      await getErrors(
        env,
        application.api_key,
        sevenDaysAgo
      );
  }


  // ----------------------------------------
  // Build AI context
  // ----------------------------------------

  const context =
    buildContext(
      activity,
      errors
    );


  // ----------------------------------------
  // Ask Sarvam
  // ----------------------------------------

  let reply;

  try {

    reply =
      await askSarvam(
        env,
        question,
        context
      );

  } catch (error) {

    console.error(
      "REPORTLI AI ERROR:",
      error
    );


    return json(
      {
        error:
          "Reportli AI service failed.",

        details:
          error?.message ||
          "Unknown AI error.",

        model:
          SARVAM_MODEL,
      },
      502
    );
  }


  // ----------------------------------------
  // Save reply
  // ----------------------------------------

  let messageId = null;


  try {

    messageId =
      await saveReply(
        env,
        {
          userId: user_id,
          applicationId: application_id,
          conversationId: conversation_id,
          question,
          reply,
        }
      );

  } catch (error) {

    console.error(
      "CHAT MESSAGE SAVE ERROR:",
      error
    );

    // Don't fail the entire chat response
    // just because saving the reply failed.
  }


  // ----------------------------------------
  // Return
  // ----------------------------------------

  return json({
    success: true,

    reply,

    message_id:
      messageId,

    model:
      SARVAM_MODEL,

    period:
      "last 7 days",
  });
}


// ============================================================
// CLOUDFLARE WORKER ENTRY
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    // ----------------------------------------
    // OPTIONS
    // ----------------------------------------

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders(),
        }
      );
    }


    // ----------------------------------------
    // GET /
    // ----------------------------------------

    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/"
    ) {

      return json({
        service:
          "Reportli AI Chat Worker",

        status:
          "online",

        model:
          SARVAM_MODEL,

        period:
          "last 7 days",
      });
    }


    // ----------------------------------------
    // POST /chat
    // ----------------------------------------

    const url =
      new URL(request.url);


    if (
      request.method === "POST" &&
      url.pathname === "/chat"
    ) {

      try {

        return await handleChat(
          request,
          env
        );

      } catch (error) {

        console.error(
          "UNHANDLED WORKER ERROR:",
          error
        );


        return json(
          {
            error:
              "Reportli AI service failed.",

            details:
              error?.message ||
              "Unknown Worker error.",
          },
          500
        );
      }
    }


    // ----------------------------------------
    // 404
    // ----------------------------------------

    return json(
      {
        error:
          "Route not found.",
      },
      404
    );
  },
};
