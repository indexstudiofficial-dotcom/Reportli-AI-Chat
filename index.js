// ============================================================
// REPORTLI AI — CHAT WORKER
// ============================================================
//
// FLOW:
//
// User question
//      ↓
// Cloudflare Worker
//      ↓
// Sarvam 105B — classify intent
//      ↓
// Worker chooses predefined data function
//      ↓
// Supabase
//      ↓
// Worker aggregates data
//      ↓
// Sarvam 105B — analyze data
//      ↓
// chat_messages.reply
//      ↓
// User
//
// IMPORTANT:
//
// conversation_id = message_id
//
// There is NO separate message_id.
//
// Every error is also written into chat_messages.reply
// whenever the conversation_id row can be identified.
//
// Sarvam NEVER generates SQL.
// Sarvam NEVER chooses arbitrary database columns.
// Worker controls all database operations.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";

const DAYS_TO_ANALYZE = 7;

const MAX_ROWS = 5000;


// ============================================================
// ALLOWED INTENTS
// ============================================================

const ALLOWED_INTENTS = [
  "total_sessions",
  "daily_sessions",
  "session_trend",

  "top_events",
  "event_trend",
  "recent_events",

  "total_errors",
  "top_errors",
  "error_trend",
  "recent_errors",

  "saas_summary",
  "biggest_problems",

  "previous_chat",

  "unsupported",
];


// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
  };
}


// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        ...corsHeaders(),

        "Content-Type":
          "application/json",
      },
    }
  );
}


// ============================================================
// DATE HELPERS
// ============================================================

function getSevenDaysAgo() {
  return new Date(
    Date.now() -
      DAYS_TO_ANALYZE *
        24 *
        60 *
        60 *
        1000
  ).toISOString();
}


function getTodayStart() {
  const now =
    new Date();

  const start =
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
      )
    );

  return start.toISOString();
}


function getDateKey(value) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date
    .toISOString()
    .slice(0, 10);
}


// ============================================================
// SAFE JSON
// ============================================================

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}


// ============================================================
// SUPABASE REQUEST
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/${path}`;

  const response =
    await fetch(
      url,
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
    console.error(
      "SUPABASE ERROR",
      {
        status:
          response.status,

        statusText:
          response.statusText,

        body: data,

        path,
      }
    );

    throw new Error(
      `Supabase ${response.status}: ${safeJson(data)}`
    );
  }

  return data;
}


// ============================================================
// SARVAM REQUEST
// ============================================================

async function sarvamRequest(
  env,
  body,
  label
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

          Authorization:
            `Bearer ${env.SARVAM_API_KEY}`,
        },

        body:
          JSON.stringify(body),
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
    console.error(
      `${label} ERROR`,
      {
        status:
          response.status,

        statusText:
          response.statusText,

        body: data,
      }
    );

    throw new Error(
      `${label} ${response.status}: ${safeJson(data)}`
    );
  }

  return data;
}


// ============================================================
// EXTRACT SARVAM CONTENT
// ============================================================

function extractSarvamContent(
  data
) {
  const content =
    data?.choices?.[0]?.message?.content;

  if (
    typeof content !== "string" ||
    !content.trim()
  ) {
    throw new Error(
      `Sarvam returned no content: ${safeJson(data)}`
    );
  }

  return content.trim();
}


// ============================================================
// PARSE JSON
// ============================================================

function parseJson(
  content
) {
  try {
    return JSON.parse(
      content
    );
  } catch {
    const cleaned =
      content
        .replace(
          /^```json\s*/i,
          ""
        )
        .replace(
          /^```\s*/i,
          ""
        )
        .replace(
          /\s*```$/i,
          ""
        )
        .trim();

    try {
      return JSON.parse(
        cleaned
      );
    } catch {
      throw new Error(
        `Invalid JSON from Sarvam: ${content}`
      );
    }
  }
}


// ============================================================
// SAVE ERROR TO CHAT MESSAGE
// ============================================================
//
// This is extremely important.
//
// If anything fails after the request has been received,
// we attempt to save the error into:
//
// chat_messages.reply
//
// We use conversation_id as the message ID.
//
// ============================================================

async function saveErrorToReply(
  env,
  context,
  errorMessage
) {
  if (
    !context ||
    !context.conversationId ||
    !context.userId ||
    !context.applicationId
  ) {
    console.error(
      "CANNOT SAVE ERROR: missing chat context"
    );

    return false;
  }

  const messageId =
    String(
      context.conversationId
    );

  const reply =
    `⚠️ Reportli couldn't complete this request.\n\n` +
    `${errorMessage}`;

  try {
    const path =
      `chat_messages?id=eq.${encodeURIComponent(
        messageId
      )}` +
      `&user_id=eq.${encodeURIComponent(
        context.userId
      )}` +
      `&application_id=eq.${encodeURIComponent(
        context.applicationId
      )}`;

    await supabaseRequest(
      env,
      path,
      {
        method: "PATCH",

        headers: {
          Prefer:
            "return=minimal",
        },

        body:
          JSON.stringify({
            reply,
          }),
      }
    );

    console.log(
      "ERROR SAVED TO chat_messages.reply"
    );

    return true;
  } catch (saveError) {
    console.error(
      "FAILED TO SAVE ERROR TO REPLY",
      saveError?.message ||
        String(saveError)
    );

    return false;
  }
}


// ============================================================
// VERIFY APPLICATION
// ============================================================
//
// We verify that:
//
// user_id
// application_id
// api_key
//
// belong together.
//
// ============================================================

async function verifyApplication(
  env,
  context
) {
  const path =
    `applications?select=id,user_id,api_key,name` +
    `&id=eq.${encodeURIComponent(
      context.applicationId
    )}` +
    `&user_id=eq.${encodeURIComponent(
      context.userId
    )}` +
    `&api_key=eq.${encodeURIComponent(
      context.apiKey
    )}` +
    `&limit=1`;

  const rows =
    await supabaseRequest(
      env,
      path
    );

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    throw new Error(
      "Application verification failed."
    );
  }

  return rows[0];
}


// ============================================================
// SARVAM CLASSIFIER
// ============================================================
//
// Sarvam ONLY classifies the question.
//
// It does NOT:
// - generate SQL
// - select database columns
// - create Supabase URLs
//
// ============================================================

async function classifyQuestion(
  env,
  question
) {
  const systemPrompt = `
You are the intent classifier for Reportli AI.

Reportli AI is an AI co-founder for SaaS founders.

Your ONLY job is to classify the user's question into
ONE of the predefined intents.

AVAILABLE INTENTS:

total_sessions
- total number of sessions

daily_sessions
- sessions grouped by day
- which day had most sessions

session_trend
- sessions increasing/decreasing
- traffic/session trend

top_events
- most common events
- what users do most

event_trend
- events increasing/decreasing
- behavior changes

recent_events
- recent activity
- recent events

total_errors
- total number of errors

top_errors
- most common errors
- biggest technical errors

error_trend
- errors increasing/decreasing

recent_errors
- recent errors
- what broke recently

saas_summary
- general 7-day SaaS summary

biggest_problems
- biggest problems
- what needs attention
- what should be fixed first

previous_chat
- questions about previous Reportli conversations

unsupported
- questions about data Reportli does not currently have

Reportli currently has:

- sessions
- events
- errors
- Reportli chat history

Reportli currently DOES NOT have:

- revenue
- Stripe data
- customer profiles
- customer names
- retention
- churn
- conversion rate
- Gmail
- Threads
- GitHub data

IMPORTANT:

Return ONLY JSON.

Format:

{
  "intent": "one_allowed_intent"
}

Never return markdown.
Never return explanations.
`;

  const body = {
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
          question,
      },
    ],

    // Classifier does not need reasoning.
    reasoning_effort:
      null,

    temperature: 0,

    max_tokens: 300,

    response_format: {
      type: "json_object",
    },
  };

  const data =
    await sarvamRequest(
      env,
      body,
      "SARVAM CLASSIFIER"
    );

  const content =
    extractSarvamContent(
      data
    );

  const result =
    parseJson(
      content
    );

  const intent =
    result?.intent;

  if (
    typeof intent !== "string" ||
    !ALLOWED_INTENTS.includes(
      intent
    )
  ) {
    console.error(
      "INVALID INTENT FROM SARVAM",
      result
    );

    return {
      intent:
        "unsupported",
    };
  }

  return {
    intent,
  };
}


// ============================================================
// FETCH ACTIVITY
// ============================================================

async function fetchActivity(
  env,
  apiKey,
  options = {}
) {
  const {
    select =
      "id,session_id,time,event",

    limit =
      MAX_ROWS,

    todayOnly =
      false,
  } = options;

  let path =
    `user_activity?select=${encodeURIComponent(
      select
    )}` +
    `&api_key=eq.${encodeURIComponent(
      apiKey
    )}`;

  if (todayOnly) {
    path +=
      `&time=gte.${encodeURIComponent(
        getTodayStart()
      )}`;
  } else {
    path +=
      `&time=gte.${encodeURIComponent(
        getSevenDaysAgo()
      )}`;
  }

  path +=
    `&order=time.desc` +
    `&limit=${limit}`;

  return await supabaseRequest(
    env,
    path
  );
}


// ============================================================
// FETCH ERRORS
// ============================================================

async function fetchErrors(
  env,
  apiKey,
  limit = MAX_ROWS
) {
  const path =
    `errors?select=id,error_message,timestamp,ai_analysis,user_id` +
    `&api_key=eq.${encodeURIComponent(
      apiKey
    )}` +
    `&timestamp=gte.${encodeURIComponent(
      getSevenDaysAgo()
    )}` +
    `&order=timestamp.desc` +
    `&limit=${limit}`;

  return await supabaseRequest(
    env,
    path
  );
}


// ============================================================
// FETCH CHAT HISTORY
// ============================================================

async function fetchChatHistory(
  env,
  userId,
  applicationId
) {
  const path =
    `chat_messages?select=id,conversation_id,role,question,reply,created_at` +
    `&user_id=eq.${encodeURIComponent(
      userId
    )}` +
    `&application_id=eq.${encodeURIComponent(
      applicationId
    )}` +
    `&created_at=gte.${encodeURIComponent(
      getSevenDaysAgo()
    )}` +
    `&order=created_at.desc` +
    `&limit=100`;

  return await supabaseRequest(
    env,
    path
  );
}


// ============================================================
// UNIQUE SESSION COUNT
// ============================================================

function countUniqueSessions(
  rows
) {
  const sessions =
    new Set();

  for (
    const row of
      rows || []
  ) {
    if (
      row?.session_id !==
        null &&
      row?.session_id !==
        undefined &&
      String(
        row.session_id
      ).trim()
    ) {
      sessions.add(
        String(
          row.session_id
        )
      );
    }
  }

  return sessions.size;
}


// ============================================================
// DAILY SESSIONS
// ============================================================

function calculateDailySessions(
  rows
) {
  const sessionsByDay =
    new Map();

  const sessionDays =
    new Map();

  for (
    const row of
      rows || []
  ) {
    if (
      !row?.session_id ||
      !row?.time
    ) {
      continue;
    }

    const sessionId =
      String(
        row.session_id
      );

    const day =
      getDateKey(
        row.time
      );

    if (!day) {
      continue;
    }

    if (
      !sessionDays.has(
        sessionId
      )
    ) {
      sessionDays.set(
        sessionId,
        day
      );
    }
  }

  for (
    const [, day] of
      sessionDays
  ) {
    sessionsByDay.set(
      day,
      (
        sessionsByDay.get(
          day
        ) || 0
      ) + 1
    );
  }

  return Array.from(
    sessionsByDay.entries()
  )
    .sort(
      (a, b) =>
        a[0].localeCompare(
          b[0]
        )
    )
    .map(
      ([date, sessions]) => ({
        date,
        sessions,
      })
    );
}


// ============================================================
// SESSION TREND
// ============================================================

function calculateSessionTrend(
  dailySessions
) {
  if (
    !dailySessions ||
    dailySessions.length <
      2
  ) {
    return {
      direction:
        "insufficient_data",

      percentage_change:
        null,

      first_day_sessions:
        dailySessions?.[0]
          ?.sessions || 0,

      last_day_sessions:
        dailySessions?.[
          dailySessions.length - 1
        ]?.sessions || 0,
    };
  }

  const first =
    dailySessions[0]
      .sessions;

  const last =
    dailySessions[
      dailySessions.length - 1
    ].sessions;

  let direction =
    "stable";

  if (last > first) {
    direction =
      "increasing";
  }

  if (last < first) {
    direction =
      "decreasing";
  }

  let percentageChange =
    null;

  if (first !== 0) {
    percentageChange =
      Number(
        (
          ((last - first) /
            first) *
          100
        ).toFixed(2)
      );
  }

  return {
    direction,

    percentage_change:
      percentageChange,

    first_day_sessions:
      first,

    last_day_sessions:
      last,
  };
}


// ============================================================
// EVENT NAME
// ============================================================

function getEventName(
  event
) {
  if (!event) {
    return "unknown_event";
  }

  if (
    typeof event ===
    "string"
  ) {
    return event
      .slice(0, 100);
  }

  if (
    typeof event ===
    "object"
  ) {
    const possible =
      event.name ??
      event.type ??
      event.event ??
      event.event_name ??
      event.action;

    if (
      typeof possible ===
        "string" &&
      possible.trim()
    ) {
      return possible
        .trim()
        .slice(0, 100);
    }
  }

  return "unknown_event";
}


// ============================================================
// TOP EVENTS
// ============================================================

function calculateTopEvents(
  rows
) {
  const counts =
    new Map();

  for (
    const row of
      rows || []
  ) {
    const eventName =
      getEventName(
        row?.event
      );

    counts.set(
      eventName,
      (
        counts.get(
          eventName
        ) || 0
      ) + 1
    );
  }

  return Array.from(
    counts.entries()
  )
    .sort(
      (a, b) =>
        b[1] - a[1]
    )
    .slice(0, 20)
    .map(
      ([event, count]) => ({
        event,
        count,
      })
    );
}


// ============================================================
// EVENT TREND
// ============================================================

function calculateEventTrend(
  rows
) {
  const daily =
    new Map();

  for (
    const row of
      rows || []
  ) {
    if (!row?.time) {
      continue;
    }

    const day =
      getDateKey(
        row.time
      );

    if (!day) {
      continue;
    }

    const event =
      getEventName(
        row?.event
      );

    if (
      !daily.has(day)
    ) {
      daily.set(
        day,
        new Map()
      );
    }

    const dayMap =
      daily.get(day);

    dayMap.set(
      event,
      (
        dayMap.get(
          event
        ) || 0
      ) + 1
    );
  }

  const days =
    Array.from(
      daily.keys()
    ).sort();

  if (
    days.length < 2
  ) {
    return [];
  }

  const first =
    daily.get(
      days[0]
    );

  const last =
    daily.get(
      days[
        days.length - 1
      ]
    );

  const events =
    new Set([
      ...first.keys(),
      ...last.keys(),
    ]);

  return Array.from(
    events
  )
    .map(event => {
      const firstCount =
        first.get(event) ||
        0;

      const lastCount =
        last.get(event) ||
        0;

      return {
        event,

        first_day_count:
          firstCount,

        last_day_count:
          lastCount,

        change:
          lastCount -
          firstCount,
      };
    })
    .sort(
      (a, b) =>
        Math.abs(
          b.change
        ) -
        Math.abs(
          a.change
        )
    )
    .slice(0, 20);
}


// ============================================================
// RECENT EVENTS
// ============================================================

function formatRecentEvents(
  rows
) {
  return (
    rows || []
  )
    .slice(0, 100)
    .map(row => ({
      time:
        row?.time ||
        null,

      session_id:
        row?.session_id ||
        null,

      event:
        getEventName(
          row?.event
        ),
    }));
}


// ============================================================
// ERROR MESSAGE
// ============================================================

function normalizeErrorMessage(
  message
) {
  if (
    typeof message !==
    "string"
  ) {
    return "unknown_error";
  }

  return message
    .trim()
    .slice(0, 500);
}


// ============================================================
// TOTAL ERRORS
// ============================================================

function calculateTotalErrors(
  rows
) {
  return Array.isArray(
    rows
  )
    ? rows.length
    : 0;
}


// ============================================================
// TOP ERRORS
// ============================================================

function calculateTopErrors(
  rows
) {
  const counts =
    new Map();

  for (
    const row of
      rows || []
  ) {
    const message =
      normalizeErrorMessage(
        row?.error_message
      );

    counts.set(
      message,
      (
        counts.get(
          message
        ) || 0
      ) + 1
    );
  }

  return Array.from(
    counts.entries()
  )
    .sort(
      (a, b) =>
        b[1] - a[1]
    )
    .slice(0, 20)
    .map(
      ([error, count]) => ({
        error,
        count,
      })
    );
}


// ============================================================
// ERROR TREND
// ============================================================

function calculateErrorTrend(
  rows
) {
  const daily =
    new Map();

  for (
    const row of
      rows || []
  ) {
    if (
      !row?.timestamp
    ) {
      continue;
    }

    const day =
      getDateKey(
        row.timestamp
      );

    if (!day) {
      continue;
    }

    daily.set(
      day,
      (
        daily.get(
          day
        ) || 0
      ) + 1
    );
  }

  return Array.from(
    daily.entries()
  )
    .sort(
      (a, b) =>
        a[0].localeCompare(
          b[0]
        )
    )
    .map(
      ([date, errors]) => ({
        date,
        errors,
      })
    );
}


// ============================================================
// RECENT ERRORS
// ============================================================

function formatRecentErrors(
  rows
) {
  return (
    rows || []
  )
    .slice(0, 100)
    .map(row => ({
      timestamp:
        row?.timestamp ||
        null,

      error_message:
        normalizeErrorMessage(
          row?.error_message
        ),

      ai_analysis:
        row?.ai_analysis ||
        null,
    }));
}


// ============================================================
// SEVEN-DAY SUMMARY
// ============================================================

async function buildSevenDaySummary(
  env,
  apiKey
) {
  const [
    activity,
    errors,
  ] = await Promise.all([
    fetchActivity(
      env,
      apiKey,
      {
        select:
          "id,session_id,time,event",
      }
    ),

    fetchErrors(
      env,
      apiKey
    ),
  ]);

  const dailySessions =
    calculateDailySessions(
      activity
    );

  return {
    period: {
      days: 7,

      since:
        getSevenDaysAgo(),
    },

    total_sessions:
      countUniqueSessions(
        activity
      ),

    daily_sessions:
      dailySessions,

    top_events:
      calculateTopEvents(
        activity
      ),

    total_errors:
      calculateTotalErrors(
        errors
      ),

    top_errors:
      calculateTopErrors(
        errors
      ),

    error_trend:
      calculateErrorTrend(
        errors
      ),
  };
}


// ============================================================
// BIGGEST PROBLEMS
// ============================================================

async function buildBiggestProblems(
  env,
  apiKey
) {
  const [
    activity,
    errors,
  ] = await Promise.all([
    fetchActivity(
      env,
      apiKey,
      {
        select:
          "id,session_id,time,event",
      }
    ),

    fetchErrors(
      env,
      apiKey
    ),
  ]);

  const dailySessions =
    calculateDailySessions(
      activity
    );

  return {
    period: {
      days: 7,

      since:
        getSevenDaysAgo(),
    },

    sessions: {
      total:
        countUniqueSessions(
          activity
        ),

      daily:
        dailySessions,

      trend:
        calculateSessionTrend(
          dailySessions
        ),
    },

    errors: {
      total:
        calculateTotalErrors(
          errors
        ),

      top:
        calculateTopErrors(
          errors
        ),

      daily:
        calculateErrorTrend(
          errors
        ),
    },

    top_events:
      calculateTopEvents(
        activity
      ),
  };
}


// ============================================================
// EXECUTE INTENT
// ============================================================
//
// Sarvam chooses:
//
// "top_errors"
//
// Worker then runs ONLY this predefined function.
//
// ============================================================

async function executeIntent(
  env,
  intent,
  context
) {
  switch (intent) {

    // --------------------------------------------------------
    // TOTAL SESSIONS
    // --------------------------------------------------------

    case "total_sessions": {
      const rows =
        await fetchActivity(
          env,
          context.apiKey,
          {
            select:
              "session_id,time",
          }
        );

      return {
        intent,

        period: {
          days: 7,
          since:
            getSevenDaysAgo(),
        },

        total_sessions:
          countUniqueSessions(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // DAILY SESSIONS
    // --------------------------------------------------------

    case "daily_sessions": {
      const rows =
        await fetchActivity(
          env,
          context.apiKey,
          {
            select:
              "session_id,time",
          }
        );

      const daily =
        calculateDailySessions(
          rows
        );

      return {
        intent,

        daily_sessions:
          daily,

        total_sessions:
          countUniqueSessions(
            rows
          ),

        highest_day:
          daily.length
            ? daily.reduce(
                (
                  max,
                  item
                ) =>
                  item.sessions >
                  max.sessions
                    ? item
                    : max,
                daily[0]
              )
            : null,
      };
    }


    // --------------------------------------------------------
    // SESSION TREND
    // --------------------------------------------------------

    case "session_trend": {
      const rows =
        await fetchActivity(
          env,
          context.apiKey,
          {
            select:
              "session_id,time",
          }
        );

      const daily =
        calculateDailySessions(
          rows
        );

      return {
        intent,

        daily_sessions:
          daily,

        trend:
          calculateSessionTrend(
            daily
          ),
      };
    }


    // --------------------------------------------------------
    // TOP EVENTS
    // --------------------------------------------------------

    case "top_events": {
      const rows =
        await fetchActivity(
          env,
          context.apiKey,
          {
            select:
              "time,event,session_id",
          }
        );

      return {
        intent,

        top_events:
          calculateTopEvents(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // EVENT TREND
    // --------------------------------------------------------

    case "event_trend": {
      const rows =
        await fetchActivity(
          env,
          context.apiKey,
          {
            select:
              "time,event",
          }
        );

      return {
        intent,

        event_trend:
          calculateEventTrend(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // RECENT EVENTS
    // --------------------------------------------------------

    case "recent_events": {
      const rows =
        await fetchActivity(
          env,
          context.apiKey,
          {
            select:
              "time,event,session_id",

            limit: 100,
          }
        );

      return {
        intent,

        recent_events:
          formatRecentEvents(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // TOTAL ERRORS
    // --------------------------------------------------------

    case "total_errors": {
      const rows =
        await fetchErrors(
          env,
          context.apiKey
        );

      return {
        intent,

        total_errors:
          calculateTotalErrors(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // TOP ERRORS
    // --------------------------------------------------------

    case "top_errors": {
      const rows =
        await fetchErrors(
          env,
          context.apiKey
        );

      return {
        intent,

        total_errors:
          calculateTotalErrors(
            rows
          ),

        top_errors:
          calculateTopErrors(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // ERROR TREND
    // --------------------------------------------------------

    case "error_trend": {
      const rows =
        await fetchErrors(
          env,
          context.apiKey
        );

      return {
        intent,

        total_errors:
          calculateTotalErrors(
            rows
          ),

        daily_errors:
          calculateErrorTrend(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // RECENT ERRORS
    // --------------------------------------------------------

    case "recent_errors": {
      const rows =
        await fetchErrors(
          env,
          context.apiKey,
          100
        );

      return {
        intent,

        recent_errors:
          formatRecentErrors(
            rows
          ),
      };
    }


    // --------------------------------------------------------
    // SAAS SUMMARY
    // --------------------------------------------------------

    case "saas_summary": {
      return await buildSevenDaySummary(
        env,
        context.apiKey
      );
    }


    // --------------------------------------------------------
    // BIGGEST PROBLEMS
    // --------------------------------------------------------

    case "biggest_problems": {
      return await buildBiggestProblems(
        env,
        context.apiKey
      );
    }


    // --------------------------------------------------------
    // PREVIOUS CHAT
    // --------------------------------------------------------

    case "previous_chat": {
      const rows =
        await fetchChatHistory(
          env,
          context.userId,
          context.applicationId
        );

      return {
        intent,

        conversations:
          rows,
      };
    }


    // --------------------------------------------------------
    // UNSUPPORTED
    // --------------------------------------------------------

    case "unsupported": {
      return {
        intent,

        supported_data: [
          "sessions",
          "events",
          "errors",
          "previous Reportli chat history",
        ],

        unsupported_data: [
          "revenue",
          "customers",
          "customer names",
          "retention",
          "churn",
          "conversion rate",
          "Stripe",
          "Gmail",
          "Threads",
          "GitHub",
        ],
      };
    }


    // --------------------------------------------------------
    // DEFAULT
    // --------------------------------------------------------

    default:
      return {
        intent:
          "unsupported",
      };
  }
}


// ============================================================
// FINAL SARVAM ANALYST
// ============================================================
//
// Sarvam receives the processed data,
// NOT the database itself.
//
// ============================================================

async function generateFinalAnswer(
  env,
  question,
  intent,
  data
) {
  const systemPrompt = `
You are Reportli AI, an AI co-founder for SaaS founders.

Answer the founder's question using ONLY the supplied data.

IMPORTANT:

1. Never invent numbers.
2. Never invent customers.
3. Never invent revenue.
4. Never claim sessions are unique customers.
5. user_activity contains sessions and events.
6. Analytics data covers the last 7 days.
7. If data is insufficient, say so.
8. Be concise and useful.
9. Give founder-level insight.
10. If you identify a problem, explain why it matters.
11. Give a practical next step when appropriate.
12. Never mention Sarvam.
13. Never mention Cloudflare.
14. Never mention SQL.
15. Never mention the internal Worker.
16. Do not pretend to have data that is not supplied.
17. Do not confuse events with sessions.
18. Do not invent percentages.
19. For unsupported questions, clearly explain that the required
    data is not currently available.
20. Write naturally, like an AI co-founder speaking directly
    to the SaaS founder.

Keep the response reasonably short.
`;

  const userPrompt = `
FOUNDER QUESTION:

${question}

INTENT:

${intent}

REPORTLI DATA:

${safeJson(data)}
`;

  const body = {
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
          userPrompt,
      },
    ],

    // No reasoning initially.
    // This keeps the MVP reliable and fast.
    reasoning_effort:
      null,

    temperature: 0.2,

    max_tokens: 2000,
  };

  const response =
    await sarvamRequest(
      env,
      body,
      "SARVAM ANALYST"
    );

  return extractSarvamContent(
    response
  );
}


// ============================================================
// MAIN CHAT HANDLER
// ============================================================

async function handleChat(
  request,
  env
) {
  // ----------------------------------------------------------
  // PARSE REQUEST
  // ----------------------------------------------------------

  let body;

  try {
    body =
      await request.json();
  } catch {
    return jsonResponse(
      {
        error:
          "Invalid JSON body.",
      },
      400
    );
  }


  // ----------------------------------------------------------
  // REQUEST FIELDS
  // ----------------------------------------------------------
  //
  // conversation_id IS the message ID.
  //
  // There is NO message_id.
  //
  // ----------------------------------------------------------

  const {
    user_id,
    application_id,
    conversation_id,
    api_key,
    question,
  } = body;


  // ----------------------------------------------------------
  // BASIC VALIDATION
  // ----------------------------------------------------------

  if (
    !user_id ||
    !application_id ||
    !conversation_id ||
    !api_key ||
    !question
  ) {
    return jsonResponse(
      {
        error:
          "user_id, application_id, conversation_id, api_key and question are required.",
      },
      400
    );
  }


  const cleanQuestion =
    String(
      question
    ).trim();


  if (!cleanQuestion) {
    return jsonResponse(
      {
        error:
          "Question cannot be empty.",
      },
      400
    );
  }


  // ----------------------------------------------------------
  // CONTEXT
  // ----------------------------------------------------------

  const context = {
    userId:
      String(user_id),

    applicationId:
      String(application_id),

    conversationId:
      String(conversation_id),

    apiKey:
      String(api_key),
  };


  console.log(
    "CHAT REQUEST",
    {
      applicationId:
        context.applicationId,

      conversationId:
        context.conversationId,

      question:
        cleanQuestion,
    }
  );


  // ==========================================================
  // STEP 1 — VERIFY APPLICATION
  // ==========================================================

  try {
    await verifyApplication(
      env,
      context
    );
  } catch (error) {
    const message =
      error?.message ||
      "Application verification failed.";

    console.error(
      "APPLICATION VERIFICATION ERROR:",
      message
    );

    // Try to save error.
    await saveErrorToReply(
      env,
      context,
      message
    );

    return jsonResponse(
      {
        error:
          message,
      },
      403
    );
  }


  // ==========================================================
  // STEP 2 — CLASSIFY QUESTION
  // ==========================================================

  let classification;

  try {
    classification =
      await classifyQuestion(
        env,
        cleanQuestion
      );
  } catch (error) {
    const message =
      error?.message ||
      "Question classification failed.";

    console.error(
      "CLASSIFIER ERROR:",
      message
    );

    await saveErrorToReply(
      env,
      context,
      message
    );

    return jsonResponse(
      {
        error:
          "I couldn't understand your question right now.",
      },
      502
    );
  }


  const intent =
    classification.intent;


  console.log(
    "CLASSIFIED INTENT:",
    intent
  );


  // ==========================================================
  // STEP 3 — EXECUTE DATA FUNCTION
  // ==========================================================

  let data;

  try {
    data =
      await executeIntent(
        env,
        intent,
        context
      );
  } catch (error) {
    const message =
      error?.message ||
      "Data retrieval failed.";

    console.error(
      "DATA EXECUTION ERROR:",
      message
    );

    await saveErrorToReply(
      env,
      context,
      message
    );

    return jsonResponse(
      {
        error:
          "I couldn't retrieve the SaaS data right now.",
      },
      502
    );
  }


  console.log(
    "DATA READY",
    {
      intent,

      dataSize:
        safeJson(data)
          .length,
    }
  );


  // ==========================================================
  // STEP 4 — SARVAM ANALYST
  // ==========================================================

  let reply;

  try {
    reply =
      await generateFinalAnswer(
        env,
        cleanQuestion,
        intent,
        data
      );
  } catch (error) {
    const message =
      error?.message ||
      "AI analysis failed.";

    console.error(
      "ANALYST ERROR:",
      message
    );

    await saveErrorToReply(
      env,
      context,
      message
    );

    return jsonResponse(
      {
        error:
          "I retrieved the data, but couldn't analyze it right now.",
      },
      502
    );
  }


  // ==========================================================
  // STEP 5 — SAVE SUCCESSFUL REPLY
  // ==========================================================
  //
  // conversation_id IS the message ID.
  //
  // Update exactly:
  //
  // chat_messages.id = conversation_id
  //
  // ==========================================================

  try {
    const path =
      `chat_messages?id=eq.${encodeURIComponent(
        context.conversationId
      )}` +
      `&user_id=eq.${encodeURIComponent(
        context.userId
      )}` +
      `&application_id=eq.${encodeURIComponent(
        context.applicationId
      )}`;

    await supabaseRequest(
      env,
      path,
      {
        method: "PATCH",

        headers: {
          Prefer:
            "return=minimal",
        },

        body:
          JSON.stringify({
            reply,
          }),
      }
    );

    console.log(
      "REPLY SAVED SUCCESSFULLY"
    );
  } catch (error) {
    const message =
      error?.message ||
      "Failed to save AI reply.";

    console.error(
      "SAVE REPLY ERROR:",
      message
    );

    // IMPORTANT:
    // Try once more using the same conversation_id
    // to save the failure into reply.
    await saveErrorToReply(
      env,
      context,
      message
    );

    return jsonResponse(
      {
        error:
          "The answer was generated, but I couldn't save it.",
      },
      502
    );
  }


  // ==========================================================
  // STEP 6 — RETURN SUCCESS
  // ==========================================================

  return jsonResponse(
    {
      success: true,

      reply,

      intent,
    },
    200
  );
}


// ============================================================
// HEALTH CHECK
// ============================================================

async function handleHealth() {
  return jsonResponse(
    {
      ok: true,

      service:
        "reportli-ai-chat",

      model:
        SARVAM_MODEL,

      architecture:
        "classifier -> deterministic data -> analyst",

      timestamp:
        new Date().toISOString(),
    }
  );
}


// ============================================================
// CLOUDFLARE WORKER ENTRY
// ============================================================

export default {
  async fetch(
    request,
    env
  ) {
    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,

          headers:
            corsHeaders(),
        }
      );
    }


    // --------------------------------------------------------
    // URL
    // --------------------------------------------------------

    const url =
      new URL(
        request.url
      );


    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      (
        url.pathname === "/" ||
        url.pathname === "/health"
      )
    ) {
      return handleHealth();
    }


    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

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
        const message =
          error?.message ||
          "Unexpected Worker error.";

        console.error(
          "UNHANDLED CHAT ERROR:",
          message
        );

        // We cannot safely save the error here unless
        // the request body has already been parsed.
        //
        // handleChat handles all expected failures
        // and saves them to chat_messages.reply.
        return jsonResponse(
          {
            error:
              "Something went wrong while processing the request.",
          },
          500
        );
      }
    }


    // --------------------------------------------------------
    // 404
    // --------------------------------------------------------

    return jsonResponse(
      {
        error:
          "Not found.",
      },
      404
    );
  },
};
