package com.example.cutdemotwo;

import com.example.cutdemotwo.algorithm.nesting.CrossCutSolverService;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService;
import com.example.cutdemotwo.business.cutting.CuttingWorkflowService;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SlittingCar;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** 一维分切并入统一任务：每一车是母卷上的定长工位，报工、扣减与二维一致。 */
class SlittingTaskTests {
    @TempDir Path temp;
    private static final CuttingTask.Slitting PARAMS = new CuttingTask.Slitting(10, 10, 1800, 1980, 10, 2);

    private CuttingTask create(RemnantService inventory) {
        return inventory.saveTask(new CuttingTask(null, "分切订单", "TC涤棉-B2026", "ERP-1D", 0,
                List.of(new CuttingTask.Line(1, "订单 A", 600, 2000, 4, false),
                        new CuttingTask.Line(2, "订单 B", 700, 2000, 2, false)),
                new CuttingTask.Process(2000, 0, "right-bottom", "horizontal", false, true),
                CuttingTask.SLITTING_1D, PARAMS));
    }

    private SlittingCar car(CuttingTask task, double start, int countA, int countB) {
        SolveRequest request = new SolveRequest();
        request.setTaskId(task.id()); request.setTaskRevision(task.revision());
        request.setRollId("ROLL-2026-0920"); request.setRollW(2000); request.setRollL(2000);
        request.setTotalRollL(60000); request.setWindowStartY(start); request.setAllowLongitudinal(true);
        request.setCutOrigin("right-bottom");
        var demands = new java.util.ArrayList<PieceDemand>();
        if (countA > 0) demands.add(new PieceDemand(1, "订单 A", 600, 2000, countA, false));
        if (countB > 0) demands.add(new PieceDemand(2, "订单 B", 700, 2000, countB, false));
        request.setDemands(demands);
        var pieces = new java.util.ArrayList<PlacedPiece>();
        double x = 10; int id = 1;
        for (int i = 0; i < countA; i++, x += 600) pieces.add(new PlacedPiece(id++, "", x, 0, 600, 2000, false, 1));
        for (int i = 0; i < countB; i++, x += 700) pieces.add(new PlacedPiece(id++, "", x, 0, 700, 2000, false, 2));
        return new SlittingCar(request, pieces);
    }

    @Test void slittingCarIsReportedLikeAFixedLengthStation() {
        RemnantService inventory = new RemnantService(temp.resolve("slit.json").toString());
        var workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory, new ToolpathOptimizerService());
        CuttingTask task = create(inventory);
        assertTrue(task.slittingTask());
        double used = inventory.getMotherRoll("ROLL-2026-0920").getUsedLength();

        var plan = workflow.slittingCar(car(task, used, 2, 1));
        assertEquals(3, plan.getPieces().size());
        assertFalse(plan.getCuts().isEmpty(), "校验后生成刀序");
        assertEquals(2000, plan.getDeductLen(), .001);
        assertTrue(inventory.completedQuantities(task.id()).isEmpty(), "出车只是候选，不计完成");

        workflow.confirm(new CutReport(plan.getPlanId(), 2000, 3, List.of(), "S-01"));
        assertEquals(2, inventory.completedQuantities(task.id()).get("1"));
        assertEquals(1, inventory.completedQuantities(task.id()).get("2"));
        assertEquals(used + 2000, inventory.getMotherRoll("ROLL-2026-0920").getUsedLength(), .001);

        // 超过剩余需求（订单 B 只剩 1 卷）被拒绝
        assertThrows(IllegalArgumentException.class, () -> workflow.slittingCar(car(task, used + 2000, 2, 2)));
        // 落在疵点（Y 8500 处油污）上的车被拒绝，不生成候选
        int plans = inventory.taskPlans(task.id()).size();
        assertThrows(IllegalArgumentException.class, () -> workflow.slittingCar(car(task, 7500, 2, 1)));
        assertEquals(plans, inventory.taskPlans(task.id()).size());
    }

    @Test void stationAfterSkippedDefectZoneConsumesTheGapAndReversalRestoresIt() {
        RemnantService inventory = new RemnantService(temp.resolve("gap.json").toString());
        var workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory, new ToolpathOptimizerService());
        CuttingTask task = create(inventory);
        var roll = inventory.getMotherRoll("ROLL-2026-0920");
        double used = roll.getUsedLength(), remaining = roll.getCurrentRemainingLength();
        // 跳过 Y 8500 处油污（含 20 mm 边距到 8720），从 8800 起出车
        var plan = workflow.slittingCar(car(task, 8800, 2, 1));
        workflow.confirm(new CutReport(plan.getPlanId(), 2000, 3, List.of(), "S-01"));
        roll = inventory.getMotherRoll("ROLL-2026-0920");
        assertEquals(10800, roll.getUsedLength(), .001, "已用长度推进到工位末端，跳过的区段计为消耗");
        assertEquals(remaining - (10800 - used), roll.getCurrentRemainingLength(), .001);
        // 跳过区段之后不能再在已消耗位置开新工位
        assertThrows(IllegalArgumentException.class, () -> workflow.slittingCar(car(task, used, 2, 0)));
        inventory.reverseReport(plan.getPlanId(), "测试冲销");
        roll = inventory.getMotherRoll("ROLL-2026-0920");
        assertEquals(used, roll.getUsedLength(), .001);
        assertEquals(remaining, roll.getCurrentRemainingLength(), .001);
    }

    @Test void reportingTheLaterCarFirstDoesNotDoubleCountTheEarlierOne() {
        RemnantService inventory = new RemnantService(temp.resolve("order.json").toString());
        var workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory, new ToolpathOptimizerService());
        CuttingTask task = create(inventory);
        var roll = inventory.getMotherRoll("ROLL-2026-0920");
        double used = roll.getUsedLength(), remaining = roll.getCurrentRemainingLength();
        var first = workflow.slittingCar(car(task, used, 2, 0));
        var second = workflow.slittingCar(car(task, used + 5000, 2, 0)); // 10–12 m 段无疵点
        workflow.confirm(new CutReport(second.getPlanId(), 2000, 2, List.of(), "S-01"));
        assertEquals(used + 7000, inventory.getMotherRoll("ROLL-2026-0920").getUsedLength(), .001);
        workflow.confirm(new CutReport(first.getPlanId(), 2000, 2, List.of(), "S-01"));
        roll = inventory.getMotherRoll("ROLL-2026-0920");
        assertEquals(used + 7000, roll.getUsedLength(), .001, "前一车落在已计入的跳过区段内，不重复扣减");
        assertEquals(remaining - 7000, roll.getCurrentRemainingLength(), .001);
        assertEquals(4, inventory.completedQuantities(task.id()).get("1"));
    }

    @Test void rejectsInvalidCarsAndTaskTypeMisuse() {
        RemnantService inventory = new RemnantService(temp.resolve("guards.json").toString());
        var workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory, new ToolpathOptimizerService());
        CuttingTask task = create(inventory);
        double used = inventory.getMotherRoll("ROLL-2026-0920").getUsedLength();
        // 条数与需求数量不一致
        var mismatch = car(task, used, 2, 1);
        var fewer = new SlittingCar(mismatch.request(), mismatch.pieces().subList(0, 2));
        assertThrows(IllegalArgumentException.class, () -> workflow.slittingCar(fewer));
        // 条重叠
        var overlap = car(task, used, 2, 0);
        overlap.pieces().get(1).setX(300);
        assertThrows(IllegalArgumentException.class, () -> workflow.slittingCar(overlap));
        // 二维任务不能按分切组合出车
        CuttingTask nesting = inventory.saveTask(new CuttingTask(null, "二维", "TC涤棉-B2026", null, 0,
                List.of(new CuttingTask.Line(1, "订单 A", 600, 2000, 4, false))));
        var wrongType = car(nesting, used, 1, 0);
        assertThrows(IllegalArgumentException.class, () -> workflow.slittingCar(wrongType));
        // 一维任务参数与需求校验
        assertThrows(IllegalArgumentException.class, () -> inventory.saveTask(new CuttingTask(null, "x", "TC涤棉-B2026", null, 0,
                List.of(new CuttingTask.Line(1, "A", 600.5, 2000, 1, false)), null, CuttingTask.SLITTING_1D, PARAMS)));
        assertThrows(IllegalArgumentException.class, () -> inventory.saveTask(new CuttingTask(null, "x", "TC涤棉-B2026", null, 0,
                List.of(new CuttingTask.Line(1, "A", 600, 2000, 1, false)), null, CuttingTask.SLITTING_1D, new CuttingTask.Slitting(0, 0, 1000, 900, 10, 0))));
        assertThrows(IllegalArgumentException.class, () -> inventory.saveTask(new CuttingTask(null, "x", "TC涤棉-B2026", null, 0,
                List.of(new CuttingTask.Line(1, "A", 600, 2000, 1, false)), null, "OTHER", PARAMS)));
        assertThrows(IllegalArgumentException.class, () -> inventory.saveTask(new CuttingTask(null, "x", "TC涤棉-B2026", null, 0,
                List.of(new CuttingTask.Line(1, "A", 600, 2500, 1, false)), null, CuttingTask.SLITTING_1D, PARAMS)), "卷长须为整米");
    }

    @Test void nestingTaskSerializesWithoutSlittingFields() {
        var json = JsonMapper.builder().build();
        var task = new CuttingTask("t", "n", "m", null, 1, List.of(new CuttingTask.Line(1, "A", 1, 1, 1, false)));
        String text = json.writeValueAsString(task);
        assertFalse(text.contains("problemType") || text.contains("slitting"), text);
        var slit = new CuttingTask("t", "n", "m", null, 1, task.demands(), null, CuttingTask.SLITTING_1D, PARAMS);
        assertEquals(slit, json.readValue(json.writeValueAsString(slit), CuttingTask.class));
    }
}
