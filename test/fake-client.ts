import type { CreateParamsLike, MessageLike } from "../src/index.js";

/** Test-side block shape: any fields, like the real SDK's block unions. */
export interface TestBlock {
  type: string;
  [key: string]: unknown;
}

export interface TestParams extends CreateParamsLike {
  model: string;
  system?: string | TestBlock[];
  messages: { role: string; content: string | TestBlock[] }[];
  stream?: boolean;
}

export interface TestMessage extends MessageLike {
  model: string;
  content: TestBlock[];
}

type Responder = (params: TestParams) => TestMessage;

/** Records every request it receives; never touches the network. */
export class FakeAnthropic {
  readonly calls: TestParams[] = [];

  constructor(private readonly respond: Responder) {}

  readonly messages = {
    create: async (params: TestParams): Promise<TestMessage> => {
      this.calls.push(structuredClone(params));
      return this.respond(params);
    },
  };

  /** Everything the "model" saw, serialised. */
  seen(): string {
    return JSON.stringify(this.calls);
  }
}

export function textMessage(text: string, model = "claude-test"): TestMessage {
  return { model, content: [{ type: "text", text }] };
}

export function textOf(message: TestMessage, index = 0): string {
  return String(message.content[index]?.["text"]);
}
