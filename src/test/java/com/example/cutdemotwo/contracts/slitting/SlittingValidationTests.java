package com.example.cutdemotwo.contracts.slitting;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class SlittingValidationTests {

    private SlittingProblem validProblem() {
        return new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 20, "FAST",
                List.of(
                        new SlittingProblem.Order("O1", 500, 3000, 2, "素色"),
                        new SlittingProblem.Order("O2", 600, 3000, 2, "素色")
                ), 5);
    }

    private SlittingResult validResult(SlittingProblem problem) {
        var stations = List.of(new SlittingResult.Station(500, 1), new SlittingResult.Station(600, 1));
        var allocs = List.of(new SlittingResult.Allocation("O1", 2), new SlittingResult.Allocation("O2", 2));
        var pattern = new SlittingResult.Pattern("P1", 1180, 1100, 3000, "素色", 2, stations, allocs);
        var fulfillments = List.of(
                new SlittingResult.Fulfillment("O1", 2, 2, 0, 0),
                new SlittingResult.Fulfillment("O2", 2, 2, 0, 0)
        );
        return new SlittingResult("1", "mm", "ortools-1d", "1.0", "FEASIBLE", false,
                List.of(pattern), fulfillments, 1100L * 3000 * 2, 1200L * 3000 * 2, 1180L * 3000 * 2, 0);
    }

    @Test
    void validProblemAndResultPassValidation() {
        var p = validProblem();
        assertDoesNotThrow(() -> SlittingValidation.validateProblem(p));
        var r = validResult(p);
        assertDoesNotThrow(() -> SlittingValidation.validateResult(p, r));
    }

    @Test
    void invalidDimensionsAndCapAreRejected() {
        var p = validProblem();
        assertThrows(SlittingValidation.ValidationException.class, () ->
                SlittingValidation.validateProblem(new SlittingProblem("1", "mm", 1200, 700, 600, 1000, 1180, 10, 20, "FAST", p.orders(), 5)));
        assertThrows(SlittingValidation.ValidationException.class, () ->
                SlittingValidation.validateProblem(new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, -1, "FAST", p.orders(), 5)));
        assertThrows(SlittingValidation.ValidationException.class, () ->
                SlittingValidation.validateProblem(new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 20, "UNKNOWN", p.orders(), 5)));
    }

    @Test
    void overCapExceededIsDetectedAndRejected() {
        var p = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 0, "FAST",
                List.of(new SlittingProblem.Order("O1", 500, 3000, 2, "素色")), 5);
        var stations = List.of(new SlittingResult.Station(500, 2));
        var allocs = List.of(new SlittingResult.Allocation("O1", 4)); // produced 4, requested 2 -> overproduced 2 > cap 0
        var pattern = new SlittingResult.Pattern("P1", 1180, 1000, 3000, "素色", 2, stations, allocs);
        var fulfillments = List.of(new SlittingResult.Fulfillment("O1", 2, 4, 0, 2));
        var r = new SlittingResult("1", "mm", "ortools-1d", "1.0", "FEASIBLE", false,
                List.of(pattern), fulfillments, 1000L * 3000 * 2, 1200L * 3000 * 2, 1180L * 3000 * 2, 2);
        assertThrows(SlittingValidation.ValidationException.class, () -> SlittingValidation.validateResult(p, r));
    }

    @Test void fractionalMetresAndOverflowingTrimsAreRejected() {
        var p=validProblem();
        assertThrows(SlittingValidation.ValidationException.class,()->SlittingValidation.validateProblem(
                new SlittingProblem("1","mm",1200,Integer.MAX_VALUE,Integer.MAX_VALUE,1000,1180,10,20,"FAST",p.orders(),5)));
        assertThrows(SlittingValidation.ValidationException.class,()->SlittingValidation.validateProblem(
                new SlittingProblem("1","mm",1200,10,10,1000,1180,10,20,"FAST",
                        List.of(new SlittingProblem.Order("O1",500,3001,2,"素色")),5)));
    }
    @Test void assignmentMustMatchEveryWidthLengthAndSurfaceAndCandidateWidth() {
        var p=validProblem();var good=validResult(p);var base=good.patterns().get(0);
        var wrong=List.of(
                new SlittingResult.Pattern("P1",1180,1100,3000,"素色",2,List.of(new SlittingResult.Station(550,2)),base.allocations()),
                new SlittingResult.Pattern("P1",1180,1100,6000,"素色",2,base.stations(),base.allocations()),
                new SlittingResult.Pattern("P1",1180,1100,3000,"涂层",2,base.stations(),base.allocations()),
                new SlittingResult.Pattern("P1",100,1100,3000,"素色",2,base.stations(),base.allocations()),
                new SlittingResult.Pattern("P1",1179,1100,3000,"素色",2,base.stations(),base.allocations()));
        for(var pattern:wrong)assertThrows(SlittingValidation.ValidationException.class,()->SlittingValidation.validateResult(p,
                new SlittingResult("1","mm","ortools-1d","1","FEASIBLE",false,List.of(pattern),good.fulfillment(),
                        good.pieceAreaMm2(),good.motherAreaMm2(),good.usableAreaMm2(),0)));
    }
    @Test void emptyResultsAndAreaOrOptimalityClaimsAreIndependentlyChecked() {
        var p=validProblem();var good=validResult(p);
        for(var bad:List.of(
                new SlittingResult("1","mm","ortools-1d","1","FEASIBLE",true,good.patterns(),good.fulfillment(),good.pieceAreaMm2(),good.motherAreaMm2(),good.usableAreaMm2(),0),
                new SlittingResult("1","mm","ortools-1d","1","FEASIBLE",false,good.patterns(),good.fulfillment(),-1,good.motherAreaMm2(),good.usableAreaMm2(),0),
                new SlittingResult("1","mm","ortools-1d","1","NO_SOLUTION_FOUND",false,List.of(),List.of(),-1,0,0,0)))
            assertThrows(SlittingValidation.ValidationException.class,()->SlittingValidation.validateResult(p,bad));
    }
    @Test void globalOverproductionCannotBeOffsetByMissingOrdersInOtherGroups() {
        var p=new SlittingProblem("1","mm",1000,0,0,1000,1000,1,0,"FAST",List.of(
                new SlittingProblem.Order("A",500,1000,1,"A"),new SlittingProblem.Order("B",500,1000,1,"B")),5);
        var pattern=new SlittingResult.Pattern("P1",1000,1000,1000,"A",1,List.of(new SlittingResult.Station(500,2)),
                List.of(new SlittingResult.Allocation("A",2)));
        var r=new SlittingResult("1","mm","ortools-1d","1","FEASIBLE",false,List.of(pattern),List.of(
                new SlittingResult.Fulfillment("A",1,2,0,1),new SlittingResult.Fulfillment("B",1,0,1,0)),1000000,1000000,1000000,1);
        assertThrows(SlittingValidation.ValidationException.class,()->SlittingValidation.validateResult(p,r));
    }
}
