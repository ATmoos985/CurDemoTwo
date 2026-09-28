package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

@Service
public class PackingSolverService implements com.example.cutdemotwo.service.solver.ICutSolverEngine {
    private static final Logger log = LoggerFactory.getLogger(PackingSolverService.class);

    @Override
    public String getEngineType() {
        return "packingsolver";
    }

    @Value("${packingsolver.executable.path:d:/GitLab/packingsolver/build/src/rectangleguillotine/packingsolver_rectangleguillotine.exe}")
    private String solverPath;

    private final com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService toolpathOptimizerService;
    private final com.example.cutdemotwo.service.toolpath.CutBoundaryCompletionService cutBoundaryCompletionService;

    @org.springframework.beans.factory.annotation.Autowired
    public PackingSolverService(
            com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService toolpathOptimizerService,
            com.example.cutdemotwo.service.toolpath.CutBoundaryCompletionService cutBoundaryCompletionService) {
        this.toolpathOptimizerService = toolpathOptimizerService;
        this.cutBoundaryCompletionService = cutBoundaryCompletionService;
    }

    public PackingSolverService() {
        this.toolpathOptimizerService = new com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService();
        this.cutBoundaryCompletionService = new com.example.cutdemotwo.service.toolpath.CutBoundaryCompletionService();
    }

    public boolean isAvailable() {
        File f = new File(solverPath);
        return f.exists() && f.canExecute();
    }

    public SolveResponse solve(SolveRequest req) {
        if (!isAvailable()) {
            SolveResponse err = new SolveResponse();
            err.setSuccess(false);
            err.setMessage("PackingSolver 可执行文件不存在或不可执行: " + solverPath);
            return err;
        }

        try {
            Path tmpDir = Files.createTempDirectory("ps_cut_");
            File binsCsv = tmpDir.resolve("bins.csv").toFile();
            File itemsCsv = tmpDir.resolve("items.csv").toFile();
            File defectsCsv = tmpDir.resolve("defects.csv").toFile();
            File certCsv = tmpDir.resolve("certificate.csv").toFile();

            double activeL = req.getRollL() - req.getTrimStart();
            if (activeL <= 0) {
                SolveResponse err = new SolveResponse();
                err.setSuccess(false);
                err.setMessage("卷头修齐量不能大于等于展开总长度");
                return err;
            }

            // 1. bins.csv
            try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(binsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
                pw.println("ID,WIDTH,HEIGHT");
                pw.println("0," + (int)req.getRollW() + "," + (int)activeL);
            }

            // 2. items.csv
            Map<Integer, String> itemMap = new HashMap<>();
            Map<Integer, Integer> demandIdMap = new HashMap<>();
            try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(itemsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
                pw.println("ID,WIDTH,HEIGHT,STACK_ID");
                int idx = 0;
                for (PieceDemand it : req.getDemands()) {
                    for (int c = 0; c < it.getDemand(); c++) {
                        pw.println(idx + "," + (int)it.getWidth() + "," + (int)it.getLength() + ",0");
                        itemMap.put(idx, it.getName());
                        demandIdMap.put(idx, it.getId());
                        idx++;
                    }
                }
            }

            String origin = req.getCutOrigin() != null ? req.getCutOrigin().trim().toLowerCase() : "right-top";
            boolean isRightOrigin = origin.startsWith("right");
            boolean isBottomOrigin = origin.endsWith("bottom");
            boolean isRemnantFeed = "remnant".equalsIgnoreCase(req.getFeedPortType());
            boolean mirrorY = isRemnantFeed && isBottomOrigin;

            // 3. defects.csv (offset Y by trimStart)
            try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(defectsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
                pw.println("ID,BIN,X,Y,WIDTH,HEIGHT");
                for (Defect d : req.getDefects()) {
                    double dy = d.getY() - req.getTrimStart();
                    if (dy + d.getH() >= 0) {
                        double safeX = isRightOrigin ?
                                Math.max(0, req.getRollW() - d.getX() - d.getW() - d.getMargin()) : d.getSafeX();
                        double safeY = mirrorY ?
                                Math.max(0, req.getRollL() - dy - d.getH() - d.getMargin()) : Math.max(0, dy - d.getMargin());
                        pw.println(d.getId() + ",0," + (int)safeX + "," + (int)safeY + "," +
                                (int)d.getSafeW() + "," + (int)d.getSafeH());
                    }
                }
            }

            String firstStage = "vertical".equalsIgnoreCase(req.getFirstStageOrientation()) ? "vertical" : "horizontal";

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
            cmd.add("--time-limit"); cmd.add("2");

            if (!req.isAllowRotation()) {
                cmd.add("--no-item-rotation");
            }

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process process = pb.start();

            // Read output
            StringBuilder logOut = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    logOut.append(line).append("\n");
                }
            }

            int exitCode = process.waitFor();
            log.info("PackingSolver finished with code {}", exitCode);

            if (!certCsv.exists() || certCsv.length() == 0) {
                SolveResponse err = new SolveResponse();
                err.setSuccess(false);
                err.setMessage("求解失败或无证书输出:\n" + logOut);
                return err;
            }

            return parseCertificate(certCsv, req, itemMap, demandIdMap);

        } catch (Exception e) {
            log.error("Execution error", e);
            SolveResponse err = new SolveResponse();
            err.setSuccess(false);
            err.setMessage("求解执行异常: " + e.getMessage());
            return err;
        }
    }

    private static class CertNode {
        int nodeId;
        double x, y, w, h;
        int type;
        int cut;
        Integer parent;
        List<CertNode> children = new ArrayList<>();
    }

    private SolveResponse parseCertificate(File certCsv, SolveRequest req, Map<Integer, String> itemMap, Map<Integer, Integer> demandIdMap) throws IOException {
        SolveResponse res = new SolveResponse();
        res.setSuccess(true);
        res.setEngine("PackingSolver (C++ 2D-Guillotine & HiGHS)");
        res.setRollW(req.getRollW());
        res.setRollL(req.getRollL());
        res.setDefects(req.getDefects());

        List<PlacedPiece> pieces = new ArrayList<>();
        List<RemnantPiece> remnants = new ArrayList<>();
        List<CutStep> rawCutSteps = new ArrayList<>();

        int remIndex = 1;
        String origin = req.getCutOrigin() != null ? req.getCutOrigin().trim().toLowerCase() : "right-top";
        boolean isRightOrigin = origin.startsWith("right");
        boolean isBottomOrigin = origin.endsWith("bottom");
        boolean isRemnantFeed = "remnant".equalsIgnoreCase(req.getFeedPortType());
        
        int stationIdx = (int) Math.round(req.getWindowStartY() / Math.max(100.0, req.getRollL())) + 1;
        if (stationIdx <= 0) stationIdx = 1;
        String remPrefix = isRemnantFeed ? "REM-RM" : ("REM-S" + stationIdx);
        
        // 关键统一：在母卷连续开卷长卷模式下，裁片排料必须顺着送料进给流向紧贴工位入口 (y + trim)，
        // 余量留在当前工位末尾，彻底杜绝反转导致两工位交界处凭空留出 260mm 悬空死区！
        // 仅在单板料头模式且指定底部原点时，才将料头裁片倒贴至料头下底边。
        boolean mirrorY = isRemnantFeed && isBottomOrigin;
        double trim = req.getTrimStart();

        if (trim > 0) {
            double trimArea = (req.getRollW() * trim) / 1_000_000.0;
            double trimY = mirrorY ? (req.getRollL() - trim) : 0;
            remnants.add(new RemnantPiece(
                    String.format("REM-TRIM-S%d-%02d", stationIdx, remIndex++),
                    "卷头修齐料头",
                    0, trimY, req.getRollW(), trim, trimArea, false
            ));
            rawCutSteps.add(new CutStep(
                    1,
                    "横切",
                    mirrorY ? (req.getRollL() - trim) : trim,
                    0,
                    req.getRollW(),
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
                n.x = Double.parseDouble(parts[3].trim());
                n.y = Double.parseDouble(parts[4].trim());
                n.w = Double.parseDouble(parts[5].trim());
                n.h = Double.parseDouble(parts[6].trim());
                n.type = Integer.parseInt(parts[7].trim());
                n.cut = Integer.parseInt(parts[8].trim());
                if (parts.length >= 10 && !parts[9].trim().isEmpty()) {
                    try {
                        n.parent = Integer.parseInt(parts[9].trim());
                    } catch (Exception ignored) {}
                }

                nodeMap.put(n.nodeId, n);
                allNodes.add(n);

                double physX = isRightOrigin ? (req.getRollW() - n.x - n.w) : n.x;
                double physY = mirrorY ? (req.getRollL() - n.y - n.h - trim) : (n.y + trim);

                if (n.type >= 0 && n.cut > 0) {
                    String name = itemMap.getOrDefault(n.type, "裁片-" + n.type);
                    Integer demId = demandIdMap != null ? demandIdMap.get(n.type) : null;
                    pieces.add(new PlacedPiece(n.type, name, physX, physY, n.w, n.h, false, demId));
                } else if (n.type == -1 || n.type == -3) {
                    // Remnant / waste
                    // 关键过滤：在母卷长卷连续开卷模式下，若母卷尚未开完，位于工位尾部全幅贯通的未排空区属于连续母卷自然顺延，并非被切断废弃的边料料头！
                    boolean isContinuousMotherRollTail = !isRemnantFeed &&
                            (req.getWindowStartY() + req.getRollL() < req.getTotalRollL() - 100) &&
                            (n.w >= req.getRollW() - 30) &&
                            (physY + n.h >= req.getRollL() - 30 || n.y + n.h >= req.getRollL() - 30);
                    if (!isContinuousMotherRollTail && n.w >= 200 && n.h >= 300) {
                        double area = (n.w * n.h) / 1_000_000.0;
                        boolean hasDefect = checkDefectOverlap(physX, physY, n.w, n.h, req.getDefects());
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

                    double physPos = mirrorY ? (req.getRollL() - cutY - trim) : (cutY + trim);
                    double physStart = isRightOrigin ? (req.getRollW() - maxX) : minX;
                    double physEnd = isRightOrigin ? (req.getRollW() - minX) : maxX;
                    int cutLvl = Math.max(1, c2.cut);

                    rawCutSteps.add(new CutStep(
                            rawCutSteps.size() + 1, "横切", physPos, Math.min(physStart, physEnd), Math.max(physStart, physEnd),
                            String.format("第 %d 阶段横切，裁切范围 [%.0f × %.0f mm]", cutLvl, maxX - minX, p.h)
                    ));
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

                    double physPos = isRightOrigin ? (req.getRollW() - cutX) : cutX;
                    double physStart = mirrorY ? (req.getRollL() - maxY - trim) : (minY + trim);
                    double physEnd = mirrorY ? (req.getRollL() - minY - trim) : (maxY + trim);
                    int cutLvl = Math.max(1, c2.cut);

                    rawCutSteps.add(new CutStep(
                            rawCutSteps.size() + 1, "纵切", physPos, Math.min(physStart, physEnd), Math.max(physStart, physEnd),
                            String.format("第 %d 阶段纵切，裁切范围 [%.0f × %.0f mm]", cutLvl, p.w, maxY - minY)
                    ));
                }
            }
        }

        // 100% 完整切断自愈检查 (确保无粘连)
        List<CutStep> fullySeparatedCuts = cutBoundaryCompletionService.ensureCompleteSeparation(
                pieces, remnants, rawCutSteps, req.getRollW(), req.getRollL(), isRemnantFeed
        );

        // 刀路连续平滑优化 (赋予 startX, startY, endX, endY, airDistance，消除乱跳)
        double homeX = isRightOrigin ? req.getRollW() : 0.0;
        double homeY = isBottomOrigin ? req.getRollL() : 0.0;
        List<CutStep> continuousCuts = toolpathOptimizerService.optimizeAndChain(fullySeparatedCuts, homeX, homeY, true);

        res.setPieces(pieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);

        // Area balance
        double rollArea = (req.getRollW() * req.getRollL()) / 1_000_000.0;
        double pieceArea = pieces.stream().mapToDouble(p -> p.getW() * p.getL()).sum() / 1_000_000.0;
        double remArea = remnants.stream().mapToDouble(RemnantPiece::getArea).sum();
        double wasteArea = Math.max(0, rollArea - pieceArea - remArea);

        double maxY = pieces.stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(req.getRollL());
        res.setFeedPortType(isRemnantFeed ? "remnant" : "roll");
        res.setSourceRemnantId(req.getSourceRemnantId());
        // 料头投料口: 严格保证母卷扣料为 0!
        res.setDeductLen(isRemnantFeed ? 0.0 : maxY);
        res.setPieceArea(pieceArea);
        res.setRemArea(remArea);
        res.setWasteArea(wasteArea);
        res.setTotalArea(rollArea);

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
