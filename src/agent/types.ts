export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type ToolCall = {
  id: string;
  name: string;
  args: JsonObject;
};

export type StopReason = "stop" | "length" | "tool_use";

export type SystemMessage = {
  role: "system";
  content: string;
};

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  responseId?: string;
  responseModel?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export type ToolMessage = {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
};

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonObject;
};

export type ModelRequest = {
  messages: Message[];
  tools?: ToolDefinition[];
};

export type ModelCallOptions = {
  signal?: AbortSignal;
};

export interface ModelClient {
  complete(request: ModelRequest, options?: ModelCallOptions): Promise<AssistantMessage>;
}
