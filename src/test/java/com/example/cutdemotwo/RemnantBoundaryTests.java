package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.service.PackingSolverService;
import com.example.cutdemotwo.service.RemnantService;
import com.example.cutdemotwo.service.solver.EngineResult;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class RemnantBoundaryTests {
    @TempDir Path temp;

    @ParameterizedTest
    @CsvSource({"-2.2737367544323206E-13,4550,0,4550", "0,-2.2737367544323206E-13,0,0",
            "-0.001,4550,0,4550", "0,-0.001,0,0"})
    void savedPlanCanReportBoundaryRoundoffWithoutChangingMeasuredSize(double x, double y, double expectedX, double expectedY) {
        Path file = temp.resolve("saved-plan.json");
        var inventory = new RemnantService(file.toString());
        var request = request();
        var plan = plan(x, y);
        inventory.rememberPlan(new CuttingPlan(plan.getPlanId(), request, plan, inventory.materialFingerprint(request),
                "PENDING", "2026-10-08T14:33:38"));
        var reopened = new RemnantService(file.toString());
        double before = reopened.getMotherRoll(request.getRollId()).getCurrentRemainingLength();
        var report = new CutReport(plan.getPlanId(), 5000, 1, plan.getRemnants(), "A-01");

        var receipt = reopened.confirmPlan(report);
        var geometry = (Map<?, ?>) ((List<?>) receipt.get("recoveredGeometry")).get(0);
        assertEquals(expectedX, ((Number) geometry.get("x")).doubleValue());
        assertEquals(expectedY, ((Number) geometry.get("y")).doubleValue());
        var child = (RemnantStock) ((List<?>) receipt.get("derivedRemnants")).get(0);
        assertEquals(614.7, child.getWidth());
        assertEquals(450, child.getLength());
        assertEquals(before - 5000, reopened.getMotherRoll(request.getRollId()).getCurrentRemainingLength());
        assertEquals(receipt, reopened.confirmPlan(report), "Retry must not deduct stock twice");
        assertEquals(x, reopened.getPlan(plan.getPlanId()).result().getRemnants().get(0).getX(), "Saved plan stays unchanged");
        assertEquals(y, reopened.getPlan(plan.getPlanId()).result().getRemnants().get(0).getY(), "Saved plan stays unchanged");
    }

    @ParameterizedTest
    @CsvSource({"-0.002,4550", "0,-0.002", "2185.302,4550", "0,4550.002"})
    void realBoundaryViolationsStillRejectWithoutChangingInventory(double x, double y) {
        var inventory = new RemnantService(temp.resolve("rejected.json").toString());
        var request = request();
        var plan = plan(x, y);
        double before = inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength();
        int remnantsBefore = inventory.getAvailableRemnants().size();
        var error = assertThrows(IllegalArgumentException.class, () -> inventory.confirm(request, plan,
                new CutReport(plan.getPlanId(), 5000, 1, plan.getRemnants(), "A-01")));
        assertEquals("实测料头超出排料范围: LEFTOVER-02", error.getMessage());
        assertEquals(before, inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength());
        assertEquals(remnantsBefore, inventory.getAvailableRemnants().size());
        assertNull(inventory.getReceipt(plan.getPlanId()));
    }

    @ParameterizedTest
    @ValueSource(strings = {"right-top", "right-bottom"})
    void fractionalCertificateCoordinatesAtMaterialEdgeAreExactlyZero(String origin) throws Exception {
        Path certificate = temp.resolve("certificate.csv");
        Files.writeString(certificate, """
                PLATE_ID,NODE_ID_PARENT,NODE_ID,X,Y,WIDTH,HEIGHT,TYPE,CUT,PARENT
                0,0,1,21853,21853,6147,6147,-1,1,
                """);
        var problem = new NestingProblem("1", "mm",
                new NestingProblem.Material("sheet", NestingProblem.Shape.rectangle(2800, 2800), List.of(), false),
                List.of(), new NestingProblem.Process("GUILLOTINE", "SHEET", origin, "horizontal",
                0, 200, 300, 0, "MAXIMIZE_PIECE_AREA"), "packingsolver", 1);
        EngineResult result = ReflectionTestUtils.invokeMethod(new PackingSolverService(), "parseCertificate",
                certificate.toFile(), problem, Map.of(), Map.of());
        assertNotNull(result);
        assertEquals(1, result.getRemnants().size());
        var remnant = result.getRemnants().get(0);
        assertEquals(0.0, remnant.getX());
        assertEquals(origin.endsWith("bottom") ? 0.0 : 2185.3, remnant.getY());
        assertEquals(614.7, remnant.getW());
        assertEquals(614.7, remnant.getL());
    }

    private SolveRequest request() {
        var request = new SolveRequest();
        request.setRollId("ROLL-REAL-893292");
        request.setRollW(2800);
        request.setRollL(5000);
        request.setWindowStartY(4870);
        return request;
    }

    private SolveResponse plan(double x, double y) {
        var plan = new SolveResponse();
        plan.setPlanId("boundary-plan");
        plan.setPieces(List.of(new PlacedPiece(33, "抱枕套", 614.7, 4550, 450, 450, false, 14)));
        plan.setRemnants(List.of(new RemnantPiece("LEFTOVER-02", "可用料头", x, y, 614.7, 450, 0.276615, false)));
        return plan;
    }
}
