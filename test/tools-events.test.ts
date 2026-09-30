import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import { createFileTools } from "../src/tools/index.ts";
import type { AssistantMessage, ModelClient } from "../src/agent/types.ts";

const reply = (text: string, calls: AssistantMessage["toolCalls"] = []): AssistantMessage =>
  ({ role: "assistant", content: text, toolCalls: calls, stopReason: calls.length ? "tool_use" : "stop" });

function client(replies: AssistantMessage[]): ModelClient {
  return { async complete() { const value = replies.shift(); if (!value) throw Error("no reply"); return value; } };
}

test("events report ordered lifecycle and correlated tool result", async () => {
  const events: string[] = [];
  const result = await runAgentLoop({ input: "x", client: client([
    reply("", [{ id: "a", name: "echo", args: { text: "hi" } }]), reply("done"),
  ]), tools: [{ name: "echo", description: "echo", parameters: { type: "object" }, async execute(args) { return String(args.text); } }],
  onEvent(event) { events.push(event.type + ("toolCallId" in event ? `:${event.toolCallId}` : "")); },
  });
  assert.equal(result.output, "done");
  assert.deepEqual(events, ["agent_start", "turn_start", "message", "tool_start:a", "tool_end:a", "turn_end", "turn_start", "message", "turn_end", "agent_end"]);
});

test("failed tool emits tool_end with error and remains visible to next turn", async () => {
  const events: unknown[] = [];
  const result = await runAgentLoop({ input: "x", client: client([
    reply("", [{ id: "a", name: "missing", args: {} }]), reply("recovered"),
  ]), onEvent(event) { events.push(event); } });
  assert.equal(result.output, "recovered");
  assert.equal((events.find((e) => (e as {type: string}).type === "tool_end") as {result: {isError: boolean}}).result.isError, true);
});

test("event callback exception propagates; events are observation not persistence", async () => {
  await assert.rejects(runAgentLoop({ input: "x", client: client([reply("done")]),
    onEvent() { throw Error("observer failed"); } }), /observer failed/);
});

test("read/write tools validate arguments, persist UTF-8, and reject traversal and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mini-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "mini-outside-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, {recursive:true, force:true}); await rm(outside, {recursive:true, force:true}); });
  const tools = createFileTools(root);
  const read = tools.find(x => x.name === "read_file")!;
  const write = tools.find(x => x.name === "write_file")!;
  await write.execute({path: "notes/a.txt", content: "你好"}, {toolCallId:"a"});
  assert.equal(await readFile(join(root,"notes/a.txt"), "utf8"), "你好");
  assert.equal(await read.execute({path:"notes/a.txt"}, {toolCallId:"b"}), "你好");
  await assert.rejects(write.execute({path:"../escape",content:"x"}, {toolCallId:"c"}), /outside workspace/);
  await assert.rejects(read.execute({path:"notes/a.txt", extra:true}, {toolCallId:"d"}), /Unexpected argument/);
  await writeFile(join(outside,"secret"), "secret");
  await symlink(outside, join(root,"link"));
  await assert.rejects(read.execute({path:"link/secret"}, {toolCallId:"e"}), /outside workspace/);
  await assert.rejects(write.execute({path:"link/new", content:"x"}, {toolCallId:"f"}), /outside workspace/);
  await symlink(join(outside,"not-created"), join(root,"dangling"));
  await assert.rejects(write.execute({path:"dangling",content:"x"}, {toolCallId:"g"}), /dangling symlink/);
  await assert.rejects(readFile(join(outside,"not-created")), {code:"ENOENT"});
});

test("real file tool result returns to the model in the next request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mini-integration-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, {recursive:true, force:true}); });
  await writeFile(join(root, "note.txt"), "实际内容");
  const requests: string[] = [];
  const model: ModelClient = { async complete(request) {
    requests.push(JSON.stringify(request.messages));
    return requests.length === 1 ? reply("", [{id:"read1", name:"read_file", args:{path:"note.txt"}}]) : reply("读到了：实际内容");
  }};
  const output = await runAgentLoop({input:"读文件", client:model, tools:createFileTools(root)});
  assert.equal(output.output, "读到了：实际内容");
  assert.match(requests[1]!, /实际内容/);
  assert.match(requests[1]!, /read1/);
});

test("shell tool requires explicit opt-in, limits output and times out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mini-shell-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, {recursive:true, force:true}); });
  assert.equal(createFileTools(root).some(x => x.name === "run_shell"), false);
  const shell = createFileTools(root, {allowShell:true, shellTimeoutMs:200, maxOutputBytes:32}).find(x => x.name === "run_shell")!;
  assert.equal(await shell.execute({command:"printf hello"}, {toolCallId:"a"}), "hello");
  await assert.rejects(shell.execute({command:"sleep 2"}, {toolCallId:"b"}), /timed out/);
  assert.match(await shell.execute({command:"printf 123456789012345678901234567890123456789"}, {toolCallId:"c"}), /truncated/);
});
