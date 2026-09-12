export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // GET /
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Reportli Chat Worker is running"
        }),
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    // POST /chat
    if (request.method === "POST" && url.pathname === "/chat") {
      try {
        const body = await request.json();

        const {
          user_id,
          application_id,
          conversation_id,
          question
        } = body;

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

        if (!question) {
          return json({
            success: false,
            error: "question is required"
          }, 400);
        }

        const reply =
          "Test successful. Your question was received by Reportli.";

        return json({
          success: true,
          message: {
            user_id,
            application_id,
            conversation_id,
            role: "AI",
            question,
            reply
          }
        });

      } catch (error) {
        return json({
          success: false,
          error: error.message
        }, 400);
      }
    }

    return json({
      success: false,
      error: "Method not allowed",
      method: request.method,
      path: url.pathname
    }, 405);
  }
};

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}
