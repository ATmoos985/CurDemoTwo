package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.algorithm.api.ToolpathOptimizer;
import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.exports.CamSchemeGeometryAdapter.CamContext;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/**
 * 生产级 CAM 裁切程序导出服务：
 * 统一从受控只读视图提取已冻结方案与绑定母卷窗口瑕疵，输出 DXF (R12/LWPOLYLINE/AAMA)、HPGL (.plt) 与 CNC G-Code (.nc)。
 */
@Service
public class CamExportService {
    public static final Set<String> SUPPORTED_FORMATS = Set.of(
            "dxf_r12", "dxf_lwpolyline", "dxf_aama", "plt", "nc"
    );

    private final CuttingStatePort statePort;
    private final DxfExportRenderer dxfRenderer = new DxfExportRenderer();
    private final HpglExportRenderer hpglRenderer = new HpglExportRenderer();
    private final GCodeExportRenderer gcodeRenderer;

    public CamExportService(RemnantService remnantService, ToolpathOptimizer toolpathOptimizer) {
        this.statePort = Objects.requireNonNull(remnantService, "remnantService");
        this.gcodeRenderer = new GCodeExportRenderer(Objects.requireNonNull(toolpathOptimizer, "toolpathOptimizer"));
    }

    public record CamExportPayload(String fileName, String contentType, byte[] bytes) {}

    public CamExportPayload exportCam(String schemeId, String format, CamExportOptions options) {
        String cleanId = requireSchemeId(schemeId);
        String fmt = normalizeFormat(format);
        CamExportOptions opt = options == null ? CamExportOptions.defaults() : options;

        CamContext ctx = statePort.inRead(view -> {
            SchedulingScheme scheme = view.findScheme(cleanId)
                    .orElseThrow(() -> new ExportNotFoundException("未找到排程方案：" + cleanId));
            MotherRollInfo roll = (scheme.rollId() != null && !scheme.rollId().isBlank())
                    ? view.findRoll(scheme.rollId()).orElse(null)
                    : null;
            return CamSchemeGeometryAdapter.extract(scheme, roll);
        });

        String content = switch (fmt) {
            case "dxf_r12" -> dxfRenderer.renderR12(ctx);
            case "dxf_lwpolyline" -> dxfRenderer.renderLwPolyline(ctx);
            case "dxf_aama" -> dxfRenderer.renderAama(ctx);
            case "plt" -> hpglRenderer.render(ctx);
            case "nc" -> gcodeRenderer.render(ctx, opt);
            default -> throw new IllegalArgumentException("不支持的 CAM 导出格式：" + format);
        };

        String ext = switch (fmt) {
            case "plt" -> "plt";
            case "nc" -> "nc";
            default -> "dxf";
        };
        String contentType = switch (fmt) {
            case "plt" -> "application/vnd.hp-hpgl; charset=UTF-8";
            case "nc" -> "text/plain; charset=UTF-8";
            default -> "application/dxf; charset=UTF-8";
        };
        String safeFile = sanitizeFileStem(cleanId) + "-" + fmt + "." + ext;
        return new CamExportPayload(safeFile, contentType, content.getBytes(StandardCharsets.UTF_8));
    }

    private static String normalizeFormat(String format) {
        if (format == null || format.isBlank()) {
            return "dxf_lwpolyline";
        }
        String lower = format.trim().toLowerCase(Locale.ROOT);
        if (!SUPPORTED_FORMATS.contains(lower)) {
            throw new IllegalArgumentException("不支持的 CAM 格式：" + format + "，支持 dxf_r12/dxf_lwpolyline/dxf_aama/plt/nc");
        }
        return lower;
    }

    private static String requireSchemeId(String schemeId) {
        if (schemeId == null || schemeId.isBlank()) {
            throw new IllegalArgumentException("方案编号 schemeId 不能为空");
        }
        return schemeId.trim();
    }

    static String sanitizeFileStem(String raw) {
        String clean = raw == null ? "scheme" : raw.replaceAll("[^A-Za-z0-9._-]", "_");
        return clean.isBlank() ? "scheme" : clean;
    }
}
