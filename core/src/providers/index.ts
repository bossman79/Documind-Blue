import { Completion } from "./utils/completion";
import { OpenAI } from "./openAI";
import { Ollama } from "./ollama";
import { Google } from "./google";
import { ModelOptions, OpenAIModels, LocalModels, GoogleModels } from "../types";

export class getModel {
  public static getProviderForModel(model: ModelOptions): Completion {
    if (Object.values(OpenAIModels).includes(model as OpenAIModels)) {
      return new OpenAI();
    }
    if (Object.values(GoogleModels).includes(model as GoogleModels)) {
      return new Google();
    }
    if (Object.values(LocalModels).includes(model as LocalModels)) {
      return new Ollama();
    }
    // Unknown model: use Ollama (defaults to localhost:11434 for custom/local models)
    return new Ollama();
  }
}
