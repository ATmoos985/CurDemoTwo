package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class BatchReportTests {
    @TempDir Path temp;
    RemnantService stock; CuttingWorkflowService workflow; CuttingTask task;
    @BeforeEach void setup() {
        stock=new RemnantService(temp.resolve("stock.json").toString());
        workflow=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),stock);
        task=stock.saveTask(new CuttingTask(null,"连续裁切","TC涤棉-B2026","",0,List.of(new CuttingTask.Line(1,"片",2000,1000,3,false))));
    }
    CutReport report(double start,int quantity) {
        var request=new SolveRequest();request.setTaskId(task.id());request.setTaskRevision(task.revision());
        request.setRollL(quantity*1000);request.setWindowStartY(start);request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(1,"片",2000,1000,quantity,false)));
        var result=workflow.solve(request);assertTrue(result.isSuccess());
        return new CutReport(result.getPlanId(),quantity*1000,quantity,List.of(),"A");
    }
    @Test void previewDoesNotWriteAndTwoStationsCommitOnceWithIndividuallyPrintableReceipts() throws Exception {
        var a=report(5000,1);var b=report(6000,1);var batch=List.of(a,b);
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        assertEquals(2,stock.reportBatch(batch,true).size());
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
        assertEquals(55000,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertTrue(stock.completedQuantities(task.id()).isEmpty());assertEquals("PENDING",stock.getPlan(a.planId()).status());
        var receipts=stock.reportBatch(batch,false);assertEquals(2,receipts.size());
        assertEquals(Map.of("1",2),stock.completedQuantities(task.id()));
        assertEquals(53000,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        for(var report:batch){assertNotNull(stock.getReceipt(report.planId()));assertEquals("CONFIRMED",stock.getPlan(report.planId()).status());}
        var json=new tools.jackson.databind.ObjectMapper();
        assertEquals(json.writeValueAsString(receipts),json.writeValueAsString(stock.reportBatch(batch,false)));
        assertEquals(53000,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        var reopened=new RemnantService(temp.resolve("stock.json").toString());assertEquals(2,reopened.taskReports(task.id()).size());
    }
    @Test void laterInvalidStationRollsBackEarlierStockPlansAndDemand() {
        var a=report(5000,2);var b=report(7000,2);
        for(boolean preview:List.of(true,false)) {
            assertThrows(IllegalArgumentException.class,()->stock.reportBatch(List.of(a,b),preview));
            assertEquals(55000,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
            assertNull(stock.getReceipt(a.planId()));assertTrue(stock.completedQuantities(task.id()).isEmpty());
            assertEquals("PENDING",stock.getPlan(a.planId()).status());
        }
    }
    @Test void oneStagedStationCanReportBeforeTheOtherAndUpdatesDemandImmediately() {
        var a=report(5000,1);var b=report(6000,1);
        stock.reportBatch(List.of(a),false);
        assertEquals(Map.of("1",1),stock.completedQuantities(task.id()));
        assertEquals("CONFIRMED",stock.getPlan(a.planId()).status());
        assertEquals("PENDING",stock.getPlan(b.planId()).status());
        assertEquals(54000,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        stock.reportBatch(List.of(b),false);
        assertEquals(Map.of("1",2),stock.completedQuantities(task.id()));
    }
    @Test void duplicateOverlappingAndStalePlansAreRejected() {
        var a=report(5000,1);var overlap=report(5000,1);
        assertThrows(IllegalArgumentException.class,()->stock.reportBatch(List.of(a,a),false));
        assertThrows(IllegalArgumentException.class,()->stock.reportBatch(List.of(a,overlap),false));
        stock.saveTask(new CuttingTask(task.id(),task.name(),task.materialModel(),"changed",task.revision(),task.demands()));
        assertThrows(IllegalArgumentException.class,()->stock.reportBatch(List.of(a),false));
        assertNull(stock.getReceipt(a.planId()));assertEquals(55000,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
}
