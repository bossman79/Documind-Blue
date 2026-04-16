import axios from "axios";
import { Completion } from "./utils/completion";
import { CompletionArgs, CompletionResponse, OpenAIModels } from "../types";
import { convertKeysToSnakeCase, encodeImageToBase64 } from "../utils";
import {
  buildVisionSystemPrompt,
  CAD_VISION_INITIAL_LONG_SIDE,
} from "./utils/visionPrompt";

export class OpenAI implements Completion {
  public async getCompletion(args: CompletionArgs): Promise<CompletionResponse> {
    const {
      imagePath,
      llmParams,
      maintainFormat,
      model,
      priorPage,
      visionSource,
    } = args;

    if (!process.env.OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY in environment variables.");
    }
    const apiKey = process.env.OPENAI_API_KEY;

    const validModels = Object.values(OpenAIModels); 
    if (!validModels.includes(model as OpenAIModels)) {
      throw new Error(`Model "${model}" is not an OpenAI model.`);
    }

    const systemPrompt = buildVisionSystemPrompt({ visionSource });

    const messages: any = [{ role: "system", content: systemPrompt }];

    if (maintainFormat && priorPage) {
      messages.push({
        role: "system",
        content: `Please ensure markdown formatting remains consistent with the prior page:\n\n"""${priorPage}"""`,
      });
    }

    const base64Image = await encodeImageToBase64(
      imagePath,
      visionSource === "cadRaster"
        ? { initialLongSide: CAD_VISION_INITIAL_LONG_SIDE }
        : undefined
    );
    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${base64Image}` },
        },
      ],
    });

    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          messages,
          model,
          ...convertKeysToSnakeCase(llmParams ?? null),
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = response.data;
      return {
        content: data.choices[0].message.content,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      console.error("OpenAI error:", err);
      throw err;
    }
  }
}
