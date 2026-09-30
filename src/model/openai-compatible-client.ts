import type {
  AssistantMessage,
  JsonObject,
  Message,
  ModelCallOptions,
  ModelClient,
  ModelRequest,
  StopReason,
  ToolCall,
  ToolDefinition,
} from "../agent/types.ts";

export class ModelHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`Model request failed with HTTP ${status}: ${responseBody || "(empty response)"}`);
    this.name = "ModelHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class ModelProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelProtocolError";
  }
}

export type OpenAICompatibleClientOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
};

type WireToolCall = {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

type WireResponse = {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCall(value: unknown, index: number): ToolCall {
  if (!isJsonObject(value)) {
    throw new ModelProtocolError(`tool_calls[${index}] must be an object`);
  }
  const wire = value as WireToolCall;
  if (typeof wire.id !== "string" || wire.id.length === 0) {
    throw new ModelProtocolError(`tool_calls[${index}].id must be a non-empty string`);
  }
  if (!wire.function || typeof wire.function.name !== "string" || wire.function.name.length === 0) {
    throw new ModelProtocolError(`tool_calls[${index}].function.name must be a non-empty string`);
  }
  if (typeof wire.function.arguments !== "string") {
    throw new ModelProtocolError(`tool_calls[${index}].function.arguments must be a JSON string`);
  }

  let args: unknown;
  try {
    args = JSON.parse(wire.function.arguments);
  } catch (error) {
    throw new ModelProtocolError(
      `tool_calls[${index}].function.arguments is not valid JSON`,
      { cause: error },
    );
  }
  if (!isJsonObject(args)) {
    throw new ModelProtocolError(`tool_calls[${index}].function.arguments must decode to an object`);
  }
  return { id: wire.id, name: wire.function.name, args };
}

function mapStopReason(value: unknown): StopReason {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "tool_calls") return "tool_use";
  throw new ModelProtocolError(`Unsupported finish_reason: ${String(value)}`);
}

function serializeMessage(message: Message): JsonObject {
  if (message.role === "assistant") {
    const wire: JsonObject = {
      role: "assistant",
      content: message.content.length > 0 ? message.content : null,
    };
    if (message.toolCalls.length > 0) {
      wire.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args),
        },
      }));
    }
    return wire;
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function serializeTool(tool: ToolDefinition): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalUsage(value: WireResponse["usage"]): AssistantMessage["usage"] {
  if (!value) return undefined;
  const { prompt_tokens, completion_tokens, total_tokens } = value;
  if (
    typeof prompt_tokens !== "number" ||
    typeof completion_tokens !== "number" ||
    typeof total_tokens !== "number"
  ) {
    throw new ModelProtocolError("usage token counts must be numbers");
  }
  return {
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
    totalTokens: total_tokens,
  };
}

function parseResponse(value: unknown): AssistantMessage {
  if (!isJsonObject(value)) throw new ModelProtocolError("Response body must be a JSON object");
  const wire = value as WireResponse;
  const choice = wire.choices?.[0];
  if (!choice?.message || choice.message.role !== "assistant") {
    throw new ModelProtocolError("Response must contain choices[0].message with role assistant");
  }
  if (choice.message.content !== null && typeof choice.message.content !== "string") {
    throw new ModelProtocolError("Assistant content must be a string or null");
  }
  const rawToolCalls = choice.message.tool_calls ?? [];
  if (!Array.isArray(rawToolCalls)) {
    throw new ModelProtocolError("Assistant tool_calls must be an array");
  }

  const result: AssistantMessage = {
    role: "assistant",
    content: choice.message.content ?? "",
    toolCalls: rawToolCalls.map(parseToolCall),
    stopReason: mapStopReason(choice.finish_reason),
  };
  const responseId = optionalString(wire.id);
  const responseModel = optionalString(wire.model);
  const usage = optionalUsage(wire.usage);
  if (responseId !== undefined) result.responseId = responseId;
  if (responseModel !== undefined) result.responseModel = responseModel;
  if (usage !== undefined) result.usage = usage;
  return result;
}

export class OpenAICompatibleClient implements ModelClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly options: OpenAICompatibleClientOptions;

  constructor(options: OpenAICompatibleClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  async complete(request: ModelRequest, callOptions: ModelCallOptions = {}): Promise<AssistantMessage> {
    const body: JsonObject = {
      model: this.options.model,
      messages: request.messages.map(serializeMessage),
      stream: false,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(serializeTool);
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.options.headers,
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: callOptions.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      throw new ModelHttpError(response.status, detail);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ModelProtocolError("Response body is not valid JSON", { cause: error });
    }
    return parseResponse(payload);
  }
}
