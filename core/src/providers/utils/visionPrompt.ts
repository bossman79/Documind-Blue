import type { CompletionArgs } from "../../types";

const BASE = `
Convert the following image/document to markdown.
Return only the markdown with no explanation text. Do not include delimiters like '''markdown.
You must include all information on the page. Do not exclude headers, footers, or subtext.
`.trim();

const CAD_RASTER = `
This is a rasterized engineering drawing (CAD/DWG export). Carefully read the entire sheet:
title block and drawing border (drawing number, title, scale, sheet x of y, client/project),
revision block (revision letter/number, dates, description, approvals),
notes, schedules, and legible dimensions and labels.
Transcribe all readable text. Use markdown headings (e.g. ## Title block) when it helps.
If the image is blank, nearly blank, or text is illegible, say that explicitly in one short line.
`.trim();

export function buildVisionSystemPrompt(args: Pick<CompletionArgs, "visionSource">): string {
  return args.visionSource === "cadRaster" ? `${BASE}\n\n${CAD_RASTER}` : BASE;
}

/** Sharper JPEG pipeline start for small CAD annotations (still capped by DOCUMIND_MAX_VISION_BASE64_CHARS). */
export const CAD_VISION_INITIAL_LONG_SIDE = 3840;
