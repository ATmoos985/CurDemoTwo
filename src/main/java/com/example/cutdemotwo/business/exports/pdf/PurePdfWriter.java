package com.example.cutdemotwo.business.exports.pdf;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;

/**
 * 纯 Java 零第三方依赖 PDF 1.4 文档写入器：
 * <ul>
 *   <li>支持 A4（595 × 842 pt）多页自动分页、{@code FlateDecode} 压缩内容流与精确字节偏移 {@code xref} 表；</li>
 *   <li>内置 {@code Helvetica}（纯 ASCII）与 {@code STSong-Light / UniGB-UTF16-H}（UTF-16BE 中文混排）双字体；</li>
 *   <li>提供基于页面顶部坐标系 {@code topY} 的文本与矢量图形原语，简化业务报表与随工单排版。</li>
 * </ul>
 */
public final class PurePdfWriter {
    public static final float A4_WIDTH = 595.0f;
    public static final float A4_HEIGHT = 842.0f;

    private final List<StringBuilder> pages = new ArrayList<>();
    private StringBuilder currentPage;

    public PurePdfWriter() {
        newPage();
    }

    public void newPage() {
        currentPage = new StringBuilder(4096);
        pages.add(currentPage);
    }

    public int pageCount() {
        return pages.size();
    }

    public void setStrokeColor(float r, float g, float b) {
        currentPage.append(String.format(Locale.ROOT, "%.3f %.3f %.3f RG\n", r, g, b));
    }

    public void setFillColor(float r, float g, float b) {
        currentPage.append(String.format(Locale.ROOT, "%.3f %.3f %.3f rg\n", r, g, b));
    }

    public void setLineWidth(float width) {
        currentPage.append(String.format(Locale.ROOT, "%.2f w\n", width));
    }

    /** 以页面左上角为原点的矩形绘制（topY 为矩形上边距离页面顶部的距离）。 */
    public void drawRectTop(float x, float topY, float w, float h, boolean stroke, boolean fill) {
        float pdfY = A4_HEIGHT - topY - h;
        currentPage.append(String.format(Locale.ROOT, "%.2f %.2f %.2f %.2f re ", x, pdfY, w, h));
        if (stroke && fill) {
            currentPage.append("B\n");
        } else if (fill) {
            currentPage.append("f\n");
        } else {
            currentPage.append("S\n");
        }
    }

    public void drawLineTop(float x1, float topY1, float x2, float topY2) {
        float y1 = A4_HEIGHT - topY1;
        float y2 = A4_HEIGHT - topY2;
        currentPage.append(String.format(Locale.ROOT, "%.2f %.2f m %.2f %.2f l S\n", x1, y1, x2, y2));
    }

    public void drawPolygonTop(float[] xs, float[] topYs, boolean stroke, boolean fill) {
        if (xs == null || topYs == null || xs.length < 3 || xs.length != topYs.length) {
            return;
        }
        currentPage.append(String.format(Locale.ROOT, "%.2f %.2f m\n", xs[0], A4_HEIGHT - topYs[0]));
        for (int i = 1; i < xs.length; i++) {
            currentPage.append(String.format(Locale.ROOT, "%.2f %.2f l\n", xs[i], A4_HEIGHT - topYs[i]));
        }
        currentPage.append("h ");
        if (stroke && fill) {
            currentPage.append("B\n");
        } else if (fill) {
            currentPage.append("f\n");
        } else {
            currentPage.append("S\n");
        }
    }

    /** 在页面指定坐标（距顶部 topY pt）绘制单行文本（自动按 ASCII / CJK 选择字体并编码）。 */
    public void drawTextTop(float x, float topY, float fontSize, String text) {
        if (text == null || text.isEmpty()) {
            return;
        }
        String clean = sanitizeText(text);
        if (clean.isEmpty()) {
            return;
        }
        float pdfY = A4_HEIGHT - topY;
        boolean asciiOnly = isPureAscii(clean);
        currentPage.append("BT\n");
        if (asciiOnly) {
            currentPage.append(String.format(Locale.ROOT, "/F1 %.1f Tf\n", fontSize));
            currentPage.append(String.format(Locale.ROOT, "1 0 0 1 %.2f %.2f Tm\n", x, pdfY));
            currentPage.append('(').append(escapePdfAscii(clean)).append(") Tj\n");
        } else {
            currentPage.append(String.format(Locale.ROOT, "/F2 %.1f Tf\n", fontSize));
            currentPage.append(String.format(Locale.ROOT, "1 0 0 1 %.2f %.2f Tm\n", x, pdfY));
            currentPage.append('<').append(toUtf16BeHex(clean)).append("> Tj\n");
        }
        currentPage.append("ET\n");
    }

    public byte[] toPdfBytes() {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(16384);
            // PDF 1.4 头 + 4 字节高位二进制标识
            out.write("%PDF-1.4\n".getBytes(StandardCharsets.US_ASCII));
            out.write(new byte[]{'%', (byte) 0xE2, (byte) 0xE3, (byte) 0xCF, (byte) 0xD3, '\n'});

            int pageCount = pages.size();
            // 1: Catalog, 2: Pages, 3: Helvetica, 4: STSong-Light Type0, 5: CIDFont,
            // 然后每页 2 个对象：pageObjId = 6 + i*2, contentObjId = 7 + i*2
            int totalObjects = 5 + pageCount * 2;
            long[] offsets = new long[totalObjects + 1];

            // Obj 1: Catalog
            offsets[1] = out.size();
            writeAscii(out, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

            // Obj 2: Pages
            offsets[2] = out.size();
            StringBuilder kids = new StringBuilder();
            for (int i = 0; i < pageCount; i++) {
                if (i > 0) kids.append(' ');
                kids.append(6 + i * 2).append(" 0 R");
            }
            writeAscii(out, "2 0 obj\n<< /Type /Pages /Kids [ " + kids + " ] /Count " + pageCount + " >>\nendobj\n");

            // Obj 3: Standard Helvetica Font
            offsets[3] = out.size();
            writeAscii(out, "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");

            // Obj 4: CJK Type0 Font
            offsets[4] = out.size();
            writeAscii(out, "4 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UTF16-H /DescendantFonts [ 5 0 R ] >>\nendobj\n");

            // Obj 5: CIDFontType0
            offsets[5] = out.size();
            writeAscii(out, "5 0 obj\n<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
                    + "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>\nendobj\n");

            for (int i = 0; i < pageCount; i++) {
                int pageObjId = 6 + i * 2;
                int contentObjId = 7 + i * 2;
                byte[] compressed = deflate(pages.get(i).toString().getBytes(StandardCharsets.UTF_8));

                offsets[pageObjId] = out.size();
                writeAscii(out, pageObjId + " 0 obj\n"
                        + "<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 595 842 ] "
                        + "/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> "
                        + "/Contents " + contentObjId + " 0 R >>\nendobj\n");

                offsets[contentObjId] = out.size();
                writeAscii(out, contentObjId + " 0 obj\n<< /Length " + compressed.length + " /Filter /FlateDecode >>\nstream\n");
                out.write(compressed);
                writeAscii(out, "\nendstream\nendobj\n");
            }

            long xrefPos = out.size();
            writeAscii(out, "xref\n0 " + (totalObjects + 1) + "\n");
            writeAscii(out, "0000000000 65535 f \n");
            for (int id = 1; id <= totalObjects; id++) {
                writeAscii(out, String.format(Locale.ROOT, "%010d 00000 n \n", offsets[id]));
            }
            writeAscii(out, "trailer\n<< /Size " + (totalObjects + 1) + " /Root 1 0 R >>\n");
            writeAscii(out, "startxref\n" + xrefPos + "\n%%EOF\n");
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("构建 PDF 1.4 字节流失败", e);
        }
    }

    private static void writeAscii(ByteArrayOutputStream out, String text) throws IOException {
        out.write(text.getBytes(StandardCharsets.US_ASCII));
    }

    private static byte[] deflate(byte[] raw) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(raw.length);
        Deflater deflater = new Deflater(Deflater.DEFAULT_COMPRESSION);
        try (DeflaterOutputStream dos = new DeflaterOutputStream(baos, deflater)) {
            dos.write(raw);
        } finally {
            deflater.end();
        }
        return baos.toByteArray();
    }

    private static String sanitizeText(String raw) {
        StringBuilder sb = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c < 0x20 || c == 0x7F) {
                if (c == '\r' || c == '\n' || c == '\t') {
                    sb.append(' ');
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static boolean isPureAscii(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 0x20 || c > 0x7E) {
                return false;
            }
        }
        return true;
    }

    private static String escapePdfAscii(String text) {
        StringBuilder sb = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\\' || c == '(' || c == ')') {
                sb.append('\\');
            }
            sb.append(c);
        }
        return sb.toString();
    }

    private static String toUtf16BeHex(String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_16BE);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >>> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString().toUpperCase(Locale.ROOT);
    }
}
