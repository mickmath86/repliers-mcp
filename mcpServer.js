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
      // NOTE: Do NOT use express.json() globally - it consumes the request stream
      // before SSEServerTransport.handlePostMessage() can read it

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
      app.get("/sse", async (req, res) => {
        console.error("[SSE] ========== SSE CONNECTION REQUEST ==========");
        console.error("[SSE] Headers:", JSON.stringify(req.headers, null, 2));
        console.error("[SSE] Query:", JSON.stringify(req.query, null, 2));
        console.error("[SSE] IP:", req.ip);
        console.error("[SSE] Method:", req.method);

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
        const sessionId = transport.sessionId;
        
        console.error("[SSE] Created transport with sessionId:", sessionId);
        console.error("[SSE] Transport type:", transport.constructor.name);
        
        transports[sessionId] = transport;
        servers[sessionId] = server;
        
        console.error("[SSE] Active sessions:", Object.keys(transports).length);
        console.error("[SSE] Session IDs:", Object.keys(transports));

        res.on("close", async () => {
          console.error("[SSE] ========== SSE CONNECTION CLOSED ==========");
          console.error("[SSE] Closing sessionId:", sessionId);
          console.error("[SSE] Active sessions before cleanup:", Object.keys(transports).length);
          
          delete transports[sessionId];
          await server.close();
          delete servers[sessionId];
          
          console.error("[SSE] Active sessions after cleanup:", Object.keys(transports).length);
        });

        await server.connect(transport);
        console.error("[SSE] Server connected successfully");
        console.error("[SSE] Client should POST to: /messages?sessionId=" + sessionId);
        console.error("[SSE] ============================================");
      });

      // Messages endpoint for MCP protocol
      // NOTE: No express.json() middleware - SSEServerTransport needs raw stream
      app.post("/messages", async (req, res) => {
        console.error("[MESSAGES] ========== POST /messages REQUEST ==========");
        console.error("[MESSAGES] Timestamp:", new Date().toISOString());
        console.error("[MESSAGES] Method:", req.method);
        console.error("[MESSAGES] URL:", req.url);
        console.error("[MESSAGES] Path:", req.path);
        console.error("[MESSAGES] Query string:", JSON.stringify(req.query, null, 2));
        console.error("[MESSAGES] Headers:", JSON.stringify(req.headers, null, 2));
        console.error("[MESSAGES] Content-Type:", req.headers['content-type']);
        console.error("[MESSAGES] Content-Length:", req.headers['content-length']);
        console.error("[MESSAGES] IP:", req.ip);
        // NOTE: Do NOT log req.body - it would consume the stream before MCP SDK reads it
        
        const sessionId = req.query.sessionId;
        console.error("[MESSAGES] Extracted sessionId:", sessionId);
        console.error("[MESSAGES] SessionId type:", typeof sessionId);
        console.error("[MESSAGES] SessionId is undefined:", sessionId === undefined);
        console.error("[MESSAGES] SessionId is null:", sessionId === null);
        console.error("[MESSAGES] SessionId is empty string:", sessionId === "");
        
        console.error("[MESSAGES] Active sessions:", Object.keys(transports).length);
        console.error("[MESSAGES] Available session IDs:", Object.keys(transports));
        
        const transport = transports[sessionId];
        const server = servers[sessionId];
        
        console.error("[MESSAGES] Transport found:", !!transport);
        console.error("[MESSAGES] Server found:", !!server);

        if (!sessionId) {
          console.error("[MESSAGES] ERROR: sessionId is missing from query string");
          console.error("[MESSAGES] Expected format: POST /messages?sessionId=<id>");
          console.error("[MESSAGES] Received query:", req.query);
          return res.status(400).json({ 
            error: "Missing sessionId in query string",
            message: "Expected format: POST /messages?sessionId=<id>",
            receivedQuery: req.query,
            availableSessions: Object.keys(transports)
          });
        }

        if (!transport || !server) {
          console.error("[MESSAGES] ERROR: No transport/server found for sessionId:", sessionId);
          console.error("[MESSAGES] This usually means:");
          console.error("[MESSAGES]   1. The SSE connection at GET /sse was never established");
          console.error("[MESSAGES]   2. The sessionId is incorrect or expired");
          console.error("[MESSAGES]   3. The SSE connection was closed");
          return res.status(400).json({ 
            error: "No active MCP session found",
            sessionId,
            availableSessions: Object.keys(transports),
            message: "Ensure GET /sse was called first to establish a session"
          });
        }

        try {
          console.error("[MESSAGES] Calling transport.handlePostMessage...");
          await transport.handlePostMessage(req, res);
          console.error("[MESSAGES] Message handled successfully");
        } catch (error) {
          console.error("[MESSAGES] ERROR handling message:", error);
          console.error("[MESSAGES] Error stack:", error.stack);
          if (!res.headersSent) {
            res.status(500).json({ 
              error: "Internal server error handling MCP message",
              message: error.message
            });
          }
        }
        
        console.error("[MESSAGES] ============================================");
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
