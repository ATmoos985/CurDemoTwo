package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class ResultComparisonsTests {
    OptimizationRequest input(double width,boolean rotate,String engine,int seconds,String objective){
        return new OptimizationRequest("2.0","NESTING_2D","comparison",new NestingProblem("1","mm",
                new NestingProblem.Material("stock",NestingProblem.Shape.rectangle(width,3000),List.of(),false),
                List.of(new NestingProblem.Part(1,"part",NestingProblem.Shape.rectangle(500,500),2,rotate)),
                new NestingProblem.Process("CROSSCUT","SHEET","left-top","horizontal",0,200,300,0,objective),engine,seconds),false,true);
    }
    OptimizationResult result(String id,double value,String unit,String basis,String version){
        return new OptimizationResult(id,id,id,"2.0","PASSED","COMPLETE",true,"COMPLETED",
                List.of(new OptimizationResult.Metric("utilization",value,unit,500000,6000000,basis,version)),(com.example.cutdemotwo.contracts.nesting.NestingResult)null);
    }
    @Test void changedSearchSettingsPermitDeltasWithoutClaimingWinner(){
        var actual=ResultComparisons.compare(input(2000,false,"auto",2,"INPUT_ORDER"),result("a",.6,"ratio","consumed","1"),
                input(2000,false,"javaguillotine",5,"AREA_DESC"),result("b",.7,"ratio","consumed","1"));
        assertTrue(actual.sameHardConstraints());assertEquals(.1,actual.metrics().get(0).rightMinusLeft(),1e-9);
        assertEquals("a",actual.leftResultId());assertEquals("b",actual.rightResultId());
    }
    @Test void differentMaterialOrRotationSuppressesDeltas(){
        for(var other:List.of(input(2001,false,"auto",2,"INPUT_ORDER"),input(2000,true,"auto",2,"INPUT_ORDER"))){
            var compared=ResultComparisons.compare(input(2000,false,"auto",2,"INPUT_ORDER"),result("a",.6,"ratio","consumed","1"),other,result("b",.7,"ratio","consumed","1"));
            assertFalse(compared.sameHardConstraints());assertFalse(compared.differences().isEmpty());assertNull(compared.metrics().get(0).rightMinusLeft());
        }
    }
    @Test void incompatibleUnitBasisOrVersionRetainsBothDefinitionsWithoutDelta(){
        var input=input(2000,false,"auto",2,"INPUT_ORDER");
        for(var right:List.of(result("b",70,"percent","consumed","1"),result("b",.7,"ratio","window","1"),result("b",.7,"ratio","consumed","2"))){
            var compared=ResultComparisons.compare(input,result("a",.6,"ratio","consumed","1"),input,right);
            assertTrue(compared.sameHardConstraints());assertEquals("INCOMPATIBLE_METRIC",compared.metrics().get(0).status());assertNull(compared.metrics().get(0).rightMinusLeft());
            assertEquals(right.metrics().get(0),compared.metrics().get(0).right());
        }
    }
    OptimizationRequest slitting(String profile,int overCap,String treatment){
        return new OptimizationRequest("2.0","SLITTING_1D","comparison",new SlittingProblem("1","mm",
                1500,0,0,100,1500,10,overCap,profile,
                List.of(new SlittingProblem.Order("order",500,1000,2,treatment)),3),false,true);
    }
    @Test void slittingSearchProfileMayDifferButOverproductionAndTreatmentMayNot(){
        var left=slitting("FAST",0,"A");var metric=result("a",.6,"ratio","consumed","1");
        assertTrue(ResultComparisons.compare(left,metric,slitting("QUALITY",0,"A"),metric).sameHardConstraints());
        for(var other:List.of(slitting("FAST",1,"A"),slitting("FAST",0,"B"))){
            var compared=ResultComparisons.compare(left,metric,other,metric);
            assertFalse(compared.sameHardConstraints());assertNull(compared.metrics().get(0).rightMinusLeft());
        }
    }
    @Test void missingMetricAndPartialFulfillmentRemainExplicit(){
        var input=input(2000,false,"auto",2,"INPUT_ORDER");
        var partial=new OptimizationResult("b","b","b","2.0","PASSED","PARTIAL",false,"TIME_LIMIT",
                List.of(),(com.example.cutdemotwo.contracts.nesting.NestingResult)null);
        var compared=ResultComparisons.compare(input,result("a",.6,"ratio","consumed","1"),input,partial);
        assertEquals("COMPLETE",compared.leftFulfillment());assertEquals("PARTIAL",compared.rightFulfillment());
        assertTrue(compared.leftMeetsRequirement());assertFalse(compared.rightMeetsRequirement());
        assertNull(compared.metrics().get(0).right());assertNull(compared.metrics().get(0).rightMinusLeft());
        assertEquals("INCOMPATIBLE_METRIC",compared.metrics().get(0).status());
    }
}
