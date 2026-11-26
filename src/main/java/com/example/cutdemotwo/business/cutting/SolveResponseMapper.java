package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.HashMap;

/**
 * 标准求解结果到工作流响应的单向映射工具：
 * 供 {@link FabricSolveAdapter} 与 {@link ContourWorkflow} 共同复用，彻底破除两者之间的双向循环依赖。
 */
final class SolveResponseMapper {
    private SolveResponseMapper() {}

    static SolveResponse toLegacy(SolveRequest request, NestingResult result) {
        SolveResponse response = new SolveResponse();
        response.setSuccess(result.feasible());
        response.setMessage(result.message());
        response.setStatus(result.status());
        // 料头横切可能仅满足混合需求中的满幅项，其余行保留并在履约清单中显式给出未排原因。
        response.setFulfillment(result.fulfillment());
        if ("remnant".equalsIgnoreCase(request.getFeedPortType()) && !request.isAllowLongitudinal()
                && request.getDemands() != null) {
            var fulfillment = new HashMap<Integer, NestingResult.Fulfillment>();
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
