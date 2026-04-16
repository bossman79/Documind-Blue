import {
  convertDwgToOrientedPngs,
  convertFileToPdf,
  convertPdfToImages,
  downloadFile,
  formatMarkdown,
  getAccoreConversionOptions,
  getPdfPageCount,
  isString,
  validateLLMParams,
} from "./utils";
import fs from "fs-extra";
import os from "os";
import path from "path";
import pLimit, { Limit } from "p-limit";
import {
  DocumindArgs,
  DocumindOutput,
  LLMParams,
  LocalModels,
  ModelOptions,
  OpenAIModels,
} from "./types";
import { getModel } from "./providers";
import { Completion } from "./providers/utils/completion";

export { getOllamaApiKeys, ollamaKeyState } from "./utils";
export {
  getKeyCache,
  clearKeyCache,
  OLLAMA_SESSION_LOCK_FALLBACK_MS,
} from "./keyCache";
export {
  getQuotaUsageSnapshot,
  recordOllamaKeySuccess,
  recordOllamaQuotaHit,
  recordOllamaSessionResetHint,
  setOllamaQuotaTrackedKeys,
  isOllamaQuotaKeyTracked,
  OLLAMA_QUOTA_KEY_COUNT,
  shouldRecordOllamaCloudQuota,
  OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL,
  OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF,
  OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS,
} from "./quotaUsage";
export { parseOllamaSessionResetAtMs } from "./ollamaSessionReset";
export { getAccoreConversionOptions } from "./utils";
export type { AccoreConversionOptions } from "./utils";
export {
  withOllamaProxyModelPrefix,
  isLocalLlmApiProxy,
  getOllamaKeysForBaseUrl,
} from "./ollamaProxies";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const documind = async ({
  cleanup = true,
  concurrency = 10,
  filePath,
  llmParams = {},
  maintainFormat = false,
  metadataOnly = false,
  model, //= ModelOptions.gpt_4o_mini,
  outputDir,
  pageDelayMs = 0,
  pagesToConvertAsImages = -1,
  tempDir = os.tmpdir(),
  preferredKeyIndex,
  keysInUse,
  accoreSerial,
  accoreBetweenRunsMs,
}: DocumindArgs): Promise<DocumindOutput> => {

  const accoreForDwg = getAccoreConversionOptions({
    serial: accoreSerial,
    betweenRunsMs: accoreBetweenRunsMs,
  });

  let inputTokenCount = 0;
  let outputTokenCount = 0;
  let priorPage = "";
  let totalPdfPageCount: number | undefined;
  const aggregatedMarkdown: string[] = [];
  const startTime = new Date();

  // Basic checks
  if (!filePath || !filePath.length) {
    throw new Error("Missing file path");
  }

  const defaultModel: ModelOptions = model ?? OpenAIModels.GPT_4O_MINI;

  // Apply model-specific parameter overrides for optimal performance
  const modelSpecificParams: Partial<LLMParams> = {};
  if (defaultModel === LocalModels.GEMMA4_31B_CLOUD) {
    // Gemma 4 recommended settings from Ollama documentation
    modelSpecificParams.temperature = 1.0;
    modelSpecificParams.topP = 0.95;
    modelSpecificParams.topK = 64;
  }

  const validatedParams = validateLLMParams({ ...modelSpecificParams, ...llmParams });

  const providerInstance: Completion = getModel.getProviderForModel(defaultModel);

  // Ensure temp directory exists + create temp folder
  const rand = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  const tempDirectory = path.join(tempDir || os.tmpdir(), `documind-file-${rand}`);
  await fs.ensureDir(tempDirectory);

  // Download the PDF. Get file name.
  const { extension, localPath } = await downloadFile({
    filePath,
    tempDir: tempDirectory,
  });
  if (!localPath) throw "Failed to save file to local drive";

  const visionSource =
    extension.toLowerCase() === ".dwg" ? ("cadRaster" as const) : ("document" as const);

  // Sort the `pagesToConvertAsImages` array to make sure we use the right index
  // for `formattedPages` as `pdf2pic` always returns images in order
  if (Array.isArray(pagesToConvertAsImages)) {
    pagesToConvertAsImages.sort((a, b) => a - b);
  }

  // Convert file to PDF / raster if necessary
  let effectivePagesToConvert = pagesToConvertAsImages;
  if (extension !== ".png") {
    if (extension === ".dwg") {
      const { totalSourceCount } = await convertDwgToOrientedPngs({
        localPath,
        tempDir: tempDirectory,
        metadataOnly,
        accore: accoreForDwg,
      });
      totalPdfPageCount = totalSourceCount;
      if (metadataOnly && totalSourceCount > 1) {
        effectivePagesToConvert = [1, totalSourceCount];
      }
    } else {
      let pdfPath: string;
      if (extension === ".pdf") {
        pdfPath = localPath;
      } else {
        pdfPath = await convertFileToPdf({
          extension,
          localPath,
          tempDir: tempDirectory,
        });
      }
      // For metadata-only mode, only convert first and last page when PDF has multiple pages
      if (metadataOnly) {
        const pageCount = await getPdfPageCount(pdfPath);
        totalPdfPageCount = pageCount ?? undefined;
        if (pageCount != null && pageCount > 1) {
          effectivePagesToConvert = [1, pageCount];
        }
      }
      if (Array.isArray(effectivePagesToConvert)) {
        effectivePagesToConvert = [...effectivePagesToConvert].sort((a, b) => a - b);
      }
      // Convert the file to a series of images
      await convertPdfToImages({
        localPath: pdfPath,
        pagesToConvertAsImages: effectivePagesToConvert,
        tempDir: tempDirectory,
      });
    }
  }

  const endOfPath = localPath.split("/")[localPath.split("/").length - 1];
  const rawFileName = endOfPath.split(".")[0];
  const fileName = rawFileName
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .substring(0, 255); // Truncate file name to 255 characters to prevent ENAMETOOLONG errors

  // Get list of converted images
  const files = await fs.readdir(tempDirectory);
  const images = files
    .filter((file) => file.endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (totalPdfPageCount === undefined && images.length > 0) {
    totalPdfPageCount = images.length;
  }

  if (maintainFormat) {
    // Use synchronous processing
    for (let i = 0; i < images.length; i++) {
      if (i > 0 && pageDelayMs > 0) await delay(pageDelayMs);
      const image = images[i];
      const imagePath = path.join(tempDirectory, image);
      try {
        const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
          imagePath,
          llmParams: validatedParams,
          maintainFormat,
          model: defaultModel,
          priorPage,
          visionSource,
          ...(preferredKeyIndex != null && { preferredKeyIndex }),
          ...(keysInUse != null && { keysInUse }),
        });
        const formattedMarkdown = formatMarkdown(content);
        inputTokenCount += inputTokens;
        outputTokenCount += outputTokens;

        // Update prior page to result from last processing step
        priorPage = formattedMarkdown;

        // Add all markdown results to array
        aggregatedMarkdown.push(formattedMarkdown);
      } catch (error) {
        console.error(`Failed to process image ${image}:`, error);
        throw error;
      }
    }
  } else {
    // Process in parallel with a limit on concurrent pages
    const processPage = async (image: string, pageIndex: number): Promise<string | null> => {
      if (pageIndex > 0 && pageDelayMs > 0) await delay(pageDelayMs);
      const imagePath = path.join(tempDirectory, image);
      try {
        const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
          imagePath,
          llmParams: validatedParams,
          maintainFormat,
          model: defaultModel,
          priorPage,
          visionSource,
          ...(preferredKeyIndex != null && { preferredKeyIndex }),
          ...(keysInUse != null && { keysInUse }),
          ...(preferredKeyIndex == null && keysInUse == null && { requestIndex: pageIndex }),
        });
        const formattedMarkdown = formatMarkdown(content);
        inputTokenCount += inputTokens;
        outputTokenCount += outputTokens;

        // Update prior page to result from last processing step
        priorPage = formattedMarkdown;

        // Add all markdown results to array
        return formattedMarkdown;
      } catch (error) {
        console.error(`Failed to process image ${image}:`, error);
        throw error;
      }
    };

    // Function to process pages with concurrency limit
    const processPagesInBatches = async (images: string[], limit: Limit) => {
      const results: (string | null)[] = [];

      const promises = images.map((image, index) =>
        limit(() =>
          processPage(image, index).then((result) => {
            results[index] = result;
          })
        )
      );

      await Promise.all(promises);
      return results;
    };

    const limit = pLimit(concurrency);
    const results = await processPagesInBatches(images, limit);
    const filteredResults = results.filter(isString);
    aggregatedMarkdown.push(...filteredResults);
  }

  // Write the aggregated markdown to a file
  if (outputDir) {
    const resultFilePath = path.join(outputDir, `${fileName}.md`);
    await fs.writeFile(resultFilePath, aggregatedMarkdown.join("\n\n"));
  }

  // Cleanup the downloaded PDF file
  if (cleanup) await fs.remove(tempDirectory);

  // Format JSON response
  const endTime = new Date();
  const completionTime = endTime.getTime() - startTime.getTime();
  const pagesForNumbering =
    extension === ".png"
      ? -1
      : extension === ".dwg"
        ? Array.isArray(effectivePagesToConvert)
          ? effectivePagesToConvert
          : -1
        : effectivePagesToConvert;
  const formattedPages = aggregatedMarkdown.map((el, i) => {
    let pageNumber: number;
    // If we convert all pages, just use the array index
    if (pagesForNumbering === -1) {
      pageNumber = i + 1;
    }
    // Else if we convert specific pages, use the page number from the parameter
    else if (Array.isArray(pagesForNumbering)) {
      pageNumber = pagesForNumbering[i];
    }
    // Else, the parameter is a number and use it for the page number
    else {
      pageNumber = pagesForNumbering;
    }

    return { content: el, page: pageNumber, contentLength: el.length };
  });

  return {
    completionTime,
    fileName,
    inputTokens: inputTokenCount,
    outputTokens: outputTokenCount,
    pages: formattedPages,
    ...(totalPdfPageCount !== undefined && { totalPdfPageCount }),
  };
};
