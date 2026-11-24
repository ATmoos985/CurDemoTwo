package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchKernel.DemItem;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchKernel.FreeRect;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchKernel.LayoutSolution;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchKernel.PlacedRec;
import com.example.cutdemotwo.algorithm.nesting.GuillotineSearchKernel.RawCut;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;
import com.example.cutdemotwo.algorithm.nesting.constraints.PatternRepeatRule;
import com.example.cutdemotwo.algorithm.toolpath.CutBoundaryCompletionService;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 纯 Java 工业级自主二维直刀（Guillotine）排样与切序求解引擎。
 * 特性：
 * 1. 多起点启发式池 + 有界 Beam Search + 预算内确定性 LNS 局部精修；
 * 2. 严格一刀到底（Guillotine Cut）树形剪切约束与显式父子阶段控制；
 * 3. 100% 严密避让全量矩形瑕疵、安全裕量及 Phase 3 窗帘约束（布边、对花、疵点分级）；
 * 4. 自动生成标准 CutStep 工步清单并执行无粘连边界补齐与空行程优化；
 * 5. 自动正交切出合规在库料头（RemnantPiece），确保面积守恒与结果可复现。
 */
@Service
public class JavaGuillotineSolverEngine implements ICutSolverEngine {

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

    @Override
    public EngineCapabilities capabilities() {
        return new EngineCapabilities(
                getEngineType(), "1", List.of("RECTANGLE"), List.of("GUILLOTINE"),
                List.of("MAXIMIZE_PIECE_AREA"), 0.1, isAvailable()
        );
    }

    @Override
    public EngineResult solve(NestingProblem req) {
        ComputationCancellation.check();
        EngineResult res = new EngineResult();
        res.setSuccess(true);

        CoordinateFrame frame = CoordinateFrame.of(req);
        double rollW = frame.width();
        double rollL = frame.height();
        double trim = frame.trimStart();
        double activeL = frame.activeLength();

        if (rollW <= 0 || rollL <= 0 || activeL <= 0) {
            res.setSuccess(false);
            res.setFailureStatus("FAILED");
            res.setMessage("母卷幅宽或有效工作台长度无效");
            return res;
        }

        boolean isRemnantFeed = frame.isSheet();
        boolean horizontalFirst = !"vertical".equalsIgnoreCase(req.process().firstStageOrientation());
        ConstraintPipeline pipeline = CurtainConstraintPack.forProblem(req);

        // 转换局部瑕疵安全框（相对于局部有效加工区 [0, activeL]）
        List<Defect> allDefects = EngineGeometry.defects(req);
        List<Defect> localDefects = new ArrayList<>(allDefects.size());
        Map<Integer, Defect> localDefectById = new HashMap<>(allDefects.size() * 2 + 1);
        for (Defect d : allDefects) {
            ComputationCancellation.check();
            double defLocalY = frame.toLocalY(d.getSafeY(), d.getSafeH());
            double defLocalX = frame.toLocalX(d.getSafeX(), d.getSafeW());
            Defect ld = new Defect(d.getId(), defLocalX, defLocalY, d.getSafeW(), d.getSafeH(), 0);
            localDefects.add(ld);
            localDefectById.put(d.getId(), ld);
        }

        // 展开待排单件及按件约束域
        List<DemItem> items = new ArrayList<>();
        int itemSeq = 0;
        if (req.parts() != null) {
            for (NestingProblem.Part p : req.parts()) {
                ComputationCancellation.check();
                double localMinX = 0.0;
                double localMaxX = rollW;
                List<Defect> hardLocal = localDefects;
                boolean patternMatch = false;
                if (!pipeline.isNoop()) {
                    double[] physBounds = pipeline.clipXBounds(req, p, 0.0, rollW);
                    if (frame.isRightOrigin()) {
                        localMinX = rollW - physBounds[1];
                        localMaxX = rollW - physBounds[0];
                    } else {
                        localMinX = physBounds[0];
                        localMaxX = physBounds[1];
                    }
                    var hardRaw = pipeline.hardExclusionsFor(req, p);
                    hardLocal = new ArrayList<>(hardRaw.size());
                    for (var he : hardRaw) {
                        Defect ld = localDefectById.get(he.id());
                        if (ld != null) hardLocal.add(ld);
                    }
                    patternMatch = PatternRepeatRule.requiresPatternMatch(req, p);
                }
                int count = Math.max(0, p.quantity());
                for (int c = 0; c < count; c++) {
                    ComputationCancellation.check();
                    items.add(new DemItem(
                            itemSeq++, p.name(), p.shape().width(), p.shape().height(),
                            p.allowRotation(), p.id(), p, localMinX, localMaxX, hardLocal, patternMatch
                    ));
                }
            }
        }

        // 调用多起点 + 有界 Beam Search + 预算内 LNS 直刀核心内核
        LayoutSolution best = GuillotineSearchKernel.solve(
                req, frame, pipeline, rollW, activeL, horizontalFirst, localDefects, items
        );

        // 映射裁片物理坐标（考虑起刀基准角镜像与卷头修齐偏移）
        List<PlacedPiece> finalPieces = new ArrayList<>(best.pieces.size());
        for (PlacedRec rec : best.pieces) {
            ComputationCancellation.check();
            DemItem it = items.get(rec.itemIdx);
            double physX = frame.toPhysicalX(rec.x, rec.w);
            double physY = frame.toPhysicalY(rec.y, rec.l);
            finalPieces.add(new PlacedPiece(it.id, it.name, physX, physY, rec.w, rec.l, rec.rotated, it.demandId));
        }

        // 识别与提取可回收料头
        List<RemnantPiece> remnants = new ArrayList<>();
        int remSeq = 1;
        String remPrefix = isRemnantFeed ? "REM-SUB" : "REM-JAVA";

        if (trim > 0) {
            remnants.add(GuillotinePostProcessor.createTrimRemnant(frame, remSeq++));
        }

        for (FreeRect fr : best.freeRects) {
            ComputationCancellation.check();
            if (fr.w < 10.0 || fr.h < 10.0) continue;

            double physX = frame.toPhysicalX(fr.x, fr.w);
            double physY = frame.toPhysicalY(fr.y, fr.h);

            RemnantPiece remnant = GuillotinePostProcessor.tryCreateRemnant(
                    req, frame, remPrefix, remSeq, fr.y, physX, physY, fr.w, fr.h, allDefects
            );
            if (remnant != null) {
                remSeq++;
                remnants.add(remnant);
            }
        }

        // 物理映射直刀切分树工步，并显式保留父子阶段（stage >= 1）约束
        List<CutStep> mappedCuts = new ArrayList<>(best.cuts.size() + (trim > 0 ? 1 : 0));
        int stepIdx = 1;
        int stageOffset = trim > 0 ? 1 : 0;
        if (trim > 0) {
            CutStep trimCut = GuillotinePostProcessor.createTrimCut(frame, stepIdx++);
            trimCut.setStage(1);
            mappedCuts.add(trimCut);
        }
        for (RawCut cs : best.cuts) {
            ComputationCancellation.check();
            CutStep step;
            if ("横切".equals(cs.type)) {
                double physPos = frame.toPhysicalHorizontalCutY(cs.pos);
                double[] span = frame.toPhysicalXSpan(cs.start, cs.end);
                step = new CutStep(stepIdx++, "横切", physPos, span[0], span[1], cs.desc);
            } else {
                double physPos = frame.toPhysicalVerticalCutX(cs.pos);
                double[] span = frame.toPhysicalYSpan(cs.start, cs.end);
                step = new CutStep(stepIdx++, "纵切", physPos, span[0], span[1], cs.desc);
            }
            step.setStage(cs.stage + stageOffset);
            mappedCuts.add(step);
        }

        // 100% 完整切断自愈检查 + 刀路平滑与空行程优化
        List<CutStep> continuousCuts = GuillotinePostProcessor.completeAndOptimizeCuts(
                cutBoundaryCompletionService, toolpathOptimizerService, finalPieces, remnants, mappedCuts, frame, true
        );

        res.setPieces(finalPieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);
        res.setSuggestedFeedLength(GuillotinePostProcessor.suggestedFeedLength(finalPieces));

        return res;
    }
}
