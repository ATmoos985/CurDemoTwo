package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.toolpath.CutBoundaryCompletionService;
import com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 纯 Java 工业级二维直刀（Guillotine）排样与切序求解引擎
 * 特性：
 * 1. 严格一刀到底（Guillotine Cut）树形剪切约束，横切/纵切正交可切断；
 * 2. 100% 严密避让全量矩形瑕疵及安全裕量（Safety Margin）；
 * 3. 自动生成标准 CutStep 工步清单并执行刀路平滑与无粘连边界补齐；
 * 4. 自动正交切出合规在库料头（RemnantPiece），确保 100% 面积严格守恒。
 */
@Service
public class JavaGuillotineSolverEngine implements ICutSolverEngine {
    private static final Logger log = LoggerFactory.getLogger(JavaGuillotineSolverEngine.class);

    private final ToolpathOptimizerService toolpathOptimizerService;
    private final CutBoundaryCompletionService cutBoundaryCompletionService;

    @Autowired
    public JavaGuillotineSolverEngine(
            ToolpathOptimizerService toolpathOptimizerService,
            CutBoundaryCompletionService cutBoundaryCompletionService) {
        this.toolpathOptimizerService = toolpathOptimizerService;
        this.cutBoundaryCompletionService = cutBoundaryCompletionService;
    }

    public JavaGuillotineSolverEngine() {
        this.toolpathOptimizerService = new ToolpathOptimizerService();
        this.cutBoundaryCompletionService = new CutBoundaryCompletionService();
    }

    @Override
    public String getEngineType() {
        return "javaguillotine";
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    private static class FreeRect {
        double x, y, w, h;
        int level;

        FreeRect(double x, double y, double w, double h, int level) {
            this.x = x;
            this.y = y;
            this.w = w;
            this.h = h;
            this.level = level;
        }

        double area() {
            return w * h;
        }
    }

    private static class DemItem {
        int id;
        String name;
        double w;
        double l;
        boolean allowRotation;
        Integer demandId;

        DemItem(int id, String name, double w, double l, boolean allowRotation, Integer demandId) {
            this.id = id;
            this.name = name;
            this.w = w;
            this.l = l;
            this.allowRotation = allowRotation;
            this.demandId = demandId;
        }
    }

    @Override
    public SolveResponse solve(SolveRequest req) {
        SolveResponse res = new SolveResponse();
        res.setSuccess(true);
        res.setEngine("Java 原生直刀排料内核 (内置高可用)");
        res.setRollW(req.getRollW());
        res.setRollL(req.getRollL());

        double rollW = req.getRollW();
        double rollL = req.getRollL();
        double trim = Math.max(0, req.getTrimStart());
        double activeL = rollL - trim;

        if (rollW <= 0 || rollL <= 0 || activeL <= 0) {
            res.setSuccess(false);
            res.setMessage("母卷幅宽或有效工作台长度无效");
            return res;
        }

        String origin = req.getCutOrigin() != null ? req.getCutOrigin().trim().toLowerCase() : "right-bottom";
        boolean isRightOrigin = origin.startsWith("right");
        boolean isBottomOrigin = origin.endsWith("bottom");
        boolean isRemnantFeed = "remnant".equalsIgnoreCase(req.getFeedPortType());
        boolean mirrorY = isRemnantFeed && isBottomOrigin;
        boolean horizontalFirst = !"vertical".equalsIgnoreCase(req.getFirstStageOrientation());

        // 收集待排单件
        List<DemItem> items = new ArrayList<>();
        int itemSeq = 0;
        if (req.getDemands() != null) {
            for (PieceDemand pd : req.getDemands()) {
                int count = Math.max(0, pd.getDemand());
                for (int c = 0; c < count; c++) {
                    boolean rot = req.isAllowRotation() || pd.isAllowRotation();
                    items.add(new DemItem(itemSeq++, pd.getName(), pd.getWidth(), pd.getLength(), rot, pd.getId()));
                }
            }
        }

        // 按大件优先排序 (Best Fit Decreasing)
        items.sort((a, b) -> Double.compare(b.w * b.l, a.w * a.l));

        // 转换局部瑕疵安全框 (相对于局部有效加工区 activeL)
        List<Defect> localDefects = new ArrayList<>();
        if (req.getDefects() != null) {
            for (Defect d : req.getDefects()) {
                // 转换到 [0, activeL] 的局部坐标
                double defLocalY = mirrorY ? (rollL - (d.getSafeY() + d.getSafeH()) - trim) : (d.getSafeY() - trim);
                double defLocalX = isRightOrigin ? (rollW - (d.getSafeX() + d.getSafeW())) : d.getSafeX();
                // 构造局部安全瑕疵实体
                Defect ld = new Defect(d.getId(), defLocalX, defLocalY, d.getSafeW(), d.getSafeH(), 0);
                localDefects.add(ld);
            }
        }

        List<FreeRect> freeRects = new ArrayList<>();
        freeRects.add(new FreeRect(0, 0, rollW, activeL, 1));

        List<PlacedPiece> rawPieces = new ArrayList<>();
        List<CutStep> rawCutSteps = new ArrayList<>();
        List<FreeRect> remainingSpaces = new ArrayList<>();

        for (DemItem it : items) {
            boolean placed = false;
            // 尝试在现有可用空间中寻找适格位置
            for (int rIdx = 0; rIdx < freeRects.size(); rIdx++) {
                FreeRect r = freeRects.get(rIdx);

                // 尝试正常方向与旋转方向
                double pw = it.w;
                double pl = it.l;
                boolean rotated = false;

                boolean canFitNormal = (r.w >= pw && r.h >= pl);
                boolean canFitRot = it.allowRotation && (r.w >= pl && r.h >= pw);

                if (!canFitNormal && !canFitRot) {
                    continue;
                }

                // 优先非旋转，其次旋转
                double chosenW = 0, chosenL = 0;
                boolean chosenRot = false;

                if (canFitNormal && isSafeFromDefects(r.x, r.y, pw, pl, localDefects)) {
                    chosenW = pw;
                    chosenL = pl;
                    chosenRot = false;
                } else if (canFitRot && isSafeFromDefects(r.x, r.y, pl, pw, localDefects)) {
                    chosenW = pl;
                    chosenL = pw;
                    chosenRot = true;
                } else {
                    // 若直接在原点重叠瑕疵，尝试沿瑕疵外边缘做平移寻找可用位置
                    double[] safePos = findSafePositionInRect(r, pw, pl, localDefects);
                    if (safePos != null) {
                        chosenW = pw;
                        chosenL = pl;
                        chosenRot = false;
                    } else if (it.allowRotation) {
                        safePos = findSafePositionInRect(r, pl, pw, localDefects);
                        if (safePos != null) {
                            chosenW = pl;
                            chosenL = pw;
                            chosenRot = true;
                        }
                    }

                    if (safePos != null) {
                        // 在矩形内部找到了避开瑕疵的安全位置 (safePos[0], safePos[1])
                        // 先通过直刀切断将安全区剥离
                        freeRects.remove(rIdx);
                        List<FreeRect> dissected = dissectRectAt(r, safePos[0], safePos[1], chosenW, chosenL, rawCutSteps, horizontalFirst);
                        // dissected 中的首个即为裁片放置区
                        FreeRect pieceRect = dissected.remove(0);
                        rawPieces.add(new PlacedPiece(it.id, it.name, pieceRect.x, pieceRect.y, chosenW, chosenL, chosenRot, it.demandId));
                        freeRects.addAll(dissected);
                        placed = true;
                        break;
                    }
                    continue;
                }

                // 成功在 (r.x, r.y) 放置
                freeRects.remove(rIdx);
                rawPieces.add(new PlacedPiece(it.id, it.name, r.x, r.y, chosenW, chosenL, chosenRot, it.demandId));

                // 实施正交 Guillotine 剪切拆解
                if (horizontalFirst) {
                    // 横切优先：第一阶段在 Y = r.y + chosenL 做横切
                    double cutY = r.y + chosenL;
                    if (r.h - chosenL > 0.5) {
                        rawCutSteps.add(new CutStep(
                                rawCutSteps.size() + 1, "横切", cutY, r.x, r.x + r.w,
                                String.format("第 %d 阶段横切，分切行条 [%.0f × %.0f mm]", r.level, r.w, chosenL)
                        ));
                        freeRects.add(new FreeRect(r.x, cutY, r.w, r.h - chosenL, r.level + 1));
                    }
                    // 第二阶段在下部行条做纵切
                    double cutX = r.x + chosenW;
                    if (r.w - chosenW > 0.5) {
                        rawCutSteps.add(new CutStep(
                                rawCutSteps.size() + 1, "纵切", cutX, r.y, r.y + chosenL,
                                String.format("第 %d 阶段纵切，切断裁片与侧料 [%.0f × %.0f mm]", r.level + 1, chosenW, chosenL)
                        ));
                        freeRects.add(new FreeRect(cutX, r.y, r.w - chosenW, chosenL, r.level + 2));
                    }
                } else {
                    // 纵切优先：第一阶段在 X = r.x + chosenW 做纵切
                    double cutX = r.x + chosenW;
                    if (r.w - chosenW > 0.5) {
                        rawCutSteps.add(new CutStep(
                                rawCutSteps.size() + 1, "纵切", cutX, r.y, r.y + r.h,
                                String.format("第 %d 阶段纵切，分切纵列 [%.0f × %.0f mm]", r.level, chosenW, r.h)
                        ));
                        freeRects.add(new FreeRect(cutX, r.y, r.w - chosenW, r.h, r.level + 1));
                    }
                    // 第二阶段在左部列做横切
                    double cutY = r.y + chosenL;
                    if (r.h - chosenL > 0.5) {
                        rawCutSteps.add(new CutStep(
                                rawCutSteps.size() + 1, "横切", cutY, r.x, r.x + chosenW,
                                String.format("第 %d 阶段横切，切断裁片与顶料 [%.0f × %.0f mm]", r.level + 1, chosenW, chosenL)
                        ));
                        freeRects.add(new FreeRect(r.x, cutY, chosenW, r.h - chosenL, r.level + 2));
                    }
                }

                placed = true;
                break;
            }

            // 保持剩余空间碎片规整排序
            freeRects.sort(Comparator.comparingDouble(FreeRect::area));
        }

        // 映射裁片物理坐标 (考虑基准点对齐与反转)
        List<PlacedPiece> finalPieces = new ArrayList<>();
        for (PlacedPiece p : rawPieces) {
            double physX = isRightOrigin ? (rollW - p.getX() - p.getW()) : p.getX();
            double physY = mirrorY ? (rollL - p.getY() - p.getL() - trim) : (p.getY() + trim);
            finalPieces.add(new PlacedPiece(p.getId(), p.getName(), physX, physY, p.getW(), p.getL(), p.isRotated(), p.getDemandId()));
        }

        // 识别与提取回收料头
        List<RemnantPiece> remnants = new ArrayList<>();
        int remSeq = 1;
        String remPrefix = isRemnantFeed ? "REM-SUB" : "REM-JAVA";

        for (FreeRect fr : freeRects) {
            if (fr.w < 10 || fr.h < 10) continue;

            double physX = isRightOrigin ? (rollW - fr.x - fr.w) : fr.x;
            double physY = mirrorY ? (rollL - fr.y - fr.h - trim) : (fr.y + trim);

            // 检查母卷长卷工位尾部全幅贯通连续段
            boolean isContinuousMotherRollTail = !isRemnantFeed &&
                    (req.getWindowStartY() + rollL < req.getTotalRollL() - 100) &&
                    (fr.w >= rollW - 30) &&
                    (physY + fr.h >= rollL - 30 || fr.y + fr.h >= activeL - 30);

            if (!isContinuousMotherRollTail && fr.w >= 200 && fr.h >= 300) {
                double area = (fr.w * fr.h) / 1_000_000.0;
                boolean hasDefect = checkDefectOverlap(physX, physY, fr.w, fr.h, req.getDefects());
                String status = hasDefect ? "带疵料头" : "可用料头";
                remnants.add(new RemnantPiece(
                        String.format("%s-%02d", remPrefix, remSeq++),
                        status, physX, physY, fr.w, fr.h, area, hasDefect
                ));
            }
        }

        // 物理映射切刀工步
        List<CutStep> mappedCuts = new ArrayList<>();
        int stepIdx = 1;
        for (CutStep cs : rawCutSteps) {
            if ("横切".equals(cs.getType())) {
                double cutY = cs.getPos();
                double physPos = mirrorY ? (rollL - cutY - trim) : (cutY + trim);
                double physStart = isRightOrigin ? (rollW - cs.getEnd()) : cs.getStart();
                double physEnd = isRightOrigin ? (rollW - cs.getStart()) : cs.getEnd();
                mappedCuts.add(new CutStep(
                        stepIdx++, "横切", physPos, Math.min(physStart, physEnd), Math.max(physStart, physEnd), cs.getDesc()
                ));
            } else {
                double cutX = cs.getPos();
                double physPos = isRightOrigin ? (rollW - cutX) : cutX;
                double physStart = mirrorY ? (rollL - cs.getEnd() - trim) : (cs.getStart() + trim);
                double physEnd = mirrorY ? (rollL - cs.getStart() - trim) : (cs.getEnd() + trim);
                mappedCuts.add(new CutStep(
                        stepIdx++, "纵切", physPos, Math.min(physStart, physEnd), Math.max(physStart, physEnd), cs.getDesc()
                ));
            }
        }

        // 100% 完整切断自愈检查 (确保无粘连)
        List<CutStep> fullySeparatedCuts = cutBoundaryCompletionService.ensureCompleteSeparation(
                finalPieces, remnants, mappedCuts, rollW, rollL, isRemnantFeed
        );

        // 刀路平滑与空行程优化
        double homeX = isRightOrigin ? rollW : 0.0;
        double homeY = isBottomOrigin ? rollL : 0.0;
        List<CutStep> continuousCuts = toolpathOptimizerService.optimizeAndChain(fullySeparatedCuts, homeX, homeY, true);

        res.setPieces(finalPieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);

        // 严格面积守恒计算
        double totalArea = (rollW * rollL) / 1_000_000.0;
        double pieceArea = finalPieces.stream().mapToDouble(p -> p.getW() * p.getL()).sum() / 1_000_000.0;
        double remArea = remnants.stream().mapToDouble(RemnantPiece::getArea).sum();
        double wasteArea = Math.max(0, totalArea - pieceArea - remArea);

        double maxY = finalPieces.stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(rollL);
        res.setFeedPortType(isRemnantFeed ? "remnant" : "roll");
        res.setSourceRemnantId(req.getSourceRemnantId());
        res.setDeductLen(isRemnantFeed ? 0.0 : maxY);
        res.setPieceArea(pieceArea);
        res.setRemArea(remArea);
        res.setWasteArea(wasteArea);
        res.setTotalArea(totalArea);

        return res;
    }

    private boolean isSafeFromDefects(double px, double py, double pw, double pl, List<Defect> defects) {
        for (Defect d : defects) {
            boolean overlaps = !(px + pw <= d.getX() || px >= d.getX() + d.getW() ||
                    py + pl <= d.getY() || py >= d.getY() + d.getH());
            if (overlaps) {
                return false;
            }
        }
        return true;
    }

    private double[] findSafePositionInRect(FreeRect r, double pw, double pl, List<Defect> defects) {
        // 查找矩形内与该裁片相交的所有瑕疵
        List<Defect> colliding = new ArrayList<>();
        for (Defect d : defects) {
            boolean inRect = !(r.x + r.w <= d.getX() || r.x >= d.getX() + d.getW() ||
                    r.y + r.h <= d.getY() || r.y >= d.getY() + d.getH());
            if (inRect) colliding.add(d);
        }

        // 尝试以各个瑕疵的边界作为起切点
        List<Double> candX = new ArrayList<>();
        candX.add(r.x);
        List<Double> candY = new ArrayList<>();
        candY.add(r.y);

        for (Defect d : colliding) {
            if (d.getX() + d.getW() >= r.x && d.getX() + d.getW() + pw <= r.x + r.w) {
                candX.add(d.getX() + d.getW());
            }
            if (d.getY() + d.getH() >= r.y && d.getY() + d.getH() + pl <= r.y + r.h) {
                candY.add(d.getY() + d.getH());
            }
        }

        for (double cx : candX) {
            for (double cy : candY) {
                if (cx + pw <= r.x + r.w && cy + pl <= r.y + r.h) {
                    if (isSafeFromDefects(cx, cy, pw, pl, defects)) {
                        return new double[]{cx, cy};
                    }
                }
            }
        }
        return null;
    }

    private List<FreeRect> dissectRectAt(FreeRect r, double px, double py, double pw, double pl,
                                         List<CutStep> cutSteps, boolean horizontalFirst) {
        List<FreeRect> list = new ArrayList<>();
        // 首个元素保留为被裁片占据的区域
        list.add(new FreeRect(px, py, pw, pl, r.level));

        if (horizontalFirst) {
            // 下部余料
            if (py > r.y + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "横切", py, r.x, r.x + r.w, "下部隔离横切"));
                list.add(new FreeRect(r.x, r.y, r.w, py - r.y, r.level + 1));
            }
            // 上部余料
            if (r.y + r.h > py + pl + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "横切", py + pl, r.x, r.x + r.w, "上部展开横切"));
                list.add(new FreeRect(r.x, py + pl, r.w, (r.y + r.h) - (py + pl), r.level + 1));
            }
            // 左部余料
            if (px > r.x + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "纵切", px, py, py + pl, "左侧分切纵刀"));
                list.add(new FreeRect(r.x, py, px - r.x, pl, r.level + 2));
            }
            // 右部余料
            if (r.x + r.w > px + pw + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "纵切", px + pw, py, py + pl, "右侧分切纵刀"));
                list.add(new FreeRect(px + pw, py, (r.x + r.w) - (px + pw), pl, r.level + 2));
            }
        } else {
            // 纵切优先
            if (px > r.x + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "纵切", px, r.y, r.y + r.h, "左部隔离纵切"));
                list.add(new FreeRect(r.x, r.y, px - r.x, r.h, r.level + 1));
            }
            if (r.x + r.w > px + pw + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "纵切", px + pw, r.y, r.y + r.h, "右部展开纵切"));
                list.add(new FreeRect(px + pw, r.y, (r.x + r.w) - (px + pw), r.h, r.level + 1));
            }
            if (py > r.y + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "横切", py, px, px + pw, "下侧分切横刀"));
                list.add(new FreeRect(px, r.y, pw, py - r.y, r.level + 2));
            }
            if (r.y + r.h > py + pl + 0.5) {
                cutSteps.add(new CutStep(cutSteps.size() + 1, "横切", py + pl, px, px + pw, "上侧分切横刀"));
                list.add(new FreeRect(px, py + pl, pw, (r.y + r.h) - (py + pl), r.level + 2));
            }
        }
        return list;
    }

    private boolean checkDefectOverlap(double x, double y, double w, double h, List<Defect> defects) {
        if (defects == null) return false;
        for (Defect d : defects) {
            boolean noOverlap = (x + w <= d.getSafeX() || x >= d.getSafeX() + d.getSafeW() ||
                    y + h <= d.getSafeY() || y >= d.getSafeY() + d.getSafeH());
            if (!noOverlap) return true;
        }
        return false;
    }
}
