/**
 * Production extraction assembly: B's LlmExtractionAdapter on top of the
 * server's canonical LLM adapter (gateway-backed, existing model config).
 *
 * No provider code here — the adapter only re-shapes the call so B's
 * `ExtractionLlmBackend` contract is satisfied by `LLMAdapter.generate`.
 * The model parameter is a Covel slot name (default / balance / fast / …).
 */

import {
  LlmExtractionAdapter,
  type ExtractionLlmBackend,
} from "@covel/world-import";
import type {
  TextGenerationParams,
  TextGenerationResult,
} from "@covel/ai-provider";
import type { LLMMessage } from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";

export function createGatewayExtractionBackend(
  llm: LLMAdapter,
): ExtractionLlmBackend {
  return async (params: TextGenerationParams): Promise<TextGenerationResult> => {
    const response = await llm.generate({
      model: params.model,
      messages: params.messages.map(
        (message): LLMMessage => ({
          role: message.role as LLMMessage["role"],
          content: typeof message.content === "string" ? message.content : "",
        }),
      ),
    });
    return {
      text: response.content ?? "",
      finishReason: response.finishReason,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
  };
}

export function createLlmExtractionAdapter(
  llm: LLMAdapter,
  model?: string,
): LlmExtractionAdapter {
  return new LlmExtractionAdapter({
    backend: createGatewayExtractionBackend(llm),
    model: model ?? "default",
  });
}
