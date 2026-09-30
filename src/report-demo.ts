import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentSession } from "./session/session.ts";
import { loadReportContext } from "./report-assistant.ts";
import type { AssistantMessage, ModelClient } from "./agent/types.ts";

const [mode, directory] = process.argv.slice(2);
if ((mode !== "save" && mode !== "resume") || !directory) throw Error("Usage: node src/report-demo.ts save|resume WORKSPACE");
const root = resolve(directory);
await mkdir(root,{recursive:true});
if (mode === "save") await writeFile(join(root,"source.md"),"本地资料：本周完成 3 项文档整理，待确认 1 项风险。\n","utf8");
const setup = await loadReportContext(root,["source.md"]);
let turn = 0;
let restored = false;
const reply = (content: string, toolCalls: AssistantMessage["toolCalls"] = []): AssistantMessage => ({role:"assistant",content,toolCalls,stopReason:toolCalls.length ? "tool_use" : "stop"});
// Deterministic offline fixture, not a live LLM and not a simulated filesystem.
const client: ModelClient = {async complete(request) {
  if (mode === "save") {
    if (turn++ === 0) return reply("",[{id:"read-source",name:"read_file",args:{path:"source.md"}}]);
    assert(request.messages.some(message=>message.role === "tool" && message.content.includes("本地资料")));
    return reply("已读取 source.md：完成 3 项文档整理，待确认 1 项风险。");
  }
  if (turn++ === 0) {
    assert(request.messages.some(message=>message.role === "user" && message.content === "读取资料并记住要点"));
    assert(request.messages.some(message=>message.role === "assistant" && message.content.startsWith("已读取 source.md")));
    const oldTool = request.messages.find(message=>message.role === "tool" && message.toolCallId === "read-source");
    assert(oldTool && oldTool.content.includes("本地资料"));
    restored = true;
    return reply("",[{id:"write-report",name:"write_file",args:{path:"report.md",content:`# 本地资料报告\n\n来源：source.md\n\n${oldTool.content}\n未知信息：风险详情待确认。\n`}}]);
  }
  assert(request.messages.some(message=>message.role === "tool" && message.content === "Wrote report.md"));
  return reply("报告已写入 report.md，来源为 source.md。");
}};
const options = {path:join(root,"session.jsonl"),config:setup.config,client,tools:setup.tools};
const session = mode === "save" ? await AgentSession.create({...options,initialMessages:setup.initialMessages}) : await AgentSession.resume(options);
try {
  const result = await session.run(mode === "save" ? "读取资料并记住要点" : "根据之前的资料生成报告");
  console.log(mode === "save" ? `saved messages=${result.messages.length}` : `restored old context=${restored}; messages=${result.messages.length}`);
  console.log(result.output);
  if (mode === "resume") console.log(`report.md:\n${await readFile(join(root,"report.md"),"utf8")}`);
} finally { await session.close(); }
