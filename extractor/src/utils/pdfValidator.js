import axios from 'axios';
import path from 'path';

/**
 * Format tab: PDF or DWG (local path or URL). Local paths avoid URL parsing so Windows paths work.
 * @param {string} file - URL or local file path
 * @returns {Promise<boolean>}
 */
export async function isFormatSupportedFile(file) {
    if (!file || typeof file !== 'string') return false;

    const isUrl = file.startsWith('http://') || file.startsWith('https://');

    if (!isUrl) {
        const ext = path.extname(file).toLowerCase();
        return ext === '.pdf' || ext === '.dwg';
    }

    let urlPath;
    try {
        urlPath = new URL(file).pathname;
    } catch {
        return false;
    }

    const isPdf = /\.pdf$/i.test(urlPath);
    const isDwg = /\.dwg$/i.test(urlPath);
    if (!isPdf && !isDwg) return false;

    try {
        const response = await axios.head(file);
        const contentType = response.headers['content-type'] || '';
        if (isPdf) {
            return contentType.startsWith('application/pdf');
        }
        return (
            contentType.startsWith('image/vnd.dwg') ||
            (contentType.startsWith('application/octet-stream') && isDwg)
        );
    } catch (error) {
        console.error('Error checking MIME type:', error);
        return false;
    }
}

/**
 * @deprecated Prefer isFormatSupportedFile for the format pipeline; kept for callers that need PDF-only checks.
 */
export async function isPdfFile(file) {
    if (!file || typeof file !== 'string') return false;
    const isUrl = file.startsWith('http://') || file.startsWith('https://');
    if (!isUrl) {
        return path.extname(file).toLowerCase() === '.pdf';
    }
    let urlPath;
    try {
        urlPath = new URL(file).pathname;
    } catch {
        return false;
    }
    if (!/\.pdf$/i.test(urlPath)) return false;
    try {
        const response = await axios.head(file);
        const contentType = response.headers['content-type'] || '';
        return contentType.startsWith('application/pdf');
    } catch (error) {
        console.error('Error checking MIME type:', error);
        return false;
    }
}
