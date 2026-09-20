import { beforeEach, describe, expect, it } from "vitest";
import {
  chatMessagesFromBody,
  newTurnMessages,
  newTurnStartIndex,
  rememberChatSession,
  configureChatSessionStore,
  resolveChatSession,
  type ChatSessionMessage
} from "./chat-session";

const OWNER = "cursor-key:test";
const NOW = Date.parse("2026-08-19T00:00:00Z");

let counter = 0;
const newSessionKey = () => `session-${(counter += 1)}`;

/** Replay a turn the way a stateless OpenAI client does: resolve, answer, remember. */
async function answerTurn(messages: ChatSessionMessage[], reply: string, owner = OWNER) {
  const resolution = await resolveChatSession(messages, owner, NOW, newSessionKey);
  await rememberChatSession({
    messages,
    ownerKey: owner,
    sessionKey: resolution.sessionKey,
    assistantText: reply,
    now: NOW
  });
  return resolution;
}

describe("chat session fingerprinting", () => {
  beforeEach(() => {
    const entries = new Map<string, { sessionKey: string; updatedAt: number }>();
    configureChatSessionStore({
      async take(key) { const value = entries.get(key); entries.delete(key); return value; },
      async set(key, value) { entries.set(key, value); }
    });
    counter = 0;
  });

  it("starts a fresh session for a first turn", async () => {
    const resolution = await resolveChatSession(
      [{ role: "user", content: "hi" }],
      OWNER,
      NOW,
      newSessionKey
    );
    expect(resolution.resumed).toBe(false);
    expect(resolution.sessionKey).toBe("session-1");
  });

  it("resumes the same session when the client replays the conversation", async () => {
    const first: ChatSessionMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "what is 2+2?" }
    ];
    const firstTurn = await answerTurn(first, "4");

    const second: ChatSessionMessage[] = [
      ...first,
      { role: "assistant", content: "4" },
      { role: "user", content: "and times 3?" }
    ];
    const secondTurn = await resolveChatSession(second, OWNER, NOW, newSessionKey);

    expect(secondTurn.resumed).toBe(true);
    expect(secondTurn.sessionKey).toBe(firstTurn.sessionKey);
    expect(newTurnMessages(second, secondTurn)).toEqual([{ role: "user", content: "and times 3?" }]);
  });

  it("keeps resuming across several turns and only ever sends the new messages", async () => {
    const turn1: ChatSessionMessage[] = [{ role: "user", content: "one" }];
    const first = await answerTurn(turn1, "1");

    const turn2: ChatSessionMessage[] = [
      ...turn1,
      { role: "assistant", content: "1" },
      { role: "user", content: "two" }
    ];
    const second = await answerTurn(turn2, "2");
    expect(second.sessionKey).toBe(first.sessionKey);

    const turn3: ChatSessionMessage[] = [
      ...turn2,
      { role: "assistant", content: "2" },
      { role: "user", content: "three" }
    ];
    const third = await resolveChatSession(turn3, OWNER, NOW, newSessionKey);
    expect(third.sessionKey).toBe(first.sessionKey);
    expect(newTurnMessages(turn3, third)).toEqual([{ role: "user", content: "three" }]);
  });

  it("carries tool results into the same session as the tool call that produced them", async () => {
    const messages: ChatSessionMessage[] = [{ role: "user", content: "read the file" }];
    const toolCalls = [{ function: { name: "read", arguments: '{"path":"a.ts"}' } }];
    const resolution = await resolveChatSession(messages, OWNER, NOW, newSessionKey);
    await rememberChatSession({
      messages,
      ownerKey: OWNER,
      sessionKey: resolution.sessionKey,
      assistantText: "",
      assistantToolCalls: toolCalls,
      now: NOW
    });

    const followUp: ChatSessionMessage[] = [
      ...messages,
      { role: "assistant", content: "", tool_calls: toolCalls },
      { role: "tool", tool_call_id: "call_1", name: "read", content: "export const a = 1;" }
    ];
    const resumed = await resolveChatSession(followUp, OWNER, NOW, newSessionKey);

    expect(resumed.resumed).toBe(true);
    expect(resumed.sessionKey).toBe(resolution.sessionKey);
    expect(newTurnMessages(followUp, resumed)).toHaveLength(1);
  });

  it("does not let two conversations with the same opening diverge onto one session", async () => {
    const opening: ChatSessionMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" }
    ];
    const conversationA = await answerTurn(opening, "hi");
    const conversationB = await answerTurn([...opening], "hi");

    const continueWith = (question: string): ChatSessionMessage[] => [
      ...opening,
      { role: "assistant", content: "hi" },
      { role: "user", content: question }
    ];
    const firstClaim = await resolveChatSession(continueWith("weather?"), OWNER, NOW, newSessionKey);
    const secondClaim = await resolveChatSession(continueWith("time?"), OWNER, NOW, newSessionKey);

    // One continuation inherits the warm agent; the other starts clean rather than sharing it.
    expect(firstClaim.resumed).toBe(true);
    expect([conversationA.sessionKey, conversationB.sessionKey]).toContain(firstClaim.sessionKey);
    expect(secondClaim.resumed).toBe(false);
    expect(secondClaim.sessionKey).not.toBe(firstClaim.sessionKey);
  });

  it("never shares a session between different owners", async () => {
    const messages: ChatSessionMessage[] = [{ role: "user", content: "hello" }];
    const mine = await answerTurn(messages, "hi");

    const replay: ChatSessionMessage[] = [
      ...messages,
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" }
    ];
    const theirs = await resolveChatSession(replay, "cursor-key:someone-else", NOW, newSessionKey);

    expect(theirs.resumed).toBe(false);
    expect(theirs.sessionKey).not.toBe(mine.sessionKey);
  });

  it("starts over when the client rewrites earlier history", async () => {
    const messages: ChatSessionMessage[] = [{ role: "user", content: "hello" }];
    await answerTurn(messages, "hi");

    const edited: ChatSessionMessage[] = [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" }
    ];
    expect((await resolveChatSession(edited, OWNER, NOW, newSessionKey)).resumed).toBe(false);
  });

  it("matches conversations whose content arrives as text parts", async () => {
    const messages: ChatSessionMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] }
    ];
    const first = await answerTurn(messages, "hi");

    const replay: ChatSessionMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" }
    ];
    const resumed = await resolveChatSession(replay, OWNER, NOW, newSessionKey);
    expect(resumed.sessionKey).toBe(first.sessionKey);
  });

  it("expires sessions that go untouched past the TTL", async () => {
    const messages: ChatSessionMessage[] = [{ role: "user", content: "hello" }];
    await answerTurn(messages, "hi");

    const replay: ChatSessionMessage[] = [
      ...messages,
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" }
    ];
    const later = NOW + 3 * 60 * 60 * 1000;
    expect((await resolveChatSession(replay, OWNER, later, newSessionKey)).resumed).toBe(false);
  });

  it("treats the whole conversation as new when no assistant has spoken", () => {
    const messages: ChatSessionMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" }
    ];
    expect(newTurnStartIndex(messages)).toBe(messages.length);
    expect(newTurnStartIndex([...messages, { role: "assistant", content: "hi" }])).toBe(3);
  });

  it("reads messages defensively from arbitrary request bodies", () => {
    expect(chatMessagesFromBody({ messages: [{ role: "user" }] })).toHaveLength(1);
    expect(chatMessagesFromBody({ messages: "nope" })).toEqual([]);
    expect(chatMessagesFromBody(null)).toEqual([]);
  });
});
