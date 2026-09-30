import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const cli = resolve("src/chat.ts");
type Request = { model: string; messages: Array<{role: string; content: string}>; tools: Array<{function: {name: string}}> };
const answer = (content: string) => ({choices:[{finish_reason:"stop",message:{role:"assistant",content}}]});
async function fixture(t: TestContext, respond: (request: Request, count: number) => unknown = (_, n) => answer(`reply-${n}`)) {
  const dir = await mkdtemp(join(tmpdir(), "tiny-chat-"));
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/v1/chat/completions");
    const request = JSON.parse(body) as Request;
    requests.push(request);
    const result = respond(request, requests.length);
    if (result === "hang") return;
    if (result === "error") { res.writeHead(503); res.end("fixture unavailable"); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert(address && typeof address !== "string");
  const env = {PATH: process.env.PATH, OPENAI_MODEL:"fixture-model", OPENAI_BASE_URL:`http://127.0.0.1:${address.port}/v1`, OPENAI_API_KEY:"fixture-secret", AGENT_WORKSPACE:join(dir,"workspace")};
  const start = (overrides: Record<string,string | undefined> = {}) => {
    const child = spawn(process.execPath, [cli], {cwd:dir, env:{...env,...overrides}, stdio:["pipe","pipe","pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const done = new Promise<{code:number | null; stdout:string; stderr:string}>((resolve, reject) => {
      const timer = setTimeout(() => {child.kill("SIGKILL"); reject(Error("CLI did not clean up within 5s"));}, 5000);
      child.on("close", code => {clearTimeout(timer); resolve({code,stdout,stderr});});
    });
    return {child, done};
  };
  const run = async (input: string, overrides: Record<string,string | undefined> = {}) => {const {child,done} = start(overrides); child.stdin.end(input); return done;};
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); await rm(dir,{recursive:true,force:true});});
  return {dir,requests,env,start,run};
}

test("chat processes buffered lines sequentially with prior history and safe persisted config", async t => {
  const f = await fixture(t); const result = await f.run("first\nsecond\n");
  assert.equal(result.code,0,result.stderr); assert.match(result.stdout,/reply-1/); assert.match(result.stdout,/reply-2/);
  assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[1]!.messages.slice(1).map(m=>m.content),["first","reply-1","second"]);
  assert.deepEqual(f.requests[0]!.tools.map(t=>t.function.name),["read_file","write_file"]);
  const names = await readdir(join(f.dir,".agent-sessions")); assert.equal(names.length,1);
  const text = await readFile(join(f.dir,".agent-sessions",names[0]!),"utf8");
  assert(!text.includes("fixture-secret")); assert(!text.includes("execute"));
  const header = JSON.parse(text.split("\n")[0]!);
  assert.equal(header.config.model,"fixture-model"); assert.equal(header.config.baseURL,f.env.OPENAI_BASE_URL);
  assert.equal(header.config.workspace,f.env.AGENT_WORKSPACE); assert.equal(typeof header.config.prompt,"string");
});
test("chat resumes across separate processes without replay", async t => {
  const f = await fixture(t); assert.equal((await f.run("remember\n")).code,0);
  assert.equal((await f.run("continue\n")).code,0);
  assert.deepEqual(f.requests[1]!.messages.slice(1).map(m=>m.content),["remember","reply-1","continue"]);
});
for (const command of ["/exit","/quit"]) test(`chat ${command} ignores subsequent buffered input`, async t => {
  const f = await fixture(t); const result = await f.run(`\n/help\n${command}\nnever\n`);
  assert.equal(result.code,0,result.stderr); assert.match(result.stdout,/\/exit/); assert.equal(f.requests.length,0);
});
test("chat config mismatch fails before HTTP", async t => {
  const f = await fixture(t); assert.equal((await f.run("hello\n")).code,0);
  const result = await f.run("never\n",{OPENAI_MODEL:"changed-model"});
  assert.notEqual(result.code,0); assert.match(result.stderr,/configuration mismatch/); assert.equal(f.requests.length,1);
});
test("chat missing model gives actionable failure", async t => {
  const f = await fixture(t); const result = await f.run("never\n",{OPENAI_MODEL:undefined});
  assert.notEqual(result.code,0); assert.match(result.stderr,/OPENAI_MODEL/); assert.equal(f.requests.length,0);
});
test("chat HTTP failure stops poisoned session and closes open stdin", async t => {
  const f = await fixture(t,()=>"error"); const {child,done} = f.start(); child.stdin.write("first\nsecond\n");
  const result = await done; assert.notEqual(result.code,0); assert.match(result.stderr,/HTTP 503/);
  assert.match(result.stderr,/AGENT_SESSION/); assert.equal(f.requests.length,1);
});
test("chat corrupt session is not treated as missing", async t => {
  const f = await fixture(t); const path = join(f.dir,"bad.jsonl"); await writeFile(path,"broken\n");
  const result = await f.run("never\n",{AGENT_SESSION:path}); assert.notEqual(result.code,0);
  assert.match(result.stderr,/invalid JSON/); assert.equal(f.requests.length,0); assert.equal(await readFile(path,"utf8"),"broken\n");
});
test("chat rejects session inside workspace", async t => {
  const f = await fixture(t); const result = await f.run("never\n",{AGENT_SESSION:join(f.env.AGENT_WORKSPACE,"session.jsonl")});
  assert.notEqual(result.code,0); assert.match(result.stderr,/outside.*workspace/); assert.equal(f.requests.length,0);
});
test("chat canonical workspace supports resume through symlink", async t => {
  const f = await fixture(t); assert.equal((await f.run("first\n")).code,0);
  const alias = join(f.dir,"alias"); await symlink(f.env.AGENT_WORKSPACE,alias);
  assert.equal((await f.run("second\n",{AGENT_WORKSPACE:alias})).code,0); assert.equal(f.requests.length,2);
});
test("chat executes real write/read tools but cannot read session or expose shell", async t => {
  const call = (name: string,args: object) => ({choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:name,type:"function",function:{name,arguments:JSON.stringify(args)}}]}}]});
  const f = await fixture(t,(_,n)=>n===1?call("write_file",{path:"notes/hello.txt",content:"hello actual file"}):n===2?call("read_file",{path:"notes/hello.txt"}):n===3?call("read_file",{path:"../private.jsonl"}):answer("done"));
  const result = await f.run("write then read\n",{AGENT_SESSION:join(f.dir,"private.jsonl"),AGENT_ALLOW_SHELL:"1"});
  assert.equal(result.code,0,result.stderr); assert.equal(await readFile(join(f.env.AGENT_WORKSPACE,"notes/hello.txt"),"utf8"),"hello actual file");
  assert.equal(f.requests[2]!.messages.at(-1)!.content,"hello actual file");
  assert.match(f.requests[3]!.messages.at(-1)!.content,/outside workspace/);
  assert(f.requests.every(r=>!r.tools.some(t=>t.function.name==="run_shell")));
});
test("chat Ctrl-C aborts active request then cleans up without busy close", async t => {
  let reached!: () => void; const pending = new Promise<void>(r=>reached=r);
  const f = await fixture(t,()=>{reached(); return "hang";}); const {child,done} = f.start(); child.stdin.write("wait\n");
  await Promise.race([pending, done.then(result => assert.equal(result.code,130,result.stderr))]); child.kill("SIGINT"); const result = await done;
  assert.equal(result.code,130); assert.doesNotMatch(result.stderr,/Session busy/); assert.equal(f.requests.length,1);
});
