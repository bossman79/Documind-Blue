import { documind, getAccoreConversionOptions } from 'core';
import { generateMarkdownDocument } from './utils/generateMarkdown.js';

const PAGE_CONCURRENCY = parseInt(process.env.DOCUMIND_PAGE_CONCURRENCY || '6', 10);
// Default 0: extract uses metadataOnly (first+last pages); a 2s gap per document was pure slowdown.
// Set DOCUMIND_PAGE_DELAY_MS if you need pacing against a strict upstream.
const PAGE_DELAY_MS = parseInt(process.env.DOCUMIND_PAGE_DELAY_MS || '0', 10);

export const convertFile = async (filePath, model, options = {}) => {
  const { metadataOnly = false, preferredKeyIndex, keysInUse } = options;
  try {
    const accoreOpts = getAccoreConversionOptions();
    const result = await documind({
      filePath,
      model,
      metadataOnly,
      concurrency: PAGE_CONCURRENCY,
      pageDelayMs: PAGE_DELAY_MS,
      accoreSerial: accoreOpts.serial,
      accoreBetweenRunsMs: accoreOpts.betweenRunsMs,
      ...(preferredKeyIndex != null && { preferredKeyIndex }),
      ...(keysInUse != null && { keysInUse }),
    });

    const { pages, fileName, totalPdfPageCount } = result;
    const totalPages = totalPdfPageCount ?? pages.length;

    const markdown = await generateMarkdownDocument(pages);
    //console.log('Markdown generated', markdown);

    return { markdown, totalPages, fileName };
  } catch (error) {
    console.error('Error running documind core:', error);
    throw error;
  }
};
