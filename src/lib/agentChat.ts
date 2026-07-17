// Transport for the in-app agent: POST the running message history + tool schemas to the Worker's
// /chat proxy (auth'd with the user's Supabase token) and return the assistant message, which may
// carry tool_calls. The caller (AgentChat) runs the tool loop and executes tools locally.

import { supabase } from "@/integrations/supabase/client";
import { visionApiUrl } from "@/lib/vision";
import { TOOL_SCHEMAS } from "@/lib/agentTools";

export interface LlmToolCall {
  id: string;
  function: { name: string; arguments: string };
}
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export function isAgentConfigured(): boolean {
  return !!visionApiUrl();
}

export async function callAgent(messages: LlmMessage[]): Promise<LlmMessage> {
  const url = visionApiUrl();
  if (!url) throw new Error("Assistant isn't configured (VITE_VISION_API_URL).");
  const token = (await supabase.auth.getSession()).data.session?.access_token || "";
  const res = await fetch(`${url.replace(/\/$/, "")}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages, tools: TOOL_SCHEMAS }),
  });
  if (!res.ok) throw new Error(`Assistant error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.message as LlmMessage) ?? { role: "assistant", content: "" };
}
