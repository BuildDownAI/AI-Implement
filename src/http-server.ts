import type http from "node:http";

type RequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Keep an unexpected request-handler failure scoped to that request. Async
 * route handlers should still handle their own expected errors close to the
 * source; this is the final process-safety boundary.
 */
export function withRequestErrorBoundary(
  handler: RequestHandler,
  logError: (message: string, error: unknown) => void = console.error,
): http.RequestListener {
  return (req, res) => {
    const respond = (error: unknown): void => {
      logError("[server] Unhandled request error:", error);
      if (res.headersSent) {
        res.destroy(asError(error));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    };

    try {
      const result = handler(req, res);
      if (result && typeof result.then === "function") {
        void result.catch(respond);
      }
    } catch (error) {
      respond(error);
    }
  };
}
