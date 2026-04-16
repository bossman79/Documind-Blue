"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.documind = exports.getOllamaKeysForBaseUrl = exports.isLocalLlmApiProxy = exports.withOllamaProxyModelPrefix = exports.getAccoreConversionOptions = exports.parseOllamaSessionResetAtMs = exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS = exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF = exports.OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL = exports.shouldRecordOllamaCloudQuota = exports.OLLAMA_QUOTA_KEY_COUNT = exports.isOllamaQuotaKeyTracked = exports.setOllamaQuotaTrackedKeys = exports.recordOllamaSessionResetHint = exports.recordOllamaQuotaHit = exports.recordOllamaKeySuccess = exports.getQuotaUsageSnapshot = exports.OLLAMA_SESSION_LOCK_FALLBACK_MS = exports.clearKeyCache = exports.getKeyCache = exports.ollamaKeyState = exports.getOllamaApiKeys = void 0;
const utils_1 = require("./utils");
const fs_extra_1 = __importDefault(require("fs-extra"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const p_limit_1 = __importDefault(require("p-limit"));
const types_1 = require("./types");
const providers_1 = require("./providers");
var utils_2 = require("./utils");
Object.defineProperty(exports, "getOllamaApiKeys", { enumerable: true, get: function () { return utils_2.getOllamaApiKeys; } });
Object.defineProperty(exports, "ollamaKeyState", { enumerable: true, get: function () { return utils_2.ollamaKeyState; } });
var keyCache_1 = require("./keyCache");
Object.defineProperty(exports, "getKeyCache", { enumerable: true, get: function () { return keyCache_1.getKeyCache; } });
Object.defineProperty(exports, "clearKeyCache", { enumerable: true, get: function () { return keyCache_1.clearKeyCache; } });
Object.defineProperty(exports, "OLLAMA_SESSION_LOCK_FALLBACK_MS", { enumerable: true, get: function () { return keyCache_1.OLLAMA_SESSION_LOCK_FALLBACK_MS; } });
var quotaUsage_1 = require("./quotaUsage");
Object.defineProperty(exports, "getQuotaUsageSnapshot", { enumerable: true, get: function () { return quotaUsage_1.getQuotaUsageSnapshot; } });
Object.defineProperty(exports, "recordOllamaKeySuccess", { enumerable: true, get: function () { return quotaUsage_1.recordOllamaKeySuccess; } });
Object.defineProperty(exports, "recordOllamaQuotaHit", { enumerable: true, get: function () { return quotaUsage_1.recordOllamaQuotaHit; } });
Object.defineProperty(exports, "recordOllamaSessionResetHint", { enumerable: true, get: function () { return quotaUsage_1.recordOllamaSessionResetHint; } });
Object.defineProperty(exports, "setOllamaQuotaTrackedKeys", { enumerable: true, get: function () { return quotaUsage_1.setOllamaQuotaTrackedKeys; } });
Object.defineProperty(exports, "isOllamaQuotaKeyTracked", { enumerable: true, get: function () { return quotaUsage_1.isOllamaQuotaKeyTracked; } });
Object.defineProperty(exports, "OLLAMA_QUOTA_KEY_COUNT", { enumerable: true, get: function () { return quotaUsage_1.OLLAMA_QUOTA_KEY_COUNT; } });
Object.defineProperty(exports, "shouldRecordOllamaCloudQuota", { enumerable: true, get: function () { return quotaUsage_1.shouldRecordOllamaCloudQuota; } });
Object.defineProperty(exports, "OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL", { enumerable: true, get: function () { return quotaUsage_1.OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL; } });
Object.defineProperty(exports, "OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF", { enumerable: true, get: function () { return quotaUsage_1.OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF; } });
Object.defineProperty(exports, "OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS", { enumerable: true, get: function () { return quotaUsage_1.OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS; } });
var ollamaSessionReset_1 = require("./ollamaSessionReset");
Object.defineProperty(exports, "parseOllamaSessionResetAtMs", { enumerable: true, get: function () { return ollamaSessionReset_1.parseOllamaSessionResetAtMs; } });
var utils_3 = require("./utils");
Object.defineProperty(exports, "getAccoreConversionOptions", { enumerable: true, get: function () { return utils_3.getAccoreConversionOptions; } });
var ollamaProxies_1 = require("./ollamaProxies");
Object.defineProperty(exports, "withOllamaProxyModelPrefix", { enumerable: true, get: function () { return ollamaProxies_1.withOllamaProxyModelPrefix; } });
Object.defineProperty(exports, "isLocalLlmApiProxy", { enumerable: true, get: function () { return ollamaProxies_1.isLocalLlmApiProxy; } });
Object.defineProperty(exports, "getOllamaKeysForBaseUrl", { enumerable: true, get: function () { return ollamaProxies_1.getOllamaKeysForBaseUrl; } });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const documind = async ({ cleanup = true, concurrency = 10, filePath, llmParams = {}, maintainFormat = false, metadataOnly = false, model, //= ModelOptions.gpt_4o_mini,
outputDir, pageDelayMs = 0, pagesToConvertAsImages = -1, tempDir = os_1.default.tmpdir(), preferredKeyIndex, keysInUse, accoreSerial, accoreBetweenRunsMs, }) => {
    const accoreForDwg = (0, utils_1.getAccoreConversionOptions)({
        serial: accoreSerial,
        betweenRunsMs: accoreBetweenRunsMs,
    });
    let inputTokenCount = 0;
    let outputTokenCount = 0;
    let priorPage = "";
    let totalPdfPageCount;
    const aggregatedMarkdown = [];
    const startTime = new Date();
    // Basic checks
    if (!filePath || !filePath.length) {
        throw new Error("Missing file path");
    }
    const defaultModel = model ?? types_1.OpenAIModels.GPT_4O_MINI;
    // Apply model-specific parameter overrides for optimal performance
    const modelSpecificParams = {};
    if (defaultModel === types_1.LocalModels.GEMMA4_31B_CLOUD) {
        // Gemma 4 recommended settings from Ollama documentation
        modelSpecificParams.temperature = 1.0;
        modelSpecificParams.topP = 0.95;
        modelSpecificParams.topK = 64;
    }
    const validatedParams = (0, utils_1.validateLLMParams)({ ...modelSpecificParams, ...llmParams });
    const providerInstance = providers_1.getModel.getProviderForModel(defaultModel);
    // Ensure temp directory exists + create temp folder
    const rand = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    const tempDirectory = path_1.default.join(tempDir || os_1.default.tmpdir(), `documind-file-${rand}`);
    await fs_extra_1.default.ensureDir(tempDirectory);
    // Download the PDF. Get file name.
    const { extension, localPath } = await (0, utils_1.downloadFile)({
        filePath,
        tempDir: tempDirectory,
    });
    if (!localPath)
        throw "Failed to save file to local drive";
    const visionSource = extension.toLowerCase() === ".dwg" ? "cadRaster" : "document";
    // Sort the `pagesToConvertAsImages` array to make sure we use the right index
    // for `formattedPages` as `pdf2pic` always returns images in order
    if (Array.isArray(pagesToConvertAsImages)) {
        pagesToConvertAsImages.sort((a, b) => a - b);
    }
    // Convert file to PDF / raster if necessary
    let effectivePagesToConvert = pagesToConvertAsImages;
    if (extension !== ".png") {
        if (extension === ".dwg") {
            const { totalSourceCount } = await (0, utils_1.convertDwgToOrientedPngs)({
                localPath,
                tempDir: tempDirectory,
                metadataOnly,
                accore: accoreForDwg,
            });
            totalPdfPageCount = totalSourceCount;
            if (metadataOnly && totalSourceCount > 1) {
                effectivePagesToConvert = [1, totalSourceCount];
            }
        }
        else {
            let pdfPath;
            if (extension === ".pdf") {
                pdfPath = localPath;
            }
            else {
                pdfPath = await (0, utils_1.convertFileToPdf)({
                    extension,
                    localPath,
                    tempDir: tempDirectory,
                });
            }
            // For metadata-only mode, only convert first and last page when PDF has multiple pages
            if (metadataOnly) {
                const pageCount = await (0, utils_1.getPdfPageCount)(pdfPath);
                totalPdfPageCount = pageCount ?? undefined;
                if (pageCount != null && pageCount > 1) {
                    effectivePagesToConvert = [1, pageCount];
                }
            }
            if (Array.isArray(effectivePagesToConvert)) {
                effectivePagesToConvert = [...effectivePagesToConvert].sort((a, b) => a - b);
            }
            // Convert the file to a series of images
            await (0, utils_1.convertPdfToImages)({
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
    const files = await fs_extra_1.default.readdir(tempDirectory);
    const images = files
        .filter((file) => file.endsWith(".png"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (totalPdfPageCount === undefined && images.length > 0) {
        totalPdfPageCount = images.length;
    }
    if (maintainFormat) {
        // Use synchronous processing
        for (let i = 0; i < images.length; i++) {
            if (i > 0 && pageDelayMs > 0)
                await delay(pageDelayMs);
            const image = images[i];
            const imagePath = path_1.default.join(tempDirectory, image);
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
                const formattedMarkdown = (0, utils_1.formatMarkdown)(content);
                inputTokenCount += inputTokens;
                outputTokenCount += outputTokens;
                // Update prior page to result from last processing step
                priorPage = formattedMarkdown;
                // Add all markdown results to array
                aggregatedMarkdown.push(formattedMarkdown);
            }
            catch (error) {
                console.error(`Failed to process image ${image}:`, error);
                throw error;
            }
        }
    }
    else {
        // Process in parallel with a limit on concurrent pages
        const processPage = async (image, pageIndex) => {
            if (pageIndex > 0 && pageDelayMs > 0)
                await delay(pageDelayMs);
            const imagePath = path_1.default.join(tempDirectory, image);
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
                const formattedMarkdown = (0, utils_1.formatMarkdown)(content);
                inputTokenCount += inputTokens;
                outputTokenCount += outputTokens;
                // Update prior page to result from last processing step
                priorPage = formattedMarkdown;
                // Add all markdown results to array
                return formattedMarkdown;
            }
            catch (error) {
                console.error(`Failed to process image ${image}:`, error);
                throw error;
            }
        };
        // Function to process pages with concurrency limit
        const processPagesInBatches = async (images, limit) => {
            const results = [];
            const promises = images.map((image, index) => limit(() => processPage(image, index).then((result) => {
                results[index] = result;
            })));
            await Promise.all(promises);
            return results;
        };
        const limit = (0, p_limit_1.default)(concurrency);
        const results = await processPagesInBatches(images, limit);
        const filteredResults = results.filter(utils_1.isString);
        aggregatedMarkdown.push(...filteredResults);
    }
    // Write the aggregated markdown to a file
    if (outputDir) {
        const resultFilePath = path_1.default.join(outputDir, `${fileName}.md`);
        await fs_extra_1.default.writeFile(resultFilePath, aggregatedMarkdown.join("\n\n"));
    }
    // Cleanup the downloaded PDF file
    if (cleanup)
        await fs_extra_1.default.remove(tempDirectory);
    // Format JSON response
    const endTime = new Date();
    const completionTime = endTime.getTime() - startTime.getTime();
    const pagesForNumbering = extension === ".png"
        ? -1
        : extension === ".dwg"
            ? Array.isArray(effectivePagesToConvert)
                ? effectivePagesToConvert
                : -1
            : effectivePagesToConvert;
    const formattedPages = aggregatedMarkdown.map((el, i) => {
        let pageNumber;
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
exports.documind = documind;
