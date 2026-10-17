package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.model.nesting.NestingResult;
import com.example.cutdemotwo.service.solver.SolverFactory;
import java.util.List;

/** The only translation between the fabric workflow contract and the stateless nesting kernel. */
public final class FabricSolveAdapter {
    private FabricSolveAdapter() {}

    public static SolveResponse solve(SolverFactory factory, SolveRequest request) {
        var problem = toProblem(request);
        double gap = request.getPieceGap();
        if (gap == 0) return toLegacy(request, factory.solve(problem));
        // Equal padding on parts and the outer boundary reserves inter-piece space without shrinking edge capacity.
        var material = new NestingProblem.Material(problem.material().id(),
                NestingProblem.Shape.rectangle(problem.width() + gap, problem.height() + gap),
                problem.material().exclusions(), problem.material().continuesAfterRegion());
        var parts = problem.parts().stream().map(p -> new NestingProblem.Part(p.id(), p.name(),
                NestingProblem.Shape.rectangle(p.shape().width() + gap, p.shape().height() + gap), p.quantity(), p.allowRotation())).toList();
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

    public static SolveResponse adjust(SolverFactory factory, SolveRequest request, List<PlacedPiece> pieces) {
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
                .map(d -> new NestingProblem.Exclusion(d.getId(), d.getX(), d.getY(),
                        NestingProblem.Shape.rectangle(d.getW(), d.getH()), d.getMargin())).toList();
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
        SolveResponse response = new SolveResponse();
        response.setSuccess(result.feasible());
        response.setMessage(result.message());
        response.setStatus(result.status());
        // A remnant crosscut may satisfy only the full-width lines of a mixed order.
        // Keep the other lines in the workflow and explicitly explain their unplaced quantities.
        response.setFulfillment(result.fulfillment());
        if ("remnant".equalsIgnoreCase(request.getFeedPortType()) && !request.isAllowLongitudinal()
                && request.getDemands() != null) {
            var fulfillment = new java.util.HashMap<Integer, NestingResult.Fulfillment>();
            result.fulfillment().forEach(line -> fulfillment.put(line.demandId(), line));
            response.setFulfillment(request.getDemands().stream().map(d -> fulfillment.getOrDefault(d.getId(),
                    new NestingResult.Fulfillment(d.getId(), d.getDemand(), 0, d.getDemand(),
                            Math.abs(d.getWidth() - request.getRollW()) >= .001 ? "CROSSCUT_WIDTH_MISMATCH"
                                    : "NOT_PLACED_IN_THIS_SOLUTION"))).toList());
        }
        response.setEngine(result.engine());
        response.setRequestedEngine(result.requestedEngine());
        response.setFallbackReason(result.fallbackReason());
        response.setRollW(request.getRollW());
        response.setRollL(request.getRollL());
        response.setDefects(request.getDefects());
        response.setFeedPortType(request.getFeedPortType());
        response.setSourceRemnantId(request.getSourceRemnantId());
        if (!result.feasible()) return response;
        response.setPieces(result.placements().stream().map(p -> new PlacedPiece(p.id(), p.name(), p.x(), p.y(),
                p.shape().width(), p.shape().height(), p.rotationDegrees() != 0, p.demandId())).toList());
        response.setRemnants(result.leftovers().stream().map(r -> new RemnantPiece(r.id(), r.hasDefect() ? "带疵料头" : "可用料头",
                r.x(), r.y(), r.shape().width(), r.shape().height(), r.shape().width() * r.shape().height() / 1_000_000, r.hasDefect())).toList());
        response.setCuts(result.cuts().stream().map(c -> {
            boolean horizontal = "HORIZONTAL".equals(c.kind());
            CutStep step = new CutStep(c.sequence(), horizontal ? "横切" : "纵切", horizontal ? c.startY() : c.startX(),
                    horizontal ? Math.min(c.startX(), c.endX()) : Math.min(c.startY(), c.endY()),
                    horizontal ? Math.max(c.startX(), c.endX()) : Math.max(c.startY(), c.endY()), c.description());
            step.setStartX(c.startX()); step.setStartY(c.startY()); step.setEndX(c.endX()); step.setEndY(c.endY());
            step.setAirDistance(c.airDistanceMm());
            step.setStage(c.stage());
            return step;
        }).toList());
        response.setDeductLen("remnant".equalsIgnoreCase(request.getFeedPortType()) ? 0 : result.metrics().suggestedFeedLengthMm());
        response.setTotalArea(result.metrics().processingAreaMm2() / 1_000_000);
        response.setPieceArea(result.metrics().pieceAreaMm2() / 1_000_000);
        response.setRemArea(result.metrics().reusableAreaMm2() / 1_000_000);
        response.setWasteArea(result.metrics().unassignedAreaMm2() / 1_000_000);
        return response;
    }
}
