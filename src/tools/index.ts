import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, lstat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { realpathSync } from "node:fs";
import type { AgentTool, ToolExecutionContext } from "../agent/agent-loop.ts";
import type { JsonObject } from "../agent/types.ts";

const exec = promisify(execFile);

function stringArg(args: JsonObject, key: string, keys: string[]): string {
  for (const name of Object.keys(args)) if (!keys.includes(name)) throw Error(`Unexpected argument: ${name}`);
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw Error(`${key} must be a nonempty string`);
  return value;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

async function safePath(root: string, candidate: string): Promise<string> {
  const destination = resolve(root, candidate);
  if (!inside(root, destination)) throw Error("path outside workspace");
  let ancestor = destination;
  while (true) {
    try {
      await lstat(ancestor);
      let resolved: string;
      try {
        resolved = await realpath(ancestor);
      } catch {
        throw Error("path outside workspace or dangling symlink");
      }
      if (!inside(root, resolved)) throw Error("path outside workspace");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw Error("path outside workspace");
      ancestor = parent;
    }
  }
  return destination;
}

export type ToolOptions = { allowShell?: boolean; shellTimeoutMs?: number; maxOutputBytes?: number };

export function createFileTools(workspace: string, options: ToolOptions = {}): AgentTool[] {
  const root = realpathSync(resolve(workspace));
  const filePath = async (args: JsonObject, keys: string[]) => safePath(root, stringArg(args, "path", keys));
  const tools: AgentTool[] = [
    {
      name: "read_file", description: "Read a UTF-8 file inside the workspace",
      parameters: {type:"object", properties:{path:{type:"string"}}, required:["path"], additionalProperties:false},
      async execute(args) { return readFile(await filePath(args, ["path"]), "utf8"); },
    },
    {
      name: "write_file", description: "Write UTF-8 text to a file inside the workspace",
      parameters: {type:"object", properties:{path:{type:"string"},content:{type:"string"}}, required:["path","content"], additionalProperties:false},
      async execute(args) {
        const path = await filePath(args, ["path","content"]);
        if (typeof args.content !== "string") throw Error("content must be a string");
        await mkdir(dirname(path), {recursive:true});
        // Resolve again after creating parents to catch a changed symlink in simple demos.
        await safePath(root, path);
        await writeFile(path, args.content, "utf8");
        return `Wrote ${String(args.path)}`;
      },
    },
  ];
  if (options.allowShell) {
    const timeout = options.shellTimeoutMs ?? 5000;
    const maxOutput = options.maxOutputBytes ?? 8192;
    if (!Number.isInteger(timeout) || timeout < 1 || !Number.isInteger(maxOutput) || maxOutput < 1) throw RangeError("Invalid shell limits");
    tools.push({
      name: "run_shell", description: "Run a shell command in the workspace (trusted local demo only)",
      parameters: {type:"object", properties:{command:{type:"string"}}, required:["command"], additionalProperties:false},
      async execute(args: JsonObject, context: ToolExecutionContext) {
        const command = stringArg(args, "command", ["command"]);
        try {
          const {stdout,stderr} = await exec("/bin/sh", ["-c", command], {
            cwd:root, timeout, signal: context.signal, encoding:"utf8", maxBuffer:1_048_576,
          });
          const output = stdout + stderr;
          return Buffer.byteLength(output) > maxOutput ? Buffer.from(output).subarray(0,maxOutput).toString("utf8") + "\n[truncated]" : output;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
              (error as Error & { killed?: boolean }).killed) throw Error("shell command timed out");
          throw error;
        }
      },
    });
  }
  return tools;
}
