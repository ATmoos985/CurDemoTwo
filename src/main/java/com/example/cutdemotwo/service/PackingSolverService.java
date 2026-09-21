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

    private final RemnantService remnantService;

    public PackingSolverService(RemnantService remnantService) {
        this.remnantService = remnantService;
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

            // 3. defects.csv (offset Y by trimStart)
            try (PrintWriter pw = new PrintWriter(new OutputStreamWriter(new FileOutputStream(defectsCsv), java.nio.charset.StandardCharsets.UTF_8))) {
                pw.println("ID,BIN,X,Y,WIDTH,HEIGHT");
                for (Defect d : req.getDefects()) {
                    double dy = d.getY() - req.getTrimStart();
                    if (dy + d.getH() >= 0) {
                        boolean isRightOrigin = "right-bottom".equalsIgnoreCase(req.getCutOrigin());
                        double safeX = isRightOrigin ?
                                Math.max(0, req.getRollW() - d.getX() - d.getW() - d.getMargin()) : d.getSafeX();
                        double safeY = isRightOrigin ?
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

    private SolveResponse parseCertificate(File certCsv, SolveRequest req, Map<Integer, String> itemMap, Map<Integer, Integer> demandIdMap) throws IOException {
        SolveResponse res = new SolveResponse();
        res.setSuccess(true);
        res.setEngine("PackingSolver (C++ 2D-Guillotine & HiGHS)");
        res.setRollW(req.getRollW());
        res.setRollL(req.getRollL());
        res.setDefects(req.getDefects());

        List<PlacedPiece> pieces = new ArrayList<>();
        List<RemnantPiece> remnants = new ArrayList<>();
        List<CutStep> cutSteps = new ArrayList<>();

        List<String[]> cutNodes = new ArrayList<>();

        int remIndex = 1;
        String origin = req.getCutOrigin() != null ? req.getCutOrigin().trim().toLowerCase() : "right-top";
        boolean isRightOrigin = origin.startsWith("right");
        boolean isBottomOrigin = origin.endsWith("bottom");
        boolean isRemnantFeed = "remnant".equalsIgnoreCase(req.getFeedPortType());
        
        // 关键统一：在母卷连续开卷长卷模式下，裁片排料必须顺着送料进给流向紧贴工位入口 (y + trim)，
        // 余量留在当前工位末尾，彻底杜绝反转导致两工位交界处凭空留出 260mm 悬空死区！
        // 仅在单板料头模式且指定底部原点时，才将料头裁片倒贴至料头下底边。
        boolean mirrorY = isRemnantFeed && isBottomOrigin;
        double trim = req.getTrimStart();

        if (trim > 0) {
            double trimArea = (req.getRollW() * trim) / 1_000_000.0;
            double trimY = mirrorY ? (req.getRollL() - trim) : 0;
            remnants.add(new RemnantPiece(
                    String.format("REM-TRIM-%02d", remIndex++),
                    "卷头修齐料头",
                    0, trimY, req.getRollW(), trim, trimArea, false
            ));
            cutSteps.add(new CutStep(
                    1,
                    "横切",
                    mirrorY ? (req.getRollL() - trim) : trim,
                    0,
                    req.getRollW(),
                    String.format("第 0 阶段：卷头修齐横切断刀，切除 0~%.0f mm 不规则料头并确立绝对测量原点", trim)
            ));
        }

        try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(certCsv), java.nio.charset.StandardCharsets.UTF_8))) {
            String header = br.readLine();
            String line;
            while ((line = br.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                String[] parts = line.split(",");
                if (parts.length < 9) continue;

                int nodeId = Integer.parseInt(parts[2].trim());
                double x = Double.parseDouble(parts[3].trim());
                double y = Double.parseDouble(parts[4].trim());
                double w = Double.parseDouble(parts[5].trim());
                double h = Double.parseDouble(parts[6].trim());
                int type = Integer.parseInt(parts[7].trim());
                int cut = Integer.parseInt(parts[8].trim());

                double physX = isRightOrigin ? (req.getRollW() - x - w) : x;
                double physY = mirrorY ? (req.getRollL() - y - h - trim) : (y + trim);

                if (type >= 0 && cut > 0) {
                    String name = itemMap.getOrDefault(type, "裁片-" + type);
                    Integer demId = demandIdMap != null ? demandIdMap.get(type) : null;
                    pieces.add(new PlacedPiece(type, name, physX, physY, w, h, false, demId));
                } else if (type == -1 || type == -3) {
                    // Remnant / waste
                    if (w >= 200 && h >= 300) {
                        double area = (w * h) / 1_000_000.0;
                        boolean hasDefect = checkDefectOverlap(physX, physY, w, h, req.getDefects());
                        String status = hasDefect ? "带疵料头" : "可用料头";
                        remnants.add(new RemnantPiece(String.format("REM-PS-%02d", remIndex++), status, physX, physY, w, h, area, hasDefect));
                    }
                } else if (type == -2) {
                    cutNodes.add(new String[]{String.valueOf(cut), String.valueOf(x), String.valueOf(y), String.valueOf(w), String.valueOf(h)});
                }
            }
        }

        // Build cut steps
        cutNodes.sort(Comparator.comparingInt(a -> Integer.parseInt(a[0])));
        int stepNo = (trim > 0) ? 2 : 1;
        for (String[] cn : cutNodes) {
            int cutLvl = Integer.parseInt(cn[0]);
            double cx = Double.parseDouble(cn[1]);
            double cy = Double.parseDouble(cn[2]);
            double cw = Double.parseDouble(cn[3]);
            double ch = Double.parseDouble(cn[4]);

            boolean isHoriz = (cutLvl % 2 == 1);
            String cutType = isHoriz ? "横切" : "纵切";
            double cutPos = isHoriz ?
                    (mirrorY ? (req.getRollL() - cy - trim) : (cy + trim)) :
                    (isRightOrigin ? (req.getRollW() - cx) : cx);
            double start = isHoriz ?
                    (isRightOrigin ? (req.getRollW() - cx - cw) : cx) :
                    (mirrorY ? (req.getRollL() - cy - ch - trim) : (cy + trim));
            double end = isHoriz ?
                    (isRightOrigin ? (req.getRollW() - cx) : (cx + cw)) :
                    (mirrorY ? (req.getRollL() - cy - trim) : (cy + ch + trim));
            String desc = String.format("第 %d 阶段%s，裁切范围 [%.0f × %.0f mm]", cutLvl, cutType, cw, ch);

            cutSteps.add(new CutStep(stepNo++, cutType, cutPos, Math.min(start, end), Math.max(start, end), desc));
        }

        res.setPieces(pieces);
        res.setRemnants(remnants);
        res.setCuts(cutSteps);

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

        // 业务闭环：无论母卷开卷切还是料头切，切出的余料自动归档并关联所属母卷
        List<RemnantStock> derived = new ArrayList<>();
        if (isRemnantFeed) {
            // 料头投料口：核销原料头，派生子料头入库 (Parent-Child Lineage)
            String parentId = (req.getSourceRemnantId() != null && !req.getSourceRemnantId().isEmpty()) ?
                    req.getSourceRemnantId() : "REM-MANUAL";
            remnantService.consumeRemnant(parentId);
            for (RemnantPiece rp : remnants) {
                RemnantStock rs = remnantService.autoRegisterCutRemnant(
                        req.getRollId(), parentId, rp.getW(), rp.getL(), rp.isHasDefect(),
                        "自料头 " + parentId + " 裁切派生" + (rp.isHasDefect() ? "(带疵)" : "完好子料头")
                );
                derived.add(rs);
            }
        } else {
            // 母卷开卷模式：每次裁切产生的料头自动进入该母卷的料头库
            for (RemnantPiece rp : remnants) {
                RemnantStock rs = remnantService.autoRegisterCutRemnant(
                        req.getRollId(), null, rp.getW(), rp.getL(), rp.isHasDefect(),
                        "自母卷 " + req.getRollId() + " 裁切生成" + (rp.isHasDefect() ? "(带疵)" : "完好料头")
                );
                derived.add(rs);
            }
        }
        res.setDerivedRemnants(derived);

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
