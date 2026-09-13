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

    if (request.method === "GET" && url.pathname === "/") {

      return json({
        success: true,
        message: "Reportli Chat Worker is running"
      });

    }


    // ========================================================
    // CHAT
    // ========================================================

    if (request.method === "POST" && url.pathname === "/chat") {

      try {

        // ----------------------------------------------------
        // Read request
        // ----------------------------------------------------

        const body = await request.json();

        const {
          user_id,
          application_id,
          conversation_id,
          question
        } = body;


        // ----------------------------------------------------
        // Validate request
        // ----------------------------------------------------

        if (!user_id) {
          return json({
            success: false,
            error: "user_id is required"
          }, 400);
        }

        if (!application_id) {
          return json({
            success: false,
            error: "application_id is required"
          }, 400);
        }

        if (!conversation_id) {
          return json({
            success: false,
            error: "conversation_id is required"
          }, 400);
        }

        if (!question || !question.trim()) {
          return json({
            success: false,
            error: "question is required"
          }, 400);
        }


        // ====================================================
        // GENERATE AI REPLY
        // ====================================================

        // ----------------------------------------------------
        // TEMPORARY TEST REPLY
        // ----------------------------------------------------
        //
        // Replace this section with your actual AI call later.
        //

        const reply =
          `I received your question: "${question.trim()}"`;


        // ====================================================
        // SAVE AI REPLY TO SUPABASE
        // ====================================================

        const messageId =
          `msg_${crypto.randomUUID()}`;


        const supabaseResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/chat_messages`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",

              "apikey":
                env.SUPABASE_SERVICE_ROLE_KEY,

              "Authorization":
                `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

              "Prefer":
                "return=representation"
            },

            body: JSON.stringify({

              // ------------------------------------------------
              // Message information
              // ------------------------------------------------

              id: messageId,

              user_id: user_id,

              application_id: application_id,

              conversation_id: conversation_id,

              // ------------------------------------------------
              // This is an AI message
              // ------------------------------------------------

              role: "AI",

              // ------------------------------------------------
              // IMPORTANT:
              //
              // The frontend already saved the question.
              // Therefore the Worker does NOT save question.
              // ------------------------------------------------

              question: null,

              // ------------------------------------------------
              // Save only the AI reply
              // ------------------------------------------------

              reply: reply

            })
          }
        );


        // ====================================================
        // SUPABASE RESPONSE
        // ====================================================

        const supabaseText =
          await supabaseResponse.text();


        // ====================================================
        // SUPABASE ERROR
        // ====================================================

        if (!supabaseResponse.ok) {

          return json({

            success: false,

            error: "Failed to save AI reply to Supabase",

            supabase_status:
              supabaseResponse.status,

            details:
              supabaseText

          }, 500);

        }


        // ====================================================
        // PARSE SAVED MESSAGE
        // ====================================================

        let savedMessage;

        try {

          savedMessage =
            JSON.parse(supabaseText);

        } catch {

          savedMessage =
            supabaseText;

        }


        // ====================================================
        // RETURN REPLY TO FRONTEND
        // ====================================================

        return json({

          success: true,

          reply: reply,

          message: savedMessage

        });


      } catch (error) {

        // ====================================================
        // GENERAL ERROR
        // ====================================================

        return json({

          success: false,

          error: error.message || "Unknown error"

        }, 500);

      }

    }


    // ========================================================
    // UNKNOWN ROUTE
    // ========================================================

    return json({

      success: false,

      error: "Method not allowed",

      method: request.method,

      path: url.pathname

    }, 405);

  }
};


// ============================================================
// CORS HEADERS
// ============================================================

function corsHeaders() {

  return {

    "Access-Control-Allow-Origin": "*",

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

function json(data, status = 200) {

  return new Response(

    JSON.stringify(data),

    {

      status: status,

      headers: corsHeaders()

    }

  );

    }
