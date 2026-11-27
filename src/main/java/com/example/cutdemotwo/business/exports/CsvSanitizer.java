package com.example.cutdemotwo.business.exports;

import java.nio.charset.StandardCharsets;

/**
 * CSV 与 Excel 单元格防公式注入清洗器：
 * <ul>
 *   <li>采用 Unicode 码点遍历：对直接以 C0/C1/DEL/NEL 控制符（{@code cp < 0x20 || Character.isISOControl(cp)}）开头的字符串前置 {@code '}；</li>
 *   <li>跳过前导空白、控制符与格式字符（含 {@code \u200B/\u200C/\u200D/\u2060/\u00AD/\uFEFF} 等 {@code Character.FORMAT} 字符）后，对首有效字符 {@code =, +, -, @} 前置 {@code '}；</li>
 *   <li>提供带 RFC-4180 双引号转义的 {@link #csvCell(Object)} 与 UTF-8 BOM 工具；</li>
 *   <li>提供写入 Apache POI 文本单元格的安全方法 {@link #excelCellText(Object)}。</li>
 * </ul>
 */
public final class CsvSanitizer {
    public static final String UTF8_BOM = "\uFEFF";

    private CsvSanitizer() {}

    public static String sanitizeText(Object value) {
        if (value == null) {
            return "";
        }
        String str = String.valueOf(value);
        if (str.isEmpty()) {
            return "";
        }
        int firstCp = str.codePointAt(0);
        if (firstCp < 0x20 || Character.isISOControl(firstCp)) {
            return "'" + str;
        }
        int idx = 0;
        while (idx < str.length()) {
            int cp = str.codePointAt(idx);
            if (cp <= 0x20 || Character.isWhitespace(cp) || Character.isSpaceChar(cp)
                    || Character.isISOControl(cp) || Character.getType(cp) == Character.FORMAT) {
                idx += Character.charCount(cp);
            } else {
                break;
            }
        }
        if (idx < str.length()) {
            int sig = str.codePointAt(idx);
            if (sig == '=' || sig == '+' || sig == '-' || sig == '@') {
                return "'" + str;
            }
        }
        return str;
    }

    public static String csvCell(Object value) {
        String safe = sanitizeText(value);
        return "\"" + safe.replace("\"", "\"\"") + "\"";
    }

    public static String excelCellText(Object value) {
        return sanitizeText(value);
    }

    public static byte[] toUtf8WithBom(String csvContent) {
        String text = csvContent == null ? "" : csvContent;
        return (UTF8_BOM + text).getBytes(StandardCharsets.UTF_8);
    }
}
