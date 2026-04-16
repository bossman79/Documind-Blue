import path from 'path';
import { fileURLToPath } from 'url';
import { readTemplateLayout } from '../gui/submittalImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const template = path.join(root, 'Vender Submittal Sheet.xlsx');
const layout = readTemplateLayout(template);
layout.headers.forEach((h, i) => {
  console.log(i, JSON.stringify(h), '->', layout.colCanonical[i]);
});
