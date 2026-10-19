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

    CutReport reportWithLength(double start, double length) {
        var request=new SolveRequest();request.setTaskId(task.id());request.setTaskRevision(task.revision());
        request.setRollL(length);request.setWindowStartY(start);request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(1,"片",2000,1000,1,false)));
        var result=workflow.solve(request);assertTrue(result.isSuccess());
        return new CutReport(result.getPlanId(),length,1,List.of(),"A");
    }
    @Test void decimalStationEndpointsTouchWithoutFalseOverlapInEitherBatchOrder() throws Exception {
        var a=reportWithLength(24351.9,2597.9);var b=reportWithLength(26949.8,2210.2);
        assertTrue(24351.9+2597.9>26949.8); // The production failure: one ULP of apparent overlap.
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        for(var batch:List.of(List.of(a,b),List.of(b,a))) {
            assertEquals(2,stock.reportBatch(batch,true).size());
            assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
            assertNull(stock.getReceipt(a.planId()));assertNull(stock.getReceipt(b.planId()));
            assertEquals("PENDING",stock.getPlan(a.planId()).status());
        }
        assertEquals(2,stock.reportBatch(List.of(a,b),false).size());
        assertEquals(55000-2597.9-2210.2,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength(),1e-8);
        assertEquals(Map.of("1",2),stock.completedQuantities(task.id()));
    }
    @Test void decimalEndpointCanContinueAfterAnAlreadyReportedStation() {
        var a=reportWithLength(24351.9,2597.9);var b=reportWithLength(26949.8,2210.2);
        stock.confirmPlan(a);
        assertEquals(1,stock.reportBatch(List.of(b),true).size());
        assertNull(stock.getReceipt(b.planId()));
        stock.confirmPlan(b);
        assertEquals(Map.of("1",2),stock.completedQuantities(task.id()));
    }
    @Test void physicalOverlapWithinPendingBatchIsRejectedAndRolledBack() throws Exception {
        var a=reportWithLength(24351.9,2597.9);var b=reportWithLength(26949.7999,2210.2);
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        for(boolean preview:List.of(true,false)) for(var batch:List.of(List.of(a,b),List.of(b,a))) {
            var error=assertThrows(IllegalArgumentException.class,()->stock.reportBatch(batch,preview));
            assertTrue(error.getMessage().contains("本批次待报工工位重叠"));
            assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
            assertNull(stock.getReceipt(a.planId()));assertNull(stock.getReceipt(b.planId()));
            assertEquals("PENDING",stock.getPlan(a.planId()).status());
            assertEquals("PENDING",stock.getPlan(b.planId()).status());
            assertTrue(stock.completedQuantities(task.id()).isEmpty());
        }
    }
    @Test void alreadyReportedOverlapIsNotMislabelledAsPendingEvenWhenIncludedInRetry() {
        var a=report(5000,1);var b=report(5999.9999,1);stock.confirmPlan(a);
        for(boolean preview:List.of(true,false)) {
            var error=assertThrows(IllegalArgumentException.class,()->stock.reportBatch(List.of(a,b),preview));
            assertTrue(error.getMessage().contains("与已报工区间重叠"));
            assertNull(stock.getReceipt(b.planId()));assertEquals("CONFIRMED",stock.getPlan(a.planId()).status());
            assertEquals(54000,stock.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        }
    }
}
