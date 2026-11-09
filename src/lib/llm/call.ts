/**
 * Per-call options and results shared by the model clients (`./openai`,
 * `./gemini`, `./ollama`): which model to use instead of the server default,
 * and the tokens the provider reports back, for the usage log's cost.
 */
export interface LlmCall {
  /** Overrides the env default model (OPENAI_MODEL, GEMINI_MODEL, OLLAMA_MODEL). */
  model?: string;
  /** Filled in by the client from the provider's usage report, when it gives one. */
  tokensIn?: number;
  tokensOut?: number;
}
