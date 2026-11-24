package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.nesting.constraints.ConstraintPipeline;
import com.example.cutdemotwo.algorithm.nesting.constraints.CurtainConstraintPack;

import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.algorithm.nesting.EngineResult;
import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;
import com.example.cutdemotwo.algorithm.geometry.CoordinateFrame;
import com.example.cutdemotwo.algorithm.geometry.EngineGeometry;
import com.example.cutdemotwo.algorithm.nesting.ICutSolverEngine;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** 仅横切机台：每件裁片必须占满幅宽，按送料方向避开疵点区间。 */
@Service
public class CrossCutSolverService implements ICutSolverEngine {
    private final ToolpathOptimizerService toolpathOptimizerService;

    @Autowired
    public CrossCutSolverService(ToolpathOptimizerService toolpathOptimizerService) {
        this.toolpathOptimizerService = toolpathOptimizerService;
    }

    public CrossCutSolverService() {
        this.toolpathOptimizerService = new ToolpathOptimizerService();
    }
    @Override public String getEngineType() { return "crosscut"; }
    @Override
    public EngineCapabilities capabilities() {
        return new EngineCapabilities(getEngineType(), "1", List.of("RECTANGLE"), List.of("CROSSCUT"), List.of("INPUT_ORDER"), .1, true);
    }

    @Override public boolean isAvailable() { return true; }

    @Override
    public EngineResult solve(NestingProblem req) {
        ComputationCancellation.check();
        EngineResult res = new EngineResult();
        if (req.width() <= 0 || req.height() <= 0 || req.process().trimStart() < 0 || req.process().trimStart() >= req.height()) {
            res.setMessage("母料尺寸或卷头修齐量无效");
            return res;
        }
        ConstraintPipeline pipeline = CurtainConstraintPack.forProblem(req);
        List<double[]> blocked = toBlockedIntervals(req.material().exclusions(), req.width(), req.height());
        List<PlacedPiece> pieces = new ArrayList<>();
        List<RemnantPiece> remnants = new ArrayList<>();
        List<CutStep> cuts = new ArrayList<>();
        double pieceGap = Math.max(0.0, req.process().pieceGap());
        double cursor = req.process().trimStart();
        if (cursor > 0 && req.width() >= req.process().minReusableWidth() && cursor >= req.process().minReusableHeight()) addRemnant(remnants, req.width(), 0, cursor, overlaps(blocked, 0, cursor));
        int unmet = 0;
        for (NestingProblem.Part demand : req.parts()) {
            ComputationCancellation.check();
            double length = demand.shape().height();
            if (Math.abs(demand.shape().width() - req.width()) > 0.001 || length <= 0 || demand.quantity() < 0) {
                res.setMessage("仅横切要求裁片宽度等于母料幅宽，且长度与件数有效：" + demand.name());
                return res;
            }
            List<double[]> hardBlocked = pipeline.isNoop()
                    ? blocked
                    : toBlockedIntervals(pipeline.hardExclusionsFor(req, demand), req.width(), req.height());
            for (int i = 0; i < demand.quantity(); i++) {
                ComputationCancellation.check();
                double minStart = pieces.isEmpty() ? cursor : cursor + pieceGap;
                // 优先避开全部疵点（含软疵点），放不下再退化为仅避让硬疵点（如辅片放行轻微疵点）
                double start = nextCrossCutStart(req, pipeline, demand, minStart, length, blocked);
                if (start + length > req.height() && hardBlocked.size() < blocked.size()) {
                    start = nextCrossCutStart(req, pipeline, demand, minStart, length, hardBlocked);
                }
                if (start + length > req.height()) {
                    unmet++;
                    continue;
                }
                if (start > cursor) {
                    if (req.width() >= req.process().minReusableWidth() && start - cursor >= req.process().minReusableHeight()) addRemnant(remnants, req.width(), cursor, start - cursor, overlaps(blocked, cursor, start));
                    cuts.add(new CutStep(cuts.size() + 1, "横切", start, 0, req.width(), "隔离疵点/间距区后起切"));
                }
                pieces.add(new PlacedPiece(pieces.size() + 1, demand.name(), 0, start,
                        req.width(), length, false, demand.id()));
                cuts.add(new CutStep(cuts.size() + 1, "横切", start + length, 0, req.width(),
                        "整幅横切 " + demand.name()));
                cursor = start + length;
            }
        }
        if (pieces.isEmpty()) {
            res.setFailureStatus("NO_SOLUTION_FOUND");
            res.setMessage("当前窗口无法排入整幅裁片，请检查尺寸、疵点或扩大窗口");
            return res;
        }
        if (req.height() > cursor && req.width() >= req.process().minReusableWidth() && req.height() - cursor >= req.process().minReusableHeight()) addRemnant(remnants, req.width(), cursor, req.height() - cursor,
                overlaps(blocked, cursor, req.height()));
        CoordinateFrame frame = CoordinateFrame.of(req);
        List<CutStep> continuousCuts = GuillotinePostProcessor.optimizeCuts(toolpathOptimizerService, cuts, frame, false);
        res.setPieces(pieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);
        double maxBoundaryY = Math.max(cursor, remnants.stream().mapToDouble(r -> r.getY() + r.getL()).max().orElse(0));
        res.setSuggestedFeedLength(maxBoundaryY);
        res.setSuccess(true);
        if (unmet > 0) res.setMessage("当前窗口未排入 " + unmet + " 件，可在后续工位接续");
        return res;
    }

    private List<double[]> toBlockedIntervals(List<NestingProblem.Exclusion> exclusions, double width, double height) {
        List<double[]> intervals = new ArrayList<>();
        for (NestingProblem.Exclusion e : exclusions) {
            ComputationCancellation.check();
            double safeX = Math.max(0, e.x() - e.clearance());
            double safeW = e.shape().width() + 2.0 * e.clearance();
            double safeY = Math.max(0, e.y() - e.clearance());
            double safeH = e.shape().height() + 2.0 * e.clearance();
            if (safeX < width && safeX + safeW > 0) {
                intervals.add(new double[]{Math.max(0, safeY), Math.min(height, safeY + safeH)});
            }
        }
        intervals.sort(Comparator.comparingDouble(a -> a[0]));
        return intervals;
    }

    private double nextCrossCutStart(NestingProblem req, ConstraintPipeline pipeline, NestingProblem.Part demand,
                                     double cursor, double length, List<double[]> intervals) {
        double start = cursor;
        for (int iter = 0; iter <= intervals.size() + 2; iter++) {
            double before = start;
            for (double[] interval : intervals) {
                ComputationCancellation.check();
                if (start < interval[1] && start + length > interval[0]) start = interval[1];
            }
            if (!pipeline.isNoop()) {
                double snapped = pipeline.snapY(req, demand, 0, start);
                if (snapped > start + 1e-6) {
                    start = snapped;
                }
            }
            if (Math.abs(start - before) < 1e-6 || start + length > req.height()) {
                break;
            }
        }
        return start;
    }

    private void addRemnant(List<RemnantPiece> remnants, double width, double y, double length, boolean hasDefect) {
        remnants.add(new RemnantPiece("REM-CROSS-" + (remnants.size() + 1), hasDefect ? "带疵料头" : "可用料头",
                0, y, width, length, width * length / 1_000_000.0, hasDefect));
    }

    private boolean overlaps(List<double[]> blocked, double start, double end) {
        return blocked.stream().anyMatch(interval -> start < interval[1] && end > interval[0]);
    }
}
