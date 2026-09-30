import type {
  JsonObject,
  Message,
  ModelClient,
  ToolDefinition,
  ToolMessage,
} from "./types.ts";

export type ToolExecutionContext = {
  toolCallId: string;
  signal?: AbortSignal;
};

export type AgentTool = ToolDefinition & {
  execute(args: JsonObject, context: ToolExecutionContext): Promise<string>;
};

export type RunAgentLoopOptions = {
  input: string;
  client: ModelClient;
  messages?: Message[];
  tools?: AgentTool[];
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Awaited durable sink, unlike the synchronous observation events. */
  onMessage?: (message: Message) => Promise<void>;
};

export type AgentEvent =
  | { type: "agent_start" | "agent_end" }
  | { type: "turn_start" | "turn_end"; turn: number }
  | { type: "message"; message: Message; turn: number }
  | { type: "tool_start"; toolCallId: string; name: string; args: JsonObject; turn: number }
  | { type: "tool_end"; toolCallId: string; name: string; result: ToolMessage; turn: number };

export type AgentLoopResult = {
  output: string;
  messages: Message[];
  turns: number;
};

export class AgentLoopLimitError extends Error {
  readonly maxTurns: number;
  readonly messages: Message[];

  constructor(maxTurns: number, messages: Message[]) {
    super(`Agent loop exceeded ${maxTurns} model turns`);
    this.name = "AgentLoopLimitError";
    this.maxTurns = maxTurns;
    this.messages = messages;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function definitions(tools: AgentTool[]): ToolDefinition[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

async function executeToolCall(
  toolCall: { id: string; name: string; args: JsonObject },
  toolByName: Map<string, AgentTool>,
  signal: AbortSignal | undefined,
): Promise<ToolMessage> {
  const tool = toolByName.get(toolCall.name);
  if (!tool) {
    return {
      role: "tool",
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: `Tool not found: ${toolCall.name}`,
      isError: true,
    };
  }

  try {
    signal?.throwIfAborted();
    const content = await tool.execute(toolCall.args, {
      toolCallId: toolCall.id,
      signal,
    });
    return {
      role: "tool",
      toolCallId: toolCall.id,
      name: toolCall.name,
      content,
      isError: false,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      role: "tool",
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: errorText(error),
      isError: true,
    };
  }
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? 8;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new RangeError("maxTurns must be a positive integer");
  }

  const tools = options.tools ?? [];
  const toolByName = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (toolByName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    toolByName.set(tool.name, tool);
  }

  const messages: Message[] = [
    ...(options.messages ?? []),
    { role: "user", content: options.input },
  ];
  const toolDefinitions = definitions(tools);
  await options.onMessage?.(messages[messages.length - 1]!);
  const emit = (event: AgentEvent) => options.onEvent?.(event);
  emit({ type: "agent_start" });

  for (let turns = 1; turns <= maxTurns; turns += 1) {
    options.signal?.throwIfAborted();
    emit({ type: "turn_start", turn: turns });
    const assistant = await options.client.complete(
      { messages, tools: toolDefinitions },
      { signal: options.signal },
    );
    messages.push(assistant);
    await options.onMessage?.(assistant);
    emit({ type: "message", message: assistant, turn: turns });

    if (assistant.toolCalls.length === 0) {
      emit({ type: "turn_end", turn: turns });
      emit({ type: "agent_end" });
      return { output: assistant.content, messages, turns };
    }

    if (assistant.stopReason === "length") {
      for (const toolCall of assistant.toolCalls) {
        const result: ToolMessage = {
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content:
            "Tool call was not executed because the model response hit the output token limit; its arguments may be truncated.",
          isError: true,
        };
        messages.push(result);
        await options.onMessage?.(result);
        emit({ type: "tool_end", toolCallId: toolCall.id, name: toolCall.name, result, turn: turns });
      }
      emit({ type: "turn_end", turn: turns });
      continue;
    }

    for (const toolCall of assistant.toolCalls) {
      emit({ type: "tool_start", toolCallId: toolCall.id, name: toolCall.name, args: toolCall.args, turn: turns });
      const result = await executeToolCall(toolCall, toolByName, options.signal);
      messages.push(result);
      await options.onMessage?.(result);
      emit({ type: "tool_end", toolCallId: toolCall.id, name: toolCall.name, result, turn: turns });
    }
    emit({ type: "turn_end", turn: turns });
  }

  throw new AgentLoopLimitError(maxTurns, messages);
}
