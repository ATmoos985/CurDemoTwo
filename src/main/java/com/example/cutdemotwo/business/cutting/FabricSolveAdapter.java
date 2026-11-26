package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.algorithm.api.NestingSolver;
import java.util.List;

/** The only translation between the fabric workflow contract and the stateless nesting kernel. */
public final class FabricSolveAdapter {
    private FabricSolveAdapter() {}

    public static SolveResponse solve(NestingSolver factory, SolveRequest request) {
        if (ContourWorkflow.isContour(request)) return ContourWorkflow.solve(factory, request);
        var problem = toProblem(request);
        double gap = request.getPieceGap();
        if (gap == 0) return toLegacy(request, factory.solve(problem));
        // Equal padding on parts and the outer boundary reserves inter-piece space without shrinking edge capacity.
        var material = new NestingProblem.Material(problem.material().id(),
                NestingProblem.Shape.rectangle(problem.width() + gap, problem.height() + gap),
                problem.material().exclusions(), problem.material().continuesAfterRegion(), problem.material().fabricRule());
        var parts = problem.parts().stream().map(p -> new NestingProblem.Part(p.id(), p.name(),
                NestingProblem.Shape.rectangle(p.shape().width() + gap, p.shape().height() + gap),
                p.quantity(), p.allowRotation(), p.allowHalfTurn(), p.rule())).toList();
        var padded = new NestingProblem(problem.schemaVersion(), problem.unit(), material, parts, problem.process(), problem.engine(), problem.timeLimitSeconds());
        var candidate = factory.solve(padded);
        if (!candidate.feasible()) return toLegacy(request, candidate);
        var pieces = candidate.placements().stream().map(p -> {
            var part = problem.parts().stream().filter(d -> d.id() == p.demandId()).findFirst().orElseThrow();
            boolean rotated = p.rotationDegrees() != 0;
            return new PlacedPiece(p.id(), p.name(), Math.rint(p.x()*10)/10, Math.rint(p.y()*10)/10,
                    rotated ? part.shape().height() : part.shape().width(), rotated ? part.shape().width() : part.shape().height(), rotated, p.demandId());
        }).toList();
        var result = adjust(factory, request, pieces);
        result.setEngine(candidate.engine());
        result.setRequestedEngine(candidate.requestedEngine());
        result.setFallbackReason(candidate.fallbackReason());
        return result;
    }

    public static SolveResponse adjust(NestingSolver factory, SolveRequest request, List<PlacedPiece> pieces) {
        if (ContourWorkflow.isContour(request)) return ContourWorkflow.adjust(factory, request, pieces);
        double gap = request.getPieceGap();
        SolveRequest.validatePieceGap(gap);
        for (int i = 0; gap > 0 && i < pieces.size(); i++) for (int j = i + 1; j < pieces.size(); j++) {
            var a = pieces.get(i); var b = pieces.get(j);
            if (a.getX()+a.getW()+gap > b.getX()+.001 && b.getX()+b.getW()+gap > a.getX()+.001
                    && a.getY()+a.getL()+gap > b.getY()+.001 && b.getY()+b.getL()+gap > a.getY()+.001)
                throw new IllegalArgumentException("裁片之间须保留至少 " + gap + " mm 间距");
        }
        return toLegacy(request, factory.validateAdjustment(toProblem(request), pieces));
    }

    public static NestingProblem toProblem(SolveRequest r) {
        r.validateSettings();
        boolean sheet = "remnant".equalsIgnoreCase(r.getFeedPortType());
        if (sheet && !r.isAllowLongitudinal() && r.getDemands() != null) {
            var ids = new java.util.HashSet<Integer>();
            long count = 0;
            for (var d : r.getDemands()) {
                if (d == null || !ids.add(d.getId()) || !Double.isFinite(d.getWidth()) || d.getWidth() <= 0
                        || !Double.isFinite(d.getLength()) || d.getLength() <= 0 || d.getDemand() <= 0)
                    throw new IllegalArgumentException("需求编号须唯一，尺寸和件数须有效");
                count += d.getDemand();
            }
            if (count > 10000) throw new IllegalArgumentException("单次排料最多 10000 件");
        }
        var defects = r.getDefects() == null ? List.<NestingProblem.Exclusion>of() : r.getDefects().stream()
                .map(d -> {
                    boolean defaultStrict = d.getSeverity() == 2
                            && (d.getAvoidanceStrategy() == null || d.getAvoidanceStrategy().isBlank()
                            || "MUST_AVOID".equalsIgnoreCase(d.getAvoidanceStrategy()));
                    return defaultStrict
                            ? new NestingProblem.Exclusion(d.getId(), d.getX(), d.getY(),
                                    NestingProblem.Shape.rectangle(d.getW(), d.getH()), d.getMargin())
                            : new NestingProblem.Exclusion(d.getId(), d.getX(), d.getY(),
                                    NestingProblem.Shape.rectangle(d.getW(), d.getH()), d.getMargin(),
                                    d.getSeverity(), d.getAvoidanceStrategy());
                }).toList();
        var parts = r.getDemands() == null ? List.<NestingProblem.Part>of() : r.getDemands().stream()
                .filter(d -> !sheet || r.isAllowLongitudinal() || Math.abs(d.getWidth() - r.getRollW()) < .001)
                .map(d -> new NestingProblem.Part(d.getId(), d.getName(), NestingProblem.Shape.rectangle(d.getWidth(), d.getLength()),
                        d.getDemand(), r.isAllowRotation() || d.isAllowRotation())).toList();
        String source = sheet ? r.getSourceRemnantId() : r.getRollId();
        var material = new NestingProblem.Material(source == null || source.isBlank() ? "material" : source,
                NestingProblem.Shape.rectangle(r.getRollW(), r.getRollL()), defects,
                !sheet && r.getWindowStartY() + r.getRollL() < r.getTotalRollL() - 100);
        var process = new NestingProblem.Process(r.isAllowLongitudinal() ? "GUILLOTINE" : "CROSSCUT",
                sheet ? "SHEET" : "CONTINUOUS", r.getCutOrigin(),
                r.isAllowLongitudinal() ? r.getFirstStageOrientation() : "horizontal", r.getTrimStart(),
                r.getMinRemnantWidth(), r.getMinRemnantLength(), 0,
                r.isAllowLongitudinal() ? "MAXIMIZE_PIECE_AREA" : "INPUT_ORDER");
        return new NestingProblem("1", "mm", material, parts, process,
                r.isAllowLongitudinal() ? r.getSolver() : "crosscut", r.getTimeLimitSeconds());
    }

    public static SolveResponse toLegacy(SolveRequest request, NestingResult result) {
        return SolveResponseMapper.toLegacy(request, result);
    }
}
