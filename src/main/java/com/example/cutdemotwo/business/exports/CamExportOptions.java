package com.example.cutdemotwo.business.exports;

import java.util.Locale;

/**
 * 生产级 CAM 导出工艺参数（支持过切补偿、引入线、微连接、共边去重与多刀头编码）。
 */
public record CamExportOptions(
        double overcutMm,
        double leadInMm,
        double microJointWidthMm,
        boolean deduplicateCommonEdges,
        String cutTool,
        String punchTool,
        String creaseTool
) {
    public static final String DEFAULT_CUT_TOOL = "T01";
    public static final String DEFAULT_PUNCH_TOOL = "T02";
    public static final String DEFAULT_CREASE_TOOL = "T03";

    public CamExportOptions {
        if (!Double.isFinite(overcutMm) || overcutMm < 0.0 || overcutMm > 20.0) {
            throw new IllegalArgumentException("过切补偿 overcutMm 必须在 0 至 20 mm 之间");
        }
        if (!Double.isFinite(leadInMm) || leadInMm < 0.0 || leadInMm > 100.0) {
            throw new IllegalArgumentException("引入线长度 leadInMm 必须在 0 至 100 mm 之间");
        }
        if (!Double.isFinite(microJointWidthMm) || microJointWidthMm < 0.0 || microJointWidthMm > 50.0) {
            throw new IllegalArgumentException("微连接宽度 microJointWidthMm 必须在 0 至 50 mm 之间");
        }
        cutTool = normalizeToolCode(cutTool, DEFAULT_CUT_TOOL, "cutTool");
        punchTool = normalizeToolCode(punchTool, DEFAULT_PUNCH_TOOL, "punchTool");
        creaseTool = normalizeToolCode(creaseTool, DEFAULT_CREASE_TOOL, "creaseTool");
    }

    public static CamExportOptions defaults() {
        return new CamExportOptions(0.0, 0.0, 0.0, false, DEFAULT_CUT_TOOL, DEFAULT_PUNCH_TOOL, DEFAULT_CREASE_TOOL);
    }

    private static String normalizeToolCode(String raw, String fallback, String fieldName) {
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        String trimmed = raw.trim().toUpperCase(Locale.ROOT);
        if (!trimmed.matches("T[0-9]{1,4}")) {
            throw new IllegalArgumentException("刀头代码 " + fieldName + " 格式无效，仅支持 T01–T9999");
        }
        return trimmed;
    }
}
