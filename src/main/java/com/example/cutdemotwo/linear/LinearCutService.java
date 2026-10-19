package com.example.cutdemotwo.linear;

import changyang.cut.apsmodule.generator.NewSolver.CuttingSolver;
import changyang.cut.apsmodule.generator.PatternSolver;
import changyang.cut.apsmodule.generator.PatternSolverFour;
import changyang.cut.apsmodule.recut.ReCutApplicationService;
import changyang.cut.apsmodule.service.*;
import changyang.cut.apsmodule.service.excel.*;
import changyang.cut.apsmodule.solver.UnifiedPatternSolver;
import changyang.cut.apsmodule.solver.kernel.CurrentNewSolverKernelAdapter;
import changyang.cut.rest.CuttingExportController;
import changyang.cut.rest.CuttingImportController;
import changyang.cut.rest.context.OptimizationContext;
import jakarta.annotation.PreDestroy;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.multipart.MultipartFile;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

@Service
public class LinearCutService {
    private final Map<String, Task> tasks = new ConcurrentHashMap<>();
    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(8), new ThreadPoolExecutor.AbortPolicy());
    private final ExcelExportService excel = new ExcelExportService();
    private final ExcelProcessingService processing = new ExcelProcessingService(new ExcelImportService(), excel);

    static final class Task {
        final String id = UUID.randomUUID().toString();
        final LinearCutRequest input;
        final OptimizationContext context = new OptimizationContext(new InMemoryOptimizationJobRepository());
        final UndoService undo = new UndoService(context);
        final CuttingExportController operations;
        final OptimizationExecutionService execution;
        volatile String status = "RUNNING";
        volatile String error = "";
        volatile Instant touched = Instant.now();

        Task(LinearCutRequest input, ExcelExportService excel, ExcelProcessingService processing) {
            this.input = input;
            var solver = new UnifiedPatternSolver(new CurrentNewSolverKernelAdapter(new CuttingSolver()),
                    List.of(new PatternSolver(), new PatternSolverFour()));
            var cutting = new CuttingOptimizationService(new OrderNormalizer(), solver);
            execution = new OptimizationExecutionService(cutting, new SolverConfigFactory());
            var changes = new SequenceGroupModificationService(context, excel, undo, new PendingPoolService(),
                    new TempGroupService(context), new ReCutApplicationService(context, excel, undo, cutting));
            operations = new CuttingExportController(context, excel, processing, changes, new PreviewMetadataService());
        }
    }

    public synchronized Map<String, Object> create(LinearCutRequest input) {
        var request = input.toSolverRequest();
        tasks.values().removeIf(t -> !t.status.equals("RUNNING") && t.touched.isBefore(Instant.now().minusSeconds(28800)));
        if (tasks.size() >= 100) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "一维任务已达容量上限，请稍后重试。");
        Task task = new Task(input, excel, processing);
        tasks.put(task.id, task);
        try {
            submit(task, () -> {
                var result = task.execution.execute(request);
                String jobId = task.context.createJob();
                task.context.completeJob(jobId, result.result(), request.getOrderItems(), input.motherWidth(), result.config());
            });
        } catch (RuntimeException e) {
            tasks.remove(task.id);
            throw e;
        }
        return Map.of("taskId", task.id, "status", "RUNNING");
    }

    private void submit(Task task, Runnable operation) {
        try {
            executor.execute(() -> {
                try {
                    operation.run();
                    task.error = "";
                    task.status = "SUCCEEDED";
                } catch (Throwable e) {
                    task.error = e.getMessage() == null ? "分切计算失败，请重试。" : e.getMessage();
                    task.status = "FAILED";
                } finally {
                    task.touched = Instant.now();
                }
            });
        } catch (RejectedExecutionException e) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "计算队列已满，请稍后重试。");
        }
    }

    public Map<String, Object> get(String id) {
        Task task = task(id);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("taskId", task.id);
        response.put("status", task.status);
        response.put("message", task.error);
        if (task.status.equals("RUNNING")) return response;
        synchronized (task) {
            if (task.status.equals("RUNNING")) return Map.of("taskId", id, "status", "RUNNING");
            response.put("input", task.input);
            if (task.context.hasResult()) {
                response.put("result", new OptimizationResultAssembler().toOptimizationResponseV2(
                        task.context.getLastOptimizationResult(), task.context.getLastOrderItems()));
                response.put("preview", task.operations.previewExport(null).getBody());
                response.put("undoCount", task.undo.getUndoCount());
            }
        }
        return response;
    }

    /** 释放已结束的任务；计算中的任务不可释放，调用方稍后重试。 */
    public void discard(String id) {
        Task task = tasks.get(id);
        if (task == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "任务已过期或服务已重启。");
        synchronized (task) {
            if (task.status.equals("RUNNING")) throw new ResponseStatusException(HttpStatus.CONFLICT, "计算中，暂不能释放任务。");
            tasks.remove(id, task);
        }
    }

    public Map<String, Object> change(String id, String action, Map<String, Object> request) {
        Task task = task(id);
        synchronized (task) {
            ready(task);
            if (!Objects.equals(request.get("planId"), task.context.getCurrentPlanId())
                    || !Objects.equals(request.get("baseRevisionId"), task.context.getCurrentRevisionId())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "方案版本已变化，请刷新结果后重试。");
            }
            if (!Set.of("re-cut", "undo").contains(action))
                throw new ResponseStatusException(HttpStatus.NOT_FOUND);
            if (action.equals("re-cut")) validateSelection(task, request);
            task.status = "RUNNING";
            try {
                submit(task, () -> {
                    var response = switch (action) {
                        case "re-cut" -> task.operations.reCut(request);
                        case "undo" -> task.operations.undo();
                        default -> throw new IllegalArgumentException("不支持的调整操作。");
                    };
                    var body = response.getBody();
                    if (!response.getStatusCode().is2xxSuccessful() || body == null || !Boolean.TRUE.equals(body.get("success")))
                        throw new IllegalArgumentException(body == null ? "操作失败。" : String.valueOf(body.get("message")));
                    var result = task.context.getLastOptimizationResult();
                    var summary = CuttingStatistics.summarizeLegacyInstructions(result.getCuttingInstructions(), result.getTotalWidth());
                    result.setTotalRollsUsed(summary.totalRollsUsed());
                    result.setTotalWaste(summary.totalWaste());
                    result.setUtilizationRate(summary.utilizationRate());
                });
            } catch (RuntimeException e) {
                task.status = "SUCCEEDED";
                throw e;
            }
            return Map.of("taskId", id, "status", "RUNNING");
        }
    }

    private void validateSelection(Task task, Map<String, Object> request) {
        if (!(request.get("selectedSequenceNumbers") instanceof List<?> selection) || selection.isEmpty()
                || selection.stream().anyMatch(n -> !(n instanceof Integer)))
            throw new IllegalArgumentException("请勾选有效的分切组合。");
        var groups = excel.buildPreviewGroups(task.context.getLastOptimizationResult());
        var selected = groups.stream().filter(g -> selection.contains(g.get("sequenceNumber"))).toList();
        if (selected.size() != new HashSet<>(selection).size()) throw new IllegalArgumentException("选择的组合已失效，请刷新结果。");
        if (selected.stream().map(g -> g.get("length") + "|" + g.get("surfaceTreatment")).distinct().count() != 1)
            throw new IllegalArgumentException("请只选择同一卷长和表面处理分组内的组合重新搭切。");
        Set<Object> indices = new HashSet<>();
        selected.forEach(g -> indices.addAll((List<?>) g.get("instructionIndices")));
        for (var group : groups) {
            if (((List<?>) group.get("instructionIndices")).stream().anyMatch(indices::contains)
                    && !selection.contains(group.get("sequenceNumber")))
                throw new IllegalArgumentException("所选组合与其他组合共享切割批次，请一并勾选该批次后重切。");
        }
    }

    public byte[] export(String id) throws java.io.IOException {
        Task task = task(id);
        synchronized (task) {
            ready(task);
            Path file = Path.of(excel.exportOptimizationResultV2(task.context.getLastOptimizationResult(), task.id + ".xlsx"));
            try (var workbook = new org.apache.poi.xssf.usermodel.XSSFWorkbook(Files.newInputStream(file));
                    var output = new java.io.ByteArrayOutputStream()) {
                var sheet = workbook.createSheet("分切工艺口径");
                Object[][] rows = {{"母卷总幅宽（mm）", task.input.motherWidth()}, {"左固定切边（mm）", task.input.leftTrim()},
                        {"右固定切边（mm）", task.input.rightTrim()}, {"可切区宽度（mm）", task.input.motherWidth()-task.input.leftTrim()-task.input.rightTrim()},
                        {"组合下限（mm）", task.input.minWidth()}, {"组合上限（mm）", task.input.maxWidth()},
                        {"方案性质", "预计分切方案，不代表实际生产或库存扣减"},
                        {"整卷得率", "成品面积 / 原母卷面积"}, {"可切区利用率", "按重复用卷数累计成品宽度 / 累计可切区宽度"}};
                for (int i=0;i<rows.length;i++) {
                    var row=sheet.createRow(i); row.createCell(0).setCellValue(rows[i][0].toString());
                    if (rows[i][1] instanceof Number number) row.createCell(1).setCellValue(number.doubleValue());
                    else row.createCell(1).setCellValue(rows[i][1].toString());
                }
                sheet.setColumnWidth(0,28*256);sheet.setColumnWidth(1,65*256);
                workbook.write(output); return output.toByteArray();
            }
            finally { Files.deleteIfExists(file); }
        }
    }

    public org.springframework.http.ResponseEntity<Map<String, Object>> parse(MultipartFile file) {
        if (file.isEmpty() || file.getSize() > 10 * 1024 * 1024)
            throw new IllegalArgumentException("请上传不超过 10 MB 的 Excel 文件。");
        return new CuttingImportController(processing).parseExcel(file);
    }

    private Task task(String id) {
        Task task = tasks.get(id);
        if (task != null && !task.status.equals("RUNNING") && task.touched.isBefore(Instant.now().minusSeconds(28800))) {
            tasks.remove(id, task); task = null;
        }
        if (task == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "任务已过期或服务已重启，请使用保留的需求重新计算。");
        task.touched = Instant.now();
        return task;
    }

    private void ready(Task task) {
        if (task.status.equals("RUNNING")) throw new ResponseStatusException(HttpStatus.CONFLICT, "计算中，请等待结果。");
        if (!task.context.hasResult()) throw new ResponseStatusException(HttpStatus.CONFLICT, "尚无可用方案，请先计算。");
    }

    @PreDestroy void close() { executor.shutdownNow(); }
}
