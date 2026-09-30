import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import type { AssistantMessage, Message, ModelClient } from "../src/agent/types.ts";

const reply = (content = "done", toolCalls: AssistantMessage["toolCalls"] = []): AssistantMessage => ({role:"assistant", content, toolCalls, stopReason:toolCalls.length ? "tool_use" : "stop", responseId:"offline-id", usage:{inputTokens:1,outputTokens:2,totalTokens:3}});
const config = {model:"offline-v1", workspace:"fixture", prompt:"report-v1", tools:["read_file","write_file"]};
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mini-session-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  return {root, path:join(root,"session.jsonl")};
}
async function api() { return import("../src/session/session.ts"); }

test("awaited message sink persists user, assistant and tool before effects and next request", async () => {
  const saved: Message[] = [];
  let calls = 0;
  const result = await runAgentLoop({input:"hello", client:{async complete() {
    assert.equal(saved.at(-1)?.role, calls === 0 ? "user" : "tool");
    return calls++ === 0 ? reply("",[{id:"a",name:"echo",args:{}}]) : reply();
  }}, tools:[{name:"echo",description:"echo",parameters:{},async execute() {
    assert.equal(saved.at(-1)?.role,"assistant"); return "ok";
  }}], onMessage: async (message: Message) => { await new Promise(resolve => setTimeout(resolve,5)); saved.push(message); }});
  assert.deepEqual(saved,result.messages);
});

test("sink rejection prevents model and tool side effects", async () => {
  let effects = 0;
  await assert.rejects(runAgentLoop({input:"hello", client:{async complete() { effects++; return reply(); }},
    onMessage:async () => { throw Error("disk failed"); }}), /disk failed/);
  assert.equal(effects,0);
});

test("session round-trips all internal messages and metadata into next request", async t => {
  const {path} = await fixture(t); const {AgentSession} = await api();
  let turns = 0;
  const first = await AgentSession.create({path,config,initialMessages:[{role:"system",content:"system"}],client:{async complete() {
    return turns++ === 0 ? reply("",[{id:"read",name:"missing",args:{path:"a"}}]) : reply("old answer");
  }}});
  const result = await first.run("old question"); await first.close();
  const second = await AgentSession.resume({path,config,client:{async complete(request) {
    assert.deepEqual(request.messages.slice(0,-1),result.messages);
    assert.equal(request.messages.at(-1)?.content,"new question"); return reply("new answer");
  }}});
  assert.equal((await second.run("new question")).output,"new answer"); await second.close();
  const records = (await readFile(path,"utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(records[0].version,1); assert.equal(records[0].type,"header");
  assert.deepEqual(records.slice(1).map(record => record.message),[...result.messages,{role:"user",content:"new question"},reply("new answer")]);
});

test("version and configuration mismatch reject restore", async t => {
  const {path} = await fixture(t); const {AgentSession} = await api();
  const client: ModelClient = {async complete(){return reply();}};
  const session = await AgentSession.create({path,config,client}); await session.close();
  await assert.rejects(AgentSession.resume({path,config:{...config,model:"other"},client}), /configuration mismatch/);
  const raw = await readFile(path,"utf8"); await writeFile(path,raw.replace('"version":1','"version":9'));
  await assert.rejects(AgentSession.resume({path,config,client}), /version/);
});

test("bad JSON, truncated final line and invalid message reject with explicit errors", async t => {
  const {path} = await fixture(t); const {AgentSession} = await api();
  const client: ModelClient = {async complete(){return reply();}};
  const session = await AgentSession.create({path,config,client}); await session.close();
  const header = await readFile(path,"utf8");
  for (const [suffix, pattern] of [["{oops}\n",/line 2/],["{\"type\":",/truncated/],[JSON.stringify({type:"message",message:{role:"alien",content:"x"}})+"\n",/line 2/]] as const) {
    await writeFile(path,header+suffix);
    await assert.rejects(AgentSession.resume({path,config,client}),pattern);
  }
});

test("unpaired or mismatched tool calls refuse resume without replay", async t => {
  const {path} = await fixture(t); const {AgentSession} = await api();
  let effects = 0; const client: ModelClient = {async complete(){effects++;return reply();}};
  const session = await AgentSession.create({path,config,client}); await session.close();
  const header = await readFile(path,"utf8");
  const call = {type:"message",message:reply("",[{id:"write1",name:"write_file",args:{path:"a",content:"side effect"}}])};
  for (const tail of [[],[{type:"message",message:{role:"tool",toolCallId:"write1",name:"wrong",content:"ok"}}],[{type:"message",message:reply()}]]) {
    await writeFile(path,header+[call,...tail].map(x=>JSON.stringify(x)+"\n").join(""));
    await assert.rejects(AgentSession.resume({path,config,client}),/tool/);
  }
  assert.equal(effects,0);
});

test("concurrent runs and duplicate process-local session owners are rejected", async t => {
  const {path} = await fixture(t); const {AgentSession} = await api();
  let release!: () => void; const gate = new Promise<void>(resolve=>{release=resolve;});
  const client: ModelClient = {async complete(){await gate;return reply();}};
  const session = await AgentSession.create({path,config,client});
  await assert.rejects(AgentSession.resume({path,config,client}), /already open/);
  const first = session.run("first"); await assert.rejects(session.run("second"), /busy/);
  await assert.rejects(session.close(),/busy/); release(); await first; await session.close();
  await assert.rejects(session.run("closed"), /closed/);
});

test("failed run poisons instance; existing log is never overwritten", async t => {
  const {path} = await fixture(t); const {AgentSession} = await api();
  const client: ModelClient = {async complete(){throw Error("model failed");}};
  const session = await AgentSession.create({path,config,client});
  await assert.rejects(session.run("first"),/model failed/);
  await assert.rejects(session.run("retry"),/failed/); await session.close();
  const before = await readFile(path,"utf8");
  await assert.rejects(AgentSession.create({path,config,client}),/EEXIST/);
  assert.equal(await readFile(path,"utf8"),before);
});

test("offline report demo runs in two processes, restores context and writes a real report", async t => {
  const {root} = await fixture(t);
  for (const mode of ["save","resume"]) {
    const result = spawnSync(process.execPath,["--experimental-strip-types","src/report-demo.ts",mode,root],{cwd:process.cwd(),encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,mode === "save" ? /saved messages=/ : /restored old context=true/);
  }
  assert.match(await readFile(join(root,"report.md"),"utf8"),/本地资料/);
});
