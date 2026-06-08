import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import adminUsersHandler from "./api/admin-users.js";

function localApiPlugin() {
  const describeError = (error: unknown) => {
    if (error instanceof Error) return error.message;

    if (error && typeof error === "object") {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }

    return String(error);
  };

  return {
    name: "arc-clue-local-api",
    configureServer(server) {
      server.middlewares.use("/api/admin-users", async (req, res) => {
        try {
          let rawBody = "";

          for await (const chunk of req) {
            rawBody += chunk;
          }

          req.body = rawBody ? JSON.parse(rawBody) : {};
          res.status = (statusCode) => {
            res.statusCode = statusCode;
            return res;
          };
          res.json = (payload) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(payload));
            return res;
          };

          await adminUsersHandler(req, res);
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: describeError(error),
            }),
          );
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

  return {
    plugins: [react(), localApiPlugin()],
  };
});
