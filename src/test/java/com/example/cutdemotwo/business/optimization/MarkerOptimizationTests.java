package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;

import com.example.cutdemotwo.algorithm.nesting.*;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.*;
import com.example.cutdemotwo.persistence.FileOptimizationJobStore;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.*;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

class MarkerOptimizationTests {
    @Test void validatedStartingLayoutParticipatesInActualCompactionAndRejectsBadGeometry() {
        var r = request("trials");
        var a = new OptimizationRequest.InitialPlacement(1,0d,0d,0);
        var b = new OptimizationRequest.InitialPlacement(1,0d,140d,0);
        var poses = List.of(a,b);
        var engine = new TrialsEngine();
        var solver = new SolverFactory(List.of(engine));
        var input = new OptimizationRequest(r.schemaVersion(),r.problemType(),r.clientRequestId(),r.problem(),false,true,
                new OptimizationRequest.Strategy("marker-shortening","2",3,null,poses));
        var outcome = MarkerOptimization.solve(input,solver,ignored->{});
        assertEquals("SEED", outcome.marker().trials().get(0).phase());
        assertEquals(240, outcome.marker().firstOccupiedLengthMm(),.00001);
        assertEquals("COMPACTION", outcome.marker().trials().get(outcome.marker().trials().size()-1).phase());
        assertEquals(200, outcome.marker().occupiedLengthMm(),.00001);
        assertEquals("marker-compactor",outcome.layout().engine());
        assertEquals(2,outcome.layout().placements().size());
        for (var invalid : List.of(List.of(a),List.of(a,a),List.of(a,new OptimizationRequest.InitialPlacement(1,0d,130d,180)),
                List.of(a,new OptimizationRequest.InitialPlacement(1,0d,999d,0)),
                List.of(a,new OptimizationRequest.InitialPlacement(2,0d,130d,0)))) {
            assertThrows(IllegalArgumentException.class,()->solver.validateMarkerSeed(r.nestingProblem(),invalid));
        }
    }
    @TempDir Path temp;
    static OptimizationRequest request(String engine) {
        return new OptimizationRequest("2.0","NESTING_2D","marker-001",
                new NestingProblem("1","mm",new NestingProblem.Material("fabric",NestingProblem.Shape.rectangle(100,1000),List.of(),false),
                        List.of(new NestingProblem.Part(1,"front",NestingProblem.Shape.rectangle(100,100),2,false)),
                        new NestingProblem.Process("CONTOUR","SHEET","left-top","none",0,0,0,0,"MAXIMIZE_PIECE_AREA",0),engine,10),
                false,true,new OptimizationRequest.Strategy("marker-shortening","1",5));
    }
    static class TrialsEngine implements ICutSolverEngine {
        final AtomicInteger calls=new AtomicInteger();
        boolean interruptSecond, invalidSecond;
        public String getEngineType(){return "trials";}
        public boolean isAvailable(){return true;}
        public EngineCapabilities capabilities(){return new EngineCapabilities("trials","1",List.of("RECTANGLE"),List.of("CONTOUR"),List.of("MAXIMIZE_PIECE_AREA"),.1,true);}
        public EngineResult solve(NestingProblem p) {
            int n=calls.incrementAndGet();
            if(n==2 && interruptSecond)Thread.currentThread().interrupt();
            var placements=new ArrayList<NestingResult.Placement>();
            placements.add(new NestingResult.Placement(1,1,"front",0,0,p.parts().get(0).shape(),0));
            if(p.height()>300)placements.add(new NestingResult.Placement(2,1,"front",0,n==1?300:200,p.parts().get(0).shape(),0));
            if(n==2 && invalidSecond)placements.add(new NestingResult.Placement(3,1,"bad",9999,0,p.parts().get(0).shape(),0));
            var result=new EngineResult();result.setSuccess(true);result.setPlacements(placements);return result;
        }
    }
    @Test void shorterPartialTrialsNeverReplaceACompleteKitAndOriginalInputIsUnchanged() {
        var input=request("trials");var engine=new TrialsEngine();
        var result=MarkerOptimization.solve(input,new SolverFactory(List.of(engine)),message->{});
        assertEquals(3,engine.calls.get());
        assertEquals(400,result.marker().firstOccupiedLengthMm());
        assertEquals(300,result.marker().occupiedLengthMm());
        assertEquals(350,result.marker().trialLengthMm());
        assertFalse(result.marker().trials().get(1).complete());
        assertNull(result.marker().trials().get(1).occupiedLengthMm());
        assertEquals(2,result.layout().placements().size());
        assertFalse(result.marker().optimalityProven());
        assertEquals(1000,input.nestingProblem().height());
    }
    @Test void versionTwoCompactsTheBestCompleteTrialAndArchivesItsPhase() {
        var r = request("trials");
        var input = new OptimizationRequest(r.schemaVersion(), r.problemType(), r.clientRequestId(), r.problem(),
                r.allowFallback(), r.requireComplete(), new OptimizationRequest.Strategy("marker-shortening","2",6));
        var result = MarkerOptimization.solve(input, new SolverFactory(List.of(new TrialsEngine())), message -> {});
        assertEquals("2", result.marker().strategyVersion());
        assertEquals(200, result.marker().occupiedLengthMm());
        assertTrue(MarkerOptimization.complete(result.layout()));
        var trials = result.marker().trials();
        assertEquals("COMPACTION", trials.get(trials.size() - 1).phase());
        assertEquals(300, trials.get(trials.size() - 2).occupiedLengthMm());
        assertNull(trials.get(0).phase());
    }
    @Test void stripSearchCanPublishTheFirstCompleteKitAfterAnOrdinaryPartialTrial() {
        var original = request("packingsolver-irregular");
        var input = new OptimizationRequest(original.schemaVersion(), original.problemType(), original.clientRequestId(),
                original.problem(), false, true, new OptimizationRequest.Strategy("marker-shortening","2",7));
        var nativeEngine = new IrregularPackingSolverService() {
            @Override public boolean isAvailable() { return true; }
            @Override public EngineResult solve(NestingProblem p) {
                var result = new EngineResult();
                result.setSuccess(true);
                result.getPlacements().add(new NestingResult.Placement(1,1,"front",0,0,p.parts().get(0).shape(),0));
                return result;
            }
            @Override public EngineResult solveStripCandidate(NestingProblem p) {
                assertEquals(original.nestingProblem().height(), p.height());
                var result = solve(p);
                result.getPlacements().add(new NestingResult.Placement(2,1,"front",0,100,p.parts().get(0).shape(),0));
                return result;
            }
        };
        var result = MarkerOptimization.solve(input, new SolverFactory(List.of(nativeEngine)), message -> {});
        var trials = result.marker().trials();
        assertFalse(trials.get(0).complete());
        assertEquals("STRIP_SEARCH", trials.get(1).phase());
        assertTrue(trials.get(1).complete());
        assertEquals(200, result.marker().firstOccupiedLengthMm());
        assertEquals(200, result.marker().occupiedLengthMm());
        assertEquals(original.nestingProblem().height(), result.marker().trialLengthMm());
        assertTrue(MarkerOptimization.complete(result.layout()));
    }
    @Test void cancellationRetainsOnlyThePreviouslyValidatedCompleteKit() {
        var engine=new TrialsEngine();engine.interruptSecond=true;
        try {
            var result=MarkerOptimization.solve(request("trials"),new SolverFactory(List.of(engine)),message->{});
            assertEquals(400,result.marker().occupiedLengthMm());
            assertEquals(2,engine.calls.get());
            assertEquals("CANCELLED",result.marker().trials().get(1).status());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {Thread.interrupted();}
    }
    @Test void invalidLaterCandidateIsRecordedAndNeverPublished() {
        var engine=new TrialsEngine();engine.invalidSecond=true;
        var result=MarkerOptimization.solve(request("trials"),new SolverFactory(List.of(engine)),message->{});
        assertEquals(400,result.marker().occupiedLengthMm());
        assertEquals("INVALID_RESULT",result.failureCode());
        assertTrue(result.layout().placements().stream().allMatch(p->p.x()==0));
    }
    @Test void markerJobPersistsHistoryAndUsesOccupiedAreaForItsSeparateMetric() throws Exception {
        var engine=new TrialsEngine();var factory=new SolverFactory(List.of(engine));
        String id;
        try(var service=new OptimizationService(factory, new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),new FileOptimizationJobStore(temp),1,1,100)){
            id=service.submit("marker-durable",request("trials")).id();
            assertEquals("SUCCEEDED",OptimizationServiceTests.finished(service,id).state());
            var result=service.result(id);
            assertEquals(3,result.marker().trials().size());
            var metric=result.metrics().stream().filter(m->m.name().equals("markerAreaUtilization")).findFirst().orElseThrow();
            assertEquals(30000,metric.denominator());assertEquals(20000,metric.numerator());
            assertEquals(200.0/3,metric.value(),.0001);
        }
        try(var reopened=new OptimizationService(factory, new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),new FileOptimizationJobStore(temp),1,1,100)){
            assertEquals(3,reopened.result(id).marker().trials().size());
            assertEquals(id,reopened.submit("marker-durable",request("trials")).id());
        }
    }
    @Test void unsupportedStrategyAndNonKitRequestsAreRejectedBeforeAcceptance() {
        var r=request("trials");
        assertThrows(OptimizationService.Failure.class,()->MarkerOptimization.validate(new OptimizationRequest(
                r.schemaVersion(),r.problemType(),r.clientRequestId(),r.problem(),false,false,r.strategy())));
        assertThrows(OptimizationService.Failure.class,()->MarkerOptimization.validate(new OptimizationRequest(
                r.schemaVersion(),r.problemType(),r.clientRequestId(),r.problem(),false,true,new OptimizationRequest.Strategy("marker-shortening","1",99))));
        assertThrows(OptimizationService.Failure.class,()->MarkerOptimization.validate(new OptimizationRequest(
                r.schemaVersion(),r.problemType(),r.clientRequestId(),r.problem(),false,true,new OptimizationRequest.Strategy("unknown","1",5))));
    }
    @Test void gapFillIsArchivedWithItsOwnAreaButDoesNotFulfillAnotherGarment() throws Exception {
        var base = request("javairregular").nestingProblem();
        var problem = new NestingProblem(base.schemaVersion(), base.unit(),
                new NestingProblem.Material("fabric", NestingProblem.Shape.rectangle(100,100), List.of(), false),
                List.of(new NestingProblem.Part(1,"身片",NestingProblem.Shape.rectangle(60,100),1,false),
                        new NestingProblem.Part(2,"袋布",NestingProblem.Shape.rectangle(20,20),1,false)),
                base.process(), base.engine(), 4);
        var input = new OptimizationRequest("2.0","NESTING_2D","gap-fill",problem,false,true,
                new OptimizationRequest.Strategy("marker-shortening","2",1,Map.of(2,2)));
        var store = new FileOptimizationJobStore(temp);
        var factory = new SolverFactory(List.of(new JavaIrregularSolverEngine()));
        try (var service = new OptimizationService(factory, new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(), store,1,1,100)) {
            String id = service.submit("gap-fill", input).id();
            assertEquals("SUCCEEDED", OptimizationServiceTests.finished(service,id).state());
            var result = service.result(id);
            assertEquals("COMPLETE", result.fulfillmentStatus());
            assertEquals(2, result.layout().placements().size());
            assertEquals(2, result.marker().gapFillPlacements().size());
            var kit = result.metrics().stream().filter(m -> m.name().equals("markerAreaUtilization")).findFirst().orElseThrow();
            var total = result.metrics().stream().filter(m -> m.name().equals("markerAreaUtilizationWithFill")).findFirst().orElseThrow();
            assertEquals(64, kit.value());
            assertEquals(72, total.value());
            assertEquals(kit.denominator(), total.denominator());
            var archived = store.load().stream().filter(d -> d.job().id().equals(id)).findFirst().orElseThrow();
            assertEquals(input, archived.input());
            assertEquals(result.marker(), archived.result().marker());
        }
    }
    @Test void rejectsUnknownPartsAndInvalidGapFillLimits() {
        var base = request("trials");
        for (var limits : List.of(Map.of(999,1), Map.of(1,0), Map.of(1,81), Map.<Integer,Integer>of())) {
            var input = new OptimizationRequest(base.schemaVersion(),base.problemType(),base.clientRequestId(),
                    base.problem(),false,true,new OptimizationRequest.Strategy("marker-shortening","2",1,limits));
            assertThrows(OptimizationService.Failure.class, () -> MarkerOptimization.validate(input));
        }
        assertFalse(JsonMapper.builder().build().writeValueAsString(base).contains("gapFillLimits"));
        var withSpares = new OptimizationRequest(base.schemaVersion(),base.problemType(),base.clientRequestId(),
                base.problem(),false,true,new OptimizationRequest.Strategy("marker-shortening","2",1,Map.of(1,2)));
        var metric = new OptimizationResult("a","a","hash","2.0","PASSED","COMPLETE",true,"COMPLETED",
                List.of(),(NestingResult)null);
        var comparison = ResultComparisons.compare(base,metric,withSpares,metric);
        assertFalse(comparison.sameHardConstraints());
        assertEquals(List.of("strategy.gapFillLimits"),comparison.differences());
    }
    @Test void optionalStrategyDoesNotChangeLegacyCanonicalHashInput() {
        var json=JsonMapper.builder().build();
        var legacy=OptimizationServiceTests.request("crosscut",1,3,false);
        assertFalse(json.writeValueAsString(legacy).contains("strategy"));
        assertEquals(legacy,json.readValue(json.writeValueAsString(legacy),OptimizationRequest.class));
    }
    @Test void cancellingRunningLaterTrialArchivesEarlierCompleteResultWithCancelledState() throws Exception {
        var entered=new CountDownLatch(1);
        var engine=new TrialsEngine(){
            @Override public EngineResult solve(NestingProblem p){
                if(calls.get()==1){
                    entered.countDown();
                    try {new CountDownLatch(1).await(3,TimeUnit.SECONDS);}
                    catch(InterruptedException stop){Thread.currentThread().interrupt();}
                }
                return super.solve(p);
            }
        };
        try(var service=new OptimizationService(new SolverFactory(List.of(engine)), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),new FileOptimizationJobStore(temp),1,1,100)){
            var job=service.submit("marker-stop",request("trials"));
            assertTrue(entered.await(2,TimeUnit.SECONDS));
            service.cancel(job.id());
            assertEquals("CANCELLED",OptimizationServiceTests.finished(service,job.id()).state());
            var result=service.result(job.id());
            assertEquals("CANCELLED",result.terminationReason());
            assertEquals("COMPLETE",result.fulfillmentStatus());
            assertEquals(400,result.marker().occupiedLengthMm());
        }
    }
    @Test void invalidLaterTrialFailsJobWhileRetainingOnlyEarlierVerifiedResult() throws Exception {
        var engine=new TrialsEngine();engine.invalidSecond=true;
        try(var service=new OptimizationService(new SolverFactory(List.of(engine)), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),new FileOptimizationJobStore(temp),1,1,100)){
            var job=service.submit("marker-invalid",request("trials"));
            var done=OptimizationServiceTests.finished(service,job.id());
            assertEquals("FAILED",done.state());assertEquals("INVALID_RESULT",done.code());
            assertEquals("ENGINE_ERROR",service.result(job.id()).terminationReason());
            assertEquals(400,service.result(job.id()).marker().occupiedLengthMm());
        }
    }
    @Test void incompleteInitialTrialHasNoCompleteMarkerMetricOrFalseInfeasibilityClaim() throws Exception {
        var r=request("javairregular");var p=r.nestingProblem();
        var impossible=new NestingProblem(p.schemaVersion(),p.unit(),p.material(),
                List.of(new NestingProblem.Part(1,"too tall",NestingProblem.Shape.rectangle(100,2000),1,false)),
                p.process(),p.engine(),p.timeLimitSeconds());
        var input=new OptimizationRequest(r.schemaVersion(),r.problemType(),r.clientRequestId(),impossible,false,true,r.strategy());
        try(var service=new OptimizationService(new SolverFactory(List.of(new JavaIrregularSolverEngine())), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),new FileOptimizationJobStore(temp),1,1,100)){
            var job=service.submit("marker-incomplete",input);
            assertEquals("SUCCEEDED",OptimizationServiceTests.finished(service,job.id()).state());
            var result=service.result(job.id());
            assertEquals("NONE",result.fulfillmentStatus());assertFalse(result.meetsRequirement());
            assertEquals("NO_SOLUTION_FOUND",result.layout().status());
            assertNull(result.marker().occupiedLengthMm());assertEquals(1,result.marker().trials().size());
            assertFalse(result.metrics().stream().anyMatch(m->m.name().equals("markerAreaUtilization")));
        }
    }
    @Test void markerTrialsPreserveMaterialFabricRuleAcrossEveryShorteningStep() {
        var fabricRule = new NestingProblem.FabricRule(30.0, 20.0, false, 400.0, 50.0);
        var material = new NestingProblem.Material("curtain-fabric", NestingProblem.Shape.rectangle(1000, 1200),
                List.of(), false, fabricRule);
        var part = new NestingProblem.Part(1, "主帘", NestingProblem.Shape.rectangle(400, 250), 2, false, false,
                new NestingProblem.PartRule("MAIN", true, 10.0, 1.0));
        var problem = new NestingProblem("1", "mm", material, List.of(part),
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", 0),
                "javairregular", 8);
        var input = new OptimizationRequest("2.0", "NESTING_2D", "marker-fabric-rule", problem, false, true,
                new OptimizationRequest.Strategy("marker-shortening", "1", 4));

        var observedRules = new ArrayList<NestingProblem.FabricRule>();
        var delegate = new JavaIrregularSolverEngine();
        var spySolver = new SolverFactory(List.of(new ICutSolverEngine() {
            @Override public String getEngineType() { return "javairregular"; }
            @Override public boolean isAvailable() { return true; }
            @Override public EngineCapabilities capabilities() { return delegate.capabilities(); }
            @Override public EngineResult solve(NestingProblem candidate) {
                observedRules.add(candidate.material().fabricRule());
                return delegate.solve(candidate);
            }
        }));

        var outcome = MarkerOptimization.solve(input, spySolver, ignored -> {});
        assertFalse(observedRules.isEmpty(), "必须执行至少一次缩长试排");
        assertTrue(observedRules.size() >= 2, "齐套后应继续缩短并透传 fabricRule，实际试排数=" + observedRules.size());
        for (var seenRule : observedRules) {
            assertEquals(fabricRule, seenRule, "每次缩长试排的 Material 均须完整保留 fabricRule");
        }
        assertTrue(MarkerOptimization.complete(outcome.layout()), outcome.layout().message());
        for (var placed : outcome.layout().placements()) {
            assertTrue(placed.x() >= 30.0 - 0.001, "唛架结果不得侵占左布边，实际 x=" + placed.x());
            assertTrue(placed.x() + placed.shape().width() <= 980.0 + 0.001, "唛架结果不得侵占右布边");
        }
    }
}
