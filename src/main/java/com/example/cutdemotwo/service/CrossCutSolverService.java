package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
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
    @Override public boolean isAvailable() { return true; }

    @Override
    public SolveResponse solve(SolveRequest req) {
        SolveResponse res = new SolveResponse();
        res.setRollW(req.getRollW());
        res.setRollL(req.getRollL());
        res.setDefects(req.getDefects());
        res.setEngine("仅横切顺序排料");
        res.setFeedPortType(req.getFeedPortType());
        res.setSourceRemnantId(req.getSourceRemnantId());
        if (req.getRollW() <= 0 || req.getRollL() <= 0 || req.getTrimStart() < 0 || req.getTrimStart() >= req.getRollL()) {
            res.setMessage("母料尺寸或卷头修齐量无效");
            return res;
        }
        List<double[]> blocked = new ArrayList<>();
        for (Defect d : req.getDefects()) {
            if (d.getSafeX() < req.getRollW() && d.getSafeX() + d.getSafeW() > 0) {
                blocked.add(new double[]{Math.max(0, d.getSafeY()), Math.min(req.getRollL(), d.getSafeY() + d.getSafeH())});
            }
        }
        blocked.sort(Comparator.comparingDouble(a -> a[0]));
        List<PlacedPiece> pieces = new ArrayList<>();
        List<RemnantPiece> remnants = new ArrayList<>();
        List<CutStep> cuts = new ArrayList<>();
        double cursor = req.getTrimStart();
        if (cursor >= 300) addRemnant(remnants, req.getRollW(), 0, cursor, overlaps(blocked, 0, cursor));
        int unmet = 0;
        for (PieceDemand demand : req.getDemands()) {
            double length = demand.getLength();
            if (Math.abs(demand.getWidth() - req.getRollW()) > 0.001 || length <= 0 || demand.getDemand() < 0) {
                res.setMessage("仅横切要求裁片宽度等于母料幅宽，且长度与件数有效：" + demand.getName());
                return res;
            }
            for (int i = 0; i < demand.getDemand(); i++) {
                double start = cursor;
                for (double[] interval : blocked) {
                    if (start < interval[1] && start + length > interval[0]) start = interval[1];
                }
                if (start + length > req.getRollL()) {
                    unmet++;
                    continue;
                }
                if (start > cursor) {
                    if (start - cursor >= 300) addRemnant(remnants, req.getRollW(), cursor, start - cursor, overlaps(blocked, cursor, start));
                    cuts.add(new CutStep(cuts.size() + 1, "横切", start, 0, req.getRollW(), "隔离疵点区后起切"));
                }
                pieces.add(new PlacedPiece(pieces.size() + 1, demand.getName(), 0, start,
                        req.getRollW(), length, false, demand.getId()));
                cuts.add(new CutStep(cuts.size() + 1, "横切", start + length, 0, req.getRollW(),
                        "整幅横切 " + demand.getName()));
                cursor = start + length;
            }
        }
        if (pieces.isEmpty()) {
            res.setMessage("当前窗口无法排入整幅裁片，请检查尺寸、疵点或扩大窗口");
            return res;
        }
        if (req.getRollL() - cursor >= 300) addRemnant(remnants, req.getRollW(), cursor, req.getRollL() - cursor,
                overlaps(blocked, cursor, req.getRollL()));
        double totalArea = req.getRollW() * req.getRollL() / 1_000_000.0;
        double pieceArea = pieces.stream().mapToDouble(p -> p.getW() * p.getL()).sum() / 1_000_000.0;
        double remArea = remnants.stream().mapToDouble(RemnantPiece::getArea).sum();
        double homeX = "right-bottom".equalsIgnoreCase(req.getCutOrigin()) ? req.getRollW() : 0.0;
        double homeY = "right-bottom".equalsIgnoreCase(req.getCutOrigin()) ? req.getRollL() : 0.0;
        List<CutStep> continuousCuts = toolpathOptimizerService.optimizeAndChain(cuts, homeX, homeY, false);
        res.setPieces(pieces);
        res.setRemnants(remnants);
        res.setCuts(continuousCuts);
        res.setDeductLen("remnant".equalsIgnoreCase(req.getFeedPortType()) ? 0 : cursor);
        res.setTotalArea(totalArea);
        res.setPieceArea(pieceArea);
        res.setRemArea(remArea);
        res.setWasteArea(Math.max(0, totalArea - pieceArea - remArea));
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
