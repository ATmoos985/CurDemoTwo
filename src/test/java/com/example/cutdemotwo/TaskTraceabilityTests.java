package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class TaskTraceabilityTests {
    @TempDir Path temp;
    RemnantService inventory;
    CuttingWorkflowService workflow;
    CuttingTask task;
    @BeforeEach void setup(){inventory=new RemnantService(temp.resolve("trace.json").toString());workflow=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),inventory);
        task=inventory.saveTask(new CuttingTask(null,"追溯任务","TC涤棉-B2026","ORDER-TRACE",0,List.of(new CuttingTask.Line(1,"主帘",2000,1000,3,false))));}
    SolveResponse solve(){var request=new SolveRequest();request.setTaskId(task.id());request.setTaskRevision(task.revision());request.setWindowStartY(5000);request.setRollL(3000);request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(1,"主帘",2000,1000,3,false)));return workflow.solve(request);}
    @Test void summariesCountOnlyQualifiedAndNonReversedOutputAndKeepAllPlanHistory(){
        var plan=solve();var before=inventory.taskSummaries().get(0);assertEquals(3,before.get("remaining"));assertEquals(1L,before.get("pendingCount"));
        workflow.confirm(new CutReport(plan.getPlanId(),2000,1,List.of(),"A",List.of(new CutReport.PieceResult(1,"QUALIFIED",""),new CutReport.PieceResult(2,"REJECTED","破损"),new CutReport.PieceResult(3,"UNCUT",""))));
        var after=inventory.taskSummaries().get(0);assertEquals(1,after.get("completed"));assertEquals(2,after.get("remaining"));assertEquals(0L,after.get("pendingCount"));assertEquals(1L,after.get("reportCount"));
        assertEquals("CONFIRMED",inventory.taskPlans(task.id()).get(0).status());
        inventory.reverseReport(plan.getPlanId(),"误报");var reversed=inventory.taskSummaries().get(0);assertEquals(0,reversed.get("completed"));assertEquals(3,reversed.get("remaining"));assertEquals(0L,reversed.get("reportCount"));
        assertEquals("REVERSED",inventory.taskPlans(task.id()).get(0).status());
    }
    @Test void printSnapshotRetainsOriginalDemandVersionAndLocalCoordinatesAfterRestart(){
        var plan=solve();workflow.confirm(new CutReport(plan.getPlanId(),3000,3,List.of(),"A"));
        inventory.saveTask(new CuttingTask(task.id(),"更新后的名称",task.materialModel(),task.externalRef(),task.revision(),List.of(new CuttingTask.Line(1,"主帘",2000,1000,4,false))));
        var reopened=new RemnantService(temp.resolve("trace.json").toString());var saved=reopened.planDetail(plan.getPlanId());
        assertEquals(plan.getPlanId(),saved.get("id"));assertEquals("CONFIRMED",saved.get("status"));assertEquals(1, saved.get("version"));
        assertEquals(1,((SolveRequest)saved.get("request")).getTaskRevision());assertEquals(5000,((SolveRequest)saved.get("request")).getWindowStartY());
        assertEquals(0,((SolveResponse)saved.get("result")).getPieces().get(0).getY());
        assertEquals(plan.getPlanId(),((Map<?,?>)saved.get("receipt")).get("planId"));
        assertEquals(1,reopened.taskSummaries().get(0).get("remaining"));
    }
    @Test void oldRevisionAndCancelledPlansAreNotOfferedAsCurrentPendingWork(){
        var first=solve();inventory.changePlanStatus(first.getPlanId(),false);var second=solve();
        inventory.saveTask(new CuttingTask(task.id(),"新需求版本",task.materialModel(),task.externalRef(),task.revision(),task.demands()));
        assertEquals(0L,inventory.taskSummaries().get(0).get("pendingCount"));assertEquals(2,inventory.taskPlans(task.id()).size());assertNull(inventory.planDetail(second.getPlanId()).get("receipt"));
    }
}
