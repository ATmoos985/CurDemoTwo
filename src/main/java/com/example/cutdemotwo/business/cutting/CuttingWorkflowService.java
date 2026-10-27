package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.PlanAdjustment;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.algorithm.api.NestingSolver;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.UUID;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

@Service
public class CuttingWorkflowService {
    private final NestingSolver solverFactory;
    private final RemnantService inventory;
    private final com.example.cutdemotwo.algorithm.api.ToolpathOptimizer toolpaths;

    public CuttingWorkflowService(NestingSolver solverFactory, RemnantService inventory,
                                  com.example.cutdemotwo.algorithm.api.ToolpathOptimizer toolpaths) {
        this.solverFactory = solverFactory;
        this.inventory = inventory;
        this.toolpaths = toolpaths;
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

    /**
     * 一维分切出车：前端按分切组合给出条的位置，这里核对任务、材料与需求后，用二维同一套校验
     * （越界、重叠、疵点避让）生成刀序和料头，保存为待报工候选。之后的执行、报工、复检与二维一致。
     */
    public SolveResponse slittingCar(com.example.cutdemotwo.business.model.SlittingCar car) {
        if (car == null || car.request() == null || car.pieces() == null || car.pieces().isEmpty() || car.pieces().size() > 500)
            throw new IllegalArgumentException("请提供本车的分切条（1–500 条）");
        SolveRequest request = car.request();
        request.validateSettings();
        if (request.getTaskId() == null || !inventory.getTask(request.getTaskId()).slittingTask())
            throw new IllegalArgumentException("只有一维分切任务可以按分切组合出车");
        if (!"roll".equals(request.getFeedPortType()) || !request.isAllowLongitudinal())
            throw new IllegalArgumentException("一维分切按母卷定长出车，且须允许纵切");
        request.setFirstStageOrientation("vertical"); // 分切先纵向开条，再在车尾横断
        inventory.prepareTaskSolve(request);
        request.setDefects(windowDefects(inventory.getMotherRoll(request.getRollId()).getDefects(),
                request.getWindowStartY(), request.getRollL(), request.getRollW()));
        var demands = new java.util.HashMap<Integer, com.example.cutdemotwo.business.model.PieceDemand>();
        request.getDemands().forEach(d -> demands.put(d.getId(), d));
        var counts = new java.util.HashMap<Integer, Integer>();
        Set<Integer> ids = new HashSet<>();
        var pieces = new ArrayList<PlacedPiece>();
        for (var p : car.pieces()) {
            var line = p == null || p.getDemandId() == null ? null : demands.get(p.getDemandId());
            if (line == null || !ids.add(p.getId()) || p.isRotated() || p.getShape() != null
                    || Math.abs(p.getW() - line.getWidth()) > .001 || Math.abs(p.getL() - line.getLength()) > .001
                    || p.getY() < request.getTrimStart() - .001)
                throw new IllegalArgumentException("分切条须属于本车需求、编号唯一、不旋转，尺寸与需求一致且位于切头之后");
            counts.merge(line.getId(), 1, Integer::sum);
            pieces.add(new PlacedPiece(p.getId(), line.getName(), p.getX(), p.getY(), line.getWidth(), line.getLength(), false, line.getId()));
        }
        if (demands.values().stream().anyMatch(d -> counts.getOrDefault(d.getId(), 0) != d.getDemand()))
            throw new IllegalArgumentException("本车分切条数与需求数量不一致");
        String baseline = inventory.materialFingerprint(request);
        SolveResponse result = FabricSolveAdapter.adjust(solverFactory, request, pieces);
        if (!result.isSuccess() || result.getPieces().isEmpty())
            throw new IllegalArgumentException(result.getMessage() == null || result.getMessage().isBlank() ? "本车分切位置未通过校验" : result.getMessage());
        String id = UUID.randomUUID().toString();
        result.setPlanId(id);
        inventory.rememberPlan(new CuttingPlan(id, request, result, baseline, "PENDING", java.time.LocalDateTime.now().toString()));
        return result;
    }

    /** 疵点以母卷档案为准（不信任客户端）：按避让边距外扩后裁到工位内，换算为工位局部坐标。 */
    static java.util.List<com.example.cutdemotwo.contracts.geometry.Defect> windowDefects(
            java.util.List<com.example.cutdemotwo.contracts.geometry.Defect> defects, double start, double length, double width) {
        var result = new ArrayList<com.example.cutdemotwo.contracts.geometry.Defect>();
        for (var d : defects == null ? java.util.List.<com.example.cutdemotwo.contracts.geometry.Defect>of() : defects) {
            double m = d.getMargin(), x = Math.max(0, d.getX() - m), y = Math.max(start, d.getY() - m);
            double w = Math.min(width, d.getX() + d.getW() + m) - x, h = Math.min(start + length, d.getY() + d.getH() + m) - y;
            if (w <= 0 || h <= 0) continue;
            result.add(new com.example.cutdemotwo.contracts.geometry.Defect(d.getId(), x, y - start, w, h, 0));
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
            var cuts = toolpaths.validateReorderedCuts(
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
            var moved = new PlacedPiece(source.getId(), source.getName(), position.x(), position.y(),
                    swap ? source.getL() : source.getW(), swap ? source.getW() : source.getL(), position.rotated(), source.getDemandId());
            if (source.getShape() != null) {
                int angle = position.rotationDegrees() == null ? (source.getRotationDegrees() + (swap ? 90 : 0)) % 360 : position.rotationDegrees();
                if (!Set.of(0,90,180,270).contains(angle) || (angle % 180 != 0) != position.rotated())
                    throw new IllegalArgumentException("轮廓旋转角度与尺寸状态不一致");
                moved.setShape(com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.rotate(source.getShape(), (angle-source.getRotationDegrees()+360)%360));
                moved.setRotationDegrees(angle);
            }
            pieces.add(moved);
        }
        var result = FabricSolveAdapter.adjust(solverFactory, original.request(), pieces);
        result.setPlanId(adjustment.adjustmentId());
        return inventory.rememberAdjustment(id, adjustment.adjustmentId(), result);
    }

    public Map<String, Object> getPlan(String id) {
        return inventory.planDetail(id);
    }

}
