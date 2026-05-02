#!/usr/bin/env node

import dotenv from "dotenv";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverTools } from "./lib/tools.js";

import path from "path";
import { fileURLToPath } from "url";
import fs from "fs"; // Added for file system checks

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.error("[DEBUG] MCP Server starting...");

// --- SECURITY IMPROVEMENTS START ---
// Verify script permissions before proceeding
try {
  const scriptPath = path.resolve(__dirname, "mcpServer.js");
  fs.accessSync(scriptPath, fs.constants.R_OK);
  console.error("[DEBUG] Script permissions verified");
} catch (err) {
  console.error("[FATAL] Permission error accessing main script:");
  console.error(`[FATAL] ${err.message}`);
  console.error("[FATAL] Run: chmod u+rwx " + path.resolve(__dirname));
  process.exit(1);
}

// Enhanced environment loading with error handling
const envPath = path.resolve(__dirname, ".env");
try {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.error("[DEBUG] Environment loaded from", envPath);
  } else {
    console.error("[WARN] .env file not found at", envPath);
  }
} catch (err) {
  console.error("[FATAL] Error loading .env file:", err);
  process.exit(1);
}
// --- SECURITY IMPROVEMENTS END ---

// Verify required environment variables
const REQUIRED_ENV = ["REPLIERS_API_KEY"];
let missingVars = [];
REQUIRED_ENV.forEach((env) => {
  if (!process.env[env]) {
    console.error(`[FATAL] Missing required environment variable: ${env}`);
    missingVars.push(env);
  }
});

if (missingVars.length > 0) {
  console.error("[FATAL] Server cannot start without required variables");
  process.exit(1);
}

const SERVER_NAME = "repliers-mcp-server";

// Process event handlers for debugging
process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

process.on("exit", (code) => {
  console.error(`[DEBUG] Process exiting with code: ${code}`);
});

process.on("SIGINT", () => {
  console.error("[DEBUG] Received SIGINT");
});

process.on("SIGTERM", () => {
  console.error("[DEBUG] Received SIGTERM");
});

async function transformTools(tools) {
  console.error("[DEBUG] Transforming tools, count:", tools.length);
  return tools
    .map((tool) => {
      const definitionFunction = tool.definition?.function;
      if (!definitionFunction) return;
      return {
        name: definitionFunction.name,
        description: definitionFunction.description,
        inputSchema: definitionFunction.parameters,
      };
    })
    .filter(Boolean);
}

async function setupServerHandlers(server, tools) {
  console.error("[DEBUG] Setting up server handlers");

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await transformTools(tools),
  }));

  // Call tool handler - FIXED VERSION
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    console.error(`[DEBUG] Tool call requested: ${toolName}`);

    const tool = tools.find((t) => t.definition.function.name === toolName);

    if (!tool) {
      console.error(`[ERROR] Tool not found: ${toolName}`);
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }

    const args = request.params.arguments;
    const requiredParameters =
      tool.definition?.function?.parameters?.required || [];

    for (const requiredParameter of requiredParameters) {
      if (!(requiredParameter in args)) {
        console.error(`[ERROR] Missing parameter: ${requiredParameter}`);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required parameter: ${requiredParameter}`
        );
      }
    }

    try {
      const result = await tool.function(args);
      const apiEndpoint = result.url || `https://api.repliers.io/${toolName}`;

      return {
        content: [
          {
            type: "text",
            text:
              `🔗 **API Endpoint Used**\n` +
              "```\n" +
              `${apiEndpoint}\n` +
              "```\n",
          },
          {
            type: "text",
            text:
              typeof result.data === "string"
                ? result.data
                : JSON.stringify(result.data || result, null, 2),
          },
        ],
      };
    } catch (error) {
      const apiEndpoint = `https://api.repliers.io/${toolName}`;

      return {
        content: [
          {
            type: "text",
            text:
              `🔗 **API Endpoint Used**\n` +
              "```\n" +
              `${apiEndpoint}\n` +
              "```\n\n" +
              `❌ **Error**\n${error.message}`,
          },
        ],
      };
    }
  });

  console.error("[DEBUG] Server handlers set up successfully");
}

async function run() {
  try {
    console.error("[DEBUG] Starting run function");
    const args = process.argv.slice(2);
    const isSSE = args.includes("--sse");

    if (isSSE) {
      console.error("[DEBUG] Starting SSE mode");

      const app = express();
      app.use(express.json());

      const transports = {};
      const servers = {};

      // Request logging middleware
      app.use((req, res, next) => {
        console.error(`[REQUEST] ${req.method} ${req.path} from ${req.ip}`);
        next();
      });

      // Health check endpoint for Railway
      app.get("/health", (_req, res) => {
        console.error("[HEALTH] Health check requested");
        res.status(200).json({ 
          status: "ok", 
          service: SERVER_NAME,
          timestamp: new Date().toISOString()
        });
      });

      // Root endpoint
      app.get("/", (_req, res) => {
        console.error("[ROOT] Root endpoint requested");
        res.status(200).json({ 
          status: "ok", 
          service: SERVER_NAME,
          version: "0.1.0",
          endpoints: {
            health: "/health",
            sse: "/sse",
            messages: "/messages"
          }
        });
      });

      // SSE endpoint for MCP connections
      app.get("/sse", async (_req, res) => {
        console.error("[SSE] SSE connection request received");

        const server = new Server(
          {
            name: SERVER_NAME,
            version: "0.1.0",
          },
          {
            capabilities: {
              tools: {},
            },
          }
        );

        server.onerror = (error) => console.error("[SERVER ERROR]", error);

        const tools = await discoverTools();
        await setupServerHandlers(server, tools);

        const transport = new SSEServerTransport("/messages", res);
        transports[transport.sessionId] = transport;
        servers[transport.sessionId] = server;

        res.on("close", async () => {
          console.error("[SSE] SSE connection closed, sessionId:", transport.sessionId);
          delete transports[transport.sessionId];
          await server.close();
          delete servers[transport.sessionId];
        });

        await server.connect(transport);
        console.error("[SSE] SSE server connected, sessionId:", transport.sessionId);
      });

      // Messages endpoint for MCP protocol
      app.post("/messages", express.json(), async (req, res) => {
        const sessionId = req.query.sessionId;
        console.error("[MESSAGES] Message received for sessionId:", sessionId);
        
        const transport = transports[sessionId];
        const server = servers[sessionId];

        if (transport && server) {
          await transport.handlePostMessage(req, res);
        } else {
          console.error("[MESSAGES] No transport/server found for sessionId:", sessionId);
          res.status(400).json({ 
            error: "No transport/server found for sessionId",
            sessionId 
          });
        }
      });

      const port = process.env.PORT || 3001;
      const host = "0.0.0.0"; // Bind to all interfaces for Railway
      console.error("[DEBUG] Starting Express server on", host + ":" + port);

      const httpServer = app.listen(port, host, () => {
        console.error(`[SSE Server] running on ${host}:${port}`);
        console.error(`[SSE Server] Health check: http://localhost:${port}/health`);
        console.error(`[SSE Server] MCP endpoint: http://localhost:${port}/sse`);
      });

      // Graceful shutdown for Railway
      const shutdown = async () => {
        console.error("[SHUTDOWN] Shutdown signal received");
        
        // Close all active MCP sessions
        for (const sessionId in servers) {
          console.error("[SHUTDOWN] Closing server for session:", sessionId);
          await servers[sessionId].close();
        }
        
        // Close HTTP server
        httpServer.close(() => {
          console.error("[SHUTDOWN] HTTP server closed");
          process.exit(0);
        });

        // Force exit after 10 seconds
        setTimeout(() => {
          console.error("[SHUTDOWN] Forced exit after timeout");
          process.exit(1);
        }, 10000);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);

    } else {
      console.error("[DEBUG] Starting stdio mode for Claude Studio");

      // Create server instance
      const server = new Server(
        {
          name: SERVER_NAME,
          version: "0.1.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Setup error handling
      server.onerror = (error) => {
        console.error("[SERVER ERROR]", error);
        process.exit(1);
      };

      // Initialize tools
      console.error("[DEBUG] Discovering tools...");
      const tools = await discoverTools();
      console.error(`[DEBUG] ${tools.length} tools discovered`);

      // Setup protocol handlers
      await setupServerHandlers(server, tools);

      // Create stdio transport
      const transport = new StdioServerTransport();

      // Connect to transport
      await server.connect(transport);
      console.error("[DEBUG] MCP server ready in stdio mode");

      // Graceful shutdown handlers
      const shutdown = async () => {
        console.error("[DEBUG] Shutdown signal received");
        await server.close();
        console.error("[DEBUG] Server closed gracefully");
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Keep process alive
      await new Promise(() => {});
    }
  } catch (error) {
    console.error("[FATAL ERROR]", error);
    process.exit(1);
  }
}

console.error("[DEBUG] Starting server...");
run().catch((error) => {
  console.error("[FATAL] Run function failed:", error);
  process.exit(1);
});
