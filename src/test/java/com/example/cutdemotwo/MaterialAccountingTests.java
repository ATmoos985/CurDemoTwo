package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class MaterialAccountingTests {
    @TempDir Path temp;
    @Test void receiptRecordsActualDenominatorSeparatelyFromProcessingAreaWithoutRoundingLength() {
        var inventory=new RemnantService(temp.resolve("accounting.json").toString());
        var workflow=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),inventory);
        var request=new SolveRequest();request.setRollW(2000);request.setRollL(5000);request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(1,"主帘",2000,1200.5,2,false)));
        var plan=workflow.solve(request);
        assertEquals(10,plan.getTotalArea()); // Existing solver contract: processing area.
        double before=inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength();
        var receipt=workflow.confirm(new CutReport(plan.getPlanId(),2401.1,2,List.of(),"A"));
        assertEquals(10.0,receipt.get("processingArea"));assertEquals(4.8022,receipt.get("usedArea"));
        assertEquals(4.802,receipt.get("pieceArea"));assertEquals(0.0,receipt.get("remArea"));
        assertEquals(4.802/4.8022*100,((Number)receipt.get("utilization")).doubleValue(),1e-9);
        assertEquals(before-2401.1,inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength(),1e-9);
    }
}
