import { open, readFile, realpath } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import { runAgentLoop } from "../agent/agent-loop.ts";
import type { RunAgentLoopOptions, AgentLoopResult } from "../agent/agent-loop.ts";
import type { JsonObject, JsonValue, Message } from "../agent/types.ts";

export type SessionOptions = Omit<RunAgentLoopOptions, "input" | "messages" | "onMessage"> & {
  path: string;
  /** Caller-owned identity: include model, prompt/context digest, workspace and tool definitions. */
  config: JsonObject;
};
const owners = new Set<string>();
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validMessage(value: unknown): value is Message {
  if (!object(value) || typeof value.content !== "string") return false;
  if (value.role === "system" || value.role === "user") return true;
  if (value.role === "tool") return typeof value.toolCallId === "string" && typeof value.name === "string" && (value.isError === undefined || typeof value.isError === "boolean");
  if (value.role !== "assistant" || !["stop","length","tool_use"].includes(String(value.stopReason)) || !Array.isArray(value.toolCalls)) return false;
  if (!value.toolCalls.every(c=>object(c) && typeof c.id === "string" && c.id.length > 0 && typeof c.name === "string" && object(c.args))) return false;
  if (value.responseId !== undefined && typeof value.responseId !== "string") return false;
  if (value.responseModel !== undefined && typeof value.responseModel !== "string") return false;
  if (value.usage !== undefined && (!object(value.usage) || !["inputTokens","outputTokens","totalTokens"].every(k=>typeof value.usage === "object" && Number.isInteger((value.usage as Record<string,unknown>)[k]) && Number((value.usage as Record<string,unknown>)[k]) >= 0))) return false;
  return true;
}
function assertPaired(messages: Message[]): void {
  const pending = new Map<string,string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (pending.get(message.toolCallId) !== message.name) throw Error("Session tool result has no matching call/name");
      pending.delete(message.toolCallId);
    } else {
      if (pending.size) throw Error("Session has unpaired tool calls before next message; refusing replay");
      if (message.role === "assistant") for (const call of message.toolCalls) {
        if (pending.has(call.id)) throw Error("Session duplicate tool call id");
        pending.set(call.id,call.name);
      }
    }
  }
  if (pending.size) throw Error("Session has unpaired tool calls; refusing replay of side effects");
}
async function identity(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await realpath(dirname(absolute)),basename(absolute));
  }
}
function line(record: unknown): string { return JSON.stringify(record) + "\n"; }

/** Single-process, flat append-only sessions. No automatic tool replay or recovery repair. */
export class AgentSession {
  private options: SessionOptions;
  private path: string;
  private messages: Message[];
  private busy = false;
  private closed = false;
  private failed = false;
  private constructor(options: SessionOptions, path: string, messages: Message[]) {
    this.options = options; this.path = path; this.messages = messages;
  }
  static async create(options: SessionOptions & {initialMessages?: Message[]}): Promise<AgentSession> {
    const path = await identity(options.path);
    if (owners.has(path)) throw Error("Session already open in this process");
    owners.add(path);
    try {
      const messages = structuredClone(options.initialMessages ?? []);
      if (!messages.every(validMessage)) throw Error("Invalid initial session message");
      assertPaired(messages);
      const config = JSON.parse(JSON.stringify(options.config)) as JsonObject;
      const file = await open(path,"wx",0o600);
      try {
        await file.writeFile(line({type:"header",version:1,config}) + messages.map(message=>line({type:"message",message})).join(""),"utf8");
        await file.sync();
      } finally { await file.close(); }
      return new AgentSession({...options,config},path,messages);
    } catch (error) { owners.delete(path); throw error; }
  }
  static async resume(options: SessionOptions): Promise<AgentSession> {
    const path = await identity(options.path);
    if (owners.has(path)) throw Error("Session already open in this process");
    owners.add(path);
    try {
      const raw = await readFile(path,"utf8");
      if (!raw.endsWith("\n")) throw Error("Session truncated: missing final newline");
      const records: unknown[] = raw.slice(0,-1).split("\n").map((text,index)=>{
        try { return JSON.parse(text); } catch { throw Error(`Session invalid JSON at line ${index+1}`); }
      });
      const header = records[0];
      if (!object(header) || header.type !== "header" || header.version !== 1 || !object(header.config)) throw Error("Session invalid header or unsupported version");
      const config = JSON.parse(JSON.stringify(options.config)) as JsonObject;
      if (canonical(header.config as JsonObject) !== canonical(config)) throw Error("Session configuration mismatch");
      const messages = records.slice(1).map((record,index)=>{
        if (!object(record) || record.type !== "message" || !validMessage(record.message)) throw Error(`Session invalid message at line ${index+2}`);
        return record.message;
      });
      assertPaired(messages);
      return new AgentSession({...options,config},path,messages);
    } catch (error) { owners.delete(path); throw error; }
  }
  async run(input: string): Promise<AgentLoopResult> {
    if (this.closed) throw Error("Session closed");
    if (this.busy) throw Error("Session busy: concurrent runs are not allowed");
    if (this.failed) throw Error("Session failed; close and explicitly resume after inspection");
    this.busy = true;
    try {
      const result = await runAgentLoop({...this.options,input,messages:structuredClone(this.messages),onMessage:async message=>{
        if (!validMessage(message)) throw Error("Invalid session message");
        const snapshot = structuredClone(message);
        const file = await open(this.path,"a");
        try { await file.writeFile(line({type:"message",message:snapshot}),"utf8"); await file.sync(); }
        finally { await file.close(); }
        this.messages.push(snapshot);
      }});
      return result;
    } catch (error) { this.failed = true; throw error; }
    finally { this.busy = false; }
  }
  async close(): Promise<void> {
    if (this.busy) throw Error("Session busy: cannot close while running");
    if (!this.closed) { this.closed = true; owners.delete(this.path); }
  }
}
