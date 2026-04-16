export const BASE_EXTRACTION_PROMPT = `
You are an expert in structured data extraction. Extract information from the document and output it as JSON.

Rules:
1. Output ONLY a raw JSON object. No markdown, no \`\`\`json\`\`\` code blocks, no explanation, no text before or after.
2. Include every field from the schema. Use null for missing values.
3. Preserve exact key names from the schema.
4. For engineering/CAD drawings, map title block, revision history, and notes in the markdown into the schema fields (e.g. drawing title, revision, dates, discipline) when they clearly match.
`;

export const AUTO_SCHEMA_PROMPT = (markdown) => `
Read the following markdown content and generate a schema of useful structured data that can be extracted from it. Follow these rules strictly:
- The \`children\` field **must only be present if the \`type\` is \`object\` or \`array\`. It should never exist for other types.
- \`description\` fields should be concise, no longer than one sentence.
"""${markdown}"""
`;

export const INSTRUCTIONS_SCHEMA_PROMPT = (markdown, data) => `
Read the following markdown content and generate a schema for the structured data I require: """${data}""". Use only the fields listed, and follow these rules strictly:
- The \`children\` field **must only be present if the \`type\` is \`object\` or \`array\`. It should never exist for other types.
- \`description\` fields should be concise, no longer than one sentence.
"""${markdown}"""
`;