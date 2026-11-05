import type { ActionEvent } from "./generated/ActionEvent";
import type { ReplyBody } from "./generated/ReplyBody";
import type { Request } from "./generated/Request";

/** Everything the content script knows about an action. The worker adds the tab. */
export type CapturedAction = Omit<ActionEvent, "tab">;

export type PageMessage =
  | { to: "rpc"; request: Request }
  | { to: "state" }
  | { to: "start"; tabId: number }
  | { to: "stop"; goal: string | null };

export type RecorderState = { rec: string; tabId: number } | null;

export type PageAnswer =
  | { ok: true; reply: ReplyBody; state?: undefined }
  | { ok: true; state: RecorderState; reply?: undefined }
  | { ok: false; error: string };

export type ContentMessage = { to: "capture"; action: CapturedAction };

export const RECORDING_KEY = "recording";

/** The worker answers `not found` when the native host manifest has not been written. */
export function isHostMissing(error: string): boolean {
  return /native messaging host/i.test(error);
}

export async function ask(message: PageMessage): Promise<PageAnswer> {
  const answer: PageAnswer | undefined = await chrome.runtime.sendMessage(message);
  return answer ?? { ok: false, error: "no answer from the extension" };
}

export async function rpc(request: Request): Promise<ReplyBody> {
  const answer = await ask({ to: "rpc", request });
  if (!answer.ok) throw new Error(answer.error);
  if (answer.reply === undefined) throw new Error("empty reply");
  if (answer.reply.type === "error") throw new Error(answer.reply.message);
  return answer.reply;
}
