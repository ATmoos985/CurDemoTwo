package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.runtime.IsolatedProcessRunner;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.CancellationException;

@Service
public class PackingSolverService implements com.example.cutdemotwo.algorithm.nesting.ICutSolverEngine {
    private static final Logger log = LoggerFactory.getLogger(PackingSolverService.class);
    // Native rectangle coordinates are integers; one native unit represents 0.1 mm.
    private static final int UNITS_PER_MM = 10;
    static final int DIAGNOSTIC_LOG_TAIL_BYTES = 4096;

    @Override
    public String getEngineType() {
        return "packingsolver";
    }

    @Value("${packingsolver.executable.path:data/solver/packingsolver_rectangleguillotine.exe}")
    private String solverPath;

    @Value("${packingsolver.memory-limit-mb:512}")
    private int memoryLimitMb = 512;

    private final com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService toolpathOptimizerService;
    private final com.example.cutdemotwo.algorithm.toolpath.CutBoundaryCompletionService cutBoundaryCompletionService;

    @org.springframework.beans.factory.annotation.Autowired
    public PackingSolverService(
            com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService toolpathOptimizerService,
            com.example.cutdemotwo.algorithm.toolpath.CutBoundaryCompletionService cutBoundaryCompletionService) {
        this.toolpathOptimizerService = toolpathOptimizerService;
        this.cutBoundaryCompletionService = cutBoundaryCompletionService;
    }

    public PackingSolverService() {
        this.toolpathOptimizerService = new com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService();
        this.cutBoundaryCompletionService = new com.example.cutdemotwo.algorithm.toolpath.CutBoundaryCompletionService();
    }

    @Override
    public EngineCapabilities capabilities() {
        return new EngineCapabilities(getEngineType(), "2", List.of("RECTANGLE"), List.of("GUILLOTINE"), List.of("MAXIMIZE_PIECE_AREA"), 1.0 / UNITS_PER_MM, isAvailable());
    }

    /** Only the native executable counts; any stand-in engine is chosen and labelled by SolverFactory. */
    @Override
    public boolean isAvailable() {
        return solverPath != null && !solverPath.isBlank() && Files.isRegularFile(Path.of(solverPath)) && Files.isExecutable(Path.of(solverPath));
    }

    @Override
    public EngineResult solve(NestingProblem req) {
        ComputationCancellation.check();
        if (!isAvailable()) {
            EngineResult err = new EngineResult();
            err.setSuccess(false);
            err.setFailureStatus("UNAVAILABLE");
            err.setMessage("原生直刀引擎可执行文件缺失或不可执行");
            return err;
        }

        Path tmpDir = null;
        Path solverLog = null;
        try {
            tmpDir = Files.createTempDirectory("ps_cut_");
            solverLog = tmpDir.resolve("solver.log");
            File binsCsv = tmpDir.resolve("bins.csv").toFile();
            File itemsCsv = tmpDir.resolve("items.csv").toFile();
            File defectsCsv = tmpDir.resolve("defects.csv").toFile();
            File certCsv = tmpDir.resolve("certificate.csv").toFile();

            CoordinateFrame frame = CoordinateFrame.of(req);
            double activeL = frame.activeLength();
            if (activeL <= 0) {
                EngineResult err = new EngineResult();
                err.setSuccess(false);
                err.setMessage("卷头修齐量不能大于等于展开总长度");
                return err;
            }

            // 1. bins.csv
            try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(binsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
                pw.println("ID,WIDTH,HEIGHT");
                pw.println("0," + nativeUnits(req.width()) + "," + nativeUnits(activeL));
            }

            // 2. items.csv
            List<NestingProblem.Part> itemTypes = writeItems(itemsCsv, req.parts());

            // 3. defects.csv (offset Y by trimStart)
            try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(defectsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
                pw.println("ID,BIN,X,Y,WIDTH,HEIGHT");
                for (Defect d : EngineGeometry.defects(req)) {
                    double x = frame.toLocalX(d.getSafeX(), d.getSafeW());
                    double y = frame.toLocalY(d.getSafeY(), d.getSafeH());
                    double left = Math.max(0, x), top = Math.max(0, y);
                    double width = Math.min(req.width(), x + d.getSafeW()) - left;
                    double height = Math.min(activeL, y + d.getSafeH()) - top;
                    if (width > 0 && height > 0) {
                        pw.println(d.getId() + ",0," + nativeUnits(left) + "," + nativeUnits(top) + "," +
                                nativeUnits(width) + "," + nativeUnits(height));
                    }
                }
            }

            ProcessBuilder pb = new ProcessBuilder(command(req, itemsCsv, binsCsv, defectsCsv, certCsv));
            pb.redirectErrorStream(true);
            pb.redirectOutput(solverLog.toFile());
            IsolatedProcessRunner.RunResult run = IsolatedProcessRunner.run(pb, (req.timeLimitSeconds() + 5L) * 1000L);
            if (run.timedOut()) {
                logDiagnosticTail("PackingSolver timed out", solverLog, -1);
                throw new IOException("求解超过时限，已终止；库存未变更");
            }
            int exitCode = run.exitCode();
            log.info("PackingSolver finished with code {}", exitCode);

            if (exitCode != 0 || !certCsv.exists() || certCsv.length() == 0) {
                EngineResult err = new EngineResult();
                err.setSuccess(false);
                logDiagnosticTail("PackingSolver failure", solverLog, exitCode);
                err.setMessage(exitCode == -1073741515 ? "求解器缺少运行库（0xC0000135），请检查服务器的 C++ 运行环境；库存未变更" :
                        "求解器退出码 " + exitCode + "，未生成有效方案；请检查求解器运行环境和输入");
                return err;
            }

            return parseCertificate(certCsv, req, itemTypes);

        } catch (CancellationException cancelled) {
            throw cancelled;
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            String tail = readLogTail(solverLog, DIAGNOSTIC_LOG_TAIL_BYTES);
            if (!tail.isEmpty()) {
                log.error("Execution error, solver.log 尾部 4KB：\n{}", tail, e);
            } else {
                log.error("Execution error", e);
            }
            EngineResult err = new EngineResult();
            err.setSuccess(false);
            err.setMessage("求解执行异常: " + e.getMessage());
            return err;
        } finally {
            IsolatedProcessRunner.deleteTempDirectory(tmpDir);
        }
    }

    private static void logDiagnosticTail(String summary, Path solverLog, int exitCode) {
        String tail = readLogTail(solverLog, DIAGNOSTIC_LOG_TAIL_BYTES);
        if (!tail.isEmpty()) {
            log.warn("{} (code={} / 0x{})，solver.log 尾部 4KB：\n{}", summary, exitCode, Integer.toHexString(exitCode), tail);
        } else {
            log.warn("{} (code={} / 0x{})，solver.log 为空或不可读", summary, exitCode, Integer.toHexString(exitCode));
        }
    }

    static String readLogTail(Path logFile, int maxBytes) {
        if (logFile == null || maxBytes <= 0 || !Files.isRegularFile(logFile)) {
            return "";
        }
        try (var channel = java.nio.channels.FileChannel.open(logFile, java.nio.file.StandardOpenOption.READ)) {
            long size = channel.size();
            if (size <= 0L) return "";
            long start = Math.max(0L, size - maxBytes);
            int length = (int) Math.min(maxBytes, size - start);
            var buffer = java.nio.ByteBuffer.allocate(length);
            channel.position(start);
            while (buffer.hasRemaining()) {
                if (channel.read(buffer) < 0) break;
            }
            return new String(buffer.array(), 0, buffer.position(), java.nio.charset.StandardCharsets.UTF_8).trim();
        } catch (IOException readError) {
            return "<无法读取 solver.log: " + readError.getMessage() + ">";
        }
    }

    /**
     * The solver writes the certificate once, when it exits normally: by default it rewrites the whole file after every
     * improvement, which on large instances takes most of the search time. Only a normal exit's certificate is read.
     */
    private List<String> command(NestingProblem req, File itemsCsv, File binsCsv, File defectsCsv, File certCsv) {
        String firstStage = "vertical".equalsIgnoreCase(req.process().firstStageOrientation()) ? "vertical" : "horizontal";
        int memMb = Math.min(4096, Math.max(128, memoryLimitMb));

        List<String> cmd = new ArrayList<>();
        cmd.add(solverPath);
        cmd.add("--items"); cmd.add(itemsCsv.getAbsolutePath());
        cmd.add("--bins"); cmd.add(binsCsv.getAbsolutePath());
        cmd.add("--defects"); cmd.add(defectsCsv.getAbsolutePath());
        cmd.add("--objective"); cmd.add("knapsack");
        cmd.add("--number-of-stages"); cmd.add("3");
        cmd.add("--cut-type"); cmd.add("roadef2018");
        cmd.add("--first-stage-orientation"); cmd.add(firstStage);
        cmd.add("--linear-programming-solver"); cmd.add("highs");
        cmd.add("--certificate"); cmd.add(certCsv.getAbsolutePath());
        cmd.add("--only-write-at-the-end");
        cmd.add("--time-limit"); cmd.add(nativeTimeLimitSeconds(req.timeLimitSeconds()));
        cmd.add("--memory-limit"); cmd.add(Integer.toString(memMb));

        if (!req.parts().stream().anyMatch(NestingProblem.Part::allowRotation)) {
            cmd.add("--no-item-rotation");
        }
        return cmd;
    }

    /**
     * Leave wall-clock headroom for process launch, certificate write (--only-write-at-the-end),
     * and Java validation so the native solver exits cleanly before OptimizationService's deadline.
     */
    static String nativeTimeLimitSeconds(int requestedSeconds) {
        double margin = Math.min(1.8, Math.max(0.75, requestedSeconds * 0.22));
        double budget = Math.max(0.35, requestedSeconds - margin);
        return String.format(Locale.ROOT, "%.2f", budget);
    }

    /**
     * One item type per demand with COPIES, so the solver treats identical pieces as one type instead of
     * one type per piece. Returns the demands in item-type order, which is the certificate's TYPE.
     */
    private static List<NestingProblem.Part> writeItems(File itemsCsv, List<NestingProblem.Part> parts) throws IOException {
        List<NestingProblem.Part> itemTypes = parts.stream().filter(p -> p.quantity() > 0).toList();
        try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(itemsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
            pw.println("ID,WIDTH,HEIGHT,COPIES,STACK_ID,ORIENTED");
            for (int type = 0; type < itemTypes.size(); type++) {
                NestingProblem.Part it = itemTypes.get(type);
                pw.println(type + "," + nativeUnits(it.shape().width()) + "," + nativeUnits(it.shape().height()) + ","
                        + it.quantity() + "," + type + "," + (it.allowRotation() ? 0 : 1));
            }
        }
        return itemTypes;
    }

    private static long nativeUnits(double millimeters) {
        double scaled = millimeters * UNITS_PER_MM;
        long units = Math.round(scaled);
        if (!Double.isFinite(scaled) || Math.abs(scaled - units) > .000001)
            throw new IllegalArgumentException("尺寸必须是 0.1 mm 的整数倍");
        return units;
    }

    private static class CertNode {
        int nodeId;
        double x, y, w, h;
        int type;
        int cut;
        Integer parent;
        List<CertNode> children = new ArrayList<>();
    }

    private EngineResult parseCertificate(File certCsv, NestingProblem req, List<NestingProblem.Part> itemTypes) throws IOException {
        EngineResult res = new EngineResult();
        res.setSuccess(true);

        // Copies share their item type's TYPE; each demand's pieces take ids from its own range, in certificate order,
        // so ids stay unique and grouped by demand as when every piece was its own item type.
        int[] nextPieceId = new int[itemTypes.size()];
        for (int type = 1; type < itemTypes.size(); type++) nextPieceId[type] = nextPieceId[type - 1] + itemTypes.get(type - 1).quantity();

        List<PlacedPiece> pieces = new ArrayList<>();
        List<RemnantPiece> remnants = new ArrayList<>();
        List<CutStep> rawCutSteps = new ArrayList<>();

        int remIndex = 1;
        CoordinateFrame frame = CoordinateFrame.of(req);
        List<Defect> allDefects = EngineGeometry.defects(req);
        String remPrefix = "LEFTOVER";

        if (frame.trimStart() > 0) {
            remnants.add(GuillotinePostProcessor.createTrimRemnant(frame, remIndex++));
            rawCutSteps.add(GuillotinePostProcessor.createTrimCut(frame, 1));
        }

        Map<Integer, CertNode> nodeMap = new LinkedHashMap<>();
        List<CertNode> allNodes = new ArrayList<>();

        try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(certCsv), java.nio.charset.StandardCharsets.UTF_8))) {
            String header = br.readLine();
            String line;
            while ((line = br.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                String[] parts = line.split(",");
                if (parts.length < 9) continue;

                CertNode n = new CertNode();
                n.nodeId = Integer.parseInt(parts[2].trim());
                n.x = Double.parseDouble(parts[3].trim()) / UNITS_PER_MM;
                n.y = Double.parseDouble(parts[4].trim()) / UNITS_PER_MM;
                n.w = Double.parseDouble(parts[5].trim()) / UNITS_PER_MM;
                n.h = Double.parseDouble(parts[6].trim()) / UNITS_PER_MM;
                n.type = Integer.parseInt(parts[7].trim());
                n.cut = Integer.parseInt(parts[8].trim());
                if (parts.length >= 10 && !parts[9].trim().isEmpty()) {
                    try {
                        n.parent = Integer.parseInt(parts[9].trim());
                    } catch (Exception ignored) {}
                }

                nodeMap.put(n.nodeId, n);
                allNodes.add(n);

                double physX = frame.toPhysicalX(n.x, n.w);
                double physY = frame.toPhysicalY(n.y, n.h);

                if (n.type >= 0 && n.cut > 0) {
                    if (n.type >= itemTypes.size()) throw new IOException("求解器返回了未知裁片类型 " + n.type);
                    var part = itemTypes.get(n.type);
                    boolean rotated = Math.abs(n.w - part.shape().width()) > .001 || Math.abs(n.h - part.shape().height()) > .001;
                    pieces.add(new PlacedPiece(nextPieceId[n.type]++, part.name(), physX, physY, n.w, n.h, rotated, part.id()));
                } else if (n.type == -1 || n.type == -3) {
                    RemnantPiece remnant = GuillotinePostProcessor.tryCreateRemnant(
                            req, frame, remPrefix, remIndex, n.y, physX, physY, n.w, n.h, allDefects
                    );
                    if (remnant != null) {
                        remIndex++;
                        remnants.add(remnant);
                    }
                }
            }
        }

        // 构建父子树
        for (CertNode n : allNodes) {
            if (n.parent != null && nodeMap.containsKey(n.parent)) {
                nodeMap.get(n.parent).children.add(n);
            }
        }

        // 提取兄弟子节点之间的 Guillotine 切割线
        for (CertNode p : allNodes) {
            if (p.children.size() <= 1) continue;
            List<CertNode> chList = p.children;

            Set<Double> distinctX = new TreeSet<>(Comparator.comparingDouble(d -> Math.round(d * 10.0)));
            Set<Double> distinctY = new TreeSet<>(Comparator.comparingDouble(d -> Math.round(d * 10.0)));
            for (CertNode c : chList) {
                distinctX.add(c.x);
                distinctY.add(c.y);
            }

            if (distinctY.size() > 1) {
                // 水平横切
                chList.sort(Comparator.comparingDouble(c -> c.y));
                for (int i = 0; i < chList.size() - 1; i++) {
                    CertNode c1 = chList.get(i);
                    CertNode c2 = chList.get(i + 1);
                    double cutY = c1.y + c1.h;
                    if (cutY <= p.y + 0.1 || cutY >= p.y + p.h - 0.1) continue;

                    double minX = chList.stream().mapToDouble(c -> c.x).min().orElse(p.x);
                    double maxX = chList.stream().mapToDouble(c -> c.x + c.w).max().orElse(p.x + p.w);

                    double physPos = frame.toPhysicalHorizontalCutY(cutY);
                    double[] span = frame.toPhysicalXSpan(minX, maxX);
                    int cutLvl = Math.max(1, c2.cut);

                    rawCutSteps.add(new CutStep(
                            rawCutSteps.size() + 1, "横切", physPos, span[0], span[1],
                            String.format("第 %d 阶段横切，裁切范围 [%.0f × %.0f mm]", cutLvl, maxX - minX, p.h)
                    ));
                    rawCutSteps.get(rawCutSteps.size() - 1).setStage(cutLvl);
                }
            } else if (distinctX.size() > 1) {
                // 垂直纵切
                chList.sort(Comparator.comparingDouble(c -> c.x));
                for (int i = 0; i < chList.size() - 1; i++) {
                    CertNode c1 = chList.get(i);
                    CertNode c2 = chList.get(i + 1);
                    double cutX = c1.x + c1.w;
                    if (cutX <= p.x + 0.1 || cutX >= p.x + p.w - 0.1) continue;

                    double minY = chList.stream().mapToDouble(c -> c.y).min().orElse(p.y);
                    double maxY = chList.stream().mapToDouble(c -> c.y + c.h).max().orElse(p.y + p.h);

                    double physPos = frame.toPhysicalVerticalCutX(cutX);
                    double[] span = frame.toPhysicalYSpan(minY, maxY);
                    int cutLvl = Math.max(1, c2.cut);

                    rawCutSteps.add(new CutStep(
                            rawCutSteps.size() + 1, "纵切", physPos, span[0], span[1],
                            String.format("第 %d 阶段纵切，裁切范围 [%.0f × %.0f mm]", cutLvl, p.w, maxY - minY)
                    ));
                    rawCutSteps.get(rawCutSteps.size() - 1).setStage(cutLvl);
                }
            }
        }

        // 100% 完整切断自愈检查 + 刀路连续平滑优化
        List<CutStep> continuousCuts = GuillotinePostProcessor.completeAndOptimizeCuts(
                cutBoundaryCompletionService, toolpathOptimizerService, pieces, remnants, rawCutSteps, frame, true
        );

        res.setPieces(pieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);

        // 面积由统一结果层核算；此处只给出当前策略的进给范围提示。
        res.setSuggestedFeedLength(GuillotinePostProcessor.suggestedFeedLength(pieces));

        return res;
    }
}
