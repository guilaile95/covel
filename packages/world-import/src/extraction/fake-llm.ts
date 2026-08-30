/**
 * Fake Covel LLM backend for tests — implements the same
 * ExtractionLlmBackend surface as gateway.generateText, scripted by tests.
 * Never contacts a network and never costs money.
 */

import type {
  TextGenerationParams,
  TextGenerationResult,
} from "@covel/ai-provider";
import type { ExtractionLlmBackend } from "./llm.js";

export interface FakeLlmResponse {
  /** Raw model text (usually JSON, sometimes intentionally broken). */
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface FakeLlmScriptEntry extends FakeLlmResponse {
  /** Only use this entry for the n-th backend call (0-based). */
  call?: number;
  /** Only use this entry when the request text contains any of these. */
  anyOf?: string[];
}

export interface FakeLlmBackend extends ExtractionLlmBackend {
  /** Number of times the backend was invoked. */
  getCalls(): number;
  /** The request texts seen, in order (for assertions). */
  getRequests(): string[];
}

export function createFakeExtractionBackend(
  script: FakeLlmScriptEntry[],
): FakeLlmBackend {
  let calls = 0;
  const requests: string[] = [];

  const backend = (async (params: TextGenerationParams) => {
    const callIndex = calls++;
    const requestText = params.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    requests.push(requestText);

    const entry =
      script.find(
        (e) =>
          e.call === callIndex ||
          (e.call === undefined &&
            e.anyOf !== undefined &&
            e.anyOf.some((k) => requestText.includes(k))),
      ) ?? script.find((e) => e.call === undefined && e.anyOf === undefined);

    if (!entry) {
      throw new Error(
        `fake llm backend: no scripted response for call ${callIndex}`,
      );
    }
    return {
      text: entry.text,
      finishReason: "stop",
      usage: {
        inputTokens: entry.usage?.inputTokens ?? 100,
        outputTokens: entry.usage?.outputTokens ?? 20,
      },
    } satisfies TextGenerationResult;
  }) as FakeLlmBackend;

  backend.getCalls = () => calls;
  backend.getRequests = () => requests;
  return backend;
}

/** Build a well-formed model response for the given extractions. */
export function extractionResponse(
  extractions: unknown[],
  usage?: { inputTokens: number; outputTokens: number },
): FakeLlmResponse {
  return {
    text: JSON.stringify({ extractions }),
    usage,
  };
}
