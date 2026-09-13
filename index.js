// ============================================================
// REPORTLI AI — AI CO-FOUNDER CHAT WORKER
// ============================================================
//
// FLOW:
//
// User
//   ↓
// Cloudflare Worker
//   ↓
// CLASSIFIER AI
//   ↓
// ┌───────────────────────┐
// │                       │
// │ NO_WORK               │ NEED_WORK
// │                       │
// ↓                       ↓
// Save classifier       Fetch Supabase data
// reply directly             ↓
//                         ANALYST AI
//                             ↓
//                         Save reply
//                             ↓
//                            User
//
// ============================================================
//
// REQUEST:
//
// {
//   "id": "chat_messages.id",
//   "user_id": "user_id",
//   "application_id": "application_id",
//   "question": "How many sessions did I have?"
// }
//
// ============================================================
//
// REQUIRED WORKER SECRETS:
//
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
//
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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
// SUPABASE REQUEST HELPER
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey:
          env.SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type":
          "application/json",

        ...(options.headers || {}),
      },
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}


// ============================================================
// SAVE REPLY
// ============================================================
//
// IMPORTANT:
//
// chat_messages uses:
//
// id
//
// NOT:
//
// message_id
//
// ============================================================

async function saveReply(
  env,
  messageId,
  reply
) {
  if (!messageId) {
    return false;
  }

  try {
    await supabaseRequest(
      env,

      `chat_messages?id=eq.${encodeURIComponent(
        messageId
      )}`,

      {
        method: "PATCH",

        headers: {
          Prefer:
            "return=minimal",
        },

        body: JSON.stringify({
          reply:
            String(reply || ""),
        }),
      }
    );

    return true;

  } catch (error) {
    console.error(
      "SAVE REPLY ERROR:",
      error
    );

    return false;
  }
}


// ============================================================
// VERIFY APPLICATION
// ============================================================
//
// We verify:
//
// application_id
// +
// user_id
//
// This prevents a user from asking the Worker to
// access another user's application data.
// ============================================================

async function verifyApplication(
  env,
  applicationId,
  userId
) {
  const applications =
    await supabaseRequest(
      env,

      `applications?id=eq.${encodeURIComponent(
        applicationId
      )}&user_id=eq.${encodeURIComponent(
        userId
      )}&select=id,user_id,api_key,name,status`
    );

  if (
    !applications ||
    applications.length === 0
  ) {
    return null;
  }

  return applications[0];
}


// ============================================================
// CLASSIFIER SYSTEM PROMPT
// ============================================================
//
// The classifier decides whether the question requires
// Supabase SaaS data.
//
// NO_WORK:
// Normal conversation that does not require SaaS data.
//
// NEED_WORK:
// Question requires information from SaaS analytics,
// sessions, events, or errors.
//
// The classifier also generates the reply for NO_WORK.
// ============================================================

const CLASSIFIER_SYSTEM_PROMPT = `
You are Reportli AI's classifier.

Decide if the user's question needs SaaS data.

NO_WORK = normal conversation, greetings, casual questions, or general help.
NEED_WORK = questions requiring sessions, events, errors, trends, or SaaS activity.

For NO_WORK, generate a short natural reply.
For NEED_WORK, return null.

Never invent data, customers, revenue, or percentages.
Never treat sessions as unique customers.
Analytics data covers the last 7 days.

Return ONLY valid JSON:

NO_WORK:
{"classification":"NO_WORK","reply":"..."}

NEED_WORK:
{"classification":"NEED_WORK","reply":null}
`;


// ============================================================
// ANALYST SYSTEM PROMPT
// ============================================================

const ANALYST_SYSTEM_PROMPT = `
You are Reportli AI, an AI co-founder for SaaS founders.

Answer the founder's question using ONLY the supplied data.

IMPORTANT:

You are Reportli AI, an AI co-founder for SaaS founders.

Answer using ONLY the supplied data.

Rules:
- Never invent numbers, customers, revenue, percentages, or data.
- Sessions are NOT unique customers.
- user_activity contains sessions and events.
- Data covers only the last 7 days.
- If data is insufficient or unavailable, say so.
- Give concise, useful, founder-level insights.
- Explain why identified problems matter.
- Give a practical next step when useful.
- Never mention Sarvam, Cloudflare, SQL, or the Worker.
- Write naturally and keep responses short.
`;


// ============================================================
// CALL SARVAM
// ============================================================
//
// This function is used for BOTH:
//
// 1. Classifier AI
// 2. Analyst AI
//
// Each call is independent.
//
// ============================================================

async function callSarvam(
  env,
  systemPrompt,
  userContent,
  maxTokens = 800
) {
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
        },

        body: JSON.stringify({
          model:
            SARVAM_MODEL,

          messages: [
            {
              role: "system",
              content:
                systemPrompt,
            },

            {
              role: "user",
              content:
                userContent,
            },
          ],

          reasoning_effort:
            null,

          temperature:
            0.2,

          max_tokens:
            maxTokens,
        }),
      }
    );

  const text =
    await response.text();

  let result;

  try {
    result =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    result = null;
  }

  if (!response.ok) {
    throw new Error(
      `Sarvam request failed: ${response.status}`
    );
  }

  const content =
    result
      ?.choices?.[0]
      ?.message
      ?.content;

  if (!content) {
    throw new Error(
      "AI returned an empty response."
    );
  }

  return String(content).trim();
}


// ============================================================
// CLASSIFIER AI
// ============================================================

async function classifyQuestion(
  env,
  question
) {
  const raw =
    await callSarvam(
      env,

      CLASSIFIER_SYSTEM_PROMPT,

      question,

      800
    );

  // ----------------------------------------------------------
  // Parse JSON
  // ----------------------------------------------------------

  let parsed;

  try {
    parsed =
      JSON.parse(raw);
  } catch {
    // --------------------------------------------------------
    // Sometimes models return JSON inside markdown.
    // --------------------------------------------------------

    const cleaned =
      raw
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();

    try {
      parsed =
        JSON.parse(cleaned);
    } catch {
      throw new Error(
        "Classifier returned invalid JSON."
      );
    }
  }

  // ----------------------------------------------------------
  // Validate classification
  // ----------------------------------------------------------

  const classification =
    String(
      parsed?.classification || ""
    )
      .trim()
      .toUpperCase();

  if (
    classification !==
      "NO_WORK" &&
    classification !==
      "NEED_WORK"
  ) {
    throw new Error(
      "Classifier returned an invalid classification."
    );
  }

  // ----------------------------------------------------------
  // NO_WORK must have reply
  // ----------------------------------------------------------

  if (
    classification ===
    "NO_WORK"
  ) {
    if (
      !parsed.reply ||
      typeof parsed.reply !==
        "string"
    ) {
      throw new Error(
        "Classifier did not provide a reply for NO_WORK."
      );
    }
  }

  return {
    classification,
    reply:
      parsed.reply || null,
  };
}


// ============================================================
// GET LAST 7 DAYS OF DATA
// ============================================================

async function getAnalyticsData(
  env,
  application
) {
  // ----------------------------------------------------------
  // Last 7 days
  // ----------------------------------------------------------

  const now =
    new Date();

  const since =
    new Date(
      now.getTime() -
      7 *
        24 *
        60 *
        60 *
        1000
    ).toISOString();

  const until =
    now.toISOString();


  // ==========================================================
  // USER ACTIVITY
  // ==========================================================

  const activity =
    await supabaseRequest(
      env,

      `user_activity?api_key=eq.${encodeURIComponent(
        application.api_key
      )}&time=gte.${encodeURIComponent(
        since
      )}&time=lte.${encodeURIComponent(
        until
      )}&select=id,user_id,session_id,time,event&order=time.desc&limit=5000`
    );


  // ==========================================================
  // ERRORS
  // ==========================================================

  const errors =
    await supabaseRequest(
      env,

      `errors?api_key=eq.${encodeURIComponent(
        application.api_key
      )}&timestamp=gte.${encodeURIComponent(
        since
      )}&timestamp=lte.${encodeURIComponent(
        until
      )}&select=id,error_message,timestamp,user_id,ai_analysis&order=timestamp.desc&limit=2000`
    );


  // ==========================================================
  // RETURN DATA
  // ==========================================================

  return {
    application: {
      id:
        application.id,

      name:
        application.name,
    },

    period: {
      from:
        since,

      to:
        until,

      days:
        7,
    },

    user_activity:
      Array.isArray(activity)
        ? activity
        : [],

    errors:
      Array.isArray(errors)
        ? errors
        : [],
  };
}


// ============================================================
// BUILD ANALYTICS SUMMARY
// ============================================================

function buildAnalyticsSummary(
  analytics
) {
  const activity =
    analytics.user_activity || [];

  const errors =
    analytics.errors || [];


  // ==========================================================
  // UNIQUE SESSION IDs
  // ==========================================================
  //
  // IMPORTANT:
  // These are sessions, NOT customers.
  //
  // Null session IDs are not counted.
  // ==========================================================

  const sessions =
    new Set();

  for (
    const row of activity
  ) {
    if (
      row.session_id
    ) {
      sessions.add(
        String(
          row.session_id
        )
      );
    }
  }


  // ==========================================================
  // EVENT COUNTS
  // ==========================================================

  const eventCounts =
    {};

  for (
    const row of activity
  ) {
    let eventName =
      "unknown";

    const event =
      row.event;

    if (
      typeof event ===
      "string"
    ) {
      eventName =
        event;
    }

    else if (
      event &&
      typeof event ===
        "object"
    ) {
      eventName =
        event.name ||
        event.event ||
        event.type ||
        "unknown";
    }

    eventName =
      String(eventName);

    eventCounts[
      eventName
    ] =
      (
        eventCounts[
          eventName
        ] || 0
      ) + 1;
  }


  // ==========================================================
  // ERROR COUNTS
  // ==========================================================

  const errorCounts =
    {};

  for (
    const error of errors
  ) {
    const message =
      String(
        error.error_message ||
        "Unknown error"
      );

    errorCounts[
      message
    ] =
      (
        errorCounts[
          message
        ] || 0
      ) + 1;
  }


  // ==========================================================
  // TOP EVENTS
  // ==========================================================

  const topEvents =
    Object.entries(
      eventCounts
    )
      .sort(
        (a, b) =>
          b[1] - a[1]
      )
      .slice(
        0,
        20
      )
      .map(
        ([event, count]) => ({
          event,
          count,
        })
      );


  // ==========================================================
  // TOP ERRORS
  // ==========================================================

  const topErrors =
    Object.entries(
      errorCounts
    )
      .sort(
        (a, b) =>
          b[1] - a[1]
      )
      .slice(
        0,
        20
      )
      .map(
        ([error, count]) => ({
          error,
          count,
        })
      );


  // ==========================================================
  // DAILY SESSION COUNTS
  // ==========================================================

  const daily =
    {};

  for (
    const row of activity
  ) {
    if (
      !row.time
    ) {
      continue;
    }

    const date =
      new Date(
        row.time
      )
        .toISOString()
        .slice(
          0,
          10
        );

    if (
      !daily[date]
    ) {
      daily[date] =
        new Set();
    }

    if (
      row.session_id
    ) {
      daily[date].add(
        String(
          row.session_id
        )
      );
    }
  }


  const dailySessions =
    Object.entries(
      daily
    )
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([date, set]) => ({
          date,
          sessions:
            set.size,
        })
      );


  // ==========================================================
  // RETURN SUMMARY
  // ==========================================================

  return {
    total_activity_rows:
      activity.length,

    total_sessions_with_session_id:
      sessions.size,

    total_errors:
      errors.length,

    top_events:
      topEvents,

    top_errors:
      topErrors,

    daily_sessions:
      dailySessions,

    recent_activity:
      activity.slice(
        0,
        100
      ),

    recent_errors:
      errors.slice(
        0,
        100
      ),
  };
}


// ============================================================
// ANALYST AI
// ============================================================

async function analyzeQuestion(
  env,
  question,
  analytics
) {
  const summary =
    buildAnalyticsSummary(
      analytics
    );


  const prompt =
    JSON.stringify(
      {
        founder_question:
          question,

        application:
          analytics.application,

        analytics_period:
          analytics.period,

        summary,

        user_activity:
          analytics.user_activity,

        errors:
          analytics.errors,
      }
    );


  return callSarvam(
    env,

    ANALYST_SYSTEM_PROMPT,

    prompt,

    1200
  );
}


// ============================================================
// REQUEST VALIDATION
// ============================================================

function validateRequest(
  body
) {
  if (
    !body ||
    typeof body !==
      "object"
  ) {
    return "Invalid request body.";
  }

  if (
    !body.id
  ) {
    return "Missing id.";
  }

  if (
    !body.user_id
  ) {
    return "Missing user_id.";
  }

  if (
    !body.application_id
  ) {
    return "Missing application_id.";
  }

  if (
    !body.question
  ) {
    return "Missing question.";
  }

  if (
    typeof body.question !==
      "string"
  ) {
    return "Question must be a string.";
  }

  if (
    body.question.trim()
      .length === 0
  ) {
    return "Question cannot be empty.";
  }

  return null;
}


// ============================================================
// MAIN HANDLER
// ============================================================

async function handleRequest(
  request,
  env
) {
  // ==========================================================
  // ONLY POST
  // ==========================================================

  if (
    request.method !==
    "POST"
  ) {
    return json(
      {
        error:
          "Method not allowed.",
      },
      405
    );
  }


  // ==========================================================
  // PARSE REQUEST
  // ==========================================================

  let body;

  try {
    body =
      await request.json();

  } catch {
    return json(
      {
        error:
          "Invalid JSON.",
      },
      400
    );
  }


  // ==========================================================
  // VALIDATE
  // ==========================================================

  const validationError =
    validateRequest(
      body
    );

  if (
    validationError
  ) {
    return json(
      {
        error:
          validationError,
      },
      400
    );
  }


  // ==========================================================
  // VALUES
  // ==========================================================

  const messageId =
    String(
      body.id
    );

  const userId =
    String(
      body.user_id
    );

  const applicationId =
    String(
      body.application_id
    );

  const question =
    String(
      body.question
    ).trim();


  try {

    // ========================================================
    // 1. VERIFY APPLICATION
    // ========================================================

    const application =
      await verifyApplication(
        env,
        applicationId,
        userId
      );

    if (
      !application
    ) {
      const reply =
        "I couldn't verify this SaaS application.";

      await saveReply(
        env,
        messageId,
        reply
      );

      return json(
        {
          success:
            false,

          reply,

          classification:
            "ERROR",
        },
        403
      );
    }


    // ========================================================
    // 2. CLASSIFIER AI
    // ========================================================
    //
    // EVERY QUESTION GOES THROUGH THE CLASSIFIER.
    //
    // ========================================================

    const classification =
      await classifyQuestion(
        env,
        question
      );


    // ========================================================
    // 3. NO WORK
    // ========================================================
    //
    // Example:
    //
    // "Hi"
    // "What are you doing?"
    // "Who are you?"
    //
    // Classifier generates the reply.
    //
    // NO SUPABASE ANALYTICS QUERY.
    // NO ANALYST AI.
    //
    // Total AI calls = 1
    // ========================================================

    if (
      classification.classification ===
      "NO_WORK"
    ) {
      const reply =
        classification.reply;

      await saveReply(
        env,
        messageId,
        reply
      );

      return json({
        success:
          true,

        reply,

        classification:
          "NO_WORK",

        ai_calls:
          1,
      });
    }


    // ========================================================
    // 4. NEED WORK
    // ========================================================
    //
    // Example:
    //
    // "How many sessions did I have?"
    //
    // Fetch Supabase data.
    // Then call Analyst AI.
    //
    // Total AI calls = 2
    // ========================================================

    const analytics =
      await getAnalyticsData(
        env,
        application
      );


    // ========================================================
    // 5. ANALYST AI
    // ========================================================

    const reply =
      await analyzeQuestion(
        env,
        question,
        analytics
      );


    // ========================================================
    // 6. SAVE ANALYST REPLY
    // ========================================================

    await saveReply(
      env,
      messageId,
      reply
    );


    // ========================================================
    // 7. RETURN
    // ========================================================

    return json({
      success:
        true,

      reply,

      classification:
        "NEED_WORK",

      ai_calls:
        2,
    });


  } catch (
    error
  ) {

    // ========================================================
    // ERROR LOG
    // ========================================================

    console.error(
      "WORKER ERROR:",
      error
    );


    // ========================================================
    // IMPORTANT
    // ========================================================
    //
    // Always try to save something into reply.
    //
    // This prevents reply from intentionally being left null
    // when the Worker encounters a handled error.
    //
    // ========================================================

    const errorReply =
      "Sorry, I couldn't process your request right now. Please try again.";


    await saveReply(
      env,
      messageId,
      errorReply
    );


    return json(
      {
        success:
          false,

        reply:
          errorReply,
      },
      500
    );
  }
}


// ============================================================
// CLOUDFLARE WORKER ENTRY POINT
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    // ========================================================
    // CORS PREFLIGHT
    // ========================================================

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status:
            204,

          headers:
            corsHeaders(),
        }
      );
    }


    // ========================================================
    // MAIN REQUEST
    // ========================================================

    return handleRequest(
      request,
      env
    );
  },
};
