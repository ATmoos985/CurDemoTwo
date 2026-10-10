package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.service.solver.EngineResult;
import com.example.cutdemotwo.service.solver.EngineCapabilities;
import com.example.cutdemotwo.service.solver.EngineGeometry;
import com.example.cutdemotwo.service.solver.ICutSolverEngine;
import com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService;
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
        EngineResult res = new EngineResult();
        if (req.width() <= 0 || req.height() <= 0 || req.process().trimStart() < 0 || req.process().trimStart() >= req.height()) {
            res.setMessage("母料尺寸或卷头修齐量无效");
            return res;
        }
        List<double[]> blocked = new ArrayList<>();
        for (Defect d : EngineGeometry.defects(req)) {
            if (d.getSafeX() < req.width() && d.getSafeX() + d.getSafeW() > 0) {
                blocked.add(new double[]{Math.max(0, d.getSafeY()), Math.min(req.height(), d.getSafeY() + d.getSafeH())});
            }
        }
        blocked.sort(Comparator.comparingDouble(a -> a[0]));
        List<PlacedPiece> pieces = new ArrayList<>();
        List<RemnantPiece> remnants = new ArrayList<>();
        List<CutStep> cuts = new ArrayList<>();
        double cursor = req.process().trimStart();
        if (cursor > 0 && req.width() >= req.process().minReusableWidth() && cursor >= req.process().minReusableHeight()) addRemnant(remnants, req.width(), 0, cursor, overlaps(blocked, 0, cursor));
        int unmet = 0;
        for (NestingProblem.Part demand : req.parts()) {
            double length = demand.shape().height();
            if (Math.abs(demand.shape().width() - req.width()) > 0.001 || length <= 0 || demand.quantity() < 0) {
                res.setMessage("仅横切要求裁片宽度等于母料幅宽，且长度与件数有效：" + demand.name());
                return res;
            }
            for (int i = 0; i < demand.quantity(); i++) {
                double start = cursor;
                for (double[] interval : blocked) {
                    if (start < interval[1] && start + length > interval[0]) start = interval[1];
                }
                if (start + length > req.height()) {
                    unmet++;
                    continue;
                }
                if (start > cursor) {
                    if (req.width() >= req.process().minReusableWidth() && start - cursor >= req.process().minReusableHeight()) addRemnant(remnants, req.width(), cursor, start - cursor, overlaps(blocked, cursor, start));
                    cuts.add(new CutStep(cuts.size() + 1, "横切", start, 0, req.width(), "隔离疵点区后起切"));
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
        double homeX = req.process().startCorner().startsWith("right") ? req.width() : 0.0;
        double homeY = req.process().startCorner().endsWith("bottom") ? req.height() : 0.0;
        List<CutStep> continuousCuts = toolpathOptimizerService.optimizeAndChain(cuts, homeX, homeY, false);
        res.setPieces(pieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);
        double maxBoundaryY = Math.max(cursor, remnants.stream().mapToDouble(r -> r.getY() + r.getL()).max().orElse(0));
        res.setSuggestedFeedLength(maxBoundaryY);
        res.setSuccess(true);
        if (unmet > 0) res.setMessage("当前窗口未排入 " + unmet + " 件，可在后续工位接续");
        return res;
    }

    private void addRemnant(List<RemnantPiece> remnants, double width, double y, double length, boolean hasDefect) {
        remnants.add(new RemnantPiece("REM-CROSS-" + (remnants.size() + 1), hasDefect ? "带疵料头" : "可用料头",
                0, y, width, length, width * length / 1_000_000.0, hasDefect));
    }

    private boolean overlaps(List<double[]> blocked, double start, double end) {
        return blocked.stream().anyMatch(interval -> start < interval[1] && end > interval[0]);
    }
}
