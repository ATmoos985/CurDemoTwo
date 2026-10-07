package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.UUID;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

@Service
public class CuttingWorkflowService {
    private final SolverFactory solverFactory;
    private final RemnantService inventory;

    public CuttingWorkflowService(SolverFactory solverFactory, RemnantService inventory) {
        this.solverFactory = solverFactory;
        this.inventory = inventory;
    }

    public SolveResponse solve(SolveRequest request) {
        request.validateSettings();
        inventory.prepareTaskSolve(request);
        String baseline = inventory.materialFingerprint(request);
        SolveResponse result = FabricSolveAdapter.solve(solverFactory, request);
        if (result.isSuccess() && !result.getPieces().isEmpty()) {
            String id = UUID.randomUUID().toString();
            result.setPlanId(id);
            inventory.rememberPlan(new CuttingPlan(id, request, result, baseline, "PENDING", java.time.LocalDateTime.now().toString()));
        }
        return result;
    }

    public synchronized Map<String, Object> confirm(CutReport report) {
        return inventory.confirmPlan(report);
    }

    public CuttingPlan adjust(String id, PlanAdjustment adjustment) {
        if (adjustment == null || adjustment.adjustmentId() == null || !adjustment.adjustmentId().matches("[a-zA-Z0-9-]{16,80}")
                || (adjustment.pieces() == null) == (adjustment.cuts() == null))
            throw new IllegalArgumentException("调整请求须提供有效操作编号，以及裁片位置或刀路其中一项");
        CuttingPlan original = inventory.getPlan(id);
        if (adjustment.cuts() != null) {
            var request = original.request();
            double homeX = request.getCutOrigin().startsWith("right") ? request.getRollW() : 0;
            double homeY = request.getCutOrigin().endsWith("bottom") ? request.getRollL() : 0;
            var cuts = new com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService().validateReorderedCuts(
                    original.result().getCuts(), adjustment.cuts(), homeX, homeY, request.isAllowLongitudinal());
            // Copy before changing a saved result: rejected persistence must leave the original intact.
            var result = tools.jackson.databind.json.JsonMapper.builder().build().convertValue(original.result(), SolveResponse.class);
            result.setCuts(cuts);
            result.setPlanId(adjustment.adjustmentId());
            return inventory.rememberAdjustment(id, adjustment.adjustmentId(), result);
        }
        var pieces = new ArrayList<PlacedPiece>();
        Set<Integer> seen = new HashSet<>();
        for (var position : adjustment.pieces()) {
            if (position == null || position.x() == null || position.y() == null || position.rotated() == null || !seen.add(position.id()))
                throw new IllegalArgumentException("调整裁片编号重复，或位置与旋转状态缺失");
            var source = original.result().getPieces().stream().filter(p -> p.getId() == position.id()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("调整中包含不属于原方案的裁片"));
            boolean swap = source.isRotated() != position.rotated();
            pieces.add(new PlacedPiece(source.getId(), source.getName(), position.x(), position.y(),
                    swap ? source.getL() : source.getW(), swap ? source.getW() : source.getL(), position.rotated(), source.getDemandId()));
        }
        var result = FabricSolveAdapter.toLegacy(original.request(), solverFactory.validateAdjustment(FabricSolveAdapter.toProblem(original.request()), pieces));
        result.setPlanId(adjustment.adjustmentId());
        return inventory.rememberAdjustment(id, adjustment.adjustmentId(), result);
    }

    public Map<String, Object> getPlan(String id) {
        return inventory.planDetail(id);
    }

}
