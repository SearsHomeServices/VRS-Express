import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupWebSocket } from "./websocket";
import { loadConfig as loadBusinessHoursConfig } from "./business-hours-config";
import { probeSnowflakeSDK } from "./services/snowflake";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    } else if (path.startsWith("/objects/")) {
      // Tyler 2026-05-07 — VRS reported "can't see photos/videos in Ticket
      // Detail". The original logger only captured /api/*, so /objects/<uuid>
      // requests (which serve the photo/video bytes) were invisible in
      // production logs, making the failure unreproducible. Log EVERY
      // /objects/* request (success and failure) with status, duration, byte
      // counts, and Range header so we can debug image and video issues going
      // forward. Errors are tagged so they're easy to grep.
      const range = (req.headers["range"] as string | undefined) || "-";
      const contentLength = res.getHeader("content-length") ?? "-";
      const contentType = res.getHeader("content-type") ?? "-";
      const tag = res.statusCode >= 400 ? "[objects-error]" : "[objects]";
      log(
        `${tag} ${req.method} ${path} ${res.statusCode} in ${duration}ms ` +
          `range=${range} bytes=${contentLength} type=${contentType}`,
      );
    }
  });

  next();
});

(async () => {
  // Tyler 2026-05-01 — diagnostic probe for runtime-image regression where
  // the production Reserved-VM publish (commit ea5f429, 5:53 AM CDT) caused
  // every Snowflake-backed proc_id/client_nm lookup to silently fall back
  // to "Not Found". Logs a single line at startup so we can tell from the
  // deployment console whether the SDK is loadable in this image.
  // Pure logging — never throws, never blocks.
  try {
    const probe = probeSnowflakeSDK();
    if (probe.ok) {
      log(`[snowflake-probe] OK version=${probe.version || "unknown"}`);
    } else {
      log(
        `[snowflake-probe] FAIL code=${probe.errorCode || "n/a"} error="${probe.error}" stack="${probe.errorStack}"`,
      );
    }
  } catch (probeErr: any) {
    // Belt-and-suspenders: probe is supposed to be no-throw.
    log(`[snowflake-probe] internal error: ${probeErr?.message || String(probeErr)}`);
  }

  // Warm the business-hours config cache before any request can hit the SMS
  // gate or analytics aggregations. Falls back to compile-time defaults if
  // the system_settings row is missing, malformed, or the DB read fails.
  await loadBusinessHoursConfig();

  await registerRoutes(httpServer, app);
  setupWebSocket(httpServer);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
