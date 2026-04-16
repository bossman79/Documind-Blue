import { isValidFile } from '../utils/fileValidator.js';
import { validateSchema } from '../utils/schemaValidator.js';
import { getTemplate } from './templates.js';
import { convertToZodSchema } from '../utils/convertToZodSchema.js';
import { autogenerateSchema } from "../autoschema/autogenerateSchema.js";
import { convertFile } from '../converter.js';
import { BASE_EXTRACTION_PROMPT } from "../prompts.js";
import { getExtractor } from '../extractors/index.js';
import {
  recordOllamaKeySuccess,
  ollamaKeyState,
  shouldRecordOllamaCloudQuota,
  OLLAMA_QUOTA_KEY_COUNT,
} from 'core';
import { extractToCSV } from '../utils/extractToCSV.js';

/**
 * Extracts data from a document based on a provided schema.
 * @param {object} options - Options for the extraction process.
 * @param {string} options.file - The file path to the document.
 * @param {object} options.schema - The schema definition for data extraction.
 * @param {string} [options.template] - Name of a pre-defined template.
 * @param {string} [options.model] - The llm model to use if a base url is set.
 * @param {boolean | object} [options.autoSchema] - Option to auto-generate the schema.
 * @param {string} [options.uploadedFileName] - Filename with extension from upload (injected into result, not sent to LLM).
 * @param {string} [options.project] - Project name/number (injected into result, not sent to LLM).
 * @param {number} [options.preferredKeyIndex] - Async mode: prefer this key index (0-based).
 * @param {Set<number>} [options.keysInUse] - Async mode: keys currently in use by other workers.
 * @returns {Promise<object>} - The result of the extraction, including pages, extracted data, and file name.
 */
export async function extract({ file, schema, template, model, autoSchema, uploadedFileName, project, preferredKeyIndex, keysInUse, preconvertedMarkdown }) {
  try {

    const defaultModel = model || "gpt-4o-mini";

    if (!file) {
      throw new Error("File is required.");
    }

    if (!(await isValidFile(file))) {
      throw new Error("Invalid file type.");
    }

    let finalSchema = null;
    if (template) {
      finalSchema = getTemplate(template); 
    } else if (schema) {
      const { isValid, errors } = validateSchema(schema);
      if (!isValid) {
        throw new Error(`Invalid schema: ${errors.join(", ")}`);
      }
      finalSchema = schema;
    } else if (!autoSchema) {
      throw new Error("You must provide a schema, template, or enable autoSchema.");
    }

    // Use preconverted markdown if provided, otherwise convert now
    let markdown, totalPages, fileName;
    if (preconvertedMarkdown) {
      ({ markdown, totalPages, fileName } = preconvertedMarkdown);
    } else {
      const result = await convertFile(file, defaultModel, {
        metadataOnly: !/\.dwg$/i.test(file),
        ...(preferredKeyIndex != null && { preferredKeyIndex }),
        ...(keysInUse != null && { keysInUse }),
      });
      ({ markdown, totalPages, fileName } = result);
    }

    if (autoSchema) {
      finalSchema = await autogenerateSchema(markdown, defaultModel, autoSchema); 
      if (!finalSchema) {
        throw new Error("Failed to auto-generate schema.");
      }
    }

    const hasFilenameField = finalSchema?.some((f) => f.name === "filename");
    const hasProjectField = finalSchema?.some((f) => f.name === "project");
    let schemaForExtractor = finalSchema;
    if (uploadedFileName && hasFilenameField) {
      schemaForExtractor = schemaForExtractor.filter((f) => f.name !== "filename");
    }
    if (project != null && project !== "" && hasProjectField) {
      schemaForExtractor = schemaForExtractor.filter((f) => f.name !== "project");
    }
    const dynamicZodSchema = convertToZodSchema(finalSchema);
    const zodSchemaForExtractor =
      schemaForExtractor.length < finalSchema.length
        ? convertToZodSchema(schemaForExtractor)
        : dynamicZodSchema;
    const extraction = getExtractor(defaultModel);

    const event = await extraction({
      markdown,
      zodSchema: zodSchemaForExtractor,
      rawSchema: schemaForExtractor,
      prompt: BASE_EXTRACTION_PROMPT,
      model: defaultModel,
      ...(preferredKeyIndex != null && { preferredKeyIndex }),
      ...(keysInUse != null && { keysInUse }),
    });

    if (uploadedFileName && event && typeof event === "object") {
      event.filename = uploadedFileName;
    }
    if (project != null && project !== "" && event && typeof event === "object") {
      event.project = project;
    }

    const csv = event && typeof event === "object" ? extractToCSV(event) : "";

    if (shouldRecordOllamaCloudQuota()) {
      let idx = preferredKeyIndex;
      if (idx == null || typeof idx !== "number" || idx < 0) {
        idx = ollamaKeyState.lastSuccessfulKeyIndex;
      }
      if (typeof idx === "number" && idx >= 0 && idx < OLLAMA_QUOTA_KEY_COUNT) {
        recordOllamaKeySuccess(idx, totalPages || 1);
      }
    }

    return {
      success: true,
      pages: totalPages,
      data: event,
      fileName,
      markdown,
      csv,
    };
  } catch (error) {
    console.error("Error processing document:", error);
    throw new Error(`Failed to process document: ${error.message}`);
  }
}
