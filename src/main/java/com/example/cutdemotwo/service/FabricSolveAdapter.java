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
        return toLegacy(request, factory.solve(toProblem(request)));
    }

    public static NestingProblem toProblem(SolveRequest r) {
        r.validateSettings();
        boolean sheet = "remnant".equalsIgnoreCase(r.getFeedPortType());
        var defects = r.getDefects() == null ? List.<NestingProblem.Exclusion>of() : r.getDefects().stream()
                .map(d -> new NestingProblem.Exclusion(d.getId(), d.getX(), d.getY(),
                        NestingProblem.Shape.rectangle(d.getW(), d.getH()), d.getMargin())).toList();
        var parts = r.getDemands() == null ? List.<NestingProblem.Part>of() : r.getDemands().stream()
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
        response.setFulfillment(result.fulfillment());
        response.setEngine(result.engine());
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
