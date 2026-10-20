package com.example.cutdemotwo.algorithm.solver;

import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.algorithm.solver.EngineResult;
import com.example.cutdemotwo.algorithm.solver.EngineCapabilities;
import com.example.cutdemotwo.algorithm.solver.EngineGeometry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

@Service
public class PackingSolverService implements com.example.cutdemotwo.algorithm.solver.ICutSolverEngine {
    private static final Logger log = LoggerFactory.getLogger(PackingSolverService.class);
    // Native rectangle coordinates are integers; one native unit represents 0.1 mm.
    private static final int UNITS_PER_MM = 10;

    @Override
    public String getEngineType() {
        return "packingsolver";
    }

    @Value("${packingsolver.executable.path:data/solver/packingsolver_rectangleguillotine.exe}")
    private String solverPath;

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
        if (!isAvailable()) {
            EngineResult err = new EngineResult();
            err.setSuccess(false);
            err.setFailureStatus("UNAVAILABLE");
            err.setMessage("原生直刀引擎可执行文件缺失或不可执行");
            return err;
        }

        Path tmpDir = null;
        Process process = null;
        try {
            tmpDir = Files.createTempDirectory("ps_cut_");
            File binsCsv = tmpDir.resolve("bins.csv").toFile();
            File itemsCsv = tmpDir.resolve("items.csv").toFile();
            File defectsCsv = tmpDir.resolve("defects.csv").toFile();
            File certCsv = tmpDir.resolve("certificate.csv").toFile();

            double activeL = req.height() - req.process().trimStart();
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

            String origin = req.process().startCorner() != null ? req.process().startCorner().trim().toLowerCase() : "right-top";
            boolean isRightOrigin = origin.startsWith("right");
            boolean isBottomOrigin = origin.endsWith("bottom");
            boolean isSheet = req.sheet();
            boolean mirrorY = isSheet && isBottomOrigin;

            // 3. defects.csv (offset Y by trimStart)
            try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(defectsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
                pw.println("ID,BIN,X,Y,WIDTH,HEIGHT");
                for (Defect d : EngineGeometry.defects(req)) {
                    double x = isRightOrigin ? req.width() - d.getX() - d.getW() - d.getMargin() : d.getX() - d.getMargin();
                    double y = mirrorY ? activeL - d.getY() - d.getH() - d.getMargin() : d.getY() - req.process().trimStart() - d.getMargin();
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
            Path output = tmpDir.resolve("solver.log");
            pb.redirectOutput(output.toFile());
            process = pb.start();
            if (!process.waitFor(req.timeLimitSeconds() + 5L, java.util.concurrent.TimeUnit.SECONDS))
                throw new IOException("求解超过时限，已终止；库存未变更");
            int exitCode = process.exitValue();
            log.info("PackingSolver finished with code {}", exitCode);

            if (exitCode != 0 || !certCsv.exists() || certCsv.length() == 0) {
                EngineResult err = new EngineResult();
                err.setSuccess(false);
                log.warn("Solver failure code {} (0x{})", exitCode, Integer.toHexString(exitCode));
                err.setMessage(exitCode == -1073741515 ? "求解器缺少运行库（0xC0000135），请检查服务器的 C++ 运行环境；库存未变更" :
                        "求解器退出码 " + exitCode + "，未生成有效方案；请检查求解器运行环境和输入");
                return err;
            }

            return parseCertificate(certCsv, req, itemTypes);

        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            log.error("Execution error", e);
            EngineResult err = new EngineResult();
            err.setSuccess(false);
            err.setMessage("求解执行异常: " + e.getMessage());
            return err;
        } finally {
            if (process != null && process.isAlive()) {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
                try { process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            }
            // Only delete files created in this invocation's fresh temporary directory; never follow links.
            if (tmpDir != null) {
                try (var files = Files.walk(tmpDir)) {
                    for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file);
                } catch (IOException cleanup) { log.warn("Unable to clean solver temporary directory", cleanup); }
            }
        }
    }

    /**
     * The solver writes the certificate once, when it exits normally: by default it rewrites the whole file after every
     * improvement, which on large instances takes most of the search time. Only a normal exit's certificate is read.
     */
    private List<String> command(NestingProblem req, File itemsCsv, File binsCsv, File defectsCsv, File certCsv) {
        String firstStage = "vertical".equalsIgnoreCase(req.process().firstStageOrientation()) ? "vertical" : "horizontal";

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
        cmd.add("--time-limit"); cmd.add(Integer.toString(req.timeLimitSeconds()));

        if (!req.parts().stream().anyMatch(NestingProblem.Part::allowRotation)) {
            cmd.add("--no-item-rotation");
        }
        return cmd;
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
        String origin = req.process().startCorner() != null ? req.process().startCorner().trim().toLowerCase() : "right-top";
        boolean isRightOrigin = origin.startsWith("right");
        boolean isBottomOrigin = origin.endsWith("bottom");
        boolean isSheet = req.sheet();
        
        String remPrefix = "LEFTOVER";
        
        // 连续送料沿 Y 正方向排料；整块材料允许按底部起刀基准镜像排列。
        boolean mirrorY = isSheet && isBottomOrigin;
        double trim = req.process().trimStart();

        if (trim > 0) {
            double trimArea = (req.width() * trim) / 1_000_000.0;
            double trimY = mirrorY ? (req.height() - trim) : 0;
            remnants.add(new RemnantPiece(
                    String.format("TRIM-%02d", remIndex++),
                    "卷头修齐料头",
                    0, trimY, req.width(), trim, trimArea, false
            ));
            rawCutSteps.add(new CutStep(
                    1,
                    "横切",
                    mirrorY ? (req.height() - trim) : trim,
                    0,
                    req.width(),
                    String.format("第 0 阶段：卷头修齐横切断刀，切除 0~%.0f mm 不规则料头并确立绝对测量原点", trim)
            ));
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

                double physX = EngineGeometry.normalizeZero(isRightOrigin ? (req.width() - n.x - n.w) : n.x);
                double physY = EngineGeometry.normalizeZero(mirrorY ? (req.height() - n.y - n.h - trim) : (n.y + trim));

                if (n.type >= 0 && n.cut > 0) {
                    if (n.type >= itemTypes.size()) throw new IOException("求解器返回了未知裁片类型 " + n.type);
                    var part = itemTypes.get(n.type);
                    boolean rotated = Math.abs(n.w - part.shape().width()) > .001 || Math.abs(n.h - part.shape().height()) > .001;
                    pieces.add(new PlacedPiece(nextPieceId[n.type]++, part.name(), physX, physY, n.w, n.h, rotated, part.id()));
                } else if (n.type == -1 || n.type == -3) {
                    // Remnant / waste
                    // 后续仍连接材料时，全幅尾部保留为连续材料，不生成独立回收块。
                    boolean isContinuousTail = !isSheet &&
                            req.material().continuesAfterRegion() &&
                            (n.w >= req.width() - 30) &&
                            (physY + n.h >= req.height() - 30 || n.y + n.h >= req.height() - 30);
                    if (!isContinuousTail && n.w >= req.process().minReusableWidth() && n.h >= req.process().minReusableHeight()) {
                        double area = (n.w * n.h) / 1_000_000.0;
                        boolean hasDefect = checkDefectOverlap(physX, physY, n.w, n.h, EngineGeometry.defects(req));
                        String status = hasDefect ? "带疵料头" : "可用料头";
                        remnants.add(new RemnantPiece(String.format("%s-%02d", remPrefix, remIndex++), status, physX, physY, n.w, n.h, area, hasDefect));
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

                    double physPos = mirrorY ? (req.height() - cutY - trim) : (cutY + trim);
                    double physStart = isRightOrigin ? (req.width() - maxX) : minX;
                    double physEnd = isRightOrigin ? (req.width() - minX) : maxX;
                    int cutLvl = Math.max(1, c2.cut);

                    rawCutSteps.add(new CutStep(
                            rawCutSteps.size() + 1, "横切", physPos, Math.min(physStart, physEnd), Math.max(physStart, physEnd),
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

                    double physPos = isRightOrigin ? (req.width() - cutX) : cutX;
                    double physStart = mirrorY ? (req.height() - maxY - trim) : (minY + trim);
                    double physEnd = mirrorY ? (req.height() - minY - trim) : (maxY + trim);
                    int cutLvl = Math.max(1, c2.cut);

                    rawCutSteps.add(new CutStep(
                            rawCutSteps.size() + 1, "纵切", physPos, Math.min(physStart, physEnd), Math.max(physStart, physEnd),
                            String.format("第 %d 阶段纵切，裁切范围 [%.0f × %.0f mm]", cutLvl, p.w, maxY - minY)
                    ));
                    rawCutSteps.get(rawCutSteps.size() - 1).setStage(cutLvl);
                }
            }
        }

        // 100% 完整切断自愈检查 (确保无粘连)
        List<CutStep> fullySeparatedCuts = cutBoundaryCompletionService.ensureCompleteSeparation(
                pieces, remnants, rawCutSteps, req.width(), req.height(), isSheet
        );

        // 刀路连续平滑优化 (赋予 startX, startY, endX, endY, airDistance，消除乱跳)
        double homeX = isRightOrigin ? req.width() : 0.0;
        double homeY = isBottomOrigin ? req.height() : 0.0;
        List<CutStep> continuousCuts = toolpathOptimizerService.optimizeAndChain(fullySeparatedCuts, homeX, homeY, true);

        res.setPieces(pieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);

        // 面积由统一结果层核算；此处只给出当前策略的进给范围提示。
        double maxY = pieces.stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(0);
        res.setSuggestedFeedLength(maxY);

        return res;
    }

    private boolean checkDefectOverlap(double x, double y, double w, double h, List<Defect> defects) {
        for (Defect d : defects) {
            boolean noOverlap = (x + w <= d.getSafeX() || x >= d.getSafeX() + d.getSafeW() ||
                    y + h <= d.getSafeY() || y >= d.getSafeY() + d.getSafeH());
            if (!noOverlap) return true;
        }
        return false;
    }
}
