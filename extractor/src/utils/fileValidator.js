import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Function to check if a file is valid based on its URL or local path
 * @param {string} file - The URL or local file path
 * @returns {Promise<boolean>} - Resolves to true if the file is valid, false otherwise
 */
export async function isValidFile(file) {
    const allowedExtensions = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'html', 'dwg'];
    const allowedMimeTypes = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        txt: 'text/plain',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        html: 'text/html',
        dwg: 'image/vnd.dwg',
    };

    const extensionRegex = new RegExp(`\\.(${allowedExtensions.join('|')})$`, 'i');

    // Local file path (Windows or Unix)
    if (!file.startsWith('http://') && !file.startsWith('https://')) {
        if (!extensionRegex.test(file)) return false;
        try {
            if (!fs.existsSync(file)) return false;
            const ext = path.extname(file).toLowerCase().slice(1);
            return allowedExtensions.includes(ext);
        } catch {
            return false;
        }
    }

    // URL
    let urlPath;
    try {
        urlPath = new URL(file).pathname;
    } catch {
        return false;
    }
    if (!extensionRegex.test(urlPath)) return false;

    try {
        const response = await axios.head(file);
        const contentType = response.headers['content-type'] || '';
        if (Object.values(allowedMimeTypes).some(mime => contentType.startsWith(mime))) {
            return true;
        }
        const extFromPath = path.extname(urlPath).toLowerCase().slice(1);
        if (extFromPath === 'dwg' && contentType.startsWith('application/octet-stream')) {
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error checking MIME type:', error);
        return false;
    }
}
