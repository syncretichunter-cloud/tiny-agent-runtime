import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  ModelHttpError,
  ModelProtocolError,
  OpenAICompatibleClient,
} from "../src/model/openai-compatible-client.ts";
import type { ModelRequest } from "../src/agent/types.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const basicRequest: ModelRequest = {
  messages: [
    { role: "system", content: "You are concise." },
    { role: "user", content: "Read package.json" },
  ],
};

test("normalizes a text response and sends the expected request", async () => {
  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer test-key");
    const body = (await readJson(req)) as Record<string, unknown>;
    assert.deepEqual(body, {
      model: "test-model",
      messages: basicRequest.messages,
      stream: false,
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp-1",
      model: "resolved-model",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "Done." },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }));
  }, async (baseUrl) => {
    const client = new OpenAICompatibleClient({ baseUrl, apiKey: "test-key", model: "test-model" });
    const message = await client.complete(basicRequest);
    assert.deepEqual(message, {
      role: "assistant",
      content: "Done.",
      toolCalls: [],
      stopReason: "stop",
      responseId: "resp-1",
      responseModel: "resolved-model",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
  });
});

test("serializes tools and parses tool calls into typed arguments", async () => {
  const request: ModelRequest = {
    messages: [
      ...basicRequest.messages,
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_old", name: "read_file", args: { path: "old.txt" } }],
        stopReason: "tool_use",
      },
      { role: "tool", toolCallId: "call_old", name: "read_file", content: "old content" },
    ],
    tools: [{
      name: "read_file",
      description: "Read one UTF-8 file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
  };

  await withServer(async (req, res) => {
    const body = (await readJson(req)) as any;
    assert.deepEqual(body.messages.at(-2), {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_old",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"old.txt\"}" },
      }],
    });
    assert.deepEqual(body.messages.at(-1), {
      role: "tool",
      tool_call_id: "call_old",
      content: "old content",
    });
    assert.deepEqual(body.tools, [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read one UTF-8 file",
        parameters: request.tools?.[0]?.parameters,
      },
    }]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp-2",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_new",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"package.json\"}" },
          }],
        },
      }],
    }));
  }, async (baseUrl) => {
    const client = new OpenAICompatibleClient({ baseUrl, model: "test-model" });
    const message = await client.complete(request);
    assert.equal(message.stopReason, "tool_use");
    assert.deepEqual(message.toolCalls, [
      { id: "call_new", name: "read_file", args: { path: "package.json" } },
    ]);
  });
});

test("maps length finish reason without inventing text", async () => {
  await withServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ finish_reason: "length", message: { role: "assistant", content: null } }],
    }));
  }, async (baseUrl) => {
    const client = new OpenAICompatibleClient({ baseUrl, model: "test-model" });
    const message = await client.complete(basicRequest);
    assert.equal(message.content, "");
    assert.equal(message.stopReason, "length");
  });
});

test("throws ModelHttpError with bounded response details", async () => {
  await withServer((_req, res) => {
    res.statusCode = 429;
    res.statusMessage = "Too Many Requests";
    res.end("rate limited");
  }, async (baseUrl) => {
    const client = new OpenAICompatibleClient({ baseUrl, model: "test-model" });
    await assert.rejects(
      client.complete(basicRequest),
      (error: unknown) => {
        assert(error instanceof ModelHttpError);
        assert.equal(error.status, 429);
        assert.match(error.message, /rate limited/);
        return true;
      },
    );
  });
});

test("rejects malformed tool arguments instead of executing an ambiguous call", async () => {
  await withServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_bad",
            type: "function",
            function: { name: "read_file", arguments: "{not-json" },
          }],
        },
      }],
    }));
  }, async (baseUrl) => {
    const client = new OpenAICompatibleClient({ baseUrl, model: "test-model" });
    await assert.rejects(client.complete(basicRequest), ModelProtocolError);
  });
});

test("rejects responses without a first assistant choice", async () => {
  await withServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [] }));
  }, async (baseUrl) => {
    const client = new OpenAICompatibleClient({ baseUrl, model: "test-model" });
    await assert.rejects(client.complete(basicRequest), ModelProtocolError);
  });
});

test("honors AbortSignal while the provider request is pending", async () => {
  await withServer((_req, _res) => {
    // Keep the response pending until the client aborts.
  }, async (baseUrl) => {
    const client = new OpenAICompatibleClient({ baseUrl, model: "test-model" });
    const controller = new AbortController();
    const pending = client.complete(basicRequest, { signal: controller.signal });
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(pending, /cancelled|abort/i);
  });
});
