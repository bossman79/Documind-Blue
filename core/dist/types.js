"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleModels = exports.LocalModels = exports.OpenAIModels = void 0;
var OpenAIModels;
(function (OpenAIModels) {
    OpenAIModels["GPT_4O"] = "gpt-4o";
    OpenAIModels["GPT_4O_MINI"] = "gpt-4o-mini";
})(OpenAIModels || (exports.OpenAIModels = OpenAIModels = {}));
var LocalModels;
(function (LocalModels) {
    //LLAVA = "llava",
    LocalModels["LLAMA3_2_VISION"] = "llama3.2-vision";
    LocalModels["GEMMA4_31B_CLOUD"] = "gemma4:31b-cloud";
    LocalModels["QWEN2_5_VL"] = "qwen2.5vl";
    LocalModels["QWEN2_5_VL_3B"] = "qwen2.5vl:3b";
    LocalModels["QWEN2_5_VL_7B"] = "qwen2.5vl:7b";
    LocalModels["QWEN2_5_VL_32B"] = "qwen2.5vl:32b";
    LocalModels["QWEN2_5_VL_72B"] = "qwen2.5vl:72b";
    LocalModels["QWEN3_5"] = "qwen3.5";
    LocalModels["QWEN3_5_08B"] = "qwen3.5:0.8b";
    LocalModels["QWEN3_5_2B"] = "qwen3.5:2b";
    LocalModels["QWEN3_5_4B"] = "qwen3.5:4b";
    LocalModels["QWEN3_5_9B"] = "qwen3.5:9b";
    LocalModels["QWEN3_5_9B_Q4_K_M"] = "qwen3.5:9b-q4_K_M";
    LocalModels["QWEN3_5_27B"] = "qwen3.5:27b";
    LocalModels["QWEN3_5_35B"] = "qwen3.5:35b";
    LocalModels["QWEN3_5_122B"] = "qwen3.5:122b";
    LocalModels["QWEN3_VL"] = "qwen3-vl";
    LocalModels["QWEN3_VL_8B"] = "qwen3-vl:8b";
})(LocalModels || (exports.LocalModels = LocalModels = {}));
var GoogleModels;
(function (GoogleModels) {
    GoogleModels["GEMINI_2_FLASH"] = "gemini-2.0-flash-001";
    GoogleModels["GEMINI_2_FLASH_LITE"] = "gemini-2.0-flash-lite-preview-02-05";
    GoogleModels["GEMINI_1_5_FLASH"] = "gemini-1.5-flash";
    GoogleModels["GEMINI_1_5_FLASH_8B"] = "gemini-1.5-flash-8b";
    GoogleModels["GEMINI_1_5_PRO"] = "gemini-1.5-pro";
})(GoogleModels || (exports.GoogleModels = GoogleModels = {}));
