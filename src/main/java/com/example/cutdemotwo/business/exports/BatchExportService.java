package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 批量 ZIP 流式打包导出服务：
 * <ul>
 *   <li>预检去重后支持 {@code 1..50} 个方案，并先确认所有目标方案均存在（否则抛出 404）；</li>
 *   <li>严格清洗 {@code ZipEntry} 名称防止 Zip Slip 目录穿越漏洞；</li>
 *   <li>流式逐条写入 {@link ZipOutputStream} 与 {@code manifest.json}，严禁全量驻留堆内存，确保 {@code -Xmx256m} 安全。</li>
 * </ul>
 */
@Service
public class BatchExportService {
    public static final int MAX_SCHEMES_PER_ZIP = 50;
    public static final List<String> DEFAULT_FORMATS = List.of("dxf_lwpolyline", "nc", "ticket_pdf");
    public static final Set<String> ALLOWED_FORMATS = Set.of(
            "dxf_r12", "dxf_lwpolyline", "dxf_aama", "plt", "nc",
            "slitting_json", "slitting_csv", "slitting_xlsx", "ticket_pdf"
    );

    private final CuttingStatePort statePort;
    private final CamExportService camExportService;
    private final SlittingExportService slittingExportService;
    private final ProductionReportService productionReportService;
    private final ObjectMapper json = new ObjectMapper();

    public BatchExportService(
            RemnantService remnantService,
            CamExportService camExportService,
            SlittingExportService slittingExportService,
            ProductionReportService productionReportService
    ) {
        this.statePort = Objects.requireNonNull(remnantService, "remnantService");
        this.camExportService = Objects.requireNonNull(camExportService, "camExportService");
        this.slittingExportService = Objects.requireNonNull(slittingExportService, "slittingExportService");
        this.productionReportService = Objects.requireNonNull(productionReportService, "productionReportService");
    }

    public record BatchExportRequest(
            List<String> schemeIds,
            List<String> formats,
            CamExportOptions camOptions
    ) {}

    public record PreparedBatch(
            List<String> schemeIds,
            List<String> formats,
            CamExportOptions camOptions
    ) {}

    public PreparedBatch prepareBatch(BatchExportRequest request) {
        if (request == null || request.schemeIds() == null || request.schemeIds().isEmpty()) {
            throw new IllegalArgumentException("schemeIds 不能为空");
        }
        LinkedHashSet<String> uniqueIds = new LinkedHashSet<>();
        for (String rawId : request.schemeIds()) {
            if (rawId == null || rawId.isBlank()) {
                throw new IllegalArgumentException("schemeIds 不能包含空值");
            }
            uniqueIds.add(rawId.trim());
        }
        if (uniqueIds.size() > MAX_SCHEMES_PER_ZIP) {
            throw new IllegalArgumentException("单次批量 ZIP 导出最多支持 " + MAX_SCHEMES_PER_ZIP + " 个方案");
        }

        List<String> rawFormats = (request.formats() == null || request.formats().isEmpty())
                ? DEFAULT_FORMATS
                : request.formats();
        LinkedHashSet<String> uniqueFormats = new LinkedHashSet<>();
        for (String f : rawFormats) {
            if (f == null || f.isBlank()) continue;
            String norm = f.trim().toLowerCase(Locale.ROOT);
            if (!ALLOWED_FORMATS.contains(norm)) {
                throw new IllegalArgumentException("不支持的批量导出格式：" + f);
            }
            uniqueFormats.add(norm);
        }
        if (uniqueFormats.isEmpty()) {
            throw new IllegalArgumentException("formats 不能为空");
        }

        CamExportOptions opt = request.camOptions() == null ? CamExportOptions.defaults() : request.camOptions();

        // 预检校验全部方案存在，避免写入半截 ZIP 后再报错
        statePort.inRead(view -> {
            for (String id : uniqueIds) {
                if (view.findScheme(id).isEmpty()) {
                    throw new ExportNotFoundException("未找到排程方案：" + id);
                }
            }
            return null;
        });

        return new PreparedBatch(List.copyOf(uniqueIds), List.copyOf(uniqueFormats), opt);
    }

    public void streamZip(PreparedBatch batch, OutputStream outputStream) throws IOException {
        List<Map<String, Object>> manifestEntries = new ArrayList<>();
        Set<String> usedEntryNames = new HashSet<>();

        try (ZipOutputStream zos = new ZipOutputStream(outputStream, StandardCharsets.UTF_8)) {
            for (String schemeId : batch.schemeIds()) {
                SchedulingScheme scheme = statePort.inRead(view -> view.findScheme(schemeId))
                        .orElseThrow(() -> new ExportNotFoundException("未找到排程方案：" + schemeId));
                String safeStem = sanitizeEntrySegment(schemeId);

                for (String fmt : batch.formats()) {
                    try {
                        EntryPayload payload = renderEntry(scheme, fmt, batch.camOptions());
                        String entryName = deduplicateEntryName(usedEntryNames, safeStem + "/" + sanitizeEntrySegment(payload.fileName()));
                        ZipEntry entry = new ZipEntry(entryName);
                        zos.putNextEntry(entry);
                        zos.write(payload.bytes());
                        zos.closeEntry();
                        manifestEntries.add(Map.of(
                                "schemeId", schemeId,
                                "format", fmt,
                                "entry", entryName,
                                "sizeBytes", payload.bytes().length,
                                "status", "OK"
                        ));
                    } catch (IllegalArgumentException mismatch) {
                        manifestEntries.add(Map.of(
                                "schemeId", schemeId,
                                "format", fmt,
                                "status", "SKIPPED",
                                "reason", mismatch.getMessage()
                        ));
                    }
                }
            }

            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("generatedAt", Instant.now().toString());
            manifest.put("schemeCount", batch.schemeIds().size());
            manifest.put("formats", batch.formats());
            manifest.put("files", manifestEntries);
            ZipEntry manifestEntry = new ZipEntry("manifest.json");
            zos.putNextEntry(manifestEntry);
            zos.write(json.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest));
            zos.closeEntry();
            zos.finish();
        }
    }

    private record EntryPayload(String fileName, byte[] bytes) {}

    private EntryPayload renderEntry(SchedulingScheme scheme, String fmt, CamExportOptions opt) {
        return switch (fmt) {
            case "dxf_r12", "dxf_lwpolyline", "dxf_aama", "plt", "nc" -> {
                var p = camExportService.exportCam(scheme.id(), fmt, opt);
                yield new EntryPayload(p.fileName(), p.bytes());
            }
            case "slitting_json" -> {
                var p = slittingExportService.exportSlitting(scheme.id(), "json");
                yield new EntryPayload(p.fileName(), p.bytes());
            }
            case "slitting_csv" -> {
                var p = slittingExportService.exportSlitting(scheme.id(), "csv");
                yield new EntryPayload(p.fileName(), p.bytes());
            }
            case "slitting_xlsx" -> {
                var p = slittingExportService.exportSlitting(scheme.id(), "xlsx");
                yield new EntryPayload(p.fileName(), p.bytes());
            }
            case "ticket_pdf" -> {
                var p = productionReportService.exportTicketPdf(scheme.id());
                yield new EntryPayload(p.fileName(), p.bytes());
            }
            default -> throw new IllegalArgumentException("不支持的格式：" + fmt);
        };
    }

    /** 严格清洗 ZipEntry 名称段，阻断 .. / \ \0 目录穿越。 */
    public static String sanitizeEntrySegment(String raw) {
        if (raw == null || raw.isBlank()) {
            return "item";
        }
        String clean = raw.replace("\0", "")
                .replace("..", "_")
                .replace('/', '_')
                .replace('\\', '_')
                .replaceAll("[^A-Za-z0-9._-]", "_");
        while (clean.startsWith(".")) {
            clean = "_" + clean.substring(1);
        }
        return clean.isBlank() ? "item" : clean;
    }

    private static String deduplicateEntryName(Set<String> used, String candidate) {
        if (used.add(candidate)) {
            return candidate;
        }
        int idx = 2;
        while (true) {
            int dot = candidate.lastIndexOf('.');
            String numbered = dot > 0
                    ? candidate.substring(0, dot) + "_" + idx + candidate.substring(dot)
                    : candidate + "_" + idx;
            if (used.add(numbered)) {
                return numbered;
            }
            idx++;
        }
    }
}
