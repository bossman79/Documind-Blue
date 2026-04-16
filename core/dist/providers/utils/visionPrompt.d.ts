import type { CompletionArgs } from "../../types";
export declare function buildVisionSystemPrompt(args: Pick<CompletionArgs, "visionSource">): string;
/** Sharper JPEG pipeline start for small CAD annotations (still capped by DOCUMIND_MAX_VISION_BASE64_CHARS). */
export declare const CAD_VISION_INITIAL_LONG_SIDE = 3840;
