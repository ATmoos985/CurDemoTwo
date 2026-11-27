/**
 * 生产级 CSV / 文本解码与分隔符容错解析模块（纯 JS，零外部依赖）。
 * 支持 UTF-8 BOM、UTF-8、UTF-16LE/BE 与 GB18030(GBK) 自动识别及 RFC 4180 引号转义。
 */

const CANDIDATE_DELIMITERS = [',', ';', '\t'];

/**
 * 将二进制 Buffer / Uint8Array 或字符串解码为规范化文本及编码标识。
 * @param {ArrayBuffer | ArrayBufferView | string} input
 * @returns {{ text: string, encoding: 'utf-8-bom' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'string' }}
 */
export function decodeTextBuffer(input) {
    if (typeof input === 'string') {
        if (input.startsWith('\ufeff')) {
            return { text: input.slice(1), encoding: 'utf-8-bom' };
        }
        return { text: input, encoding: 'string' };
    }
    if (!input) {
        return { text: '', encoding: 'string' };
    }
    let bytes;
    if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
    } else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
        throw new Error('不支持的文本输入类型，需提供字符串或二进制字节流。');
    }

    if (bytes.length === 0) {
        return { text: '', encoding: 'utf-8' };
    }

    // 1. BOM 优先识别
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return {
            text: stripBom(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(3))),
            encoding: 'utf-8-bom'
        };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return {
            text: stripBom(new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(2))),
            encoding: 'utf-16le'
        };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return {
            text: stripBom(new TextDecoder('utf-16be', { fatal: false }).decode(bytes.subarray(2))),
            encoding: 'utf-16be'
        };
    }

    // 2. 严格 UTF-8 校验
    try {
        const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { text: stripBom(utf8), encoding: 'utf-8' };
    } catch {
        // 3. 回退 GB18030（兼容 GBK / GB2312 中文车间导出表）
        const gb = new TextDecoder('gb18030', { fatal: false }).decode(bytes);
        return { text: stripBom(gb), encoding: 'gb18030' };
    }
}

function stripBom(str) {
    return str.startsWith('\ufeff') ? str.slice(1) : str;
}

/**
 * 在忽略引号内字符的前提下，自动探测分隔符（',' | ';' | '\t'）。
 * @param {string} text
 * @returns {',' | ';' | '\t'}
 */
export function detectCsvDelimiter(text) {
    const clean = stripBom(String(text ?? ''));
    if (!clean.trim()) return ',';

    // 抽取前 25 条逻辑行中引号外的分隔符出现次数
    const lineCounts = [];
    let current = { ',': 0, ';': 0, '\t': 0 };
    let inQuotes = false;

    for (let i = 0; i < clean.length && lineCounts.length < 25; i++) {
        const ch = clean[i];
        if (ch === '"') {
            if (inQuotes && clean[i + 1] === '"') {
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (!inQuotes) {
            if (ch === '\r' || ch === '\n') {
                if (ch === '\r' && clean[i + 1] === '\n') i++;
                if (current[','] + current[';'] + current['\t'] > 0) {
                    lineCounts.push(current);
                }
                current = { ',': 0, ';': 0, '\t': 0 };
            } else if (ch === ',' || ch === ';' || ch === '\t') {
                current[ch]++;
            }
        }
    }
    if (current[','] + current[';'] + current['\t'] > 0 && lineCounts.length < 25) {
        lineCounts.push(current);
    }

    if (lineCounts.length === 0) return ',';

    let bestDelimiter = ',';
    let bestScore = -1;

    for (const delim of CANDIDATE_DELIMITERS) {
        const counts = lineCounts.map(c => c[delim]).filter(n => n > 0);
        if (counts.length === 0) continue;
        const total = counts.reduce((s, n) => s + n, 0);
        const avg = total / counts.length;
        const variance = counts.reduce((s, n) => s + Math.pow(n - avg, 2), 0) / counts.length;
        // 多行稳定出现且列数方差越低得分越高
        const consistencyBonus = counts.length === lineCounts.length ? 100 : counts.length * 10;
        const score = consistencyBonus + counts.length * 20 + total - variance * 15;
        if (score > bestScore) {
            bestScore = score;
            bestDelimiter = delim;
        }
    }
    return bestDelimiter;
}

/**
 * 完整 RFC 4180 状态机解析分隔文本（支持引号内换行、双引号转义 `""` 与尾部空白容错）。
 * @param {string} text
 * @param {string} [delimiter]
 * @returns {{ rows: string[][], delimiter: ',' | ';' | '\t' }}
 */
export function parseDelimitedText(text, delimiter) {
    const clean = stripBom(String(text ?? ''));
    const chosen = CANDIDATE_DELIMITERS.includes(delimiter) ? delimiter : detectCsvDelimiter(clean);
    if (!clean) {
        return { rows: [], delimiter: chosen };
    }

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let atFieldStart = true;

    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];

        if (inQuotes) {
            if (ch === '"') {
                if (clean[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }

        const isLeadingWhitespaceOnly =
            field.length > 0 && (chosen === '\t' ? /^ +$/.test(field) : /^[ \t]+$/.test(field));
        if ((atFieldStart || isLeadingWhitespaceOnly) && ch === '"') {
            field = '';
            inQuotes = true;
            atFieldStart = false;
            continue;
        }

        if (ch === chosen) {
            row.push(field);
            field = '';
            atFieldStart = true;
            continue;
        }

        if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && clean[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            atFieldStart = true;
            continue;
        }

        field += ch;
        atFieldStart = false;
    }

    if (!atFieldStart || row.length > 0 || field.length > 0) {
        row.push(field);
        rows.push(row);
    }

    // 剔除末尾完全为空的尾行
    while (rows.length > 0) {
        const tail = rows[rows.length - 1];
        if (tail.every(cell => cell === '')) {
            rows.pop();
        } else {
            break;
        }
    }

    return { rows, delimiter: chosen };
}
