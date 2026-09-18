import type { CursorTokenUsage } from "./types";

export interface ModelPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  // Above 200k/272k tokens pricing
  input_cost_per_token_above_200k_tokens?: number;
  input_cost_per_token_above_272k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_272k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_272k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_272k_tokens?: number;
}

/**
 * Model pricing data from https://github.com/Wei-Shaw/model-price-repo/blob/main/config.json
 * Updated: 2026-09-18
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude models
  "claude-opus-5": {
    input_cost_per_token: 0.000015,
    output_cost_per_token: 0.000075,
    cache_read_input_token_cost: 0.0000015,
    cache_creation_input_token_cost: 0.00001875
  },
  "claude-sonnet-5": {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.0000002,
    cache_creation_input_token_cost: 0.0000025
  },
  "claude-sonnet-4": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375
  },
  "claude-haiku-4": {
    input_cost_per_token: 0.0000008,
    output_cost_per_token: 0.000004,
    cache_read_input_token_cost: 0.00000008,
    cache_creation_input_token_cost: 0.000001
  },
  "claude-mythos-5": {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00005,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.0000125
  },
  "claude-fable-5": {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00005,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.0000125
  },
  // GPT models
  "gpt-4o": {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125
  },
  "gpt-4o-mini": {
    input_cost_per_token: 0.00000015,
    output_cost_per_token: 0.0000006,
    cache_read_input_token_cost: 0.000000075
  },
  "gpt-5.4-mini": {
    input_cost_per_token: 0.00000075,
    output_cost_per_token: 0.0000045,
    cache_read_input_token_cost: 0.000000075
  },
  "gpt-5.4-nano": {
    input_cost_per_token: 0.0000002,
    output_cost_per_token: 0.00000125,
    cache_read_input_token_cost: 0.00000002
  },
  "gpt-5.6-sol": {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.00003,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.00000625,
    input_cost_per_token_above_272k_tokens: 0.00001,
    output_cost_per_token_above_272k_tokens: 0.000045,
    cache_read_input_token_cost_above_272k_tokens: 0.000001
  },
  "gpt-5.6-terra": {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000012,
    cache_read_input_token_cost: 0.0000002,
    cache_creation_input_token_cost: 0.0000025,
    input_cost_per_token_above_272k_tokens: 0.000004,
    output_cost_per_token_above_272k_tokens: 0.000018
  },
  "gpt-5.6-luna": {
    input_cost_per_token: 0.0000002,
    output_cost_per_token: 0.0000012,
    cache_read_input_token_cost: 0.00000002,
    cache_creation_input_token_cost: 0.00000025,
    input_cost_per_token_above_272k_tokens: 0.0000004,
    output_cost_per_token_above_272k_tokens: 0.0000018
  },
  // Gemini models
  "gemini-2.0-flash": {
    input_cost_per_token: 0.0000001,
    output_cost_per_token: 0.0000004,
    cache_read_input_token_cost: 0.00000001
  },
  "gemini-2.5-pro": {
    input_cost_per_token: 0.00000125,
    output_cost_per_token: 0.000005,
    cache_read_input_token_cost: 0.000000125,
    cache_creation_input_token_cost: 0.00000125,
    input_cost_per_token_above_200k_tokens: 0.0000025,
    cache_creation_input_token_cost_above_200k_tokens: 0.0000025
  },
  "gemini-3-pro-preview": {
    input_cost_per_token: 0.0000016,
    output_cost_per_token: 0.0000064,
    cache_read_input_token_cost: 0.00000016,
    cache_creation_input_token_cost: 0.000002,
    input_cost_per_token_above_200k_tokens: 0.0000032,
    cache_creation_input_token_cost_above_200k_tokens: 0.000004
  },
  // DeepSeek models
  "deepseek-chat": {
    input_cost_per_token: 0.00000014,
    output_cost_per_token: 0.00000028,
    cache_read_input_token_cost: 0.000000014
  },
  "deepseek-reasoner": {
    input_cost_per_token: 0.00000055,
    output_cost_per_token: 0.0000022,
    cache_read_input_token_cost: 0.000000014
  },
  // Grok models
  "grok-4.5": {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000006,
    cache_read_input_token_cost: 0.0000003,
    input_cost_per_token_above_200k_tokens: 0.000004,
    output_cost_per_token_above_200k_tokens: 0.000012,
    cache_read_input_token_cost_above_200k_tokens: 0.0000006
  },
  "grok-4.3": {
    input_cost_per_token: 0.00000125,
    output_cost_per_token: 0.0000025,
    cache_read_input_token_cost: 0.0000002,
    input_cost_per_token_above_200k_tokens: 0.0000025,
    output_cost_per_token_above_200k_tokens: 0.000005
  },
  // o1/o3 models
  "o1": {
    input_cost_per_token: 0.000015,
    output_cost_per_token: 0.00006
  },
  "o1-mini": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000012
  },
  "o3-mini": {
    input_cost_per_token: 0.0000011,
    output_cost_per_token: 0.0000044
  }
};

/**
 * Calculate the cost for a request based on token usage and model pricing
 */
export function calculateCost(
  model: string,
  usage: CursorTokenUsage
): {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
} {
  const pricing = getModelPricing(model);

  const totalInputTokens = usage.inputTokens + usage.cacheWriteTokens;
  const contextThreshold = getContextThreshold(model);

  let inputCost = 0;
  let cacheWriteCost = 0;

  // Calculate input cost with threshold-based pricing
  if (contextThreshold > 0 && totalInputTokens > contextThreshold) {
    const belowThreshold = contextThreshold;
    const aboveThreshold = totalInputTokens - contextThreshold;

    inputCost = belowThreshold * pricing.input_cost_per_token;
    inputCost += aboveThreshold * (getAboveThresholdInputPrice(pricing, model) || pricing.input_cost_per_token);

    // Cache write cost
    if (usage.cacheWriteTokens > 0) {
      const cacheWritePrice = pricing.cache_creation_input_token_cost || pricing.input_cost_per_token * 1.25;
      const cacheAbovePrice = getAboveThresholdCacheWritePrice(pricing, model) || cacheWritePrice;

      if (usage.cacheWriteTokens <= contextThreshold) {
        cacheWriteCost = usage.cacheWriteTokens * cacheWritePrice;
      } else {
        cacheWriteCost = contextThreshold * cacheWritePrice;
        cacheWriteCost += (usage.cacheWriteTokens - contextThreshold) * cacheAbovePrice;
      }
    }
  } else {
    inputCost = usage.inputTokens * pricing.input_cost_per_token;
    cacheWriteCost = usage.cacheWriteTokens * (pricing.cache_creation_input_token_cost || pricing.input_cost_per_token * 1.25);
  }

  // Calculate output cost
  let outputCost = 0;
  if (contextThreshold > 0 && totalInputTokens > contextThreshold) {
    const outputAbovePrice = getAboveThresholdOutputPrice(pricing, model) || pricing.output_cost_per_token;
    outputCost = usage.outputTokens * outputAbovePrice;
  } else {
    outputCost = usage.outputTokens * pricing.output_cost_per_token;
  }

  // Calculate cache read cost
  const cacheReadPrice = pricing.cache_read_input_token_cost || pricing.input_cost_per_token * 0.1;
  let cacheReadCost = 0;
  if (contextThreshold > 0 && usage.cacheReadTokens > contextThreshold) {
    const cacheReadAbovePrice = getAboveThresholdCacheReadPrice(pricing, model) || cacheReadPrice;
    cacheReadCost = contextThreshold * cacheReadPrice;
    cacheReadCost += (usage.cacheReadTokens - contextThreshold) * cacheReadAbovePrice;
  } else {
    cacheReadCost = usage.cacheReadTokens * cacheReadPrice;
  }

  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost
  };
}

/**
 * Estimate cost based on character counts when token usage is not available
 */
export function estimateCostFromChars(
  model: string,
  promptChars: number,
  completionChars: number
): {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
} {
  // Rough estimate: 1 token ≈ 4 characters
  const estimatedInputTokens = Math.ceil(promptChars / 4);
  const estimatedOutputTokens = Math.ceil(completionChars / 4);

  return calculateCost(model, {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: estimatedInputTokens + estimatedOutputTokens
  });
}

function getModelPricing(model: string): ModelPricing {
  // Normalize model name
  const normalizedModel = model.toLowerCase().trim();

  // Direct match
  if (MODEL_PRICING[normalizedModel]) {
    return MODEL_PRICING[normalizedModel];
  }

  // Try to match by prefix
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (normalizedModel.startsWith(key) || key.startsWith(normalizedModel)) {
      return pricing;
    }
  }

  // Default fallback pricing (Claude Sonnet 5 as baseline)
  return {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.0000002,
    cache_creation_input_token_cost: 0.0000025
  };
}

function getContextThreshold(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes("gpt-5") || normalized.includes("grok")) {
    if (normalized.includes("200k")) return 200000;
    if (normalized.includes("272k")) return 272000;
    // Default for GPT-5 and Grok
    return normalized.includes("grok") ? 200000 : 272000;
  }
  if (normalized.includes("gemini")) {
    return 200000;
  }
  return 0; // No threshold for other models
}

function getAboveThresholdInputPrice(pricing: ModelPricing, model: string): number | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes("272k") || normalized.includes("gpt-5")) {
    return pricing.input_cost_per_token_above_272k_tokens;
  }
  return pricing.input_cost_per_token_above_200k_tokens;
}

function getAboveThresholdOutputPrice(pricing: ModelPricing, model: string): number | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes("272k") || normalized.includes("gpt-5")) {
    return pricing.output_cost_per_token_above_272k_tokens;
  }
  return pricing.output_cost_per_token_above_200k_tokens;
}

function getAboveThresholdCacheReadPrice(pricing: ModelPricing, model: string): number | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes("272k") || normalized.includes("gpt-5")) {
    return pricing.cache_read_input_token_cost_above_272k_tokens;
  }
  return pricing.cache_read_input_token_cost_above_200k_tokens;
}

function getAboveThresholdCacheWritePrice(pricing: ModelPricing, model: string): number | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes("272k") || normalized.includes("gpt-5")) {
    return pricing.cache_creation_input_token_cost_above_272k_tokens;
  }
  return pricing.cache_creation_input_token_cost_above_200k_tokens;
}