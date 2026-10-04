package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.persistence.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import com.example.cutdemotwo.controller.RemnantRecommendationController;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class RemnantRecommendationTests {
    @TempDir Path temp;
    RemnantService inventory;
    RemnantRecommendationService service;
    SolverFactory kernel;
    @BeforeEach void setup() {
        inventory = new RemnantService(new FileInventoryStore(temp.resolve("inventory.json").toString()), false);
        var nativeEngine = new PackingSolverService();
        ReflectionTestUtils.setField(nativeEngine, "solverPath", System.getenv().getOrDefault("PACKINGSOLVER_PATH", "data/solver/packingsolver_rectangleguillotine.exe"));
        kernel = new SolverFactory(List.of(new CrossCutSolverService(), nativeEngine));
        service = new RemnantRecommendationService(inventory, kernel);
    }
    RemnantStock stock(String id, double w, double h) {
        return new RemnantStock(id,w,h,"A-01","MODEL","AVAILABLE","ROLL",false,"");
    }
    SolveRequest input(boolean longitudinal, PieceDemand... demands) {
        var r=new SolveRequest();r.setRollModel("MODEL");r.setDemands(List.of(demands));
        r.setAllowLongitudinal(longitudinal);r.setCutOrigin("left-top");return r;
    }
    PieceDemand demand(int id, double w, double h, int count) {return new PieceDemand(id,"同名裁片",w,h,count,false);}
    RemnantRecommendationService.Analysis recommend(SolveRequest r) {return service.recommend(new RemnantRecommendationService.Request(r,Map.of()));}

    @Test void ranksActualOutputAndUtilizationWithPerDemandCountsWithoutWriting() throws Exception {
        inventory.registerRemnant(stock("SMALL",600,500));inventory.registerRemnant(stock("LARGE",600,1200));inventory.registerRemnant(stock("TIGHT",600,1000));
        var other=stock("OTHER",600,800);other.setMaterialBatch("OTHER");inventory.registerRemnant(other);
        var used=stock("USED",600,800);used.setStatus("CONSUMED");inventory.registerRemnant(used);
        byte[] before=Files.readAllBytes(temp.resolve("inventory.json"));
        var result=recommend(input(false,demand(1,600,500,2),demand(2,600,500,1)));
        assertEquals(3,result.candidateCount());assertEquals(List.of("TIGHT","LARGE","SMALL"),result.recommendations().stream().map(r->r.stock().getId()).toList());
        var top=result.recommendations().get(0);assertEquals(2,top.pieceCount());assertEquals(100,top.utilization(),1e-8);
        assertEquals(2,top.lines().get(0).placed());assertEquals(0,top.lines().get(1).placed());assertEquals(1,top.lines().get(1).remaining());
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("inventory.json")));assertTrue(inventory.listTasks().isEmpty());
    }
    @Test void remnantCrosscutKeepsNarrowerDemandAndProductionCanUseTheSameSubset() {
        inventory.registerRemnant(stock("REM",600,1000));
        var request=input(false,demand(1,600,500,2),demand(2,200,500,5));
        var suggestion=recommend(request).recommendations().get(0);assertEquals(2,suggestion.pieceCount());assertEquals(5,suggestion.lines().get(1).remaining());
        var task=inventory.saveTask(new CuttingTask(null,"需求","MODEL","",0,List.of(new CuttingTask.Line(1,"同名裁片",600,500,2,false),new CuttingTask.Line(2,"同名裁片",200,500,5,false))));
        request.setTaskId(task.id());request.setTaskRevision(task.revision());request.setFeedPortType("remnant");request.setSourceRemnantId("REM");request.setRollId("ROLL");request.setRollW(600);request.setRollL(1000);
        var result=new CuttingWorkflowService(kernel,inventory).solve(request);assertTrue(result.isSuccess(),result.getMessage());assertEquals(2,result.getPieces().size());
        assertEquals("CROSSCUT_WIDTH_MISMATCH",result.getFulfillment().get(1).reason());assertEquals("AVAILABLE",inventory.scanOrGetById("REM").getStatus());
    }
    @Test void defectsAndTrimChangeTheTrueCuttableCountAndUnknownDefectsAreNotRecommended() {
        var clean=stock("CLEAN",600,1000);inventory.registerRemnant(clean);
        var blocked=stock("BLOCKED",600,1000);blocked.setHasDefect(true);blocked.setDefects(List.of(new Defect(1,0,0,600,1000,0)));inventory.registerRemnant(blocked);
        var unknown=stock("UNKNOWN",600,1000);unknown.setHasDefect(true);inventory.registerRemnant(unknown);
        var request=input(true,demand(1,600,500,2));request.setTrimStart(10);
        var result=recommend(request);assertEquals(1,result.recommendations().size());assertEquals("CLEAN",result.recommendations().get(0).stock().getId());assertEquals(1,result.recommendations().get(0).pieceCount());
        assertEquals(2,result.unavailable().size());assertTrue(result.unavailable().stream().anyMatch(r->"DEFECTS_UNLOCATED".equals(r.status())));
    }
    @Test void nativeSolverRespectsRotationAndFractionalDimensions() {
        inventory.registerRemnant(stock("ROT",300.3,500.5));
        var request=input(true,demand(7,500.5,300.3,1));assertEquals(0,recommend(request).candidateCount());
        request.setAllowRotation(true);var result=recommend(request);assertEquals(1,result.recommendations().size());assertEquals(1,result.recommendations().get(0).pieceCount());
        assertEquals(100,result.recommendations().get(0).utilization(),1e-8);
        request.setAllowLongitudinal(false);var crosscut=recommend(request);assertTrue(crosscut.recommendations().isEmpty());assertEquals("PROCESS_MISMATCH",crosscut.unavailable().get(0).status());
    }
    @Test void savedTaskCompletionAndInventoryChangesInvalidateRecommendations() {
        inventory.registerRemnant(stock("REM",600,1000));
        var task=inventory.saveTask(new CuttingTask(null,"需求","MODEL","",0,List.of(new CuttingTask.Line(1,"裁片",600,500,2,false))));
        var request=input(false,demand(1,600,500,2));request.setTaskId(task.id());request.setTaskRevision(task.revision());
        assertThrows(InventoryConflictException.class,()->service.recommend(new RemnantRecommendationService.Request(request,Map.of("1",1))));
        var snapshot=inventory.recommendationSnapshot(request,Map.of());inventory.updateStatus("REM","SCRAPPED");
        assertEquals("AVAILABLE",snapshot.stocks().get(0).getStatus(),"detached snapshot must not mutate");
        assertThrows(InventoryConflictException.class,()->inventory.verifyRecommendationRevision(snapshot.revision()));
        assertEquals(0,recommend(request).candidateCount());
        request.setTaskRevision(999);assertThrows(InventoryConflictException.class,()->recommend(request));
    }
    @Test void reportingOneRemnantRecommendsOnlyOutstandingDemandAndReversalRestoresIt() {
        inventory.registerRemnant(stock("FIRST",600,500));inventory.registerRemnant(stock("NEXT",600,500));
        var task=inventory.saveTask(new CuttingTask(null,"需求","MODEL","",0,List.of(new CuttingTask.Line(1,"裁片",600,500,2,false))));
        var request=input(false,demand(1,600,500,2));request.setTaskId(task.id());request.setTaskRevision(task.revision());
        request.setFeedPortType("remnant");request.setSourceRemnantId("FIRST");request.setRollId("ROLL");request.setRollW(600);request.setRollL(500);
        var workflow=new CuttingWorkflowService(kernel,inventory);var plan=workflow.solve(request);
        workflow.confirm(new CutReport(plan.getPlanId(),0,1,List.of(),"A"));
        assertThrows(InventoryConflictException.class,()->recommend(request));
        request.setDemands(List.of(demand(1,600,500,1)));
        var next=service.recommend(new RemnantRecommendationService.Request(request,inventory.completedQuantities(task.id())));
        assertEquals(1,next.candidateCount());assertEquals("NEXT",next.recommendations().get(0).stock().getId());assertEquals(1,next.recommendations().get(0).lines().get(0).requested());
        inventory.reverseReport(plan.getPlanId(),"测试误报纠正");request.setDemands(List.of(demand(1,600,500,2)));
        assertEquals(2,recommend(request).candidateCount());assertTrue(inventory.completedQuantities(task.id()).isEmpty());
    }
    @Test void changesDuringTrialAreRejectedAndTheNextAttemptIsAllowed() {
        inventory.registerRemnant(stock("REM",600,1000));
        var changingKernel=new SolverFactory(List.of(new CrossCutSolverService())) {
            @Override public com.example.cutdemotwo.model.nesting.NestingResult solve(com.example.cutdemotwo.model.nesting.NestingProblem problem) {
                var result=super.solve(problem);inventory.updateStatus("REM","SCRAPPED");return result;
            }
        };
        var changing=new RemnantRecommendationService(inventory,changingKernel);
        assertThrows(InventoryConflictException.class,()->changing.recommend(new RemnantRecommendationService.Request(input(false,demand(1,600,500,1)),Map.of())));
        assertEquals(0,changing.recommend(new RemnantRecommendationService.Request(input(false,demand(1,600,500,1)),Map.of())).candidateCount());
    }
    @Test void searchLimitReportsUnevaluatedStocksExplicitly() {
        for(int i=0;i<10;i++)inventory.registerRemnant(stock("REM-"+i,600,1000+i*10));
        var result=recommend(input(false,demand(1,600,500,1)));assertEquals(10,result.candidateCount());assertEquals(8,result.evaluatedCount());assertEquals(2,result.deferredCount());assertEquals(8,result.recommendations().size());
    }
    @Test void unavailableEngineIsNotPresentedAsNoCompatibleStock() {
        inventory.registerRemnant(stock("REM",600,1000));
        var missing=new RemnantRecommendationService(inventory,new SolverFactory(List.of()));
        var result=missing.recommend(new RemnantRecommendationService.Request(input(true,demand(1,600,500,1)),Map.of()));
        assertEquals(1,result.candidateCount());assertEquals(0,result.recommendations().size());assertEquals("UNSUPPORTED",result.unavailable().get(0).status());
    }
    @Test void rejectsInvalidDemandBeforeFilteringAndHttpEndpointIsReadOnly() throws Exception {
        inventory.registerRemnant(stock("REM",600,1000));
        assertThrows(IllegalArgumentException.class,()->recommend(input(false,demand(1,600,500,1),demand(1,200,500,1))));
        assertThrows(IllegalArgumentException.class,()->recommend(input(false,demand(1,600,500,10001))));
        var invalid=input(false,demand(1,600,500,1),demand(2,-1,500,1));invalid.setFeedPortType("remnant");
        assertThrows(IllegalArgumentException.class,()->FabricSolveAdapter.toProblem(invalid));
        var mvc=MockMvcBuilders.standaloneSetup(new RemnantRecommendationController(service)).build();
        var payload=new tools.jackson.databind.ObjectMapper().writeValueAsString(new RemnantRecommendationService.Request(input(false,demand(1,600,500,1)),Map.of()));
        byte[] before=Files.readAllBytes(temp.resolve("inventory.json"));
        mvc.perform(post("/api/cutting/remnant-recommendations").contentType("application/json").content(payload)).andExpect(status().isOk());
        mvc.perform(post("/api/cutting/remnant-recommendations").contentType("application/json").content("{}")).andExpect(status().isBadRequest());
        mvc.perform(post("/api/cutting/remnant-recommendations").contentType("application/json").content(payload.replace("\"demand\":1", "\"demand\":1.5"))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/cutting/remnant-recommendations").contentType("application/json").content(payload.substring(0,payload.length()-1)+",\"unknown\":true}")).andExpect(status().isBadRequest());
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("inventory.json")));
    }
}
