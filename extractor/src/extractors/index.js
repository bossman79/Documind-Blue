import { ollamaExtractor } from "./ollama.js";
import { openAIExtractor } from "./openAI.js";
import { googleExtractor } from "./google.js";

export const OpenAIModels = ["gpt-4o", "gpt-4o-mini"];
export const LocalModels = [
  "llama3.2-vision",
  "qwen2.5vl",
  "qwen2.5vl:3b",
  "qwen2.5vl:7b",
  "qwen2.5vl:32b",
  "qwen2.5vl:72b",
  "qwen3.5",
  "qwen3.5:0.8b",
  "qwen3.5:2b",
  "qwen3.5:4b",
  "qwen3.5:9b",
  "qwen3.5:9b-q4_K_M",
  "qwen3.5:27b",
  "qwen3.5:35b",
  "qwen3.5:122b",
  "qwen3-vl",
  "qwen3-vl:8b",
];
export const GoogleModels = [
  "gemini-2.0-flash-001", 
  "gemini-2.0-flash-lite-preview-02-05", 
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
 "gemini-1.5-pro"
];

export function getExtractor(model) {
  if (OpenAIModels.includes(model)) {
    return openAIExtractor;
  }

  if (GoogleModels.includes(model)) {
    return googleExtractor;
  }

  if (LocalModels.includes(model)) {
    return ollamaExtractor;
  }

  // Unknown model: use Ollama (defaults to localhost:11434)
  return ollamaExtractor;
}
