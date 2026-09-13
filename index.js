// ============================================================
// REPORTLI AI — CHAT WORKER
// ============================================================
//
// CURRENT MVP
//
// DATA SOURCES:
//   1. user_activity
//   2. errors
//
// AI:
//   Sarvam AI
//
// TIME RANGE:
//   Last 7 days only
//
// NOT INCLUDED:
//   - Gmail
//   - Threads
//   - Stripe
//   - GitHub
//   - Customer identity
//
// CHAT FLOW:
//
// Frontend
//    ↓
// Creates chat_messages row
//    ↓
// Sends question to Worker
//    ↓
// Worker gets SaaS data
//    ↓
// Worker sends relevant data to Sarvam
//    ↓
// Sarvam generates answer
//    ↓
// Worker updates existing chat_messages row
//    ↓
// Worker returns answer to frontend
//
// ============================================================


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env) {

    // ========================================================
    // CORS
    // ========================================================

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });

    }


    // ========================================================
    // URL
    // ========================================================

    const url = new URL(request.url);


    // ========================================================
    // HEALTH CHECK
    // ========================================================

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {

      return json({

        success: true,

        message:
          "Reportli Chat Worker is running"

      });

    }


    // ========================================================
    // CHAT
    // ========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/chat"
    ) {

      return handleChat(
        request,
        env
      );

    }


    // ========================================================
    // UNKNOWN ROUTE
    // ========================================================

    return json({

      success: false,

      error:
        "Method not allowed",

      method:
        request.method,

      path:
        url.pathname

    }, 405);

  }

};


// ============================================================
// CHAT HANDLER
// ============================================================

async function handleChat(
  request,
  env
) {

  try {

    // ========================================================
    // READ REQUEST BODY
    // ========================================================

    const body =
      await request.json();


    const {
      user_id,
      application_id,
      conversation_id,
      question
    } = body;


    // ========================================================
    // VALIDATE USER ID
    // ========================================================

    if (!user_id) {

      return json({

        success: false,

        error:
          "user_id is required"

      }, 400);

    }


    // ========================================================
    // VALIDATE APPLICATION ID
    // ========================================================

    if (!application_id) {

      return json({

        success: false,

        error:
          "application_id is required"

      }, 400);

    }


    // ========================================================
    // VALIDATE CONVERSATION ID
    // ========================================================

    if (!conversation_id) {

      return json({

        success: false,

        error:
          "conversation_id is required"

      }, 400);

    }


    // ========================================================
    // VALIDATE QUESTION
    // ========================================================

    if (
      !question ||
      !question.trim()
    ) {

      return json({

        success: false,

        error:
          "question is required"

      }, 400);

    }


    const cleanQuestion =
      question.trim();


    // ========================================================
    // CHECK SUPABASE CONFIGURATION
    // ========================================================

    if (!env.SUPABASE_URL) {

      return json({

        success: false,

        error:
          "SUPABASE_URL is not configured"

      }, 500);

    }


    if (!env.SUPABASE_SERVICE_ROLE_KEY) {

      return json({

        success: false,

        error:
          "SUPABASE_SERVICE_ROLE_KEY is not configured"

      }, 500);

    }


    // ========================================================
    // CHECK SARVAM CONFIGURATION
    // ========================================================

    if (!env.SARVAM_API_KEY) {

      return json({

        success: false,

        error:
          "SARVAM_API_KEY is not configured"

      }, 500);

    }


    // ========================================================
    // FIND APPLICATION
    // ========================================================
    //
    // application_id
    //       ↓
    // applications
    //       ↓
    // api_key
    //
    // The api_key is used to locate:
    //
    // user_activity
    // errors
    //
    // ========================================================

    const application =
      await getApplication(
        env,
        application_id,
        user_id
      );


    if (!application) {

      return json({

        success: false,

        error:
          "Application was not found"

      }, 404);

    }


    // ========================================================
    // DETERMINE QUESTION TYPE
    // ========================================================

    const intent =
      detectIntent(
        cleanQuestion
      );


    // ========================================================
    // UNSUPPORTED QUESTION
    // ========================================================

    if (
      intent === "unsupported"
    ) {

      const reply =
        "For now, I can answer questions about your SaaS sessions, events, and errors from the last 7 days.";


      const updatedMessage =
        await updateChatMessage(
          env,
          user_id,
          application_id,
          conversation_id,
          cleanQuestion,
          reply
        );


      return json({

        success: true,

        reply,

        message:
          updatedMessage

      });

    }


    // ========================================================
    // DATA OBJECT
    // ========================================================

    const data = {

      sessions: [],

      events: [],

      errors: []

    };


    // ========================================================
    // GET ACTIVITY
    // ========================================================

    if (
      intent === "activity" ||
      intent === "combined"
    ) {

      data.events =
        await getActivity(
          env,
          application.api_key
        );


      // ------------------------------------------------------
      // Convert activity into sessions
      // ------------------------------------------------------

      data.sessions =
        buildSessions(
          data.events
        );

    }


    // ========================================================
    // GET ERRORS
    // ========================================================

    if (
      intent === "errors" ||
      intent === "combined"
    ) {

      data.errors =
        await getErrors(
          env,
          application.api_key
        );

    }


    // ========================================================
    // BUILD SUMMARY
    // ========================================================

    const summary =
      buildDataSummary(
        data
      );


    // ========================================================
    // GENERATE AI RESPONSE
    // ========================================================

    const reply =
      await generateSarvamReply(
        env,
        cleanQuestion,
        summary
      );


    // ========================================================
    // UPDATE EXISTING CHAT ROW
    // ========================================================

    const updatedMessage =
      await updateChatMessage(
        env,
        user_id,
        application_id,
        conversation_id,
        cleanQuestion,
        reply
      );


    // ========================================================
    // RETURN RESPONSE
    // ========================================================

    return json({

      success: true,

      reply,

      message:
        updatedMessage

    });


  } catch (error) {

    // ========================================================
    // GENERAL ERROR
    // ========================================================

    console.error(
      "Reportli Chat Worker Error:",
      error
    );


    return json({

      success: false,

      error:
        error?.message ||
        "Unknown error"

    }, 500);

  }

}


// ============================================================
// QUESTION INTENT DETECTION
// ============================================================
//
// Determines which Reportli data should be queried.
//
// ============================================================

function detectIntent(
  question
) {

  const q =
    question.toLowerCase();


  // ==========================================================
  // ERROR WORDS
  // ==========================================================

  const errorWords = [

    "error",
    "errors",
    "bug",
    "bugs",
    "failure",
    "failures",
    "failed",
    "crash",
    "crashes",
    "problem",
    "problems",
    "issue",
    "issues",
    "broken",
    "failing"

  ];


  const asksAboutErrors =
    errorWords.some(
      word =>
        q.includes(word)
    );


  // ==========================================================
  // ACTIVITY WORDS
  // ==========================================================

  const activityWords = [

    "session",
    "sessions",
    "activity",
    "activities",
    "event",
    "events",
    "doing",
    "happening",
    "used",
    "usage",
    "active",
    "day",
    "week",
    "today",
    "yesterday",
    "recent"

  ];


  const asksAboutActivity =
    activityWords.some(
      word =>
        q.includes(word)
    );


  // ==========================================================
  // COMBINED QUESTIONS
  // ==========================================================

  const combinedWords = [

    "what happened",
    "what is happening",
    "what's happening",
    "overview",
    "summary",
    "summarize",
    "biggest problem",
    "biggest problems",
    "what should i fix",
    "what should i do",
    "health",
    "performance"

  ];


  const asksCombined =
    combinedWords.some(
      word =>
        q.includes(word)
    );


  // ==========================================================
  // COMBINED HAS PRIORITY
  // ==========================================================

  if (asksCombined) {

    return "combined";

  }


  // ==========================================================
  // BOTH ERROR + ACTIVITY
  // ==========================================================

  if (
    asksAboutErrors &&
    asksAboutActivity
  ) {

    return "combined";

  }


  // ==========================================================
  // ERROR ONLY
  // ==========================================================

  if (asksAboutErrors) {

    return "errors";

  }


  // ==========================================================
  // ACTIVITY ONLY
  // ==========================================================

  if (asksAboutActivity) {

    return "activity";

  }


  // ==========================================================
  // UNSUPPORTED
  // ==========================================================

  return "unsupported";

}


// ============================================================
// GET APPLICATION
// ============================================================

async function getApplication(
  env,
  applicationId,
  userId
) {

  const params =
    new URLSearchParams();


  params.set(
    "id",
    `eq.${applicationId}`
  );


  params.set(
    "user_id",
    `eq.${userId}`
  );


  params.set(
    "select",
    "id,name,api_key,status"
  );


  params.set(
    "limit",
    "1"
  );


  const response =
    await supabaseFetch(
      env,
      `/rest/v1/applications?${params.toString()}`,
      {
        method: "GET"
      }
    );


  if (!response.ok) {

    const text =
      await response.text();


    throw new Error(
      `Failed to find application: ${text}`
    );

  }


  const rows =
    await response.json();


  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {

    return null;

  }


  return rows[0];

}


// ============================================================
// GET USER ACTIVITY
// ============================================================
//
// LAST 7 DAYS ONLY
//
// ============================================================

async function getActivity(
  env,
  apiKey
) {

  const sevenDaysAgo =
    new Date(

      Date.now() -
      7 * 24 * 60 * 60 * 1000

    ).toISOString();


  const params =
    new URLSearchParams();


  params.set(
    "api_key",
    `eq.${apiKey}`
  );


  params.set(
    "time",
    `gte.${sevenDaysAgo}`
  );


  params.set(
    "select",
    "id,session_id,time,event"
  );


  params.set(
    "order",
    "time.asc"
  );


  // ==========================================================
  // SAFETY LIMIT
  // ==========================================================

  params.set(
    "limit",
    "5000"
  );


  const response =
    await supabaseFetch(
      env,
      `/rest/v1/user_activity?${params.toString()}`,
      {
        method: "GET"
      }
    );


  if (!response.ok) {

    const text =
      await response.text();


    throw new Error(
      `Failed to fetch activity: ${text}`
    );

  }


  const rows =
    await response.json();


  if (!Array.isArray(rows)) {

    return [];

  }


  return rows;

}


// ============================================================
// GET ERRORS
// ============================================================
//
// LAST 7 DAYS ONLY
//
// ============================================================

async function getErrors(
  env,
  apiKey
) {

  const sevenDaysAgo =
    new Date(

      Date.now() -
      7 * 24 * 60 * 60 * 1000

    ).toISOString();


  const params =
    new URLSearchParams();


  params.set(
    "api_key",
    `eq.${apiKey}`
  );


  params.set(
    "timestamp",
    `gte.${sevenDaysAgo}`
  );


  params.set(
    "select",
    "id,error_message,timestamp,ai_analysis,user_id"
  );


  params.set(
    "order",
    "timestamp.asc"
  );


  // ==========================================================
  // SAFETY LIMIT
  // ==========================================================

  params.set(
    "limit",
    "5000"
  );


  const response =
    await supabaseFetch(
      env,
      `/rest/v1/errors?${params.toString()}`,
      {
        method: "GET"
      }
    );


  if (!response.ok) {

    const text =
      await response.text();


    throw new Error(
      `Failed to fetch errors: ${text}`
    );

  }


  const rows =
    await response.json();


  if (!Array.isArray(rows)) {

    return [];

  }


  return rows;

}


// ============================================================
// BUILD UNIQUE SESSIONS
// ============================================================
//
// IMPORTANT:
//
// These are SESSIONS.
//
// They are NOT unique customers/users.
//
// ============================================================

function buildSessions(
  events
) {

  const sessions =
    new Map();


  for (
    const activity of events
  ) {

    const sessionId =
      activity.session_id;


    if (!sessionId) {

      continue;

    }


    if (
      !sessions.has(sessionId)
    ) {

      sessions.set(
        sessionId,
        {

          session_id:
            sessionId,

          first_event:
            activity.time,

          last_event:
            activity.time,

          event_count:
            0

        }
      );

    }


    const session =
      sessions.get(
        sessionId
      );


    session.event_count++;


    // ======================================================
    // FIRST EVENT
    // ======================================================

    if (
      new Date(activity.time) <
      new Date(session.first_event)
    ) {

      session.first_event =
        activity.time;

    }


    // ======================================================
    // LAST EVENT
    // ======================================================

    if (
      new Date(activity.time) >
      new Date(session.last_event)
    ) {

      session.last_event =
        activity.time;

    }

  }


  return Array.from(
    sessions.values()
  );

}


// ============================================================
// BUILD DATA SUMMARY
// ============================================================
//
// We calculate basic statistics before sending data to AI.
//
// This makes the AI faster and reduces unnecessary tokens.
//
// ============================================================

function buildDataSummary(
  data
) {

  const summary = {

    period:
      "Last 7 days",

    total_sessions:
      data.sessions.length,

    total_events:
      data.events.length,

    total_errors:
      data.errors.length,

    events_by_name:
      {},

    sessions_by_day:
      {},

    errors_by_day:
      {},

    errors_by_message:
      {},

    recent_errors:
      []

  };


  // ==========================================================
  // COUNT EVENTS
  // ==========================================================

  for (
    const activity of data.events
  ) {

    const eventName =
      normalizeEvent(
        activity.event
      );


    if (!eventName) {

      continue;

    }


    if (
      !summary.events_by_name[eventName]
    ) {

      summary.events_by_name[eventName] =
        0;

    }


    summary.events_by_name[eventName]++;

  }


  // ==========================================================
  // COUNT SESSIONS BY DAY
  // ==========================================================

  for (
    const session of data.sessions
  ) {

    const day =
      getDateOnly(
        session.first_event
      );


    if (
      !summary.sessions_by_day[day]
    ) {

      summary.sessions_by_day[day] =
        0;

    }


    summary.sessions_by_day[day]++;

  }


  // ==========================================================
  // COUNT ERRORS BY DAY
  // ==========================================================

  for (
    const error of data.errors
  ) {

    if (!error.timestamp) {

      continue;

    }


    const day =
      getDateOnly(
        error.timestamp
      );


    if (
      !summary.errors_by_day[day]
    ) {

      summary.errors_by_day[day] =
        0;

    }


    summary.errors_by_day[day]++;


    const message =
      String(
        error.error_message ||
        "Unknown error"
      ).trim();


    if (
      !summary.errors_by_message[message]
    ) {

      summary.errors_by_message[message] =
        0;

    }


    summary.errors_by_message[message]++;

  }


  // ==========================================================
  // RECENT ERRORS
  // ==========================================================

  summary.recent_errors =
    data.errors
      .slice(-50)
      .map(
        error => ({

          timestamp:
            error.timestamp,

          message:
            error.error_message,

          ai_analysis:
            error.ai_analysis ||
            null

        })
      );


  // ==========================================================
  // SORT RESULTS
  // ==========================================================

  summary.events_by_name =
    sortObjectDescending(
      summary.events_by_name
    );


  summary.sessions_by_day =
    sortObjectDescending(
      summary.sessions_by_day
    );


  summary.errors_by_day =
    sortObjectDescending(
      summary.errors_by_day
    );


  summary.errors_by_message =
    sortObjectDescending(
      summary.errors_by_message
    );


  return summary;

}


// ============================================================
// GENERATE SARVAM AI REPLY
// ============================================================
//
// Required secret:
//
// SARVAM_API_KEY
//
// ============================================================

async function generateSarvamReply(
  env,
  question,
  summary
) {

  // ==========================================================
  // SYSTEM INSTRUCTION
  // ==========================================================

  const systemInstruction = `
You are Reportli AI, an AI employee for SaaS founders.

You analyze data from the founder's SaaS application.

CURRENT DATA AVAILABLE:

- Sessions
- Events
- Errors

DATA PERIOD:

Only the last 7 days.

IMPORTANT RULES:

1. Use ONLY the data provided in the REPORTLI DATA section.
2. Never invent data.
3. Never pretend you have data that is not provided.
4. Do NOT call sessions unique users.
5. Report sessions as sessions.
6. Do NOT claim to know individual customers.
7. Do NOT invent customer names or email addresses.
8. Do NOT mention Gmail, Threads, Stripe, GitHub, or other integrations.
9. If the available data cannot answer the question, say so clearly.
10. Give useful conclusions instead of dumping raw database data.
11. When useful, identify important patterns.
12. Use exact numbers when available.
13. The available period is only the last 7 days.
14. Keep the response concise and easy for a SaaS founder to understand.
15. Do not say you performed actions that you did not perform.
16. Do not claim revenue, conversion, retention, churn, or customer counts unless that information exists in the provided data.
`;


  // ==========================================================
  // PROMPT
  // ==========================================================

  const prompt = `

${systemInstruction}

FOUNDER QUESTION:

${question}

REPORTLI DATA:

${JSON.stringify(summary)}

Now answer the founder's question using ONLY the Reportli data above.
`;


  // ==========================================================
  // SARVAM API
  // ==========================================================

  const response =
    await fetch(
      "https://api.sarvam.ai/v1/chat/completions",
      {

        method: "POST",

        headers: {

          "Content-Type":
            "application/json",

          "api-subscription-key":
            env.SARVAM_API_KEY

        },

        body: JSON.stringify({

          model:
            "sarvam-m",

          messages: [

            {

              role:
                "system",

              content:
                systemInstruction

            },

            {

              role:
                "user",

              content:
                `${question}\n\nREPORTLI DATA:\n${JSON.stringify(summary)}`

            }

          ],

          temperature:
            0.2,

          max_tokens:
            1000

        })

      }
    );


  // ==========================================================
  // READ SARVAM RESPONSE
  // ==========================================================

  const responseText =
    await response.text();


  // ==========================================================
  // SARVAM ERROR
  // ==========================================================

  if (!response.ok) {

    throw new Error(
      `Sarvam API error ${response.status}: ${responseText}`
    );

  }


  // ==========================================================
  // PARSE RESPONSE
  // ==========================================================

  let result;

  try {

    result =
      JSON.parse(
        responseText
      );

  } catch {

    throw new Error(
      "Sarvam returned invalid JSON"
    );

  }


  // ==========================================================
  // GET ASSISTANT TEXT
  // ==========================================================

  const reply =
    result
      ?.choices?.[0]
      ?.message
      ?.content
      ?.trim();


  // ==========================================================
  // EMPTY RESPONSE
  // ==========================================================

  if (!reply) {

    throw new Error(
      "Sarvam returned an empty reply"
    );

  }


  return reply;

}


// ============================================================
// UPDATE EXISTING CHAT MESSAGE
// ============================================================
//
// The frontend already created the question row.
//
// Worker finds it and updates ONLY the reply.
//
// ============================================================

async function updateChatMessage(
  env,
  userId,
  applicationId,
  conversationId,
  question,
  reply
) {

  // ==========================================================
  // FIND EXISTING QUESTION
  // ==========================================================

  const params =
    new URLSearchParams();


  params.set(
    "user_id",
    `eq.${userId}`
  );


  params.set(
    "application_id",
    `eq.${applicationId}`
  );


  params.set(
    "conversation_id",
    `eq.${conversationId}`
  );


  params.set(
    "question",
    `eq.${question}`
  );


  params.set(
    "reply",
    "is.null"
  );


  params.set(
    "select",
    "id,user_id,application_id,conversation_id,role,question,reply,created_at"
  );


  params.set(
    "order",
    "created_at.desc"
  );


  params.set(
    "limit",
    "1"
  );


  const findResponse =
    await supabaseFetch(
      env,
      `/rest/v1/chat_messages?${params.toString()}`,
      {
        method: "GET"
      }
    );


  const findText =
    await findResponse.text();


  if (!findResponse.ok) {

    throw new Error(
      `Failed to find chat message: ${findText}`
    );

  }


  let rows;

  try {

    rows =
      JSON.parse(
        findText
      );

  } catch {

    rows = [];

  }


  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {

    throw new Error(
      "Existing question row was not found"
    );

  }


  const messageId =
    rows[0].id;


  // ==========================================================
  // UPDATE EXISTING ROW
  // ==========================================================

  const updateParams =
    new URLSearchParams();


  updateParams.set(
    "id",
    `eq.${messageId}`
  );


  const updateResponse =
    await supabaseFetch(
      env,
      `/rest/v1/chat_messages?${updateParams.toString()}`,
      {

        method:
          "PATCH",

        headers: {

          "Content-Type":
            "application/json",

          "Prefer":
            "return=representation"

        },

        body:
          JSON.stringify({

            reply

          })

      }
    );


  const updateText =
    await updateResponse.text();


  if (!updateResponse.ok) {

    throw new Error(
      `Failed to update chat message: ${updateText}`
    );

  }


  // ==========================================================
  // PARSE UPDATED MESSAGE
  // ==========================================================

  let updatedMessage;

  try {

    updatedMessage =
      JSON.parse(
        updateText
      );

  } catch {

    updatedMessage =
      updateText;

  }


  return updatedMessage;

}


// ============================================================
// SUPABASE FETCH HELPER
// ============================================================

async function supabaseFetch(
  env,
  path,
  options = {}
) {

  const headers = {

    "apikey":
      env.SUPABASE_SERVICE_ROLE_KEY,

    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

    ...(options.headers || {})

  };


  return fetch(

    `${env.SUPABASE_URL}${path}`,

    {

      ...options,

      headers

    }

  );

}


// ============================================================
// NORMALIZE EVENT
// ============================================================
//
// Supports event values such as:
//
// "checkout_clicked"
//
// {
//   "name": "checkout_clicked"
// }
//
// {
//   "event": "checkout_clicked"
// }
//
// {
//   "type": "checkout_clicked"
// }
//
// ============================================================

function normalizeEvent(
  event
) {

  if (
    typeof event === "string"
  ) {

    return event.trim();

  }


  if (
    event &&
    typeof event === "object"
  ) {

    if (
      typeof event.name === "string"
    ) {

      return event.name.trim();

    }


    if (
      typeof event.event === "string"
    ) {

      return event.event.trim();

    }


    if (
      typeof event.type === "string"
    ) {

      return event.type.trim();

    }

  }


  return "";

}


// ============================================================
// GET DATE ONLY
// ============================================================

function getDateOnly(
  timestamp
) {

  try {

    return new Date(
      timestamp
    )
      .toISOString()
      .slice(
        0,
        10
      );

  } catch {

    return "unknown";

  }

}


// ============================================================
// SORT OBJECT DESCENDING
// ============================================================

function sortObjectDescending(
  object
) {

  return Object.fromEntries(

    Object.entries(
      object
    )
      .sort(
        ([, a], [, b]) =>
          b - a
      )

  );

}


// ============================================================
// CORS HEADERS
// ============================================================

function corsHeaders() {

  return {

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Content-Type":
      "application/json"

  };

}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
  data,
  status = 200
) {

  return new Response(

    JSON.stringify(
      data
    ),

    {

      status,

      headers:
        corsHeaders()

    }

  );

  }
