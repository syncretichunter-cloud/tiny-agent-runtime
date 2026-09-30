import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoopLimitError,
  runAgentLoop,
  type AgentTool,
} from "../src/agent/agent-loop.ts";
import type {
  AssistantMessage,
  ModelCallOptions,
  ModelClient,
  ModelRequest,
} from "../src/agent/types.ts";

function assistant(
  content: string,
  options: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    toolCalls: [],
    stopReason: "stop",
    ...options,
  };
}

class ScriptedClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly options: (ModelCallOptions | undefined)[] = [];
  private readonly replies: AssistantMessage[];

  constructor(replies: AssistantMessage[]) {
    this.replies = replies;
  }

  async complete(request: ModelRequest, options?: ModelCallOptions): Promise<AssistantMessage> {
    this.requests.push(structuredClone(request));
    this.options.push(options);
    const reply = this.replies.shift();
    if (!reply) throw new Error("No scripted model reply remains");
    return structuredClone(reply);
  }
}

const readTool: AgentTool = {
  name: "read_file",
  description: "Read one UTF-8 file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args) {
    return `contents:${String(args.path)}`;
  },
};

test("returns a final text response after one model turn", async () => {
  const client = new ScriptedClient([assistant("Done.")]);

  const result = await runAgentLoop({ input: "Say done", client });

  assert.equal(result.output, "Done.");
  assert.equal(result.turns, 1);
  assert.deepEqual(result.messages, [
    { role: "user", content: "Say done" },
    assistant("Done."),
  ]);
  assert.deepEqual(client.requests[0], {
    messages: [{ role: "user", content: "Say done" }],
    tools: undefined,
  });
});

test("executes a tool, appends its correlated result, and asks the model again", async () => {
  const client = new ScriptedClient([
    assistant("", {
      stopReason: "tool_use",
      toolCalls: [{ id: "call_1", name: "read_file", args: { path: "a.txt" } }],
    }),
    assistant("The file says hello."),
  ]);

  const result = await runAgentLoop({ input: "Read a.txt", client, tools: [readTool] });

  assert.equal(result.output, "The file says hello.");
  assert.equal(result.turns, 2);
  assert.deepEqual(client.requests[1]?.messages.at(-1), {
    role: "tool",
    toolCallId: "call_1",
    name: "read_file",
    content: "contents:a.txt",
    isError: false,
  });
  assert.deepEqual(client.requests[0]?.tools, [{
    name: readTool.name,
    description: readTool.description,
    parameters: readTool.parameters,
  }]);
});

test("executes multiple tool calls sequentially in model order", async () => {
  const order: string[] = [];
  const tool: AgentTool = {
    ...readTool,
    async execute(args) {
      order.push(String(args.path));
      return String(args.path);
    },
  };
  const client = new ScriptedClient([
    assistant("", {
      stopReason: "tool_use",
      toolCalls: [
        { id: "call_a", name: "read_file", args: { path: "first" } },
        { id: "call_b", name: "read_file", args: { path: "second" } },
      ],
    }),
    assistant("Both read."),
  ]);

  const result = await runAgentLoop({ input: "Read both", client, tools: [tool] });

  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(
    result.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
    ["call_a", "call_b"],
  );
});

test("turns an unknown tool into an error message so the model can recover", async () => {
  const client = new ScriptedClient([
    assistant("", {
      stopReason: "tool_use",
      toolCalls: [{ id: "call_missing", name: "missing", args: {} }],
    }),
    assistant("I cannot use that tool."),
  ]);

  const result = await runAgentLoop({ input: "Try it", client, tools: [readTool] });

  assert.equal(result.output, "I cannot use that tool.");
  assert.deepEqual(client.requests[1]?.messages.at(-1), {
    role: "tool",
    toolCallId: "call_missing",
    name: "missing",
    content: "Tool not found: missing",
    isError: true,
  });
});

test("turns a thrown tool error into a correlated error message", async () => {
  const failingTool: AgentTool = {
    ...readTool,
    async execute() {
      throw new Error("permission denied");
    },
  };
  const client = new ScriptedClient([
    assistant("", {
      stopReason: "tool_use",
      toolCalls: [{ id: "call_fail", name: "read_file", args: { path: "secret" } }],
    }),
    assistant("The read failed."),
  ]);

  await runAgentLoop({ input: "Read it", client, tools: [failingTool] });

  assert.deepEqual(client.requests[1]?.messages.at(-1), {
    role: "tool",
    toolCallId: "call_fail",
    name: "read_file",
    content: "permission denied",
    isError: true,
  });
});

test("does not execute tool calls from a length-truncated assistant message", async () => {
  let executions = 0;
  const tool: AgentTool = {
    ...readTool,
    async execute() {
      executions += 1;
      return "should not run";
    },
  };
  const client = new ScriptedClient([
    assistant("", {
      stopReason: "length",
      toolCalls: [{ id: "call_cut", name: "read_file", args: { path: "possibly-incomplete" } }],
    }),
    assistant("Please retry with complete arguments."),
  ]);

  const result = await runAgentLoop({ input: "Read it", client, tools: [tool] });

  assert.equal(executions, 0);
  assert.equal(result.output, "Please retry with complete arguments.");
  assert.deepEqual(client.requests[1]?.messages.at(-1), {
    role: "tool",
    toolCallId: "call_cut",
    name: "read_file",
    content: "Tool call was not executed because the model response hit the output token limit; its arguments may be truncated.",
    isError: true,
  });
});

test("stops before exceeding the configured model-turn limit", async () => {
  const repeatCall = assistant("", {
    stopReason: "tool_use",
    toolCalls: [{ id: "call_repeat", name: "read_file", args: { path: "again" } }],
  });
  const client = new ScriptedClient([repeatCall, repeatCall, assistant("too late")]);

  await assert.rejects(
    runAgentLoop({ input: "Loop", client, tools: [readTool], maxTurns: 2 }),
    (error: unknown) => {
      assert(error instanceof AgentLoopLimitError);
      assert.equal(error.maxTurns, 2);
      assert.equal(error.messages.at(-1)?.role, "tool");
      return true;
    },
  );
  assert.equal(client.requests.length, 2);
});

test("rejects invalid turn limits before calling the model", async () => {
  const client = new ScriptedClient([assistant("unused")]);

  await assert.rejects(
    runAgentLoop({ input: "No turns", client, maxTurns: 0 }),
    /maxTurns must be a positive integer/,
  );
  assert.equal(client.requests.length, 0);
});

test("rejects duplicate tool names instead of silently replacing one", async () => {
  const client = new ScriptedClient([assistant("unused")]);
  const replacement: AgentTool = { ...readTool, execute: async () => "replacement" };

  await assert.rejects(
    runAgentLoop({ input: "Read", client, tools: [readTool, replacement] }),
    /Duplicate tool name: read_file/,
  );
  assert.equal(client.requests.length, 0);
});

test("passes the same AbortSignal to model calls and tool execution", async () => {
  const controller = new AbortController();
  let toolSignal: AbortSignal | undefined;
  const tool: AgentTool = {
    ...readTool,
    async execute(_args, context) {
      toolSignal = context.signal;
      return "ok";
    },
  };
  const client = new ScriptedClient([
    assistant("", {
      stopReason: "tool_use",
      toolCalls: [{ id: "call_signal", name: "read_file", args: {} }],
    }),
    assistant("Done."),
  ]);

  await runAgentLoop({ input: "Run", client, tools: [tool], signal: controller.signal });

  assert.equal(client.options[0]?.signal, controller.signal);
  assert.equal(client.options[1]?.signal, controller.signal);
  assert.equal(toolSignal, controller.signal);
});
