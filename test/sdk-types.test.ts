import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { wrapAnthropic } from "../src/index.js";

describe("SDK structural compatibility", () => {
  it("accepts a real Anthropic client without network access", () => {
    const client = new Anthropic({ apiKey: "test-key-not-used" });
    const gated = wrapAnthropic<MessageCreateParamsNonStreaming, Message>(client);
    expect(typeof gated.messages.create).toBe("function");
  });
});
