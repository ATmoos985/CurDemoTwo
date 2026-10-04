package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.*;
import com.example.cutdemotwo.service.*;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class FulfillmentReasonTests {
    private NestingProblem problem(double trim) {
        return new NestingProblem("1","mm",new NestingProblem.Material("M",NestingProblem.Shape.rectangle(1000,2000),List.of(),false),
                List.of(),new NestingProblem.Process("GUILLOTINE","SHEET","left-top","horizontal",trim,200,300,0,"MAXIMIZE_PIECE_AREA"),"auto",3);
    }
    private NestingProblem.Part part(double width,double length,boolean rotation) {
        return new NestingProblem.Part(17,"A",NestingProblem.Shape.rectangle(width,length),3,rotation);
    }
    @Test void dimensionProofAccountsForAllowedOrientationsAndTrim() {
        assertEquals("EXCEEDS_MATERIAL_WIDTH",FulfillmentReason.unplaced(problem(0),part(1100,2100,true),false));
        assertEquals("EXCEEDS_PROCESSING_LENGTH",FulfillmentReason.unplaced(problem(100),part(900,1950,false),false));
        assertEquals("EXCEEDS_PROCESSING_REGION",FulfillmentReason.unplaced(problem(100),part(1950,950,true),false));
    }
    @Test void rotationSuggestionDoesNotClaimThatRotatedPackingWillSucceed() {
        assertEquals("ROTATION_REQUIRED",FulfillmentReason.unplaced(problem(0),part(1500,900,false),false));
        assertEquals("NOT_PLACED_IN_THIS_SOLUTION",FulfillmentReason.unplaced(problem(0),part(1500,900,true),false));
        assertEquals("NOT_PLACED_IN_THIS_SOLUTION",FulfillmentReason.unplaced(problem(0),part(900,1500,false),false));
        assertEquals("NOT_INCLUDED_IN_MANUAL_LAYOUT",FulfillmentReason.unplaced(problem(0),part(900,1500,false),true));
    }
    @Test void polygonOmissionsNeverUseRectangularDimensionProof() {
        var p=part(3000,3000,false);
        p=new NestingProblem.Part(p.id(),p.name(),new NestingProblem.Shape("POLYGON",3000,3000,List.of()),1,false);
        assertEquals("NOT_PLACED_IN_THIS_SOLUTION",FulfillmentReason.unplaced(problem(0),p,false));
    }
    @Test void fabricAdapterPreservesFulfillmentAndStatusEvenWhenNoPlanExists() {
        var kernel=new SolverFactory(List.of(new CrossCutSolverService()));
        var request=new SolveRequest();request.setRollW(2000);request.setRollL(3000);request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(17,"A",2000,1200,3,false)));
        var partial=FabricSolveAdapter.solve(kernel,request);
        assertEquals("FEASIBLE",partial.getStatus());assertEquals(2,partial.getFulfillment().get(0).placed());
        assertEquals(1,partial.getFulfillment().get(0).unplaced());assertEquals(17,partial.getFulfillment().get(0).demandId());
        request.setDemands(List.of(new PieceDemand(17,"A",2000,4000,1,false)));
        var empty=FabricSolveAdapter.solve(kernel,request);
        assertFalse(empty.isSuccess());assertNull(empty.getPlanId());assertEquals("NO_SOLUTION_FOUND",empty.getStatus());
        assertEquals("EXCEEDS_PROCESSING_LENGTH",empty.getFulfillment().get(0).reason());
        assertEquals(1,empty.getFulfillment().get(0).unplaced());
    }
}
