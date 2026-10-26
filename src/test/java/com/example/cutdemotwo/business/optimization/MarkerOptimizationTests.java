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
}
