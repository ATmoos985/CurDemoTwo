package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;

import com.example.cutdemotwo.algorithm.nesting.*;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.slitting.*;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

@Timeout(20)
class SlittingOptimizationTests {
    @TempDir Path temp;
    static OptimizationRequest request() {
        return new OptimizationRequest("2.0","SLITTING_1D","erp-roll-001",new SlittingProblem("1","mm",1200,10,10,1000,1180,10,10,"FAST",
                List.of(new SlittingProblem.Order("A/001",500,3000,4,"A"),new SlittingProblem.Order("B/002",600,3000,2,"A")),10),false,true);
    }
    OptimizationJob done(OptimizationService service,String id)throws Exception {
        for(int i=0;i<600;i++){var j=service.get(id);if(j.terminal())return j;Thread.sleep(20);}
        throw new AssertionError("job still running");
    }
    OptimizationJobStore store(boolean jdbc) {
        if(!jdbc)return new FileOptimizationJobStore(temp);
        var source=OptimizationTestDatabase.create();Flyway.configure().dataSource(source).load().migrate();return new JdbcOptimizationJobStore(source);
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void actualProcessJobPersistsAndReplaysInFileAndJdbc(boolean jdbc)throws Exception {
        OptimizationRequest request=request();String id;OptimizationResult result;
        var store=store(jdbc);
        try(var service=new OptimizationService(new SolverFactory(List.of(new CrossCutSolverService())), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),store,1,2,100)) {
            id=service.submit("slitting-real-process",request).id();var job=done(service,id);
            assertEquals("SUCCEEDED",job.state(),job.toString());
            result=service.result(id);assertEquals("COMPLETE",result.fulfillmentStatus());assertTrue(result.meetsRequirement());
            assertNull(result.layout());assertNotNull(result.slitting());
            assertEquals(List.of("A/001","B/002"),result.slitting().fulfillment().stream().map(SlittingResult.Fulfillment::orderId).toList());
            assertEquals(id,service.submit("slitting-real-process",request).id());assertEquals(request,service.input(id));
            assertEquals(2,result.metrics().size());assertTrue(result.metrics().get(1).value()>result.metrics().get(0).value());
        }
        var reopened=jdbc?store:new FileOptimizationJobStore(temp);
        try(var next=new OptimizationService(new SolverFactory(List.of(new CrossCutSolverService())), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),reopened,1,2,100)) {
            assertEquals(result,next.result(id));assertEquals(id,next.submit("slitting-real-process",request).id());
        }
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void timeoutCannotBeMisreportedAsEngineFailure(boolean jdbc)throws Exception {
        ISlittingSolverEngine timed=new ISlittingSolverEngine(){
            public String getEngineType(){return "test";}public boolean isAvailable(){return true;}
            public SlittingResult solve(SlittingProblem p){throw new com.example.cutdemotwo.algorithm.api.ComputationTimeout();}
        };
        try(var service=new OptimizationService(new SolverFactory(List.of(new CrossCutSolverService())),timed,store(jdbc),1,2,100)) {
            var job=done(service,service.submit("timeout-slitting",request()).id());
            assertEquals("TIMED_OUT",job.state());assertEquals("TIMED_OUT",job.code());assertNull(job.resultRef());
        }
    }
    @Test void unsupportedStrategyAndMismatchedPayloadAreRejectedBeforeAcceptance() {
        try(var service=new OptimizationService(new SolverFactory(List.of(new CrossCutSolverService())), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),store(false),1,2,100)) {
            var r=request();
            assertEquals(422,assertThrows(OptimizationService.Failure.class,()->service.validate(new OptimizationRequest("2.0","SLITTING_1D","x",r.problem(),false,true,
                    new OptimizationRequest.Strategy("marker-shortening","1",2)))).status);
            assertEquals(400,assertThrows(OptimizationService.Failure.class,()->service.validate(new OptimizationRequest("2.0","NESTING_2D","x",r.problem(),false,true))).status);
        }
    }
}
