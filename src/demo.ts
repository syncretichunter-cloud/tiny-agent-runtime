import { runAgentLoop } from "./agent/agent-loop.ts";
import { OpenAICompatibleClient } from "./model/openai-compatible-client.ts";
import { createFileTools } from "./tools/index.ts";

const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
const prompt = process.argv.slice(2).join(" ").trim();

if (!model || !prompt) {
  console.error(
    "Usage: OPENAI_MODEL=<model> OPENAI_API_KEY=<key> npm run demo -- \"your prompt\"\n" +
      "Optional: OPENAI_BASE_URL=http://127.0.0.1:8000/v1",
  );
  process.exitCode = 1;
} else {
  const client = new OpenAICompatibleClient({ baseUrl, apiKey, model });
  const tools = createFileTools(process.env.AGENT_WORKSPACE ?? process.cwd(), {
    allowShell: process.env.AGENT_ALLOW_SHELL === "1",
  });
  const result = await runAgentLoop({
    input: prompt,
    client,
    tools,
    onEvent(event) {
      if (event.type === "tool_end") {
        console.error(`${event.name} (${event.toolCallId}): ${event.result.isError ? "error" : "ok"}`);
      }
    },
    messages: [{
      role: "system",
      content: "Answer concisely. Use available file tools only when needed; file paths are relative to the workspace.",
    }],
  });
  console.log(result.output);
}
